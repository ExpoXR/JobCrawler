import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  decryptSecret,
  encryptSecret,
  isSecretStorageConfigured,
  secretLast4,
  SETTINGS_ENCRYPTION_KEY_ENV,
} from './secrets';

const key = { [SETTINGS_ENCRYPTION_KEY_ENV]: randomBytes(32).toString('base64') };
const otherKey = { [SETTINGS_ENCRYPTION_KEY_ENV]: randomBytes(32).toString('base64') };

describe('isSecretStorageConfigured', () => {
  it('reports whether a usable key is present', () => {
    expect(isSecretStorageConfigured(key)).toBe(true);
    expect(isSecretStorageConfigured({})).toBe(false);
  });

  it('treats a wrong-length key as unusable rather than throwing', () => {
    // Silently accepting a 16-byte key would weaken every stored secret.
    expect(isSecretStorageConfigured({ [SETTINGS_ENCRYPTION_KEY_ENV]: 'dG9vc2hvcnQ=' })).toBe(
      false,
    );
  });
});

describe('encryptSecret / decryptSecret', () => {
  it('round-trips a secret', () => {
    const secret = 'sk-proj-abc123def456';
    expect(decryptSecret(encryptSecret(secret, key), key)).toBe(secret);
  });

  it('round-trips non-ASCII', () => {
    const secret = 'schlüssel-🔐-ключ';
    expect(decryptSecret(encryptSecret(secret, key), key)).toBe(secret);
  });

  it('never contains the plaintext', () => {
    const payload = encryptSecret('sk-proj-abc123def456', key);
    expect(payload.toString('utf8')).not.toContain('sk-proj');
    expect(payload.toString('base64')).not.toContain('sk-proj');
  });

  it('produces a different payload every time', () => {
    // A fresh IV per encryption: identical keys must not be linkable by ciphertext.
    const a = encryptSecret('same secret', key);
    const b = encryptSecret('same secret', key);
    expect(a.equals(b)).toBe(false);
  });

  it('refuses to encrypt with no key configured, rather than storing plaintext', () => {
    expect(() => encryptSecret('sk-proj-abc', {})).toThrow(/SETTINGS_ENCRYPTION_KEY/);
  });

  it('refuses a key of the wrong length', () => {
    expect(() =>
      encryptSecret('sk-proj-abc', { [SETTINGS_ENCRYPTION_KEY_ENV]: 'dG9vc2hvcnQ=' }),
    ).toThrow(/32 bytes/);
  });

  it('fails to decrypt under a different key', () => {
    const payload = encryptSecret('sk-proj-abc123def456', key);
    expect(() => decryptSecret(payload, otherKey)).toThrow(/could not be decrypted/);
  });

  it('detects a tampered ciphertext', () => {
    const payload = encryptSecret('sk-proj-abc123def456', key);
    // Flip one bit in the ciphertext body; GCM's tag must catch it.
    payload[payload.length - 1] ^= 0x01;
    expect(() => decryptSecret(payload, key)).toThrow(/could not be decrypted/);
  });

  it('detects a tampered authentication tag', () => {
    const payload = encryptSecret('sk-proj-abc123def456', key);
    payload[14] ^= 0x01;
    expect(() => decryptSecret(payload, key)).toThrow(/could not be decrypted/);
  });

  it('rejects a truncated payload', () => {
    const payload = encryptSecret('sk-proj-abc123def456', key);
    expect(() => decryptSecret(payload.subarray(0, 10), key)).toThrow(/truncated/);
  });

  it('rejects an unknown format version', () => {
    const payload = encryptSecret('sk-proj-abc123def456', key);
    payload[0] = 99;
    expect(() => decryptSecret(payload, key)).toThrow(/format version/);
  });
});

describe('secretLast4', () => {
  it('shows the last four characters of a real key', () => {
    expect(secretLast4('sk-proj-abc123def456')).toBe('f456');
  });

  it('reveals nothing about a short secret', () => {
    // Four of seven characters would be most of it.
    expect(secretLast4('short')).toBe('');
    expect(secretLast4('')).toBe('');
  });
});
