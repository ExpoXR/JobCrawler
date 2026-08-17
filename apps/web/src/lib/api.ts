import { AppError, getLogger, publicErrorMessage } from '@ejc/shared';
import { NextResponse } from 'next/server';
import { ZodError } from 'zod';

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
    const status =
      error.type === 'validation'
        ? 400
        : error.type === 'not_configured'
          ? 503
          : error.type === 'rate_limited'
            ? 429
            : error.type === 'provider_unavailable'
              ? 503
              : 500;

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
 * Very small fixed-window rate limiter.
 *
 * In-memory and therefore per-instance: enough to stop a single client from
 * hammering search or geocoding on a self-hosted deployment (plan section 37).
 * A multi-instance deployment should front this with a shared limiter.
 */
const buckets = new Map<string, { count: number; resetAt: number }>();

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

export function rateLimit(key: string, limit: number, windowMs: number): RateLimitResult {
  const now = Date.now();
  const bucket = buckets.get(key);

  if (!bucket || bucket.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true, remaining: limit - 1, retryAfterSeconds: 0 };
  }

  bucket.count += 1;
  if (bucket.count > limit) {
    return {
      allowed: false,
      remaining: 0,
      retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
    };
  }

  // Opportunistic cleanup so the map cannot grow without bound.
  if (buckets.size > 5000) {
    for (const [entryKey, entry] of buckets) {
      if (entry.resetAt <= now) buckets.delete(entryKey);
    }
  }

  return { allowed: true, remaining: limit - bucket.count, retryAfterSeconds: 0 };
}

/** Best-effort client identity for rate limiting. Never stored. */
export function clientKey(request: Request, scope: string): string {
  const forwarded = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  const real = request.headers.get('x-real-ip');
  return `${scope}:${forwarded ?? real ?? 'local'}`;
}

export function tooManyRequests(retryAfterSeconds: number): NextResponse<ApiErrorBody> {
  return NextResponse.json(
    { error: 'Too many requests. Please slow down.', type: 'rate_limited' },
    { status: 429, headers: { 'retry-after': String(retryAfterSeconds) } },
  );
}
