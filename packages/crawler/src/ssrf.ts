import dns from 'node:dns/promises';
import net from 'node:net';

import { AppError } from '@ejc/shared';

/**
 * SSRF protection (plan sections 10 and 37).
 *
 * Two layers:
 *   1. URL shape — scheme, port, credentials, obvious internal hostnames.
 *   2. Resolved address — every A/AAAA record must be a public unicast address.
 *
 * The second layer is the one that matters: an attacker-controlled hostname can
 * resolve to 169.254.169.254 no matter how innocent it looks. Redirects are
 * re-validated hop by hop by the fetcher.
 */

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

/** Ports outside this set are refused; crawling never needs them. */
const ALLOWED_PORTS = new Set(['', '80', '443', '8080', '8443']);

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'ip6-localhost',
  'ip6-loopback',
  'metadata',
  'metadata.google.internal',
  'metadata.goog',
  'instance-data',
  'host.docker.internal',
  'gateway.docker.internal',
  'kubernetes.default',
  'kubernetes.default.svc',
]);

/** Internal-only TLDs and Docker/Kubernetes service suffixes. */
const BLOCKED_SUFFIXES = [
  '.localhost',
  '.local',
  '.internal',
  '.intranet',
  '.lan',
  '.home',
  '.corp',
  '.private',
  '.svc',
  '.svc.cluster.local',
  '.cluster.local',
  '.docker',
];

export type AddressVerdict = { allowed: true } | { allowed: false; reason: string };

function ipv4ToInt(address: string): number | undefined {
  const parts = address.split('.');
  if (parts.length !== 4) return undefined;
  let value = 0;
  for (const part of parts) {
    const octet = Number(part);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) return undefined;
    value = value * 256 + octet;
  }
  return value;
}

const IPV4_BLOCKS: Array<{ cidr: string; reason: string }> = [
  { cidr: '0.0.0.0/8', reason: 'this-network' },
  { cidr: '10.0.0.0/8', reason: 'private' },
  { cidr: '100.64.0.0/10', reason: 'carrier-grade-nat' },
  { cidr: '127.0.0.0/8', reason: 'loopback' },
  { cidr: '169.254.0.0/16', reason: 'link-local/metadata' },
  { cidr: '172.16.0.0/12', reason: 'private' },
  { cidr: '192.0.0.0/24', reason: 'ietf-protocol' },
  { cidr: '192.0.2.0/24', reason: 'documentation' },
  { cidr: '192.168.0.0/16', reason: 'private' },
  { cidr: '198.18.0.0/15', reason: 'benchmark' },
  { cidr: '198.51.100.0/24', reason: 'documentation' },
  { cidr: '203.0.113.0/24', reason: 'documentation' },
  { cidr: '224.0.0.0/4', reason: 'multicast' },
  { cidr: '240.0.0.0/4', reason: 'reserved' },
];

const PARSED_IPV4_BLOCKS = IPV4_BLOCKS.map(({ cidr, reason }) => {
  const [base = '', bitsText = '0'] = cidr.split('/');
  const bits = Number(bitsText);
  const baseInt = ipv4ToInt(base) ?? 0;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  // `&` operates on signed int32, so addresses above 2^31 (172.16/12,
  // 192.168/16, 224/4 …) come back negative. Normalise to unsigned on both
  // sides of the comparison or those ranges silently stop matching.
  return { baseInt: (baseInt & mask) >>> 0, mask, reason };
});

function checkIpv4(address: string): AddressVerdict {
  const value = ipv4ToInt(address);
  if (value === undefined) return { allowed: false, reason: 'unparsable IPv4 address' };
  for (const block of PARSED_IPV4_BLOCKS) {
    if ((value & block.mask) >>> 0 === block.baseInt) {
      return { allowed: false, reason: `blocked IPv4 range (${block.reason})` };
    }
  }
  return { allowed: true };
}

function expandIpv6(address: string): string[] | undefined {
  const withoutZone = address.split('%')[0] ?? address;
  const halves = withoutZone.split('::');
  if (halves.length > 2) return undefined;

  const head = (halves[0] ?? '').split(':').filter(Boolean);
  const tail = halves.length === 2 ? (halves[1] ?? '').split(':').filter(Boolean) : [];

  // An embedded IPv4 tail (::ffff:127.0.0.1) becomes two groups.
  const expandTail: string[] = [];
  for (const group of tail) {
    if (group.includes('.')) {
      const value = ipv4ToInt(group);
      if (value === undefined) return undefined;
      expandTail.push(((value >>> 16) & 0xffff).toString(16));
      expandTail.push((value & 0xffff).toString(16));
    } else {
      expandTail.push(group);
    }
  }

  const expandHead: string[] = [];
  for (const group of head) {
    if (group.includes('.')) {
      const value = ipv4ToInt(group);
      if (value === undefined) return undefined;
      expandHead.push(((value >>> 16) & 0xffff).toString(16));
      expandHead.push((value & 0xffff).toString(16));
    } else {
      expandHead.push(group);
    }
  }

  const missing = 8 - expandHead.length - expandTail.length;
  if (halves.length === 1) {
    return expandHead.length === 8 ? expandHead : undefined;
  }
  if (missing < 0) return undefined;
  return [...expandHead, ...Array<string>(missing).fill('0'), ...expandTail];
}

