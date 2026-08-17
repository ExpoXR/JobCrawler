import { describe, expect, it } from 'vitest';

import { loadConfig } from './config';
import { classifyError, errorTypeForStatus, isRetryable, publicErrorMessage, AppError } from './errors';
import { createLimiter, withRetry, withTimeout } from './async';

describe('loadConfig', () => {
  it('applies safe defaults for an empty environment', () => {
    const config = loadConfig({});
    expect(config.env).toBe('development');
    expect(config.crawler.respectRobots).toBe(true);
    // SSRF protection must never be off unless explicitly requested.
    expect(config.crawler.allowPrivateAddresses).toBe(false);
    expect(config.ai.provider).toBe('none');
    expect(config.admin.enabled).toBe(false);
  });

  it('coerces string booleans and numbers from the environment', () => {
    const config = loadConfig({
      CRAWL_RESPECT_ROBOTS: 'false',
      CRAWL_ALLOW_PRIVATE_ADDRESSES: 'true',
      CRAWL_MAX_PAGES_PER_DOMAIN: '7',
      CRAWL_BLOCKED_DOMAINS: 'Example.com, spam.test ',
      OVERPASS_FALLBACK_URLS: 'https://one.example/api, https://two.example/api ',
    });

    expect(config.crawler.respectRobots).toBe(false);
    expect(config.crawler.allowPrivateAddresses).toBe(true);
    expect(config.crawler.maxPagesPerDomain).toBe(7);
    expect(config.crawler.blockedDomains).toEqual(['example.com', 'spam.test']);
    expect(config.geo.overpassFallbackUrls).toEqual([
      'https://one.example/api',
      'https://two.example/api',
    ]);
  });

  it('enables the admin area only when a password is set', () => {
    expect(loadConfig({ ADMIN_PASSWORD: 'secret' }).admin.enabled).toBe(true);
  });

  it('rejects an out-of-range value instead of silently clamping', () => {
    expect(() =>
      loadConfig({ AI_TEMPERATURE: '9' }),
    ).toThrow(/Invalid environment configuration/);
  });

  it('rejects an unknown AI provider', () => {
    expect(() => loadConfig({ AI_PROVIDER: 'skynet' })).toThrow();
  });
});

describe('error classification', () => {
  it('maps HTTP statuses to error types', () => {
    expect(errorTypeForStatus(403)).toBe('forbidden');
    expect(errorTypeForStatus(404)).toBe('not_found');
    expect(errorTypeForStatus(429)).toBe('rate_limited');
    expect(errorTypeForStatus(500)).toBe('http_server');
    expect(errorTypeForStatus(418)).toBe('http_client');
  });

  it('treats transient failures as retryable and permanent ones as not', () => {
    expect(isRetryable(new AppError('timeout', 'x'))).toBe(true);
    expect(isRetryable(new AppError('rate_limited', 'x'))).toBe(true);
    expect(isRetryable(new AppError('not_found', 'x'))).toBe(false);
    expect(isRetryable(new AppError('blocked_by_robots', 'x'))).toBe(false);
  });

  it('classifies Node network errors', () => {
    const dnsError = Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' });
    expect(classifyError(dnsError)).toBe('dns');

    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
    expect(classifyError(abort)).toBe('timeout');
  });

  it('never leaks internal detail in a user-facing message', () => {
    const error = new AppError('unknown', 'postgres://user:pw@host/db failed');
    expect(publicErrorMessage(error)).not.toContain('postgres');
  });
});

describe('async helpers', () => {
  it('retries a retryable failure and then succeeds', async () => {
    let attempts = 0;
    const result = await withRetry(
      async () => {
        attempts += 1;
        if (attempts < 3) throw new AppError('timeout', 'flaky');
        return 'ok';
      },
      { retries: 3, baseDelayMs: 1 },
    );

    expect(result).toBe('ok');
    expect(attempts).toBe(3);
  });

  it('does not retry a permanent failure', async () => {
    let attempts = 0;
    await expect(
      withRetry(
        async () => {
          attempts += 1;
          throw new AppError('not_found', 'gone');
        },
        { retries: 3, baseDelayMs: 1 },
      ),
    ).rejects.toThrow('gone');

    expect(attempts).toBe(1);
  });

  it('enforces the timeout', async () => {
    await expect(
      withTimeout(new Promise((resolve) => setTimeout(resolve, 200)), 20, 'test'),
    ).rejects.toThrow(/timed out/);
  });

  it('never exceeds the configured concurrency', async () => {
    const limit = createLimiter(2);
    let active = 0;
    let peak = 0;

    await Promise.all(
      Array.from({ length: 10 }, () =>
        limit(async () => {
          active += 1;
          peak = Math.max(peak, active);
          await new Promise((resolve) => setTimeout(resolve, 5));
          active -= 1;
        }),
      ),
    );

    expect(peak).toBeLessThanOrEqual(2);
  });
});
