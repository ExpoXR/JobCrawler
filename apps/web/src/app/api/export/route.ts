import { exportSearchResults } from '@ejc/search';
import { exportRequestSchema } from '@ejc/shared';

import { clientKey, handleRouteError, rateLimit, tooManyRequests } from '@/lib/api';
import { assertSearchAccess } from '@/lib/auth';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Result export (plan section 31).
 *
 * A search run anonymously is still readable by anyone holding its id — that is
 * how the account-free product works. A search run while signed in belongs to
 * that account, so a shared URL no longer grants access to it.
 */
export async function GET(request: Request) {
  try {
    const limit = await rateLimit(clientKey(request, 'export'), 10, 60_000);
    if (!limit.allowed) return tooManyRequests(limit.retryAfterSeconds);

    const url = new URL(request.url);
    const parsed = exportRequestSchema.parse({
      searchId: url.searchParams.get('searchId') ?? '',
      format: url.searchParams.get('format') ?? 'csv',
    });

    await assertSearchAccess(parsed.searchId);

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
