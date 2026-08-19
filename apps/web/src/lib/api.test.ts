import { AppError, resetConfigCache } from '@ejc/shared';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { assertSameOrigin, handleRouteError, readJsonBody } from './api';

describe('handleRouteError', () => {
  test('reports unavailable geocoding as an actionable 503', async () => {
    const response = handleRouteError(
      new AppError('provider_unavailable', 'All geocoding providers failed'),
      'POST /api/search',
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: 'Geocoding is temporarily unavailable. Please try again after the service is ready.',
      type: 'provider_unavailable',
    });
  });

  test('maps the authentication error types to their statuses', () => {
    expect(handleRouteError(new AppError('unauthenticated', 'x'), 'r').status).toBe(401);
    expect(handleRouteError(new AppError('forbidden', 'x'), 'r').status).toBe(403);
    expect(handleRouteError(new AppError('not_found', 'x'), 'r').status).toBe(404);
    expect(handleRouteError(new AppError('rate_limited', 'x'), 'r').status).toBe(429);
  });

  test('does not leak an unexpected error to the client', async () => {
    const response = handleRouteError(
      new Error('connect ECONNREFUSED postgres://user:hunter2@db:5432'),
      'GET /api/health',
    );

    expect(response.status).toBe(500);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe('Unexpected error');
    expect(JSON.stringify(body)).not.toContain('hunter2');
  });
});

describe('readJsonBody', () => {
  function post(body: string, headers: Record<string, string> = {}): Request {
    return new Request('https://example.test/api/x', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body,
    });
  }

  test('parses a JSON body', async () => {
    await expect(readJsonBody(post('{"a":1}'))).resolves.toEqual({ a: 1 });
  });

  test('treats an empty body as an empty object', async () => {
    await expect(readJsonBody(post('   '))).resolves.toEqual({});
  });

  test('rejects malformed JSON as a validation error, not a crash', async () => {
    await expect(readJsonBody(post('{not json'))).rejects.toMatchObject({ type: 'validation' });
  });

  test('refuses a body larger than the cap', async () => {
    await expect(readJsonBody(post('"' + 'x'.repeat(200) + '"'), 100)).rejects.toMatchObject({
      type: 'validation',
    });
  });

  test('refuses an oversized body on content-length alone, without reading it', async () => {
    // The declared length is the cheap check: it rejects before the body is
    // buffered into memory.
    await expect(
      readJsonBody(post('{}', { 'content-length': '999999999' }), 1000),
    ).rejects.toMatchObject({ type: 'validation' });
  });
});

describe('assertSameOrigin', () => {
  beforeEach(() => {
    process.env['PUBLIC_BASE_URL'] = 'https://jobs.example.test';
    resetConfigCache();
  });

  afterEach(() => {
    delete process.env['PUBLIC_BASE_URL'];
    resetConfigCache();
  });

  function post(headers: Record<string, string>): Request {
    return new Request('https://jobs.example.test/api/x', { method: 'POST', headers });
  }

  test('allows a request from the configured origin', () => {
    expect(() => assertSameOrigin(post({ origin: 'https://jobs.example.test' }))).not.toThrow();
  });

  test('rejects a request from somewhere else', () => {
    expect(() => assertSameOrigin(post({ origin: 'https://evil.example' }))).toThrow(
      /Cross-origin/,
    );
  });

  test('rejects a lookalike origin', () => {
    // Substring matching would let this through.
    expect(() =>
      assertSameOrigin(post({ origin: 'https://jobs.example.test.evil.example' })),
    ).toThrow(/Cross-origin/);
  });

  test('accepts an origin matching the Host the browser addressed', () => {
    // The deployment is published on :3005 but PUBLIC_BASE_URL names another
    // host; behind a port mapping `request.url` reports the internal address,
    // so the Host header is what has to be trusted here.
    expect(() =>
      assertSameOrigin(
        post({ origin: 'http://192.168.1.50:3005', host: '192.168.1.50:3005' }),
      ),
    ).not.toThrow();
  });

  test('still rejects when Origin and Host disagree', () => {
    expect(() =>
      assertSameOrigin(post({ origin: 'https://evil.example', host: '192.168.1.50:3005' })),
    ).toThrow(/Cross-origin/);
  });

  test('names the offending origin so a rejection is diagnosable', () => {
    // A bare "forbidden" here is indistinguishable from a missing admin role.
    expect(() => assertSameOrigin(post({ origin: 'https://evil.example' }))).toThrow(
      /evil\.example/,
    );
  });

  test('allows a request with no Origin header at all', () => {
    // curl and native clients send none, and CSRF needs a browser to exist.
    expect(() => assertSameOrigin(post({}))).not.toThrow();
  });
});
