import {
  type Company,
  type GeoPoint,
  normalizeCompanyName,
  type SourceReference,
} from '@ejc/shared';

import { query, queryOne, queryRows } from '../pool';

export interface CompanyRow {
  id: string;
  name: string;
  normalized_name: string;
  domain: string | null;
  website: string | null;
  description: string | null;
  industry: string | null;
  address: string | null;
  city: string | null;
  region: string | null;
  country: string | null;
  country_code: string | null;
  lat: number | null;
  lon: number | null;
  technologies: string[];
  services: string[];
  size_bucket: string | null;
  employee_count_min: number | null;
  employee_count_max: number | null;
  social_links: Record<string, string>;
  career_page_url: string | null;
  contact_page_url: string | null;
  public_email: string | null;
  public_phone: string | null;
  sitemap_urls: string[];
  active_job_count: number;
  ai_summary: string | null;
  last_crawled_at: Date | null;
  last_verified_at: Date | null;
  created_at: Date;
  updated_at: Date;
  distance_km?: number | null;
}

export const COMPANY_COLUMNS = `
  id, name, normalized_name, domain, website, description, industry, address, city, region,
  country, country_code,
  ST_Y(location::geometry) AS lat,
  ST_X(location::geometry) AS lon,
  technologies, services, size_bucket, employee_count_min, employee_count_max, social_links,
  career_page_url, contact_page_url, public_email, public_phone, sitemap_urls, active_job_count,
  ai_summary, last_crawled_at, last_verified_at, created_at, updated_at
`;

export function mapCompanyRow(row: CompanyRow): Company {
  const company: Company = {
    id: row.id,
    name: row.name,
    normalizedName: row.normalized_name,
    technologies: row.technologies ?? [],
    services: row.services ?? [],
    socialLinks: row.social_links ?? {},
    sitemapUrls: row.sitemap_urls ?? [],
    activeJobCount: row.active_job_count ?? 0,
    sources: [],
  };

  if (row.domain) company.domain = row.domain;
  if (row.website) company.website = row.website;
  if (row.description) company.description = row.description;
  if (row.industry) company.industry = row.industry;
  if (row.address) company.address = row.address;
  if (row.city) company.city = row.city;
  if (row.region) company.region = row.region;
  if (row.country) company.country = row.country;
  if (row.country_code) company.countryCode = row.country_code;
  if (row.lat !== null && row.lon !== null) company.location = { lat: row.lat, lon: row.lon };
  if (row.size_bucket) company.sizeBucket = row.size_bucket;
  if (row.employee_count_min !== null) company.employeeCountMin = row.employee_count_min;
  if (row.employee_count_max !== null) company.employeeCountMax = row.employee_count_max;
  if (row.career_page_url) company.careerPageUrl = row.career_page_url;
  if (row.contact_page_url) company.contactPageUrl = row.contact_page_url;
  if (row.public_email) company.publicEmail = row.public_email;
  if (row.public_phone) company.publicPhone = row.public_phone;
  if (row.ai_summary) company.aiSummary = row.ai_summary;
  if (row.last_crawled_at) company.lastCrawledAt = row.last_crawled_at.toISOString();
  if (row.last_verified_at) company.lastVerifiedAt = row.last_verified_at.toISOString();
  company.createdAt = row.created_at?.toISOString();
  company.updatedAt = row.updated_at?.toISOString();

  return company;
}

export interface CompanyUpsert {
  name: string;
  domain?: string | undefined;
  website?: string | undefined;
  description?: string | undefined;
  industry?: string | undefined;
  address?: string | undefined;
  city?: string | undefined;
  region?: string | undefined;
  country?: string | undefined;
  countryCode?: string | undefined;
  location?: GeoPoint | undefined;
  technologies?: string[] | undefined;
  services?: string[] | undefined;
  sizeBucket?: string | undefined;
  socialLinks?: Record<string, string> | undefined;
  careerPageUrl?: string | undefined;
  contactPageUrl?: string | undefined;
  publicEmail?: string | undefined;
  publicPhone?: string | undefined;
  sitemapUrls?: string[] | undefined;
  aiSummary?: string | undefined;
  osmId?: string | undefined;
  markCrawled?: boolean;
}

