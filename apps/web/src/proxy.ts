import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

import { buildCsp, cspHeaderName, tileOriginFrom, type CspMode } from '@/lib/csp';

/**
 * Two jobs, both of which have to happen before the app renders.
 *
 * **1. Content-Security-Policy.** The policy carries a per-request nonce, so it
 * cannot be a static header in `next.config.ts`. The nonce is passed inward on
 * `x-nonce` for the root layout's inline theme script, and outward in the CSP
 * header; Next picks it up for its own bootstrap scripts automatically.
 *
 * **2. An edge gate for the admin area.** This runs on the edge runtime and
 * therefore cannot reach Postgres, so it can only see *whether* a session cookie
 * is present — never whether it is valid, or whose. It is a redirect, not an
 * authorisation check. **The real check is `requireAdmin()` inside each route
 * handler and page**, on the Node runtime, against the database. Nothing here is
 * load-bearing for security.
 */

const SESSION_COOKIE = 'ejc_session';

function generateNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes));
}

function applySecurityHeaders(response: NextResponse, nonce: string): NextResponse {
  const mode = (process.env.CSP_MODE ?? 'report-only') as CspMode;
  const header = cspHeaderName(mode);
  if (!header) return response;

  response.headers.set(
    header,
    buildCsp({
      nonce,
      development: process.env.NODE_ENV === 'development',
      tileOrigin: tileOriginFrom(process.env.NEXT_PUBLIC_MAP_TILE_URL),
    }),
  );
  return response;
}

/** Exact segment matching: `/adminfoo` is not the admin area. */
function isAdminPath(pathname: string): boolean {
  return (
    pathname === '/admin' ||
    pathname.startsWith('/admin/') ||
    pathname === '/api/admin' ||
    pathname.startsWith('/api/admin/')
  );
}

export function proxy(request: NextRequest): NextResponse {
  const nonce = generateNonce();

  if (isAdminPath(request.nextUrl.pathname) && !request.cookies.has(SESSION_COOKIE)) {
    // An API client gets a status it can act on; a browser gets the login page.
    if (request.nextUrl.pathname.startsWith('/api/')) {
      return applySecurityHeaders(
        NextResponse.json(
          { error: 'Please sign in to continue.', type: 'unauthenticated' },
          { status: 401 },
        ),
        nonce,
      );
    }

    const login = new URL('/login', request.url);
    login.searchParams.set('next', request.nextUrl.pathname + request.nextUrl.search);
    return NextResponse.redirect(login);
  }

  // Forward the nonce so the layout can mark its inline script with it.
  const headers = new Headers(request.headers);
  headers.set('x-nonce', nonce);

  return applySecurityHeaders(NextResponse.next({ request: { headers } }), nonce);
}

export const config = {
  matcher: [
    /*
     * Everything that renders or serves an API, and nothing that does not:
     * static assets and the image optimiser carry no markup to protect, and
     * running middleware for them is pure overhead.
     */
    '/((?!_next/static|_next/image|favicon.ico|fonts/|robots.txt).*)',
  ],
};
