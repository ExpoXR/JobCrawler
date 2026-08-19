import { AppError, type ErrorType, getConfig, getLogger, publicErrorMessage } from '@ejc/shared';
import { NextResponse } from 'next/server';
import { ZodError } from 'zod';

import { clientAddress } from './rateLimit';

/**
 * Shared API-route helpers.
 *
 * One place decides what an error looks like on the wire, so no route ever
 * leaks a stack trace, a connection string or a provider key to a client
 * (plan section 37).
 */

export interface ApiErrorBody {
  error: string;
  type?: string;
  details?: unknown;
}

export function jsonError(
  status: number,
  message: string,
  extra: Omit<ApiErrorBody, 'error'> = {},
): NextResponse<ApiErrorBody> {
  return NextResponse.json({ error: message, ...extra }, { status });
}

/** Error types with a status other than 500. */
const STATUS_BY_ERROR_TYPE: Partial<Record<ErrorType, number>> = {
  validation: 400,
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  rate_limited: 429,
  not_configured: 503,
  provider_unavailable: 503,
};

/** Maps a thrown value to a safe HTTP response. */
export function handleRouteError(error: unknown, route: string): NextResponse<ApiErrorBody> {
  const logger = getLogger('api');

  if (error instanceof ZodError) {
    return jsonError(400, 'Invalid request', {
      type: 'validation',
      details: error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    });
  }

  if (error instanceof AppError) {
    const status = STATUS_BY_ERROR_TYPE[error.type] ?? 500;

    logger.warn('Request failed', { route, errorType: error.type, message: error.message });
    const message =
      error.type === 'provider_unavailable' &&
      (route.includes('/api/search') || route.includes('/api/geocode'))
        ? 'Geocoding is temporarily unavailable. Please try again after the service is ready.'
        : publicErrorMessage(error);
    return jsonError(status, message, { type: error.type });
  }

  logger.error('Unhandled route error', {
    route,
    message: error instanceof Error ? error.message : String(error),
  });
  return jsonError(500, 'Unexpected error');
}

/** Reads and parses a JSON body, rejecting oversized or malformed payloads. */
export async function readJsonBody(request: Request, maxBytes = 256_000): Promise<unknown> {
  const contentLength = Number(request.headers.get('content-length') ?? '0');
  if (contentLength > maxBytes) {
    throw new AppError('validation', 'Request body is too large');
  }

  const text = await request.text();
  if (text.length > maxBytes) {
    throw new AppError('validation', 'Request body is too large');
  }
  if (!text.trim()) return {};

  try {
    return JSON.parse(text);
  } catch {
    throw new AppError('validation', 'Request body is not valid JSON');
  }
}

/**
 * Rejects a state-changing request that did not come from this application.
 *
 * The session cookie is `SameSite=Lax`, which already blocks the cross-site form
 * post. This closes the remaining gap: a same-site subdomain, or a browser that
 * has not applied the default. Requests with no `Origin` at all — curl, a native
 * client — are allowed through, because CSRF requires a browser to begin with.
 */
export function assertSameOrigin(request: Request): void {
  const origin = request.headers.get('origin');
  if (!origin) return;

  let expected: string;
  try {
    expected = new URL(getConfig().web.baseUrl).origin;
  } catch {
    throw new AppError('not_configured', 'PUBLIC_BASE_URL is not a valid URL');
  }

  if (origin === expected) return;

  /*
   * Fall back to comparing the Origin's host against the request's own Host
   * header — *not* against `request.url`, which behind a port mapping or a
   * reverse proxy reports the address the server listens on internally rather
   * than the one the browser used. A container published on :3005 but listening
   * on :3000 would otherwise reject every request it received.
   *
   * Host is client-controlled, but that does not weaken the check: the point is
   * that a browser sets Origin honestly and a cross-site page cannot forge it,
   * so an Origin matching the Host the browser addressed is by definition
   * same-origin.
   */
  const host = request.headers.get('host');
  if (host) {
    try {
      if (new URL(origin).host === host) return;
    } catch {
      // A malformed Origin is not a match.
    }
  }

  throw new AppError('forbidden', `Cross-origin request rejected (origin ${origin})`);
}

/**
 * Best-effort client identity for rate limiting. Never stored.
 *
 * The address comes from `clientAddress`, which only trusts as many
 * `x-forwarded-for` hops as the deployment says sit in front of it.
 */
export function clientKey(request: Request, scope: string): string {
  const address = clientAddress(request, getConfig().security.trustedProxyHops);
  return `${scope}:${address ?? 'local'}`;
}

export { rateLimit } from './rateLimit';
export type { RateLimitResult } from './rateLimit';

export function tooManyRequests(retryAfterSeconds: number): NextResponse<ApiErrorBody> {
  return NextResponse.json(
    { error: 'Too many requests. Please slow down.', type: 'rate_limited' },
    { status: 429, headers: { 'retry-after': String(retryAfterSeconds) } },
  );
}
