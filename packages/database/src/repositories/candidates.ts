import type { Candidate, GeoPoint } from '@ejc/shared';

import { query, queryOne, queryRows } from '../pool';

/**
 * Candidate storage (plan section 16).
 *
 * Every write goes through the suppression list first: a removal request must
 * survive re-discovery, otherwise the next crawl silently undoes it.
 */

export interface CandidateRow {
  id: string;
  public_name: string | null;
  public_title: string | null;
  approximate_location: string | null;
  city: string | null;
  country_code: string | null;
  lat: number | null;
  lon: number | null;
  skills: string[];
  technologies: string[];
  profile_url: string;
  portfolio_url: string | null;
  github_url: string | null;
  ai_summary: string | null;
  discovered_at: Date;
  last_checked_at: Date | null;
  distance_km?: number | null;
}

const CANDIDATE_COLUMNS = `
  id, public_name, public_title, approximate_location, city, country_code,
  ST_Y(location::geometry) AS lat,
  ST_X(location::geometry) AS lon,
  skills, technologies, profile_url, portfolio_url, github_url, ai_summary,
  discovered_at, last_checked_at
`;

export function mapCandidateRow(row: CandidateRow): Candidate {
  const candidate: Candidate = {
    id: row.id,
    skills: row.skills ?? [],
    technologies: row.technologies ?? [],
    profileUrl: row.profile_url,
    sources: [],
  };
  if (row.public_name) candidate.publicName = row.public_name;
  if (row.public_title) candidate.publicTitle = row.public_title;
  if (row.approximate_location) candidate.approximateLocation = row.approximate_location;
  if (row.country_code) candidate.countryCode = row.country_code;
  if (row.lat !== null && row.lon !== null) candidate.coordinates = { lat: row.lat, lon: row.lon };
  if (row.portfolio_url) candidate.portfolioUrl = row.portfolio_url;
  if (row.github_url) candidate.githubUrl = row.github_url;
  if (row.ai_summary) candidate.aiSummary = row.ai_summary;
  if (row.discovered_at) candidate.discoveredAt = row.discovered_at.toISOString();
  if (row.last_checked_at) candidate.lastCheckedAt = row.last_checked_at.toISOString();
  return candidate;
}

export interface CandidateUpsert {
  publicName?: string | undefined;
  publicTitle?: string | undefined;
  approximateLocation?: string | undefined;
  city?: string | undefined;
  countryCode?: string | undefined;
  coordinates?: GeoPoint | undefined;
  skills?: string[] | undefined;
  technologies?: string[] | undefined;
  profileUrl: string;
  portfolioUrl?: string | undefined;
  githubUrl?: string | undefined;
  aiSummary?: string | undefined;
  source: { provider: string; url: string };
}

export async function upsertCandidate(input: CandidateUpsert): Promise<Candidate | undefined> {
  if (await isSuppressed('candidate', input.profileUrl)) return undefined;

  const row = await queryOne<CandidateRow>(
    `
      INSERT INTO candidates (
        public_name, public_title, approximate_location, city, country_code, location,
        skills, technologies, profile_url, portfolio_url, github_url, ai_summary, last_checked_at
      ) VALUES (
        $1, $2, $3, $4, $5,
        CASE WHEN $6::float8 IS NULL OR $7::float8 IS NULL THEN NULL
             ELSE ST_SetSRID(ST_MakePoint($6::float8, $7::float8), 4326)::geography END,
        $8::text[], $9::text[], $10, $11, $12, $13, now()
      )
      ON CONFLICT (profile_url) DO UPDATE SET
        public_name = COALESCE(EXCLUDED.public_name, candidates.public_name),
        public_title = COALESCE(EXCLUDED.public_title, candidates.public_title),
        approximate_location = COALESCE(
          EXCLUDED.approximate_location, candidates.approximate_location
        ),
        city = COALESCE(EXCLUDED.city, candidates.city),
        country_code = COALESCE(EXCLUDED.country_code, candidates.country_code),
        location = COALESCE(EXCLUDED.location, candidates.location),
        skills = ARRAY(SELECT DISTINCT unnest(candidates.skills || EXCLUDED.skills)),
        technologies = ARRAY(
          SELECT DISTINCT unnest(candidates.technologies || EXCLUDED.technologies)
        ),
        portfolio_url = COALESCE(EXCLUDED.portfolio_url, candidates.portfolio_url),
        github_url = COALESCE(EXCLUDED.github_url, candidates.github_url),
        ai_summary = COALESCE(EXCLUDED.ai_summary, candidates.ai_summary),
        last_checked_at = now()
      RETURNING ${CANDIDATE_COLUMNS}
    `,
    [
      input.publicName ?? null,
      input.publicTitle ?? null,
      input.approximateLocation ?? null,
      input.city ?? null,
      input.countryCode ?? null,
      input.coordinates?.lon ?? null,
      input.coordinates?.lat ?? null,
      input.skills ?? [],
      input.technologies ?? [],
      input.profileUrl,
      input.portfolioUrl ?? null,
      input.githubUrl ?? null,
      input.aiSummary ?? null,
    ],
  );

  if (!row) return undefined;

  await query(
    `INSERT INTO candidate_sources (candidate_id, provider, url) VALUES ($1, $2, $3)
     ON CONFLICT (candidate_id, url) DO UPDATE SET retrieved_at = now()`,
    [row.id, input.source.provider, input.source.url],
  );

  return mapCandidateRow(row);
}

