import type { NextConfig } from 'next';

/**
 * Workspace packages ship TypeScript source (no build step), so Next compiles
 * them with the app. That keeps the monorepo to a single toolchain.
 */
const workspacePackages = [
  '@ejc/ai',
  '@ejc/crawler',
  '@ejc/database',
  '@ejc/matching',
  '@ejc/providers',
  '@ejc/queue',
  '@ejc/search',
  '@ejc/shared',
];

/**
 * `Strict-Transport-Security` is only meaningful — and only safe — on a
 * deployment actually served over TLS. Sending it from an http:// deployment
 * would tell browsers to refuse the plain-text origin they are using.
 *
 * The Content-Security-Policy is *not* here: it carries a per-request nonce, so
 * it is set in `src/proxy.ts`.
 */
const servedOverTls = (process.env.PUBLIC_BASE_URL ?? '').startsWith('https://');

const securityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'X-Frame-Options', value: 'DENY' },
  {
    key: 'Permissions-Policy',
    value: 'geolocation=(self), microphone=(), camera=(), payment=(), usb=()',
  },
  // Isolates the browsing context from anything that opens or embeds the app.
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
  { key: 'Cross-Origin-Resource-Policy', value: 'same-origin' },
  ...(servedOverTls
    ? [
        {
          key: 'Strict-Transport-Security',
          value: 'max-age=31536000; includeSubDomains',
        },
      ]
    : []),
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  transpilePackages: workspacePackages,
  output: 'standalone',
  serverExternalPackages: ['pg', 'bullmq', 'ioredis', 'cheerio'],
  poweredByHeader: false,
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
};

export default nextConfig;
