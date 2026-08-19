import { randomBytes, scrypt, type ScryptOptions, timingSafeEqual } from 'node:crypto';

/**
 * Password hashing.
 *
 * scrypt from `node:crypto`, not a dependency: it is memory-hard, it is in the
 * standard library, and it keeps the supply-chain surface of the authentication
 * path at zero — the same reasoning that gives `packages/ai` hand-written HTTP
 * calls instead of vendor SDKs.
 *
 * Deliberately free of framework and database imports so it can be tested on its
 * own, without a request scope.
 */

/**
 * Promise wrapper around `crypto.scrypt`.
 *
 * Hand-rolled rather than `promisify`d: `scrypt` has no `__promisify__` overload
 * in the Node types, so `promisify` resolves to its four-argument form and the
 * `options` object — which is where the cost parameters live — has nowhere to
 * go. Wrapping it keeps them, and drops the `as Buffer` casts as a bonus.
 */
function deriveKey(
  password: string,
  salt: Buffer,
  keylen: number,
  options: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keylen, options, (error, derived) => {
      if (error) reject(error);
      else resolve(derived);
    });
  });
}

/**
 * N=2^15 with r=8 needs 32 MB per hash, so `maxmem` is raised explicitly — the
 * Node default sits exactly on that boundary.
 */
const SCRYPT_N = 32_768;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 32;
const SCRYPT_MAXMEM = 64 * 1024 * 1024;
const SALT_BYTES = 32;

/** Below this a password is not worth hashing. */
export const MIN_PASSWORD_LENGTH = 12;

/** `scrypt$N$r$p$salt$hash`, all base64. Self-describing so cost can change. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const derived = await deriveKey(password.normalize('NFKC'), salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAXMEM,
  });

  return [
    'scrypt',
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P,
    salt.toString('base64'),
    derived.toString('base64'),
  ].join('$');
}

/**
 * Constant-time verification against a stored hash.
 *
 * Returns false rather than throwing on a malformed record: a corrupt row must
 * deny access, not take the login route down with it.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  const salt = Buffer.from(parts[4] ?? '', 'base64');
  const expected = Buffer.from(parts[5] ?? '', 'base64');

  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  if (n <= 1 || r <= 0 || p <= 0) return false;
  if (salt.length === 0 || expected.length === 0) return false;

  try {
    const derived = await deriveKey(password.normalize('NFKC'), salt, expected.length, {
      N: n,
      r,
      p,
      maxmem: SCRYPT_MAXMEM,
    });
    return derived.length === expected.length && timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

/**
 * A structurally valid hash of a value nobody knows.
 *
 * The login path verifies against this when no account matches, so a missing
 * account costs the same time as a wrong password and the response cannot be
 * used to enumerate accounts.
 */
export const DUMMY_PASSWORD_HASH = [
  'scrypt',
  SCRYPT_N,
  SCRYPT_R,
  SCRYPT_P,
  Buffer.alloc(SALT_BYTES, 7).toString('base64'),
  Buffer.alloc(SCRYPT_KEYLEN, 11).toString('base64'),
].join('$');
