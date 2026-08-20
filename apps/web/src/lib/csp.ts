/**
 * Content-Security-Policy construction.
 *
 * Kept out of `proxy.ts` so it can be tested without a request: the policy is
 * the kind of thing that breaks an application silently, and a typo in a
 * directive name is not something a browser reports usefully.
 *
 * This module runs on the **edge runtime**, so it must not import `@ejc/shared`
 * (which reads `process.env` dynamically) or anything from Node.
 */

export type CspMode = 'enforce' | 'report-only' | 'off';

export interface CspOptions {
  nonce: string;
  /** Adds the allowances Next's dev server needs. Never enable in production. */
  development?: boolean;
  /** Tile server from `NEXT_PUBLIC_MAP_TILE_URL`, if it is not the default. */
  tileOrigin?: string | undefined;
  /**
   * Widens the policy for the Google Maps JavaScript API.
   *
   * Only true where the operator set `NEXT_PUBLIC_MAP_PROVIDER_ALLOW_GOOGLE`.
   * A deployment that never offers Google has no Google hosts in its policy at
   * all, which is the point of the flag.
   */
  googleMaps?: boolean;
}

/**
 * Hosts the Maps JavaScript API needs, by directive.
 *
 * The `script-src` entry looks redundant next to `'strict-dynamic'`, which tells
 * a CSP3 browser to ignore host allowlists entirely — and does: the loader is
 * injected by our own nonce-carrying bundle, so it inherits trust. It is there
 * for CSP2 browsers, which ignore `'strict-dynamic'` and enforce the allowlist.
 */
const GOOGLE_MAPS_HOSTS = {
  script: ['https://maps.googleapis.com'],
  img: ['https://*.googleapis.com', 'https://*.gstatic.com'],
  connect: ['https://maps.googleapis.com', 'https://*.googleapis.com'],
  // Maps links a stylesheet for its own icon font.
  style: ['https://fonts.googleapis.com'],
  font: ['https://fonts.gstatic.com'],
} as const;

/**
 * Extracts the origin from a tile URL template.
 *
 * The value carries `{z}/{x}/{y}` placeholders, which are not valid in a URL, so
 * they are replaced before parsing. Returns undefined for anything unparseable
 * rather than letting a malformed value widen the policy.
 */
export function tileOriginFrom(template: string | undefined): string | undefined {
  if (!template) return undefined;
  try {
    const url = new URL(template.replace(/\{[zxys]\}/g, '1'));
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}

export function buildCsp(options: CspOptions): string {
  const tile = options.tileOrigin ? [options.tileOrigin] : [];
  const google = options.googleMaps
    ? GOOGLE_MAPS_HOSTS
    : { script: [], img: [], connect: [], style: [], font: [] };

  const directives: Record<string, string[]> = {
    'default-src': ["'self'"],

    // 'strict-dynamic' means the allowlist is ignored in favour of the nonce:
    // only scripts this server marked, and scripts they load, may run. Next
    // applies the nonce to its own bootstrap when it sees one in this header.
    'script-src': [
      "'self'",
      `'nonce-${options.nonce}'`,
      "'strict-dynamic'",
      // The dev server evaluates code for hot reloading. Production does not.
      ...(options.development ? ["'unsafe-eval'"] : []),
      ...google.script,
    ],

    // MapLibre injects style elements at runtime, and Next inlines critical CSS.
    // Neither can carry a nonce, so this stays the one loose directive.
    'style-src': ["'self'", "'unsafe-inline'", ...google.style],

    // blob: is for map tiles composited client-side; data: for inline icons.
    'img-src': ["'self'", 'data:', 'blob:', ...tile, ...google.img],
    'font-src': ["'self'", ...google.font],
    'connect-src': [
      "'self'",
      ...tile,
      ...google.connect,
      ...(options.development ? ['ws:'] : []),
    ],

    // MapLibre runs its tile parser in a worker created from a blob URL.
    'worker-src': ["'self'", 'blob:'],

    'manifest-src': ["'self'"],
    'media-src': ["'self'"],

    // Nothing embeds, nothing is embedded, no plugins, no <base> rewriting, and
    // forms may only post back to this origin.
    'frame-src': ["'none'"],
    'frame-ancestors': ["'none'"],
    'object-src': ["'none'"],
    'base-uri': ["'none'"],
    'form-action': ["'self'"],
  };

  return Object.entries(directives)
    .map(([name, values]) => `${name} ${values.join(' ')}`)
    .join('; ');
}

export function cspHeaderName(mode: CspMode): string | undefined {
  if (mode === 'off') return undefined;
  return mode === 'enforce'
    ? 'Content-Security-Policy'
    : 'Content-Security-Policy-Report-Only';
}
