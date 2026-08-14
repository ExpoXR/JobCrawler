import { AppError, type GeoLocation, getLogger } from '@ejc/shared';
import { getGeocodingProviders } from '@ejc/providers';

/**
 * Location resolution.
 *
 * Tries each enabled geocoder in order and returns the first usable answer, so
 * one provider outage does not block a search (plan section 35).
 */
export async function geocodeLocation(
  query: string,
  signal?: AbortSignal,
): Promise<GeoLocation[]> {
  const providers = await getGeocodingProviders();
  if (providers.length === 0) {
    throw new AppError('not_configured', 'No geocoding provider is enabled');
  }

  const logger = getLogger('search');
  const errors: string[] = [];

  for (const provider of providers) {
    try {
      const results = await provider.geocode(query, signal ? { signal } : {});
      if (results.length > 0) return results;
    } catch (error) {
      errors.push(provider.info.key);
      logger.warn('Geocoding provider failed', {
        provider: provider.info.key,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (errors.length === providers.length) {
    throw new AppError('provider_unavailable', 'All geocoding providers failed');
  }
  return [];
}

/** Resolves a place name to a single best location. */
export async function resolveLocation(
  query: string,
  signal?: AbortSignal,
): Promise<GeoLocation | undefined> {
  const results = await geocodeLocation(query, signal);
  return results[0];
}
