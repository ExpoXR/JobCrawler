import { exportSearchResults } from '@ejc/search';
import { exportRequestSchema } from '@ejc/shared';

import { clientKey, handleRouteError, rateLimit, tooManyRequests } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Result export (plan section 31). No account needed; the search id is the
 * only credential, and search sessions expire on their own.
 */
export async function GET(request: Request) {
  try {
    const limit = rateLimit(clientKey(request, 'export'), 10, 60_000);
    if (!limit.allowed) return tooManyRequests(limit.retryAfterSeconds);

    const url = new URL(request.url);
    const parsed = exportRequestSchema.parse({
      searchId: url.searchParams.get('searchId') ?? '',
      format: url.searchParams.get('format') ?? 'csv',
    });

    const payload = await exportSearchResults(parsed.searchId, parsed.format);

    return new Response(payload.body, {
      headers: {
        'content-type': payload.contentType,
        'content-disposition': `attachment; filename="${payload.filename}"`,
        'cache-control': 'no-store',
      },
    });
  } catch (error) {
    return handleRouteError(error, 'GET /api/export');
  }
}
