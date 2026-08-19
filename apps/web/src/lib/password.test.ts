import { describe, expect, it } from 'vitest';

import { DUMMY_PASSWORD_HASH, hashPassword, MIN_PASSWORD_LENGTH, verifyPassword } from './password';

/**
 * Password primitives only. Session handling needs `cookies()` from a request
 * scope and a database, so it belongs in an integration test rather than here —
 * which is exactly why these functions live in a module with no framework or
 * database imports.
 */

describe('hashPassword', () => {
  it('produces a self-describing scrypt record', async () => {
    const hash = await hashPassword('correct horse battery staple');
    const parts = hash.split('$');

    expect(parts).toHaveLength(6);
    expect(parts[0]).toBe('scrypt');
    // Cost parameters travel with the hash so they can be raised later without
    // invalidating everything already stored.
    expect(Number(parts[1])).toBeGreaterThanOrEqual(16_384);
    expect(Number(parts[2])).toBeGreaterThan(0);
    expect(Number(parts[3])).toBeGreaterThan(0);
  });

  it('never contains the password', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(hash).not.toContain('correct');
  });

  it('salts, so the same password hashes differently every time', async () => {
    const [a, b] = await Promise.all([hashPassword('same password'), hashPassword('same password')]);
    expect(a).not.toBe(b);
  });
});

describe('verifyPassword', () => {
  it('accepts the right password', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(await verifyPassword('correct horse battery staple', hash)).toBe(true);
  });

  it('rejects the wrong password', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(await verifyPassword('Correct horse battery staple', hash)).toBe(false);
    expect(await verifyPassword('', hash)).toBe(false);
  });

  it('normalises unicode, so an equivalent password still verifies', async () => {
    // "café" composed vs decomposed: the same password to a human typing it.
    const hash = await hashPassword('café password');
    expect(await verifyPassword('café password', hash)).toBe(true);
  });

  it('rejects a malformed record instead of throwing', async () => {
    // A corrupt row must deny access, not take the login route down with it.
    for (const record of [
      '',
      'not-a-hash',
      'scrypt$1$2$3',
      'bcrypt$32768$8$1$c2FsdA==$aGFzaA==',
      'scrypt$notanumber$8$1$c2FsdA==$aGFzaA==',
      'scrypt$32768$8$1$$',
    ]) {
      expect(await verifyPassword('anything', record)).toBe(false);
    }
  });
});

describe('MIN_PASSWORD_LENGTH', () => {
  it('is long enough to be worth hashing', () => {
    expect(MIN_PASSWORD_LENGTH).toBeGreaterThanOrEqual(12);
  });
});

describe('DUMMY_PASSWORD_HASH', () => {
  it('is well formed, so the no-such-account path really does hash', async () => {
    // If this were malformed, verifyPassword would bail early and the login
    // route would answer faster for an unknown email than a known one.
    expect(await verifyPassword('anything at all', DUMMY_PASSWORD_HASH)).toBe(false);
    expect(DUMMY_PASSWORD_HASH.split('$')).toHaveLength(6);
    expect(DUMMY_PASSWORD_HASH.startsWith('scrypt$')).toBe(true);
  });
});
