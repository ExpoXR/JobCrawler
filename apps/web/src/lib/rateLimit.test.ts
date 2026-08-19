import { beforeEach, describe, expect, it } from 'vitest';

import { clientAddress, rateLimitInMemory, resetInMemoryBuckets } from './rateLimit';

/**
 * The Redis path needs a live server, so these cover the fallback limiter and
 * the client-identity logic. The latter is the security-relevant half: getting
 * it wrong makes every limit trivially bypassable.
 */

beforeEach(() => {
  resetInMemoryBuckets();
});

describe('rateLimitInMemory', () => {
  it('allows requests up to the limit and refuses the next', () => {
    for (let i = 0; i < 3; i += 1) {
      expect(rateLimitInMemory('k', 3, 60_000).allowed).toBe(true);
    }
    const blocked = rateLimitInMemory('k', 3, 60_000);
    expect(blocked.allowed).toBe(false);
    expect(blocked.remaining).toBe(0);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('counts down the remaining budget', () => {
    expect(rateLimitInMemory('k', 3, 60_000).remaining).toBe(2);
    expect(rateLimitInMemory('k', 3, 60_000).remaining).toBe(1);
    expect(rateLimitInMemory('k', 3, 60_000).remaining).toBe(0);
  });

  it('keeps separate keys separate', () => {
    rateLimitInMemory('a', 1, 60_000);
    expect(rateLimitInMemory('a', 1, 60_000).allowed).toBe(false);
    // A different client must not inherit someone else's exhausted budget.
    expect(rateLimitInMemory('b', 1, 60_000).allowed).toBe(true);
  });

  it('starts a fresh window once the old one has passed', () => {
    expect(rateLimitInMemory('k', 1, 1).allowed).toBe(true);
    expect(rateLimitInMemory('k', 1, 1).allowed).toBe(false);

    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(rateLimitInMemory('k', 1, 1).allowed).toBe(true);
        resolve();
      }, 5);
    });
  });
});

function requestWith(headers: Record<string, string>): Request {
  return new Request('https://example.test/api/search', { headers });
}

describe('clientAddress', () => {
  it('ignores x-forwarded-for when no proxy is configured', () => {
    // Otherwise any client could spoof an address and get a fresh budget.
    const request = requestWith({ 'x-forwarded-for': '1.2.3.4' });
    expect(clientAddress(request, 0)).toBeUndefined();
  });

  it('falls back to x-real-ip when no proxy is configured', () => {
    const request = requestWith({ 'x-real-ip': '9.9.9.9' });
    expect(clientAddress(request, 0)).toBe('9.9.9.9');
  });

  it('takes the hop the trusted proxy wrote, not the one the client claims', () => {
    // The client sent "1.1.1.1"; our single proxy appended the real address.
    const request = requestWith({ 'x-forwarded-for': '1.1.1.1, 203.0.113.7' });
    expect(clientAddress(request, 1)).toBe('203.0.113.7');
  });

  it('counts hops from the right', () => {
    const request = requestWith({
      'x-forwarded-for': 'spoofed, 203.0.113.7, 10.0.0.1',
    });
    expect(clientAddress(request, 1)).toBe('10.0.0.1');
    expect(clientAddress(request, 2)).toBe('203.0.113.7');
  });

  it('does not fall off the front of a shorter chain than expected', () => {
    const request = requestWith({ 'x-forwarded-for': '203.0.113.7' });
    expect(clientAddress(request, 3)).toBe('203.0.113.7');
  });

  it('returns undefined when there is nothing to go on', () => {
    expect(clientAddress(requestWith({}), 1)).toBeUndefined();
    expect(clientAddress(requestWith({ 'x-forwarded-for': '  ,  ' }), 1)).toBeUndefined();
  });
});
