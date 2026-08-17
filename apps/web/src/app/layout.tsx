import type { Metadata, Viewport } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';

import { ThemeControl } from '@/components/ThemeControl';

import './expoxr-system.css';
import './globals.css';

export const metadata: Metadata = {
  title: {
    default: 'ExpoJobCrawler',
    template: '%s · ExpoJobCrawler',
  },
  description:
    'AI-powered geographic employment research for Germany, Austria and Switzerland. Discover jobs, employers and public professional profiles around a location.',
  robots:
    process.env.PUBLIC_ROBOTS_NOINDEX === 'false'
      ? undefined
      : { index: false, follow: false, noarchive: true },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html
      lang="en"
      data-expo-product="expojobcrawler"
      data-expo-profile="workspace"
      suppressHydrationWarning
    >
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: `try{var t=localStorage.getItem('expojobcrawler-theme')||'light';t=/^(light|dark|system)$/.test(t)?t:'light';var d=t==='dark'||(t==='system'&&matchMedia('(prefers-color-scheme: dark)').matches);var r=d?'dark':'light';document.documentElement.dataset.theme=r;document.documentElement.dataset.expoTheme=r;document.documentElement.dataset.themePreference=t;}catch(e){document.documentElement.dataset.theme='light';document.documentElement.dataset.expoTheme='light';document.documentElement.dataset.themePreference='light';}`,
          }}
        />
      </head>
      <body>
        <a className="skip-link" href="#main">
          Skip to content
        </a>
        <header className="app-header">
          <Link href="/" className="brand ex-wordmark" aria-label="ExpoXR JobCrawler home">
            <span>EXPO</span>
            <span className="ex-wordmark__xr">XR</span>
            <span className="ex-wordmark__descriptor">JobCrawler</span>
          </Link>
          <div className="header-actions">
            <span className="coverage-badge">DACH launch</span>
            <nav aria-label="Primary">
              <Link href="/search?mode=jobs">Find jobs</Link>
              <Link href="/search?mode=candidates">Find people</Link>
              <Link href="/admin">Admin</Link>
            </nav>
            <ThemeControl />
          </div>
        </header>
        <main id="main" tabIndex={-1}>
          {children}
        </main>
      </body>
    </html>
  );
}
