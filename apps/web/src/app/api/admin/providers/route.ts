import { listSourceProviders, setProviderEnabled } from '@ejc/database';
import { syncProviderRegistry } from '@ejc/providers';
import { NextResponse } from 'next/server';
import { z } from 'zod';

import {
  assertSameOrigin,
  clientKey,
  handleRouteError,
  rateLimit,
  readJsonBody,
  tooManyRequests,
} from '@/lib/api';
import { requireAdmin } from '@/lib/auth';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: Request) {
  try {
    const limit = await rateLimit(clientKey(request, 'admin'), 60, 60_000);
    if (!limit.allowed) return tooManyRequests(limit.retryAfterSeconds);
    await requireAdmin();

    // Sync first so a newly added provider appears without a worker restart.
    await syncProviderRegistry();
    return NextResponse.json({ providers: await listSourceProviders() });
  } catch (error) {
    return handleRouteError(error, 'GET /api/admin/providers');
  }
}

const toggleSchema = z.object({
  key: z.string().min(1).max(100),
  enabled: z.boolean(),
});

export async function POST(request: Request) {
  try {
    const limit = await rateLimit(clientKey(request, 'admin'), 60, 60_000);
    if (!limit.allowed) return tooManyRequests(limit.retryAfterSeconds);
    assertSameOrigin(request);
    await requireAdmin();

    const body = toggleSchema.parse(await readJsonBody(request));
    await setProviderEnabled(body.key, body.enabled);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return handleRouteError(error, 'POST /api/admin/providers');
  }
}
