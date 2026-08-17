import { checkDatabaseHealth } from '@ejc/database';
import { checkRedisHealth } from '@ejc/queue';
import { getConfig } from '@ejc/shared';
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface GeocoderHealth {
  ok: boolean;
  latencyMs: number;
  checkedAt: number;
}

let cachedGeocoderHealth: GeocoderHealth | undefined;

async function checkGeocoderHealth(baseUrl: string): Promise<GeocoderHealth> {
  const now = Date.now();
  if (cachedGeocoderHealth && now - cachedGeocoderHealth.checkedAt < 30_000) {
    return cachedGeocoderHealth;
  }

  const startedAt = performance.now();
  try {
    const response = await fetch(new URL('/status', baseUrl), {
      cache: 'no-store',
      signal: AbortSignal.timeout(3_000),
      headers: { accept: 'text/plain, application/json' },
    });
    cachedGeocoderHealth = {
      ok: response.ok,
      latencyMs: Math.round(performance.now() - startedAt),
      checkedAt: now,
    };
  } catch {
    cachedGeocoderHealth = {
      ok: false,
      latencyMs: Math.round(performance.now() - startedAt),
      checkedAt: now,
    };
  }
  return cachedGeocoderHealth;
}

/**
 * Health endpoint (plan section 33).
 *
 * Reports dependency status without exposing configuration: provider *names*
 * are safe to publish, credentials never are.
 */
export async function GET() {
  const config = getConfig();
  const [database, redis, geocoding] = await Promise.all([
    checkDatabaseHealth(),
    checkRedisHealth(),
    checkGeocoderHealth(config.geo.nominatimBaseUrl),
  ]);

  const healthy = database.ok && database.postgis && database.pgvector && geocoding.ok;

  return NextResponse.json(
    {
      status: healthy ? 'ok' : 'degraded',
      time: new Date().toISOString(),
      database: {
        ok: database.ok,
        latencyMs: database.latencyMs,
        postgis: database.postgis,
        pgvector: database.pgvector,
      },
      redis: { ok: redis.ok, latencyMs: redis.latencyMs },
      ai: { provider: config.ai.provider, configured: config.ai.provider !== 'none' },
      embeddings: {
        provider: config.embedding.provider,
        configured: config.embedding.provider !== 'none',
      },
      geocoding: {
        provider: config.geo.provider,
        ok: geocoding.ok,
        latencyMs: geocoding.latencyMs,
      },
    },
    { status: healthy ? 200 : 503 },
  );
}
