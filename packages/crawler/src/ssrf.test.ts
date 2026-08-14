import { describe, expect, it } from 'vitest';

import { assertUrlIsSafe, checkIpAddress, domainMatches, validateUrlShape } from './ssrf';

/**
 * SSRF is the highest-severity risk in a crawler, so these tests are
 * exhaustive about the address classes that must never be reachable.
 */

describe('checkIpAddress', () => {
  it('blocks IPv4 loopback, private and link-local ranges', () => {
    for (const address of [
      '127.0.0.1',
      '127.1.2.3',
      '10.0.0.1',
      '10.255.255.255',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '169.254.169.254', // cloud metadata
      '0.0.0.0',
      '100.64.0.1',
      '224.0.0.1',
    ]) {
      expect(checkIpAddress(address).allowed, address).toBe(false);
    }
  });

  it('allows public IPv4 addresses', () => {
    for (const address of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.32.0.1', '172.15.0.1']) {
      expect(checkIpAddress(address).allowed, address).toBe(true);
    }
  });

  it('blocks IPv6 loopback, unique-local and link-local', () => {
    for (const address of ['::1', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'ff02::1', '::']) {
      expect(checkIpAddress(address).allowed, address).toBe(false);
    }
  });

  it('blocks IPv4-mapped IPv6 pointing at a private address', () => {
    expect(checkIpAddress('::ffff:127.0.0.1').allowed).toBe(false);
    expect(checkIpAddress('::ffff:169.254.169.254').allowed).toBe(false);
    expect(checkIpAddress('::ffff:10.0.0.1').allowed).toBe(false);
  });

  it('allows public IPv6', () => {
    expect(checkIpAddress('2606:4700:4700::1111').allowed).toBe(true);
  });

  it('rejects non-addresses', () => {
    expect(checkIpAddress('not-an-ip').allowed).toBe(false);
  });
});

describe('validateUrlShape', () => {
  it('accepts ordinary public URLs', () => {
    expect(() => validateUrlShape('https://example.com/careers')).not.toThrow();
    expect(() => validateUrlShape('http://example.com:8080/jobs')).not.toThrow();
  });

  it('rejects non-HTTP schemes', () => {
    expect(() => validateUrlShape('file:///etc/passwd')).toThrow();
    expect(() => validateUrlShape('gopher://example.com')).toThrow();
    expect(() => validateUrlShape('javascript:alert(1)')).toThrow();
  });

  it('rejects embedded credentials', () => {
    expect(() => validateUrlShape('https://user:pass@example.com')).toThrow();
  });

  it('rejects unusual ports', () => {
    expect(() => validateUrlShape('http://example.com:22/')).toThrow();
    expect(() => validateUrlShape('http://example.com:5432/')).toThrow();
  });

  it('rejects internal hostnames and suffixes', () => {
    for (const url of [
      'http://localhost/',
      'http://metadata.google.internal/',
      'http://host.docker.internal/',
      'http://service.local/',
      'http://api.svc.cluster.local/',
      'http://redis/',
    ]) {
      expect(() => validateUrlShape(url), url).toThrow();
    }
  });

  it('honours the blocked-domain list, including subdomains', () => {
    expect(() =>
      validateUrlShape('https://careers.example.com', { blockedDomains: ['example.com'] }),
    ).toThrow();
  });

  it('allows internal hosts when explicitly permitted for local development', () => {
    expect(() => validateUrlShape('http://localhost:8080', { allowPrivateAddresses: true })).not.toThrow();
  });
});

describe('assertUrlIsSafe', () => {
  it('rejects a public hostname that resolves to a private address', async () => {
    await expect(
      assertUrlIsSafe('https://evil.example.com', {
        resolve: async () => ['169.254.169.254'],
      }),
    ).rejects.toThrow(/non-public address/);
  });

  it('rejects when any resolved address is private', async () => {
    await expect(
      assertUrlIsSafe('https://mixed.example.com', {
        resolve: async () => ['93.184.216.34', '10.0.0.5'],
      }),
    ).rejects.toThrow();
  });

  it('accepts a hostname resolving only to public addresses', async () => {
    const result = await assertUrlIsSafe('https://example.com/jobs', {
      resolve: async () => ['93.184.216.34'],
    });
    expect(result.hostname).toBe('example.com');
    expect(result.addresses).toEqual(['93.184.216.34']);
  });

  it('surfaces DNS failures as an error rather than allowing the fetch', async () => {
    await expect(
      assertUrlIsSafe('https://example.com', {
        resolve: async () => {
          throw new Error('ENOTFOUND');
        },
      }),
    ).rejects.toThrow();
  });
});

describe('domainMatches', () => {
  it('matches the host and its subdomains only', () => {
    expect(domainMatches('example.com', 'example.com')).toBe(true);
    expect(domainMatches('jobs.example.com', 'example.com')).toBe(true);
    expect(domainMatches('notexample.com', 'example.com')).toBe(false);
  });
});
