import { getSearchProgress, listSearchResults } from '@ejc/database';
import { z } from 'zod';
import { NextResponse } from 'next/server';

import { handleRouteError, jsonError } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const paramsSchema = z.object({ id: z.uuid() });

/** Returns a search's current progress together with its results so far. */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = paramsSchema.parse(await context.params);
    const url = new URL(request.url);

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
