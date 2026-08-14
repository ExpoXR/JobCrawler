import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

/**
 * Admin authentication (plan section 33).
 *
 * The public app requires no account; everything under `/admin` and
 * `/api/admin` does. HTTP Basic over the deployment's TLS is deliberate for a
 * self-hosted single-operator tool: no session store, no cookie handling, no
 * password reset flow to get wrong.
 *
 * With no `ADMIN_PASSWORD` set, the admin area is closed rather than open —
 * failing safe matters more than convenience here.
 */

const REALM = 'ExpoJobCrawler Admin';

function unauthorized(message = 'Authentication required'): NextResponse {
  return new NextResponse(message, {
    status: 401,
    headers: {
      'www-authenticate': `Basic realm="${REALM}", charset="UTF-8"`,
      'content-type': 'text/plain; charset=utf-8',
    },
  });
}

/** Length-independent comparison to avoid leaking the secret by timing. */
function safeEquals(a: string, b: string): boolean {
  const length = Math.max(a.length, b.length);
  let mismatch = a.length === b.length ? 0 : 1;
  for (let i = 0; i < length; i += 1) {
    mismatch |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return mismatch === 0;
}

export function middleware(request: NextRequest): NextResponse {
  const expectedUser = process.env['ADMIN_USERNAME'] ?? 'admin';
  const expectedPassword = process.env['ADMIN_PASSWORD'] ?? '';

  if (!expectedPassword) {
    return new NextResponse(
      'The admin dashboard is disabled because ADMIN_PASSWORD is not configured.',
      { status: 503, headers: { 'content-type': 'text/plain; charset=utf-8' } },
    );
  }

  const header = request.headers.get('authorization') ?? '';
  if (!header.toLowerCase().startsWith('basic ')) return unauthorized();

  let decoded: string;
  try {
    decoded = atob(header.slice(6).trim());
  } catch {
    return unauthorized('Malformed credentials');
  }

  const separator = decoded.indexOf(':');
  if (separator === -1) return unauthorized('Malformed credentials');

  const user = decoded.slice(0, separator);
  const password = decoded.slice(separator + 1);

  if (!safeEquals(user, expectedUser) || !safeEquals(password, expectedPassword)) {
    return unauthorized('Invalid credentials');
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/admin/:path*', '/api/admin/:path*'],
};
