import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

import { AppError } from './errors';

/**
 * Authenticated encryption for secrets held in the database.
 *
 * Until now the rule was absolute: the database never holds an API key, only the
 * *name* of an environment variable (`provider_settings.secret_ref`). Letting an
 * administrator paste a key into the dashboard relaxes that, so the relaxation
 * is made as narrow as possible:
 *
 * - **AES-256-GCM**, so a tampered ciphertext fails to decrypt rather than
 *   decrypting to something attacker-chosen.
 * - **The key lives only in the environment** (`SETTINGS_ENCRYPTION_KEY`). A
 *   database dump on its own is therefore useless, which is the property the
 *   original rule existed to protect.
 * - **Fail closed.** With no key configured, storing a secret is refused
 *   outright rather than falling back to plaintext.
 *
 * The env-var indirection stays available and remains the better option for
 * deployments that can manage it.
 */

const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** Lets the payload format change later without guessing at old rows. */
const FORMAT_VERSION = 1;

export const SETTINGS_ENCRYPTION_KEY_ENV = 'SETTINGS_ENCRYPTION_KEY';

/**
 * Reads and validates the key.
 *
 * Not cached: the cost is negligible next to the cipher, and re-reading means a
 * rotated key takes effect on the next call rather than on the next restart.
 */
function readKey(source: Record<string, string | undefined>): Buffer | undefined {
  const raw = source[SETTINGS_ENCRYPTION_KEY_ENV];
  if (!raw) return undefined;

  const key = Buffer.from(raw.trim(), 'base64');
  if (key.length !== KEY_BYTES) {
    throw new AppError(
      'not_configured',
      `${SETTINGS_ENCRYPTION_KEY_ENV} must be ${KEY_BYTES} bytes of base64 ` +
        `(generate one with: openssl rand -base64 32)`,
    );
  }
  return key;
}

export function isSecretStorageConfigured(
  source: Record<string, string | undefined> = process.env,
): boolean {
  try {
    return readKey(source) !== undefined;
  } catch {
    // A malformed key is not a usable one.
    return false;
  }
}

function requireKey(source: Record<string, string | undefined>): Buffer {
  const key = readKey(source);
  if (!key) {
    throw new AppError(
      'not_configured',
      `${SETTINGS_ENCRYPTION_KEY_ENV} is not set, so secrets cannot be stored. ` +
        `Set it, or configure the provider through an environment variable instead.`,
    );
  }
  return key;
}

/** `version || iv || tag || ciphertext`, ready for a BYTEA column. */
export function encryptSecret(
  plaintext: string,
  source: Record<string, string | undefined> = process.env,
): Buffer {
  const key = requireKey(source);
  const iv = randomBytes(IV_BYTES);

  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);

  return Buffer.concat([Buffer.from([FORMAT_VERSION]), iv, cipher.getAuthTag(), ciphertext]);
}

/**
 * Reverses `encryptSecret`.
 *
 * Throws on a wrong key, a truncated payload or a modified one — GCM's tag makes
 * all three indistinguishable, which is the point.
 */
export function decryptSecret(
  payload: Buffer,
  source: Record<string, string | undefined> = process.env,
): string {
  const key = requireKey(source);

  if (payload.length < 1 + IV_BYTES + TAG_BYTES) {
    throw new AppError('validation', 'Stored secret is truncated');
  }
  if (payload[0] !== FORMAT_VERSION) {
    throw new AppError('validation', `Unsupported secret format version ${String(payload[0])}`);
  }

  const iv = payload.subarray(1, 1 + IV_BYTES);
  const tag = payload.subarray(1 + IV_BYTES, 1 + IV_BYTES + TAG_BYTES);
  const ciphertext = payload.subarray(1 + IV_BYTES + TAG_BYTES);

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);

  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    // Never echo the cause: it would distinguish "wrong key" from "tampered".
    throw new AppError(
      'validation',
      'Stored secret could not be decrypted. Has SETTINGS_ENCRYPTION_KEY changed?',
    );
  }
}

/**
 * The last few characters of a secret, for confirming *which* key is stored
 * without revealing it. Short secrets yield nothing rather than most of
 * themselves.
 */
export function secretLast4(plaintext: string): string {
  return plaintext.length >= 8 ? plaintext.slice(-4) : '';
}
