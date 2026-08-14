import { AppError, boundingBox, getConfig, getLogger, type GeoPoint } from '@ejc/shared';

import type {
  CompanyProvider,
  CompanySearchQuery,
  DiscoveredCompany,
  ProviderContext,
  ProviderInfo,
} from '../types';

/**
 * Company discovery via the OpenStreetMap Overpass API (plan section 8).
 *
 * OSM knows where businesses physically are, which is exactly the signal a
 * geographic job search needs and which no job board provides. We query the
 * office/craft/shop tags that correspond to employers, inside the search
 * radius, and keep only entries with enough information to be useful.
 *
 * Overpass is a shared free service: queries are bounded by radius, capped by
 * `limit`, and given an explicit server-side timeout.
 */

interface OverpassElement {
  type: 'node' | 'way' | 'relation';
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

interface OverpassResponse {
  elements?: OverpassElement[];
}

/**
 * OSM tags that indicate an employer.
 *
 * `office=*` covers most white-collar employers; `craft` and the industrial
 * `building`/`landuse` tags catch the rest. Retail is deliberately excluded
 * except where it is tagged as a company office.
 */
const EMPLOYER_FILTERS = [
  'nwr["office"]',
  'nwr["craft"]',
  'nwr["industrial"]',
  'nwr["amenity"="coworking_space"]',
  'nwr["building"="office"]["name"]',
];

/** Maps an OSM tag combination onto a human industry label. */
function industryFor(tags: Record<string, string>): string | undefined {
  const office = tags['office'];
  const craft = tags['craft'];
  const industrial = tags['industrial'];

  const labels: Record<string, string> = {
    it: 'Information Technology',
    company: 'Company',
    consulting: 'Consulting',
    engineering: 'Engineering',
    advertising_agency: 'Advertising & Marketing',
    architect: 'Architecture',
    accountant: 'Accounting',
    lawyer: 'Legal',
    insurance: 'Insurance',
    financial: 'Finance',
    research: 'Research',
    educational_institution: 'Education',
    employment_agency: 'Recruitment',
    government: 'Public Sector',
    ngo: 'Non-profit',
    telecommunication: 'Telecommunications',
    logistics: 'Logistics',
    estate_agent: 'Real Estate',
  };

  if (office && labels[office]) return labels[office];
  if (office) return office.replace(/_/g, ' ');
  if (craft) return craft.replace(/_/g, ' ');
  if (industrial) return `Industrial (${industrial.replace(/_/g, ' ')})`;
  return undefined;
}

function domainFromWebsite(website: string | undefined): string | undefined {
  if (!website) return undefined;
  try {
    const url = new URL(website.startsWith('http') ? website : `https://${website}`);
    return url.hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return undefined;
  }
}

function pointOf(element: OverpassElement): GeoPoint | undefined {
  const lat = element.lat ?? element.center?.lat;
  const lon = element.lon ?? element.center?.lon;
  if (typeof lat !== 'number' || typeof lon !== 'number') return undefined;
  return { lat, lon };
}

export class OverpassProvider implements CompanyProvider {
  readonly info: ProviderInfo = {
    key: 'overpass',
    name: 'OpenStreetMap Overpass',
    homepage: 'https://wiki.openstreetmap.org/wiki/Overpass_API',
    capabilities: ['api-search', 'radius-search', 'metadata-extraction'],
    rateLimitPerMinute: 10,
  };

  isAvailable(): boolean {
    return getConfig().geo.overpassBaseUrl.length > 0;
  }

  /** Builds an Overpass QL query bounded by radius and result count. */
  buildQuery(center: GeoPoint, radiusKm: number, limit: number): string {
    const radiusMeters = Math.round(Math.min(radiusKm, 100) * 1000);
    const box = boundingBox(center, Math.min(radiusKm, 100));
    const bbox = `${box.minLat.toFixed(5)},${box.minLon.toFixed(5)},${box.maxLat.toFixed(5)},${box.maxLon.toFixed(5)}`;

    const clauses = EMPLOYER_FILTERS.map(
      (filter) => `  ${filter}(around:${radiusMeters},${center.lat},${center.lon})(${bbox});`,
    ).join('\n');

    return [
      '[out:json][timeout:45];',
      '(',
      clauses,
      ');',
      `out center ${Math.min(limit, 500)};`,
    ].join('\n');
  }

