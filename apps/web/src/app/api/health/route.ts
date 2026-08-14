import { checkDatabaseHealth } from '@ejc/database';
import { checkRedisHealth } from '@ejc/queue';
import { getConfig } from '@ejc/shared';
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Health endpoint (plan section 33).
 *
 * Reports dependency status without exposing configuration: provider *names*
 * are safe to publish, credentials never are.
 */
export async function GET() {
  const config = getConfig();
  const [database, redis] = await Promise.all([checkDatabaseHealth(), checkRedisHealth()]);

  const healthy = database.ok && database.postgis && database.pgvector;

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
      geocoding: { provider: config.geo.provider },
    },
    { status: healthy ? 200 : 503 },
  );
}
