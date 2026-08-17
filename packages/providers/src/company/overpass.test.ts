import { afterEach, describe, expect, test, vi } from 'vitest';

import { resetConfigCache } from '@ejc/shared';

import { OverpassProvider } from './overpass';

describe('OverpassProvider.buildQuery', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    resetConfigCache();
  });

  test('uses one valid radius filter per employer clause', () => {
    const query = new OverpassProvider().buildQuery({ lat: 47.7267063, lon: 10.3168835 }, 1, 25);

    expect(query.match(/\(around:1000,47\.7267063,10\.3168835\)/g)).toHaveLength(5);
    expect(query).not.toMatch(/\)\(-?\d/);
    expect(query).toContain('out center 25;');
  });

  test('uses the configured fallback after a transient primary failure', async () => {
    vi.stubEnv('OVERPASS_BASE_URL', 'https://primary.example/api');
    vi.stubEnv('OVERPASS_FALLBACK_URLS', 'https://fallback.example/api');
    vi.stubEnv('CRAWLER_USER_AGENT', 'ExpoXR-Research/0.1');
    resetConfigCache();

    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('', { status: 504 }))
      .mockResolvedValueOnce(
        Response.json({
          elements: [
            {
              type: 'node',
              id: 1,
              lat: 47.72,
              lon: 10.31,
              tags: { name: 'Fallback Company', office: 'company' },
            },
          ],
        }),
      );

    const companies = await new OverpassProvider().discoverCompanies({
      center: { lat: 47.72, lon: 10.31 },
      radiusKm: 1,
      limit: 5,
    });

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'https://primary.example/api',
      'https://fallback.example/api',
    ]);
    expect(companies[0]?.name).toBe('Fallback Company');
  });
});
