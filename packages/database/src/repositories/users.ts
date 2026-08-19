import { query, queryOne, queryRows } from '../pool';

/**
 * Accounts and sessions.
 *
 * This module holds the SQL only. Password hashing and session-token generation
 * are deliberately *not* here: they are cryptographic concerns, and keeping them
 * out means this file never sees a plaintext password or a usable token — it
 * stores the derived values it is handed.
 */

export type UserRole = 'admin' | 'user';

export interface UserRecord {
  id: string;
  email: string;
  role: UserRole;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
  lastLoginAt: Date | null;
}

interface UserRow {
  id: string;
  email: string;
  role: UserRole;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
  last_login_at: Date | null;
}

const USER_COLUMNS = `id, email, role, is_active, created_at, updated_at, last_login_at`;

function mapUserRow(row: UserRow): UserRecord {
  return {
    id: row.id,
    email: row.email,
    role: row.role,
    isActive: row.is_active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastLoginAt: row.last_login_at,
  };
}

export interface CreateUserInput {
  email: string;
  passwordHash: string;
  role?: UserRole;
}

export async function createUser(input: CreateUserInput): Promise<UserRecord> {
  const row = await queryOne<UserRow>(
    `INSERT INTO users (email, password_hash, role)
     VALUES ($1, $2, $3)
     RETURNING ${USER_COLUMNS}`,
    [input.email.trim(), input.passwordHash, input.role ?? 'user'],
  );
  if (!row) throw new Error('User insert returned no row');
  return mapUserRow(row);
}

export async function getUserById(id: string): Promise<UserRecord | undefined> {
  const row = await queryOne<UserRow>(`SELECT ${USER_COLUMNS} FROM users WHERE id = $1`, [id]);
  return row ? mapUserRow(row) : undefined;
}

/**
 * Looks up an account *with* its password hash, for the login path only.
 *
 * Separate from `getUserByEmail` so the hash is never fetched by accident: any
 * call site holding this result is, by construction, doing authentication.
 */
export async function getUserCredentialsByEmail(
  email: string,
): Promise<{ user: UserRecord; passwordHash: string } | undefined> {
  const row = await queryOne<UserRow & { password_hash: string }>(
    `SELECT ${USER_COLUMNS}, password_hash FROM users WHERE lower(email) = lower($1)`,
    [email.trim()],
  );
  return row ? { user: mapUserRow(row), passwordHash: row.password_hash } : undefined;
}

export async function getUserByEmail(email: string): Promise<UserRecord | undefined> {
  const row = await queryOne<UserRow>(
    `SELECT ${USER_COLUMNS} FROM users WHERE lower(email) = lower($1)`,
    [email.trim()],
  );
  return row ? mapUserRow(row) : undefined;
}

export async function listUsers(): Promise<UserRecord[]> {
  const rows = await queryRows<UserRow>(`SELECT ${USER_COLUMNS} FROM users ORDER BY created_at`);
  return rows.map(mapUserRow);
}

export async function countUsers(): Promise<number> {
  const row = await queryOne<{ count: string }>(`SELECT count(*)::text AS count FROM users`);
  return Number(row?.count ?? 0);
}

export async function countAdmins(): Promise<number> {
  const row = await queryOne<{ count: string }>(
    `SELECT count(*)::text AS count FROM users WHERE role = 'admin' AND is_active`,
  );
  return Number(row?.count ?? 0);
}

export async function setUserRole(id: string, role: UserRole): Promise<void> {
  await query(`UPDATE users SET role = $2 WHERE id = $1`, [id, role]);
}

export async function setUserActive(id: string, isActive: boolean): Promise<void> {
  await query(`UPDATE users SET is_active = $2 WHERE id = $1`, [id, isActive]);
}

export async function setUserPasswordHash(id: string, passwordHash: string): Promise<void> {
  await query(`UPDATE users SET password_hash = $2 WHERE id = $1`, [id, passwordHash]);
}

export async function recordLogin(id: string): Promise<void> {
  await query(`UPDATE users SET last_login_at = now() WHERE id = $1`, [id]);
}