/**
 * Inserts or merges a company.
 *
 * Merge semantics matter: discovery runs repeatedly and must never blank out
 * data that an earlier, richer pass established. Scalars use COALESCE(new, old)
 * and arrays are unioned.
 */
export async function upsertCompany(input: CompanyUpsert): Promise<Company> {
  const normalizedName = normalizeCompanyName(input.name);
  const domain = input.domain?.toLowerCase() ?? null;

  const params = [
    input.name,
    normalizedName,
    domain,
    input.website ?? null,
    input.description ?? null,
    input.industry ?? null,
    input.address ?? null,
    input.city ?? null,
    input.region ?? null,
    input.country ?? null,
    input.countryCode ?? null,
    input.location?.lon ?? null,
    input.location?.lat ?? null,
    input.technologies ?? [],
    input.services ?? [],
    input.sizeBucket ?? null,
    JSON.stringify(input.socialLinks ?? {}),
    input.careerPageUrl ?? null,
    input.contactPageUrl ?? null,
    input.publicEmail ?? null,
    input.publicPhone ?? null,
    input.sitemapUrls ?? [],
    input.aiSummary ?? null,
    input.osmId ?? null,
    input.markCrawled ?? false,
  ];

  const conflictTarget = domain ? '(domain) WHERE domain IS NOT NULL' : null;

  const updateClause = `
    SET name = EXCLUDED.name,
        website = COALESCE(EXCLUDED.website, companies.website),
        description = COALESCE(EXCLUDED.description, companies.description),
        industry = COALESCE(EXCLUDED.industry, companies.industry),
        address = COALESCE(EXCLUDED.address, companies.address),
        city = COALESCE(EXCLUDED.city, companies.city),
        region = COALESCE(EXCLUDED.region, companies.region),
        country = COALESCE(EXCLUDED.country, companies.country),
        country_code = COALESCE(EXCLUDED.country_code, companies.country_code),
        location = COALESCE(EXCLUDED.location, companies.location),
        technologies = ARRAY(
          SELECT DISTINCT unnest(companies.technologies || EXCLUDED.technologies)
        ),
        services = ARRAY(SELECT DISTINCT unnest(companies.services || EXCLUDED.services)),
        size_bucket = COALESCE(EXCLUDED.size_bucket, companies.size_bucket),
        social_links = companies.social_links || EXCLUDED.social_links,
        career_page_url = COALESCE(EXCLUDED.career_page_url, companies.career_page_url),
        contact_page_url = COALESCE(EXCLUDED.contact_page_url, companies.contact_page_url),
        public_email = COALESCE(EXCLUDED.public_email, companies.public_email),
        public_phone = COALESCE(EXCLUDED.public_phone, companies.public_phone),
        sitemap_urls = ARRAY(SELECT DISTINCT unnest(companies.sitemap_urls || EXCLUDED.sitemap_urls)),
        ai_summary = COALESCE(EXCLUDED.ai_summary, companies.ai_summary),
        osm_id = COALESCE(EXCLUDED.osm_id, companies.osm_id),
        last_crawled_at = CASE WHEN $25 THEN now() ELSE companies.last_crawled_at END
  `;

  const insert = `
    INSERT INTO companies (
      name, normalized_name, domain, website, description, industry, address, city, region,
      country, country_code, location, technologies, services, size_bucket, social_links,
      career_page_url, contact_page_url, public_email, public_phone, sitemap_urls, ai_summary,
      osm_id, last_crawled_at
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
      CASE WHEN $12::float8 IS NULL OR $13::float8 IS NULL THEN NULL
           ELSE ST_SetSRID(ST_MakePoint($12::float8, $13::float8), 4326)::geography END,
      $14::text[], $15::text[], $16, $17::jsonb, $18, $19, $20, $21, $22::text[], $23, $24,
      CASE WHEN $25 THEN now() ELSE NULL END
    )
    ON CONFLICT ${conflictTarget ?? '(normalized_name, COALESCE(city, \'\')) WHERE domain IS NULL'}
    DO UPDATE ${updateClause}
    RETURNING ${COMPANY_COLUMNS}
  `;

  const row = await queryOne<CompanyRow>(insert, params);
  if (!row) throw new Error('Company upsert returned no row');
  return mapCompanyRow(row);
}

