import { createHash, randomBytes } from 'node:crypto';

import {
  countUsers,
  createSession,
  createUser,
  deleteSession,
  findSessionByTokenHash,
  getSearchOwner,
  getUserCredentialsByEmail,
  recordLogin,
  touchSession,
  type UserRecord,
  type UserRole,
} from '@ejc/database';
import { AppError, getConfig, getLogger } from '@ejc/shared';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

import {
  DUMMY_PASSWORD_HASH,
  hashPassword,
  MIN_PASSWORD_LENGTH,
  verifyPassword,
} from './password';

/**
 * Authentication: password hashing, sessions, and the guards routes use.
 *
 * Sessions are **opaque tokens, not JWTs**: revocation has to be immediate, and
 * deactivating an account or changing a password must end every session at once,
 * which a self-contained token cannot do.
 *
 * The database stores neither a password nor a usable token — only the scrypt
 * hash from `./password` and a SHA-256 of the cookie value.
 */

export const SESSION_COOKIE = 'ejc_session';

const SESSION_TOKEN_BYTES = 32;

/* --- Session tokens ------------------------------------------------------ */

function generateSessionToken(): string {
  return randomBytes(SESSION_TOKEN_BYTES).toString('base64url');
}

/** The database only ever sees this, never the cookie value. */
function hashToken(token: string): Buffer {
  return createHash('sha256').update(token).digest();
}

/**
 * A salted digest of the client address.
 *
 * Enough to notice a session being used from somewhere new; not an identifier
 * for a visitor, and not reversible to an address.
 */
function hashIp(ip: string | null): Buffer | undefined {
  if (!ip) return undefined;
  return createHash('sha256').update(`ejc:${ip}`).digest();
}

/* --- Session lifecycle --------------------------------------------------- */

function ttlMs(hours: number): number {
  return hours * 60 * 60 * 1000;
}

function isSecureDeployment(): boolean {
  return getConfig().web.baseUrl.startsWith('https://');
}

/**
 * Issues a session and sets its cookie.
 *
 * `httpOnly` puts it out of reach of script, `sameSite: 'lax'` stops it riding
 * along with a cross-site form post, and `secure` follows the deployment's own
 * base URL so local HTTP development still works.
 */
export async function startSession(
  user: UserRecord,
  meta: { ip?: string | null; userAgent?: string | null } = {},
): Promise<void> {
  const config = getConfig();
  const now = Date.now();
  const token = generateSessionToken();

  await createSession({
    userId: user.id,
    tokenHash: hashToken(token),
    expiresAt: new Date(now + ttlMs(config.auth.sessionTtlHours)),
    absoluteExpiresAt: new Date(now + ttlMs(config.auth.sessionAbsoluteTtlHours)),
    ipHash: hashIp(meta.ip ?? null),
    userAgent: meta.userAgent ?? undefined,
  });

  const store = await cookies();
  store.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: isSecureDeployment(),
    path: '/',
    maxAge: Math.floor(ttlMs(config.auth.sessionAbsoluteTtlHours) / 1000),
  });
}

/** Ends the current session everywhere: database row and cookie both go. */
export async function endSession(): Promise<void> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (token) await deleteSession(hashToken(token));
  store.delete(SESSION_COOKIE);
}

/**
 * Resolves the caller, or undefined when there is no valid session.
 *
 * Never throws: unauthenticated is a normal state for the public application.
 */
