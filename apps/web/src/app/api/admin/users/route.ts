import {
  countAdmins,
  createUser,
  deleteSessionsForUser,
  deleteUser,
  getUserByEmail,
  getUserById,
  listUsers,
  setUserActive,
  setUserPasswordHash,
  setUserRole,
} from '@ejc/database';
import { AppError } from '@ejc/shared';
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
import { hashPassword, MIN_PASSWORD_LENGTH, requireAdmin } from '@/lib/auth';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const createSchema = z.object({
  email: z.string().trim().min(3).max(320).refine((value) => value.includes('@'), {
    message: 'Must be an email address',
  }),
  password: z.string().min(MIN_PASSWORD_LENGTH).max(1024),
  role: z.enum(['admin', 'user']).default('user'),
});

const updateSchema = z.object({
  id: z.uuid(),
  role: z.enum(['admin', 'user']).optional(),
  isActive: z.boolean().optional(),
  password: z.string().min(MIN_PASSWORD_LENGTH).max(1024).optional(),
});

const deleteSchema = z.object({ id: z.uuid() });

/**
 * Account administration.
 *
 * Password hashes never leave the database layer, so no response here can carry
 * one — `listUsers` does not select the column at all.
 */
export async function GET(request: Request) {
  try {
    const limit = await rateLimit(clientKey(request, 'admin'), 60, 60_000);
    if (!limit.allowed) return tooManyRequests(limit.retryAfterSeconds);
    await requireAdmin();
    return NextResponse.json({ users: await listUsers() });
  } catch (error) {
    return handleRouteError(error, 'GET /api/admin/users');
  }
}

export async function POST(request: Request) {
  try {
    const limit = await rateLimit(clientKey(request, 'admin'), 60, 60_000);
    if (!limit.allowed) return tooManyRequests(limit.retryAfterSeconds);
    assertSameOrigin(request);
    await requireAdmin();

    const body = createSchema.parse(await readJsonBody(request));

    if (await getUserByEmail(body.email)) {
      throw new AppError('validation', 'An account with that email already exists');
    }

    const user = await createUser({
      email: body.email,
      passwordHash: await hashPassword(body.password),
      role: body.role,
    });

    return NextResponse.json({ user }, { status: 201 });
  } catch (error) {
    return handleRouteError(error, 'POST /api/admin/users');
  }
}

export async function PATCH(request: Request) {
  try {
    const limit = await rateLimit(clientKey(request, 'admin'), 60, 60_000);
    if (!limit.allowed) return tooManyRequests(limit.retryAfterSeconds);
    assertSameOrigin(request);
    const actor = await requireAdmin();

    const body = updateSchema.parse(await readJsonBody(request));
    const target = await getUserById(body.id);
    if (!target) throw new AppError('validation', 'No such account');

    // Losing the last administrator would lock everyone out of the dashboard
    // permanently, so demoting or deactivating one is refused rather than
    // recovered from.
    const losesAdmin =
      target.role === 'admin' && (body.role === 'user' || body.isActive === false);
    if (losesAdmin && (await countAdmins()) <= 1) {
      throw new AppError('validation', 'This is the only active administrator');
    }

    if (body.role !== undefined) await setUserRole(target.id, body.role);
    if (body.isActive !== undefined) await setUserActive(target.id, body.isActive);

    if (body.password !== undefined) {
      await setUserPasswordHash(target.id, await hashPassword(body.password));
    }

    // A changed password, a revoked role or a deactivated account must end the
    // sessions that were opened under the old state — including the actor's own
    // if they just changed their own password.
    if (body.password !== undefined || body.role !== undefined || body.isActive === false) {
      await deleteSessionsForUser(target.id);
    }

    return NextResponse.json({ user: await getUserById(target.id), actor: actor.email });
  } catch (error) {
    return handleRouteError(error, 'PATCH /api/admin/users');
  }
}

export async function DELETE(request: Request) {
  try {
    const limit = await rateLimit(clientKey(request, 'admin'), 60, 60_000);
    if (!limit.allowed) return tooManyRequests(limit.retryAfterSeconds);
    assertSameOrigin(request);
    const actor = await requireAdmin();

    const body = deleteSchema.parse(await readJsonBody(request));
    if (body.id === actor.id) {
      throw new AppError('validation', 'You cannot delete your own account');
    }

    const target = await getUserById(body.id);
    if (!target) return NextResponse.json({ ok: true });

    if (target.role === 'admin' && (await countAdmins()) <= 1) {
      throw new AppError('validation', 'This is the only active administrator');
    }

    await deleteUser(target.id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return handleRouteError(error, 'DELETE /api/admin/users');
  }
}
