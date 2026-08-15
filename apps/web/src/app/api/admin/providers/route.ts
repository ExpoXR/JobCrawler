import { listSourceProviders, setProviderEnabled } from '@ejc/database';
import { syncProviderRegistry } from '@ejc/providers';
import { NextResponse } from 'next/server';
import { z } from 'zod';

import { handleRouteError, readJsonBody } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET() {
  try {
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
    const body = toggleSchema.parse(await readJsonBody(request));
    await setProviderEnabled(body.key, body.enabled);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return handleRouteError(error, 'POST /api/admin/providers');
  }
}
