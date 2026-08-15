import { startSearch } from '@ejc/search';
import { getSearchStats } from '@ejc/database';
import { z } from 'zod';
import { NextResponse } from 'next/server';

import { clientKey, handleRouteError, rateLimit, readJsonBody, tooManyRequests } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const requestSchema = z.object({
  query: z.unknown(),
  naturalLanguage: z.string().max(4000).optional(),
  indexOnly: z.boolean().optional(),
});

/**
 * Creates a search (plan section 7).
 *
 * Returns as soon as the indexed results are stored; live discovery continues
 * in the background and the client follows it via `/api/search/{id}`.
 */
export async function POST(request: Request) {
  try {
    // Searches are expensive: they geocode, hit the database and fan out to
    // crawlers. A tighter budget than the read endpoints is deliberate.
    const limit = rateLimit(clientKey(request, 'search'), 10, 60_000);
    if (!limit.allowed) return tooManyRequests(limit.retryAfterSeconds);

    const body = requestSchema.parse(await readJsonBody(request));

    const result = await startSearch({
      query: body.query,
      ...(body.naturalLanguage ? { naturalLanguage: body.naturalLanguage } : {}),
      ...(body.indexOnly !== undefined ? { indexOnly: body.indexOnly } : {}),
    });

    return NextResponse.json(
      {
        searchId: result.searchId,
        query: result.query,
        immediateResults: result.immediateResults,
        liveDiscoveryStarted: result.liveDiscoveryStarted,
      },
      { status: 201 },
    );
  } catch (error) {
    return handleRouteError(error, 'POST /api/search');
  }
}

export async function GET() {
  try {
    return NextResponse.json(await getSearchStats());
  } catch (error) {
    return handleRouteError(error, 'GET /api/search');
  }
}
