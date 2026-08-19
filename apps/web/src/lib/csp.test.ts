import { describe, expect, it } from 'vitest';

import { buildCsp, cspHeaderName, tileOriginFrom } from './csp';

function directives(policy: string): Map<string, string[]> {
  return new Map(
    policy.split('; ').map((entry) => {
      const [name, ...values] = entry.split(' ');
      return [name ?? '', values];
    }),
  );
}

describe('buildCsp', () => {
  const policy = buildCsp({ nonce: 'abc123' });
  const parsed = directives(policy);

  it('carries the nonce and strict-dynamic', () => {
    expect(parsed.get('script-src')).toContain("'nonce-abc123'");
    expect(parsed.get('script-src')).toContain("'strict-dynamic'");
  });

  it('locks down the directives that make XSS useful', () => {
    expect(parsed.get('object-src')).toEqual(["'none'"]);
    expect(parsed.get('base-uri')).toEqual(["'none'"]);
    expect(parsed.get('frame-ancestors')).toEqual(["'none'"]);
    expect(parsed.get('form-action')).toEqual(["'self'"]);
  });

  it('never allows unsafe-eval outside development', () => {
    expect(policy).not.toContain("'unsafe-eval'");
    expect(buildCsp({ nonce: 'x', development: true })).toContain("'unsafe-eval'");
  });

  it('never allows unsafe-inline in script-src', () => {
    // style-src needs it — MapLibre and Next both inject style elements — but a
    // script-src with unsafe-inline would make the whole policy decorative.
    expect(parsed.get('script-src')).not.toContain("'unsafe-inline'");
    expect(parsed.get('style-src')).toContain("'unsafe-inline'");
  });

  it('allows the blob worker MapLibre needs', () => {
    expect(parsed.get('worker-src')).toContain('blob:');
  });

  it('admits a configured tile server to img-src and connect-src only', () => {
    const withTile = directives(
      buildCsp({ nonce: 'x', tileOrigin: 'https://tiles.example.test' }),
    );
    expect(withTile.get('img-src')).toContain('https://tiles.example.test');
    expect(withTile.get('connect-src')).toContain('https://tiles.example.test');
    expect(withTile.get('script-src')).not.toContain('https://tiles.example.test');
  });
});

describe('tileOriginFrom', () => {
  it('strips the tile placeholders before parsing', () => {
    expect(tileOriginFrom('https://tile.openstreetmap.org/{z}/{x}/{y}.png')).toBe(
      'https://tile.openstreetmap.org',
    );
  });

  it('returns only the origin, never a path', () => {
    expect(tileOriginFrom('https://a.example.test/styles/v1/{z}/{x}/{y}@2x.png')).toBe(
      'https://a.example.test',
    );
  });

  it('refuses anything unparseable rather than widening the policy', () => {
    expect(tileOriginFrom(undefined)).toBeUndefined();
    expect(tileOriginFrom('')).toBeUndefined();
    expect(tileOriginFrom('not a url')).toBeUndefined();
    expect(tileOriginFrom('javascript:alert(1)')).toBeUndefined();
    expect(tileOriginFrom('data:image/png;base64,AAAA')).toBeUndefined();
  });
});

describe('cspHeaderName', () => {
  it('maps each mode to the right header', () => {
    expect(cspHeaderName('enforce')).toBe('Content-Security-Policy');
    expect(cspHeaderName('report-only')).toBe('Content-Security-Policy-Report-Only');
    expect(cspHeaderName('off')).toBeUndefined();
  });
});