export async function getCandidateById(id: string): Promise<Candidate | undefined> {
  const row = await queryOne<CandidateRow>(
    `SELECT ${CANDIDATE_COLUMNS} FROM candidates WHERE id = $1 AND NOT is_removed`,
    [id],
  );
  return row ? mapCandidateRow(row) : undefined;
}

export interface CandidateSearchOptions {
  center?: GeoPoint;
  radiusKm?: number;
  skills?: string[];
  limit?: number;
}

export async function findCandidates(
  options: CandidateSearchOptions,
): Promise<Array<{ candidate: Candidate; distanceKm: number | undefined }>> {
  const limit = Math.min(options.limit ?? 100, 500);
  const point = options.center
    ? `SRID=4326;POINT(${options.center.lon} ${options.center.lat})`
    : null;

  const rows = await queryRows<CandidateRow & { distance_km: number | null }>(
    `
      SELECT ${CANDIDATE_COLUMNS},
             CASE WHEN $1::geography IS NULL OR location IS NULL THEN NULL
                  ELSE ST_Distance(location, $1::geography) / 1000.0 END AS distance_km
      FROM candidates
      WHERE NOT is_removed
        AND ($1::geography IS NULL OR location IS NULL
             OR ST_DWithin(location, $1::geography, $2))
        AND ($3::text[] IS NULL OR skills && $3::text[])
      ORDER BY distance_km ASC NULLS LAST, last_checked_at DESC NULLS LAST
      LIMIT $4
    `,
    [point, (options.radiusKm ?? 50) * 1000, options.skills?.length ? options.skills : null, limit],
  );

  return rows.map((row) => ({
    candidate: mapCandidateRow(row),
    distanceKm: row.distance_km === null ? undefined : Number(row.distance_km),
  }));
}

/** GDPR removal: tombstone the row and remember the suppression. */
export async function removeCandidate(id: string, reason: string): Promise<void> {
  const row = await queryOne<{ profile_url: string }>(
    `UPDATE candidates SET is_removed = TRUE, removal_reason = $2, public_name = NULL,
       ai_summary = NULL, skills = '{}', technologies = '{}'
     WHERE id = $1 RETURNING profile_url`,
    [id, reason],
  );
  if (row) await suppress('candidate', row.profile_url, reason);
}

export async function suppress(
  subjectType: 'candidate' | 'domain' | 'company',
  key: string,
  reason?: string,
): Promise<void> {
  await query(
    `INSERT INTO removal_requests (subject_type, subject_key, reason) VALUES ($1, $2, $3)
     ON CONFLICT (subject_type, subject_key) DO NOTHING`,
    [subjectType, key.toLowerCase(), reason ?? null],
  );
}

export async function isSuppressed(
  subjectType: 'candidate' | 'domain' | 'company',
  key: string,
): Promise<boolean> {
  const row = await queryOne<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM removal_requests WHERE subject_type = $1 AND subject_key = $2
     ) AS exists`,
    [subjectType, key.toLowerCase()],
  );
  return row?.exists ?? false;
}

export async function countCandidates(): Promise<number> {
  const row = await queryOne<{ count: string }>(
    `SELECT count(*)::text AS count FROM candidates WHERE NOT is_removed`,
  );
  return Number(row?.count ?? 0);
}
