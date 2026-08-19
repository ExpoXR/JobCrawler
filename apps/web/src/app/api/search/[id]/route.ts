import { getSearchProgress, listSearchResults } from '@ejc/database';
import { z } from 'zod';
import { NextResponse } from 'next/server';

import {
  clientKey,
  handleRouteError,
  jsonError,
  rateLimit,
  tooManyRequests,
} from '@/lib/api';
import { assertSearchAccess } from '@/lib/auth';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const paramsSchema = z.object({ id: z.uuid() });

/** Returns a search's current progress together with its results so far. */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    // Polled once per progress tick per open workspace, so the ceiling is
    // generous — it exists to stop a scripted loop, not normal use.
    const limit = await rateLimit(clientKey(request, 'search-read'), 120, 60_000);
    if (!limit.allowed) return tooManyRequests(limit.retryAfterSeconds);

    const { id } = paramsSchema.parse(await context.params);
    const url = new URL(request.url);

    await assertSearchAccess(id);

    const progress = await getSearchProgress(id);
    if (!progress) return jsonError(404, 'Search not found');

    const kindsParam = url.searchParams.get('kinds');
    const kinds = kindsParam
      ? kindsParam
          .split(',')
          .map((entry) => entry.trim())
          .filter((entry): entry is 'job' | 'potential_employer' | 'candidate' =>
            ['job', 'potential_employer', 'candidate'].includes(entry),
          )
      : undefined;

    const results = await listSearchResults(id, {
      limit: Number(url.searchParams.get('limit') ?? 100),
      offset: Number(url.searchParams.get('offset') ?? 0),
      minScore: Number(url.searchParams.get('minScore') ?? 0),
      ...(kinds?.length ? { kinds } : {}),
    });

    return NextResponse.json(
      { progress, results },
      { headers: { 'cache-control': 'no-store' } },
    );
  } catch (error) {
    return handleRouteError(error, 'GET /api/search/[id]');
  }
}
