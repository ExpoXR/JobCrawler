import { AppError } from '@ejc/shared';
import { describe, expect, test } from 'vitest';

import { handleRouteError } from './api';

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
});
