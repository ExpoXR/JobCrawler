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

const nextConfig: NextConfig = {
  reactStrictMode: true,
  transpilePackages: workspacePackages,
  output: 'standalone',
  serverExternalPackages: ['pg', 'bullmq', 'ioredis', 'cheerio'],
  poweredByHeader: false,
  eslint: {
    // Linting runs once at the repo root; re-running it during build is noise.
    ignoreDuringBuilds: true,
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'X-Frame-Options', value: 'DENY' },
          {
            key: 'Permissions-Policy',
            value: 'geolocation=(self), microphone=(), camera=()',
          },
        ],
      },
    ];
  },
};

export default nextConfig;
