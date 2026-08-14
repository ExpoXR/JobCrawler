import { AppError, getConfig, getLogger, type GeoLocation, type GeoPoint } from '@ejc/shared';
import { getCachedGeocode, setCachedGeocode } from '@ejc/database';

import type { GeocodingProvider, ProviderContext, ProviderInfo } from '../types';

/**
 * Nominatim / OpenStreetMap geocoding (plan section 2).
 *
 * The public instance has a strict usage policy: identify yourself, do not run
 * bulk queries, and cache results. All three are honoured here — every lookup
 * goes through the database cache first, and `NOMINATIM_BASE_URL` can point at
 * a self-hosted instance for production volume.
 */

interface NominatimPlace {
  lat?: string;
  lon?: string;
  display_name?: string;
  address?: Record<string, string>;
  type?: string;
  importance?: number;
}

const GEOCODE_CACHE_DAYS = 30;

function pickCity(address: Record<string, string> | undefined): string | undefined {
  if (!address) return undefined;
  return (
    address['city'] ??
    address['town'] ??
    address['village'] ??
    address['municipality'] ??
    address['county']
  );
}

export class NominatimProvider implements GeocodingProvider {
  readonly info: ProviderInfo = {
    key: 'nominatim',
    name: 'OpenStreetMap Nominatim',
    homepage: 'https://operations.osmfoundation.org/policies/nominatim/',
    capabilities: ['geocoding', 'reverse-geocoding'],
    rateLimitPerMinute: 60,
  };

  isAvailable(): boolean {
    return getConfig().geo.nominatimBaseUrl.length > 0;
  }

  async geocode(query: string, context: ProviderContext = {}): Promise<GeoLocation[]> {
    const config = getConfig();
    const trimmed = query.trim();
    if (trimmed.length < 2) return [];

    const cacheKey = `nominatim:search:${trimmed.toLowerCase()}`;
    const cached = await getCachedGeocode<GeoLocation[]>(cacheKey).catch(() => undefined);
    if (cached) return cached;

    const url = new URL('/search', config.geo.nominatimBaseUrl);
    url.searchParams.set('q', trimmed);
    url.searchParams.set('format', 'jsonv2');
    url.searchParams.set('addressdetails', '1');
    url.searchParams.set('limit', '5');
    // Europe-first, but not Europe-only: the bias is a hint, not a filter.
    url.searchParams.set('accept-language', 'de,en');

    const places = await this.request<NominatimPlace[]>(url, context);
    const results = places
      .map((place) => this.toLocation(place))
      .filter((location): location is GeoLocation => location !== undefined);

    if (results.length > 0) {
      await setCachedGeocode(cacheKey, this.info.key, results, GEOCODE_CACHE_DAYS).catch(() => {
        // A cache write failure must not fail the lookup.
      });
    }

    return results;
  }

  async reverseGeocode(
    point: GeoPoint,
    context: ProviderContext = {},
  ): Promise<GeoLocation | undefined> {
    const config = getConfig();
    const cacheKey = `nominatim:reverse:${point.lat.toFixed(4)},${point.lon.toFixed(4)}`;
    const cached = await getCachedGeocode<GeoLocation>(cacheKey).catch(() => undefined);
    if (cached) return cached;

    const url = new URL('/reverse', config.geo.nominatimBaseUrl);
    url.searchParams.set('lat', String(point.lat));
    url.searchParams.set('lon', String(point.lon));
    url.searchParams.set('format', 'jsonv2');
    url.searchParams.set('addressdetails', '1');

    const place = await this.request<NominatimPlace>(url, context);
    const location = this.toLocation(place);
    if (location) {
      await setCachedGeocode(cacheKey, this.info.key, location, GEOCODE_CACHE_DAYS).catch(
        () => undefined,
      );
    }
    return location;
  }

  private toLocation(place: NominatimPlace): GeoLocation | undefined {
    const lat = Number(place.lat);
    const lon = Number(place.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return undefined;

    const location: GeoLocation = {
      lat,
      lon,
      label: place.display_name ?? `${lat}, ${lon}`,
      source: this.info.key,
    };

    const city = pickCity(place.address);
    if (city) location.city = city;
    const region = place.address?.['state'] ?? place.address?.['region'];
    if (region) location.region = region;
    const country = place.address?.['country'];
    if (country) location.country = country;
    const countryCode = place.address?.['country_code'];
    if (countryCode) location.countryCode = countryCode.toUpperCase();
    const postalCode = place.address?.['postcode'];
    if (postalCode) location.postalCode = postalCode;

    return location;
  }

  private async request<T>(url: URL, context: ProviderContext): Promise<T> {
    const config = getConfig();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.crawler.timeoutMs);
    const onAbort = () => controller.abort();
    context.signal?.addEventListener('abort', onAbort, { once: true });

    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          // Nominatim requires a descriptive UA identifying the deployment.
          'user-agent': config.crawler.userAgent,
          accept: 'application/json',
          ...(config.crawler.contactEmail ? { from: config.crawler.contactEmail } : {}),
        },
      });

      if (!response.ok) {
        throw new AppError(
          response.status === 429 ? 'rate_limited' : 'provider_unavailable',
          `Nominatim returned ${response.status}`,
          { context: { provider: this.info.key, status: response.status } },
        );
      }

      return (await response.json()) as T;
    } catch (error) {
      if (error instanceof AppError) throw error;
      getLogger('providers').warn('Nominatim request failed', {
        provider: this.info.key,
        errorType: 'provider_unavailable',
      });
      throw new AppError('provider_unavailable', 'Geocoding request failed', { cause: error });
    } finally {
      clearTimeout(timer);
      context.signal?.removeEventListener('abort', onAbort);
    }
  }
}

export const nominatimProvider = new NominatimProvider();