  async discoverCompanies(
    query: CompanySearchQuery,
    context: ProviderContext = {},
  ): Promise<DiscoveredCompany[]> {
    const config = getConfig();
    const limit = Math.min(query.limit ?? 200, 500);
    const body = this.buildQuery(query.center, query.radiusKm, limit);

    const controller = new AbortController();
    // Overpass is slow by nature; give it more headroom than a page fetch.
    const timer = setTimeout(() => controller.abort(), Math.max(config.crawler.timeoutMs, 60_000));
    const onAbort = () => controller.abort();
    context.signal?.addEventListener('abort', onAbort, { once: true });

    let payload: OverpassResponse;
    try {
      const response = await fetch(config.geo.overpassBaseUrl, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'user-agent': config.crawler.userAgent,
          accept: 'application/json',
        },
        body: new URLSearchParams({ data: body }).toString(),
      });

      if (!response.ok) {
        throw new AppError(
          response.status === 429 || response.status === 504
            ? 'rate_limited'
            : 'provider_unavailable',
          `Overpass returned ${response.status}`,
          { context: { provider: this.info.key, status: response.status } },
        );
      }

      payload = (await response.json()) as OverpassResponse;
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError('provider_unavailable', 'Overpass request failed', { cause: error });
    } finally {
      clearTimeout(timer);
      context.signal?.removeEventListener('abort', onAbort);
    }

    const companies: DiscoveredCompany[] = [];
    const seenNames = new Set<string>();

    for (const element of payload.elements ?? []) {
      const tags = element.tags ?? {};
      const name = tags['name'] ?? tags['operator'] ?? tags['brand'];
      if (!name) continue;

      const point = pointOf(element);
      if (!point) continue;

      const website = tags['website'] ?? tags['contact:website'] ?? tags['url'];
      const domain = domainFromWebsite(website);

      // Prefer one entry per company per locality; OSM often has both a node
      // and a building way for the same office.
      const dedupeKey = `${domain ?? name.toLowerCase()}|${tags['addr:city'] ?? ''}`;
      if (seenNames.has(dedupeKey)) continue;
      seenNames.add(dedupeKey);

      const company: DiscoveredCompany = {
        name,
        location: point,
        provider: this.info.key,
        sourceId: `${element.type}/${element.id}`,
        sourceUrl: `https://www.openstreetmap.org/${element.type}/${element.id}`,
      };

      if (website) company.website = website.startsWith('http') ? website : `https://${website}`;
      if (domain) company.domain = domain;

      const industry = industryFor(tags);
      if (industry) company.industry = industry;

      const street = tags['addr:street'];
      const houseNumber = tags['addr:housenumber'];
      if (street) company.address = [street, houseNumber].filter(Boolean).join(' ');
      const city = tags['addr:city'];
      if (city) company.city = city;
      const postcode = tags['addr:postcode'];
      if (postcode) company.postalCode = postcode;
      const countryCode = tags['addr:country'];
      if (countryCode) company.countryCode = countryCode.toUpperCase();

      const email = tags['email'] ?? tags['contact:email'];
      if (email) company.publicEmail = email;
      const phone = tags['phone'] ?? tags['contact:phone'];
      if (phone) company.publicPhone = phone;

      companies.push(company);
      if (companies.length >= limit) break;
    }

    getLogger('providers').info('Overpass discovery finished', {
      provider: this.info.key,
      found: companies.length,
      radiusKm: query.radiusKm,
    });

    return companies;
  }
}

export const overpassProvider = new OverpassProvider();
