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
import { authenticate, ensureBootstrapAdmin, startSession } from '@/lib/auth';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const loginSchema = z.object({
  email: z.string().trim().min(3).max(320),
  password: z.string().min(1).max(1024),
});

/**
 * Signs a user in.
 *
 * Rate limited twice over: by address, and — inside `authenticate` — by making
 * every outcome cost the same, so neither the response nor its timing reveals
 * whether an account exists.
 */
export async function POST(request: Request) {
  try {
    assertSameOrigin(request);

    const limit = await rateLimit(clientKey(request, 'login'), 5, 60_000);
    if (!limit.allowed) return tooManyRequests(limit.retryAfterSeconds);

    const body = loginSchema.parse(await readJsonBody(request));

    // First run of a fresh deployment: seed the operator's account from the
    // environment so there is something to sign in as. No-op thereafter.
    await ensureBootstrapAdmin();

    const { user } = await authenticate(body.email, body.password);

    await startSession(user, {
      ip: request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
      userAgent: request.headers.get('user-agent'),
    });

    return NextResponse.json({ user: { email: user.email, role: user.role } });
  } catch (error) {
    return handleRouteError(error, 'POST /api/auth/login');
  }
}
