import { geocodeLocation } from '@ejc/search';
import { geocodeRequestSchema } from '@ejc/shared';
import { NextResponse } from 'next/server';

import { clientKey, handleRouteError, rateLimit, tooManyRequests } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Location autocomplete.
 *
 * Rate limited because it proxies Nominatim, whose usage policy we are
 * responsible for upholding on behalf of every visitor.
 */
export async function GET(request: Request) {
  try {
    const limit = await rateLimit(clientKey(request, 'geocode'), 20, 60_000);
    if (!limit.allowed) return tooManyRequests(limit.retryAfterSeconds);

    const url = new URL(request.url);
    const parsed = geocodeRequestSchema.parse({
      q: url.searchParams.get('q') ?? '',
      limit: url.searchParams.get('limit') ?? 5,
    });

    const results = await geocodeLocation(parsed.q);

    return NextResponse.json(
      { results: results.slice(0, parsed.limit) },
      { headers: { 'cache-control': 'private, max-age=300' } },
    );
  } catch (error) {
    return handleRouteError(error, 'GET /api/geocode');
  }
}