function checkIpv6(address: string): AddressVerdict {
  const groups = expandIpv6(address.toLowerCase());
  if (!groups) return { allowed: false, reason: 'unparsable IPv6 address' };

  const values = groups.map((group) => Number.parseInt(group || '0', 16));
  const first = values[0] ?? 0;

  const isUnspecified = values.every((value) => value === 0);
  const isLoopback = values.slice(0, 7).every((value) => value === 0) && values[7] === 1;
  if (isUnspecified) return { allowed: false, reason: 'unspecified IPv6 address' };
  if (isLoopback) return { allowed: false, reason: 'IPv6 loopback' };

  // ::ffff:0:0/96 — IPv4-mapped: re-check against the IPv4 rules.
  if (values.slice(0, 5).every((value) => value === 0) && values[5] === 0xffff) {
    const high = values[6] ?? 0;
    const low = values[7] ?? 0;
    const ipv4 = [(high >> 8) & 0xff, high & 0xff, (low >> 8) & 0xff, low & 0xff].join('.');
    return checkIpv4(ipv4);
  }

  if ((first & 0xfe00) === 0xfc00) return { allowed: false, reason: 'IPv6 unique-local' };
  if ((first & 0xffc0) === 0xfe80) return { allowed: false, reason: 'IPv6 link-local' };
  if ((first & 0xff00) === 0xff00) return { allowed: false, reason: 'IPv6 multicast' };

  return { allowed: true };
}

/** Classifies a literal IP address as publicly routable or not. */
export function checkIpAddress(address: string): AddressVerdict {
  const family = net.isIP(address);
  if (family === 4) return checkIpv4(address);
  if (family === 6) return checkIpv6(address);
  return { allowed: false, reason: 'not an IP address' };
}

export interface UrlGuardOptions {
  /** Escape hatch for local development only. */
  allowPrivateAddresses?: boolean;
  blockedDomains?: readonly string[];
  /** Injected for tests. */
  resolve?: (hostname: string) => Promise<string[]>;
}

async function defaultResolve(hostname: string): Promise<string[]> {
  const records = await dns.lookup(hostname, { all: true, verbatim: true });
  return records.map((record) => record.address);
}

export function normalizeHostname(hostname: string): string {
  return hostname.replace(/\.$/, '').toLowerCase();
}

/** Registrable-ish domain check used for blocklists: matches host and subdomains. */
export function domainMatches(hostname: string, blocked: string): boolean {
  const host = normalizeHostname(hostname);
  const target = normalizeHostname(blocked);
  return host === target || host.endsWith(`.${target}`);
}

/**
 * Validates a URL's shape. Cheap, synchronous, and safe to run on every
 * candidate URL before spending a DNS lookup.
 */
export function validateUrlShape(rawUrl: string, options: UrlGuardOptions = {}): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new AppError('invalid_url', 'Malformed URL', { context: { url: rawUrl } });
  }

  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    throw new AppError('invalid_url', `Unsupported protocol: ${url.protocol}`, {
      context: { url: rawUrl },
    });
  }
  if (url.username || url.password) {
    throw new AppError('invalid_url', 'URLs with embedded credentials are refused', {
      context: { url: url.origin },
    });
  }
  if (!ALLOWED_PORTS.has(url.port)) {
    throw new AppError('invalid_url', `Refused port: ${url.port}`, { context: { url: url.origin } });
  }

  const hostname = normalizeHostname(url.hostname);
  if (!hostname) {
    throw new AppError('invalid_url', 'Missing hostname', { context: { url: rawUrl } });
  }

  if (!options.allowPrivateAddresses) {
    if (BLOCKED_HOSTNAMES.has(hostname)) {
      throw new AppError('blocked_address', `Refused internal hostname: ${hostname}`);
    }
    if (BLOCKED_SUFFIXES.some((suffix) => hostname.endsWith(suffix))) {
      throw new AppError('blocked_address', `Refused internal domain suffix: ${hostname}`);
    }
    // A bare hostname with no dot is almost always an internal service name.
    if (!hostname.includes('.') && net.isIP(hostname) === 0) {
      throw new AppError('blocked_address', `Refused non-qualified hostname: ${hostname}`);
    }
  }

  for (const blocked of options.blockedDomains ?? []) {
    if (blocked && domainMatches(hostname, blocked)) {
      throw new AppError('blocked_domain', `Domain is blocked: ${hostname}`);
    }
  }

  return url;
}

export interface GuardedUrl {
  url: URL;
  hostname: string;
  addresses: string[];
}

/**
 * Full check: shape plus DNS resolution. Throws `AppError` on refusal so the
 * caller can log a stable `errorType` and continue with other sources.
 */
export async function assertUrlIsSafe(
  rawUrl: string,
  options: UrlGuardOptions = {},
): Promise<GuardedUrl> {
  const url = validateUrlShape(rawUrl, options);
  const hostname = normalizeHostname(url.hostname);

  if (options.allowPrivateAddresses) {
    return { url, hostname, addresses: [] };
  }

  if (net.isIP(hostname) !== 0) {
    const verdict = checkIpAddress(hostname);
    if (!verdict.allowed) {
      throw new AppError('blocked_address', `Refused address ${hostname}: ${verdict.reason}`);
    }
    return { url, hostname, addresses: [hostname] };
  }

  const resolve = options.resolve ?? defaultResolve;
  let addresses: string[];
  try {
    addresses = await resolve(hostname);
  } catch (error) {
    throw new AppError('dns', `DNS lookup failed for ${hostname}`, { cause: error });
  }

  if (addresses.length === 0) {
    throw new AppError('dns', `No addresses for ${hostname}`);
  }

  for (const address of addresses) {
    const verdict = checkIpAddress(address);
    if (!verdict.allowed) {
      throw new AppError(
        'blocked_address',
        `${hostname} resolves to a non-public address (${verdict.reason})`,
      );
    }
  }

  return { url, hostname, addresses };
}
