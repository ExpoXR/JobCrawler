import type { Metadata, Viewport } from 'next';
import { headers } from 'next/headers';
import Link from 'next/link';
import type { ReactNode } from 'react';

import { AccountNav } from '@/components/AccountNav';
import { ThemeControl } from '@/components/ThemeControl';
import { getCurrentUser } from '@/lib/auth';

import packageJson from '../../package.json';
import './expoxr-system.css';
import './globals.css';

// The header reflects who is signed in, so the shell is rendered per request.
export const dynamic = 'force-dynamic';

const appVersion = packageJson.version;
const appVersionLabel = `Version ${appVersion}`;

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

export default async function RootLayout({ children }: { children: ReactNode }) {
  const [user, requestHeaders] = await Promise.all([getCurrentUser(), headers()]);

  // Set by `src/proxy.ts`. Without it the anti-FOUC script below is inline code
  // with no nonce, which the CSP blocks — the page would flash the wrong theme.
  const nonce = requestHeaders.get('x-nonce') ?? undefined;

  return (
    <html
      lang="en"
      data-theme="dark"
      data-expo-theme="dark"
      data-expo-product="expojobcrawler"
      data-expo-profile="workspace"
      data-theme-preference="dark"
      suppressHydrationWarning
    >
      <head>
        <script
          nonce={nonce}
          dangerouslySetInnerHTML={{
            __html: `try{var v=localStorage.getItem('expojobcrawler-theme');var t=v==='light'?'light':'dark';if(v!==t)localStorage.setItem('expojobcrawler-theme',t);document.documentElement.dataset.theme=t;document.documentElement.dataset.expoTheme=t;document.documentElement.dataset.themePreference=t;}catch(e){document.documentElement.dataset.theme='dark';document.documentElement.dataset.expoTheme='dark';document.documentElement.dataset.themePreference='dark';}`,
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
              <AccountNav
                {...(user ? { email: user.email, role: user.role } : {})}
              />
            </nav>
            <ThemeControl />
          </div>
        </header>
        <main id="main" tabIndex={-1}>
          {children}
        </main>
        <footer className="app-footer">
          <p>Made with Love by Ayal Othman from ExpoXR</p>
          <p>{appVersionLabel}</p>
        </footer>
      </body>
    </html>
  );
}