export async function deleteUser(id: string): Promise<void> {
  await query(`DELETE FROM users WHERE id = $1`, [id]);
}

/* --- Sessions ----------------------------------------------------------- */

export interface SessionRecord {
  id: string;
  userId: string;
  createdAt: Date;
  lastSeenAt: Date;
  expiresAt: Date;
  absoluteExpiresAt: Date;
}

export interface CreateSessionInput {
  userId: string;
  /** SHA-256 of the cookie value. The value itself must not reach this module. */
  tokenHash: Buffer;
  expiresAt: Date;
  absoluteExpiresAt: Date;
  ipHash?: Buffer | undefined;
  userAgent?: string | undefined;
}

export async function createSession(input: CreateSessionInput): Promise<SessionRecord> {
  const row = await queryOne<{
    id: string;
    user_id: string;
    created_at: Date;
    last_seen_at: Date;
    expires_at: Date;
    absolute_expires_at: Date;
  }>(
    `INSERT INTO sessions (user_id, token_hash, expires_at, absolute_expires_at, ip_hash, user_agent)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, user_id, created_at, last_seen_at, expires_at, absolute_expires_at`,
    [
      input.userId,
      input.tokenHash,
      input.expiresAt,
      input.absoluteExpiresAt,
      input.ipHash ?? null,
      input.userAgent?.slice(0, 400) ?? null,
    ],
  );
  if (!row) throw new Error('Session insert returned no row');
  return {
    id: row.id,
    userId: row.user_id,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    expiresAt: row.expires_at,
    absoluteExpiresAt: row.absolute_expires_at,
  };
}

export interface AuthenticatedSession {
  session: SessionRecord;
  user: UserRecord;
}

/**
 * Resolves a session token hash to its account.
 *
 * Expired and deactivated accounts return nothing, so a session cannot outlive
 * either its window or the account behind it.
 */
export async function findSessionByTokenHash(
  tokenHash: Buffer,
): Promise<AuthenticatedSession | undefined> {
  const row = await queryOne<
    UserRow & {
      session_id: string;
      session_created_at: Date;
      last_seen_at: Date;
      expires_at: Date;
      absolute_expires_at: Date;
    }
  >(
    `SELECT s.id AS session_id,
            s.created_at AS session_created_at,
            s.last_seen_at, s.expires_at, s.absolute_expires_at,
            u.id, u.email, u.role, u.is_active,
            u.created_at, u.updated_at, u.last_login_at
     FROM sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = $1
       AND s.expires_at > now()
       AND s.absolute_expires_at > now()
       AND u.is_active`,
    [tokenHash],
  );
  if (!row) return undefined;

  return {
    session: {
      id: row.session_id,
      userId: row.id,
      createdAt: row.session_created_at,
      lastSeenAt: row.last_seen_at,
      expiresAt: row.expires_at,
      absoluteExpiresAt: row.absolute_expires_at,
    },
    user: mapUserRow(row),
  };
}

/**
 * Extends the sliding window, never past the absolute cap.
 */
export async function touchSession(id: string, expiresAt: Date): Promise<void> {
  await query(
    `UPDATE sessions
     SET last_seen_at = now(),
         expires_at = LEAST($2::timestamptz, absolute_expires_at)
     WHERE id = $1`,
    [id, expiresAt],
  );
}

export async function deleteSession(tokenHash: Buffer): Promise<void> {
  await query(`DELETE FROM sessions WHERE token_hash = $1`, [tokenHash]);
}

/** Used on password change and on deactivation: every other session dies. */
export async function deleteSessionsForUser(userId: string): Promise<number> {
  const result = await query(`DELETE FROM sessions WHERE user_id = $1`, [userId]);
  return result.rowCount ?? 0;
}

export async function deleteExpiredSessions(): Promise<number> {
  const result = await query(
    `DELETE FROM sessions WHERE expires_at <= now() OR absolute_expires_at <= now()`,
  );
  return result.rowCount ?? 0;
}
