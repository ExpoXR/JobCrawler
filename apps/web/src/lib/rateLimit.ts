import { getLogger } from '@ejc/shared';

/**
 * Fixed-window rate limiting.
 *
 * Backed by Redis, which the deployment already runs for queues, so a limit
 * means the same thing across every web instance and survives a restart. When
 * Redis is unreachable it degrades to the in-memory limiter rather than failing
 * open — a self-hosted single-instance deployment then behaves exactly as it did
 * before, and a multi-instance one is still limited, just per instance.
 */

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

/* --- In-memory fallback --------------------------------------------------- */

const buckets = new Map<string, { count: number; resetAt: number }>();

export function rateLimitInMemory(key: string, limit: number, windowMs: number): RateLimitResult {
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

/** Test seam. */
export function resetInMemoryBuckets(): void {
  buckets.clear();
}

/* --- Redis ---------------------------------------------------------------- */

/**
 * Redis is imported lazily and its failure is contained here.
 *
 * `@ejc/queue` pulls in ioredis and BullMQ; importing it eagerly would drag both
 * into every route that only wants a counter.
 */
let redisUnavailableUntil = 0;

const REDIS_RETRY_BACKOFF_MS = 30_000;

async function rateLimitInRedis(
  key: string,
  limit: number,
  windowMs: number,
): Promise<RateLimitResult | undefined> {
  if (Date.now() < redisUnavailableUntil) return undefined;

  try {
    const { getRedisConnection } = await import('@ejc/queue');
    const redis = getRedisConnection();

    const windowKey = `ratelimit:${key}:${Math.floor(Date.now() / windowMs)}`;

    // INCR then EXPIRE, pipelined: one round trip, and the key always gets a
    // TTL even on the first hit of a window.
    const results = await redis
      .multi()
      .incr(windowKey)
      .pexpire(windowKey, windowMs)
      .exec();

    // `exec` yields [error, value] pairs, and a null result means the
    // transaction was discarded. Either way, fall through to the memory limiter
    // rather than treating an unknown count as "allowed".
    const incr = results?.[0];
    if (!incr || incr[0]) return undefined;

    const count = typeof incr[1] === 'number' ? incr[1] : Number(String(incr[1]));
    if (!Number.isFinite(count) || count <= 0) return undefined;

    if (count > limit) {
      const ttl = await redis.pttl(windowKey);
      return {
        allowed: false,
        remaining: 0,
        retryAfterSeconds: Math.max(1, Math.ceil((ttl > 0 ? ttl : windowMs) / 1000)),
      };
    }

    return { allowed: true, remaining: limit - count, retryAfterSeconds: 0 };
  } catch (error) {
    // Stop hammering a dead Redis on every request.
    redisUnavailableUntil = Date.now() + REDIS_RETRY_BACKOFF_MS;
    getLogger('api').warn('Rate limiter falling back to memory', {
      errorType: 'queue_failure',
      message: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

export async function rateLimit(
  key: string,
  limit: number,
  windowMs: number,
): Promise<RateLimitResult> {
  return (await rateLimitInRedis(key, limit, windowMs)) ?? rateLimitInMemory(key, limit, windowMs);
}

/* --- Client identity ------------------------------------------------------ */

/**
 * Best-effort client identity for rate limiting. Never stored.
 *
 * `x-forwarded-for` is appended to by every hop, and the *client* can put
 * anything in the first entry — so trusting the leftmost value makes the limiter
 * trivially bypassable. Only the last `trustedProxyHops` entries were written by
 * infrastructure we control, so the address we want is that many places from the
 * right. With no proxy configured the header is ignored entirely.
 */
export function clientAddress(request: Request, trustedProxyHops: number): string | undefined {
  if (trustedProxyHops <= 0) {
    return request.headers.get('x-real-ip')?.trim() || undefined;
  }

  const chain = (request.headers.get('x-forwarded-for') ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);

  if (chain.length === 0) return request.headers.get('x-real-ip')?.trim() || undefined;

  // One hop means the rightmost entry was written by our proxy; two means the
  // one before it, and so on. A shorter chain than expected means the request
  // did not come through the full proxy path, so fall back to its first entry.
  const index = Math.max(0, chain.length - trustedProxyHops);
  return chain[index] ?? chain[0];
}
