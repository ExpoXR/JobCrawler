import type { Metadata, Viewport } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';

import './globals.css';

export const metadata: Metadata = {
  title: {
    default: 'ExpoJobCrawler',
    template: '%s · ExpoJobCrawler',
  },
  description:
    'AI-powered geographic employment research engine for Europe. Discover jobs, employers and public professional profiles around a location.',
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <a className="skip-link" href="#main">
          Skip to content
        </a>
        <header className="app-header">
          <Link href="/" className="brand">
            ExpoJobCrawler
          </Link>
          <nav aria-label="Primary">
            <Link href="/search?mode=jobs">Find a job</Link>
            <Link href="/search?mode=candidates">Find people</Link>
            <Link href="/admin">Admin</Link>
          </nav>
        </header>
        <main id="main">{children}</main>
      </body>
    </html>
  );
}