export async function getCurrentUser(): Promise<UserRecord | undefined> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (!token) return undefined;

  let found;
  try {
    found = await findSessionByTokenHash(hashToken(token));
  } catch (error) {
    // A database outage must not read as "signed in".
    getLogger('auth').error('Session lookup failed', {
      message: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
  if (!found) return undefined;

  // Slide the window, but only in the second half of its life — otherwise every
  // request becomes a write.
  const config = getConfig();
  const window = ttlMs(config.auth.sessionTtlHours);
  if (found.session.expiresAt.getTime() - Date.now() < window / 2) {
    await touchSession(found.session.id, new Date(Date.now() + window)).catch(() => undefined);
  }

  return found.user;
}

export async function requireUser(): Promise<UserRecord> {
  const user = await getCurrentUser();
  if (!user) throw new AppError('unauthenticated', 'Sign in to continue');
  return user;
}

export async function requireAdmin(): Promise<UserRecord> {
  const user = await requireUser();
  if (user.role !== 'admin') {
    throw new AppError('forbidden', 'This action requires an administrator account');
  }
  return user;
}

/**
 * Page-level equivalent of `requireAdmin`.
 *
 * Route handlers want a thrown error mapped to a status; a page wants a
 * redirect, because a 500 page is the wrong answer to "you are not signed in".
 */
export async function guardAdminPage(nextPath: string): Promise<UserRecord> {
  const user = await getCurrentUser();
  if (!user) redirect(`/login?next=${encodeURIComponent(nextPath)}`);
  if (user.role !== 'admin') redirect('/?denied=admin');
  return user;
}

/** True when the caller may act on a resource owned by `ownerId`. */
export function canAccessOwned(user: UserRecord | undefined, ownerId: string | null): boolean {
  if (ownerId === null) return true; // Anonymous resources stay public.
  if (!user) return false;
  return user.role === 'admin' || user.id === ownerId;
}

/**
 * Guards a search's results and export.
 *
 * A search made while signed out stays readable by anyone holding its id — that
 * is how the anonymous product works. A search made while signed in belongs to
 * that account, so a leaked URL is no longer enough.
 *
 * A search that does not exist and a search belonging to someone else fail
 * identically — same status, same message. Distinguishing them would turn this
 * endpoint into an oracle for which search ids exist.
 */
export async function assertSearchAccess(searchId: string): Promise<void> {
  const owner = await getSearchOwner(searchId);
  if (!owner.found) throw new AppError('not_found', 'No such search');
  if (owner.userId === null) return;

  const user = await getCurrentUser();
  if (!canAccessOwned(user, owner.userId)) {
    throw new AppError('not_found', 'No such search');
  }
}

/* --- Login --------------------------------------------------------------- */

export interface LoginResult {
  user: UserRecord;
}

/**
 * Verifies credentials.
 *
 * Every failure returns the same error regardless of cause, so the response
 * cannot be used to enumerate accounts. A missing account still pays the cost of
 * a hash comparison, so timing cannot either.
 */
export async function authenticate(email: string, password: string): Promise<LoginResult> {
  const found = await getUserCredentialsByEmail(email);

  if (!found) {
    await verifyPassword(password, DUMMY_PASSWORD_HASH);
    throw new AppError('unauthenticated', 'Incorrect email or password');
  }

  const ok = await verifyPassword(password, found.passwordHash);
  if (!ok || !found.user.isActive) {
    throw new AppError('unauthenticated', 'Incorrect email or password');
  }

  await recordLogin(found.user.id);
  return { user: found.user };
}

/* --- Bootstrap ----------------------------------------------------------- */

/**
 * Seeds the first administrator from `ADMIN_EMAIL` / `ADMIN_PASSWORD`, once.
 *
 * Only ever runs against an empty users table, so it cannot resurrect or
 * overwrite an account that an operator has since changed.
 */
export async function ensureBootstrapAdmin(): Promise<UserRecord | undefined> {
  const config = getConfig();
  const logger = getLogger('auth');

  if (!config.admin.email || !config.admin.password) return undefined;
  if ((await countUsers()) > 0) return undefined;

  if (config.admin.password.length < MIN_PASSWORD_LENGTH) {
    logger.warn('Refusing to seed the bootstrap administrator: ADMIN_PASSWORD is too short', {
      minimum: MIN_PASSWORD_LENGTH,
    });
    return undefined;
  }

  const user = await createUser({
    email: config.admin.email,
    passwordHash: await hashPassword(config.admin.password),
    role: 'admin',
  });

  logger.warn('Seeded the bootstrap administrator from the environment', {
    email: user.email,
    action: 'Change this password, then clear ADMIN_PASSWORD from the environment',
  });

  return user;
}

export { hashPassword, MIN_PASSWORD_LENGTH, verifyPassword } from './password';
export type { UserRecord, UserRole };
