import { NextResponse } from 'next/server';

import {
  assertSameOrigin,
  clientKey,
  handleRouteError,
  rateLimit,
  tooManyRequests,
} from '@/lib/api';
import { endSession } from '@/lib/auth';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Ends the session: the database row is deleted, not merely the cookie. */
export async function POST(request: Request) {
  try {
    const limit = await rateLimit(clientKey(request, 'logout'), 30, 60_000);
    if (!limit.allowed) return tooManyRequests(limit.retryAfterSeconds);
    assertSameOrigin(request);
    await endSession();
    return NextResponse.json({ ok: true });
  } catch (error) {
    return handleRouteError(error, 'POST /api/auth/logout');
  }
}