export async function getCompanyById(id: string): Promise<Company | undefined> {
  const row = await queryOne<CompanyRow>(
    `SELECT ${COMPANY_COLUMNS} FROM companies WHERE id = $1`,
    [id],
  );
  return row ? mapCompanyRow(row) : undefined;
}

export async function getCompanyByDomain(domain: string): Promise<Company | undefined> {
  const row = await queryOne<CompanyRow>(
    `SELECT ${COMPANY_COLUMNS} FROM companies WHERE domain = $1`,
    [domain.toLowerCase()],
  );
  return row ? mapCompanyRow(row) : undefined;
}

export interface RadiusSearchOptions {
  center: GeoPoint;
  radiusKm: number;
  limit?: number;
  /** Restrict to companies whose technologies overlap these values. */
  technologies?: string[];
  industry?: string;
  onlyWithCareerPage?: boolean;
}

export interface CompanyWithDistance {
  company: Company;
  distanceKm: number;
}

/** PostGIS radius search. Distance is returned so the UI never recomputes it. */
export async function findCompaniesWithinRadius(
  options: RadiusSearchOptions,
): Promise<CompanyWithDistance[]> {
  const { center, radiusKm } = options;
  const limit = Math.min(options.limit ?? 200, 1000);

  const rows = await queryRows<CompanyRow & { distance_km: number }>(
    `
      SELECT ${COMPANY_COLUMNS},
             ST_Distance(location, $1::geography) / 1000.0 AS distance_km
      FROM companies
      WHERE location IS NOT NULL
        AND ST_DWithin(location, $1::geography, $2)
        AND ($3::text[] IS NULL OR technologies && $3::text[])
        AND ($4::text IS NULL OR industry ILIKE '%' || $4 || '%')
        AND ($5::boolean IS FALSE OR career_page_url IS NOT NULL)
      ORDER BY distance_km ASC
      LIMIT $6
    `,
    [
      `SRID=4326;POINT(${center.lon} ${center.lat})`,
      radiusKm * 1000,
      options.technologies?.length ? options.technologies : null,
      options.industry ?? null,
      options.onlyWithCareerPage ?? false,
      limit,
    ],
  );

  return rows.map((row) => ({
    company: mapCompanyRow(row),
    distanceKm: Number(row.distance_km),
  }));
}

export async function setCompanySources(
  companyId: string,
  sources: readonly SourceReference[],
): Promise<void> {
  if (sources.length === 0) return;
  // Sources for companies live in crawled_pages; this keeps the website field
  // pointing at the best-known entry point.
  const primary = sources[0];
  if (!primary) return;
  await query(`UPDATE companies SET website = COALESCE(website, $2) WHERE id = $1`, [
    companyId,
    primary.url,
  ]);
}

export async function refreshActiveJobCount(companyId: string): Promise<number> {
  const row = await queryOne<{ active_job_count: number }>(
    `
      UPDATE companies
      SET active_job_count = (
        SELECT count(*) FROM jobs WHERE jobs.company_id = companies.id AND jobs.is_active
      )
      WHERE id = $1
      RETURNING active_job_count
    `,
    [companyId],
  );
  return row?.active_job_count ?? 0;
}

export async function markCompanyVerified(companyId: string): Promise<void> {
  await query(`UPDATE companies SET last_verified_at = now() WHERE id = $1`, [companyId]);
}

/** Companies whose data is older than the configured re-crawl window. */
export async function findCompaniesDueForRecrawl(
  olderThanDays: number,
  limit = 50,
): Promise<Company[]> {
  const rows = await queryRows<CompanyRow>(
    `
      SELECT ${COMPANY_COLUMNS}
      FROM companies
      WHERE website IS NOT NULL
        AND (last_crawled_at IS NULL OR last_crawled_at < now() - make_interval(days => $1))
      ORDER BY last_crawled_at ASC NULLS FIRST
      LIMIT $2
    `,
    [olderThanDays, limit],
  );
  return rows.map(mapCompanyRow);
}

export async function deleteCompaniesByDomain(domain: string): Promise<number> {
  const result = await query(`DELETE FROM companies WHERE domain = $1`, [domain.toLowerCase()]);
  return result.rowCount ?? 0;
}

export async function countCompanies(): Promise<number> {
  const row = await queryOne<{ count: string }>(`SELECT count(*)::text AS count FROM companies`);
  return Number(row?.count ?? 0);
}
