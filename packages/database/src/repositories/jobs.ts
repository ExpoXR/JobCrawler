import { createHash } from 'node:crypto';

import {
  type EmploymentType,
  type GeoPoint,
  type Job,
  normalizeJobTitle,
  type Seniority,
  type SourceReference,
  type WorkModel,
} from '@ejc/shared';

import { query, queryOne, queryRows, toVectorLiteral, withTransaction } from '../pool';

export interface JobRow {
  id: string;
  company_id: string | null;
  company_name: string | null;
  title: string;
  normalized_title: string;
  location_text: string | null;
  city: string | null;
  region: string | null;
  country: string | null;
  country_code: string | null;
  lat: number | null;
  lon: number | null;
  work_model: WorkModel;
  employment_type: EmploymentType;
  seniority: Seniority;
  salary_min: string | null;
  salary_max: string | null;
  salary_currency: string | null;
  salary_period: 'hour' | 'day' | 'month' | 'year' | null;
  required_experience_years: number | null;
  preferred_experience_years: number | null;
  languages: string[];
  description: string | null;
  ai_summary: string | null;
  application_url: string | null;
  canonical_url: string | null;
  published_at: Date | null;
  expires_at: Date | null;
  discovered_at: Date;
  last_verified_at: Date | null;
  is_active: boolean;
  skills?: string[] | null;
  source_urls?: string[] | null;
  source_providers?: string[] | null;
  distance_km?: number | null;
}

export const JOB_COLUMNS = `
  j.id, j.company_id, j.company_name, j.title, j.normalized_title, j.location_text, j.city,
  j.region, j.country, j.country_code,
  ST_Y(j.location::geometry) AS lat,
  ST_X(j.location::geometry) AS lon,
  j.work_model, j.employment_type, j.seniority, j.salary_min, j.salary_max, j.salary_currency,
  j.salary_period, j.required_experience_years, j.preferred_experience_years, j.languages,
  j.description, j.ai_summary, j.application_url, j.canonical_url, j.published_at, j.expires_at,
  j.discovered_at, j.last_verified_at, j.is_active,
  COALESCE(
    (SELECT array_agg(DISTINCT s.name) FROM job_skills js
      JOIN skills s ON s.id = js.skill_id WHERE js.job_id = j.id),
    '{}'
  ) AS skills,
  COALESCE((SELECT array_agg(src.url ORDER BY src.is_primary DESC) FROM job_sources src
    WHERE src.job_id = j.id), '{}') AS source_urls,
  COALESCE((SELECT array_agg(src.provider ORDER BY src.is_primary DESC) FROM job_sources src
    WHERE src.job_id = j.id), '{}') AS source_providers
`;

export function mapJobRow(row: JobRow): Job {
  const sources: SourceReference[] = (row.source_urls ?? []).map((url, index) => ({
    url,
    provider: row.source_providers?.[index] ?? 'unknown',
  }));

  const job: Job = {
    id: row.id,
    title: row.title,
    normalizedTitle: row.normalized_title,
    workModel: row.work_model,
    employmentType: row.employment_type,
    seniority: row.seniority,
    skills: row.skills ?? [],
    technologies: [],
    languages: row.languages ?? [],
    sources,
    isActive: row.is_active,
  };

  if (row.company_id) job.companyId = row.company_id;
  if (row.company_name) job.companyName = row.company_name;
  if (row.location_text) job.location = row.location_text;
  if (row.city) job.city = row.city;
  if (row.region) job.region = row.region;
  if (row.country) job.country = row.country;
  if (row.country_code) job.countryCode = row.country_code;
  if (row.lat !== null && row.lon !== null) job.coordinates = { lat: row.lat, lon: row.lon };
  if (row.salary_min !== null) job.salaryMin = Number(row.salary_min);
  if (row.salary_max !== null) job.salaryMax = Number(row.salary_max);
  if (row.salary_currency) job.salaryCurrency = row.salary_currency;
  if (row.salary_period) job.salaryPeriod = row.salary_period;
  if (row.required_experience_years !== null) {
    job.requiredExperienceYears = row.required_experience_years;
  }
  if (row.preferred_experience_years !== null) {
    job.preferredExperienceYears = row.preferred_experience_years;
  }
  if (row.description) job.description = row.description;
  if (row.ai_summary) job.aiSummary = row.ai_summary;
  if (row.application_url) job.applicationUrl = row.application_url;
  if (row.published_at) job.publishedAt = row.published_at.toISOString();
  if (row.expires_at) job.expiresAt = row.expires_at.toISOString();
  if (row.discovered_at) job.discoveredAt = row.discovered_at.toISOString();
  if (row.last_verified_at) job.lastVerifiedAt = row.last_verified_at.toISOString();

  return job;
}

export interface JobUpsert {
  companyId?: string | undefined;
  companyName?: string | undefined;
  title: string;
  location?: string | undefined;
  city?: string | undefined;
  region?: string | undefined;
  country?: string | undefined;
  countryCode?: string | undefined;
  coordinates?: GeoPoint | undefined;
  workModel?: WorkModel | undefined;
  employmentType?: EmploymentType | undefined;
  seniority?: Seniority | undefined;
  salaryMin?: number | undefined;
  salaryMax?: number | undefined;
  salaryCurrency?: string | undefined;
  salaryPeriod?: 'hour' | 'day' | 'month' | 'year' | undefined;
  requiredExperienceYears?: number | undefined;
  preferredExperienceYears?: number | undefined;
  languages?: string[] | undefined;
  description?: string | undefined;
  aiSummary?: string | undefined;
  applicationUrl?: string | undefined;
  canonicalUrl?: string | undefined;
  publishedAt?: string | undefined;
  expiresAt?: string | undefined;
  skills?: string[] | undefined;
  source: { provider: string; url: string; isPrimary?: boolean; raw?: unknown };
}

function contentHash(input: JobUpsert): string {
  return createHash('sha256')
    .update(
      [
        normalizeJobTitle(input.title),
        input.companyId ?? input.companyName ?? '',
        input.city ?? '',
        (input.description ?? '').slice(0, 4000),
      ].join('|'),
    )
    .digest('hex');
}

/**
 * Inserts a job or merges it into the existing logical job.
 *
 * Deduplication (plan section 17) happens on two keys, in order:
 *   1. canonical URL — the same posting fetched twice
 *   2. company + normalised title + city — the same posting on two providers
 *
 * Either way, every source URL is retained and the employer's own page wins the
 * `application_url` slot.
 */
export async function upsertJob(input: JobUpsert): Promise<{ job: Job; isNew: boolean }> {
  const normalizedTitle = normalizeJobTitle(input.title);
  const hash = contentHash(input);

  return withTransaction(async (client) => {
    const existing = await client.query<{ id: string }>(
      `
        SELECT id FROM jobs
        WHERE ($1::text IS NOT NULL AND canonical_url = $1)
           OR (COALESCE(company_id::text, '') = COALESCE($2::text, '')
               AND normalized_title = $3
               AND COALESCE(city, '') = COALESCE($4, ''))
        LIMIT 1
      `,
      [input.canonicalUrl ?? null, input.companyId ?? null, normalizedTitle, input.city ?? null],
    );

    const params = [
      input.companyId ?? null,
      input.companyName ?? null,
      input.title,
      normalizedTitle,
      input.location ?? null,
      input.city ?? null,
      input.region ?? null,
      input.country ?? null,
      input.countryCode ?? null,
      input.coordinates?.lon ?? null,
      input.coordinates?.lat ?? null,
      input.workModel ?? 'unknown',
      input.employmentType ?? 'unknown',
      input.seniority ?? 'unknown',
      input.salaryMin ?? null,
      input.salaryMax ?? null,
      input.salaryCurrency ?? null,
      input.salaryPeriod ?? null,
      input.requiredExperienceYears ?? null,
      input.preferredExperienceYears ?? null,
      input.languages ?? [],
      input.description ?? null,
      input.aiSummary ?? null,
      input.applicationUrl ?? null,
      input.canonicalUrl ?? null,
      hash,
      input.publishedAt ?? null,
      input.expiresAt ?? null,
    ];

    let jobId: string;
    let isNew: boolean;

    const existingId = existing.rows[0]?.id;
    if (existingId) {
      jobId = existingId;
      isNew = false;
      await client.query(
        `
          UPDATE jobs SET
            company_id = COALESCE($2, company_id),
            company_name = COALESCE($3, company_name),
            title = $4,
            normalized_title = $5,
            location_text = COALESCE($6, location_text),
            city = COALESCE($7, city),
            region = COALESCE($8, region),
            country = COALESCE($9, country),
            country_code = COALESCE($10, country_code),
            location = COALESCE(
              CASE WHEN $11::float8 IS NULL OR $12::float8 IS NULL THEN NULL
                   ELSE ST_SetSRID(ST_MakePoint($11::float8, $12::float8), 4326)::geography END,
              location
            ),
            work_model = CASE WHEN $13 = 'unknown' THEN work_model ELSE $13 END,
            employment_type = CASE WHEN $14 = 'unknown' THEN employment_type ELSE $14 END,
            seniority = CASE WHEN $15 = 'unknown' THEN seniority ELSE $15 END,
            salary_min = COALESCE($16, salary_min),
            salary_max = COALESCE($17, salary_max),
            salary_currency = COALESCE($18, salary_currency),
            salary_period = COALESCE($19, salary_period),
            required_experience_years = COALESCE($20, required_experience_years),
            preferred_experience_years = COALESCE($21, preferred_experience_years),
            languages = ARRAY(SELECT DISTINCT unnest(languages || $22::text[])),
            description = CASE
              WHEN $23::text IS NOT NULL
                AND length($23) > COALESCE(length(description), 0) THEN $23
              ELSE description END,
            ai_summary = COALESCE($24, ai_summary),
            -- The employer's own page is the preferred application link.
            application_url = CASE
              WHEN $29::boolean THEN COALESCE($25, application_url)
              ELSE COALESCE(application_url, $25) END,
            canonical_url = COALESCE(canonical_url, $26),
            content_hash = $27,
            published_at = COALESCE(published_at, $28::timestamptz),
            expires_at = COALESCE($30::timestamptz, expires_at),
            is_active = TRUE,
            inactive_since = NULL,
            last_verified_at = now()
          WHERE id = $1
        `,
        [
          jobId,
          ...params.slice(0, 27),
          input.source.isPrimary ?? false,
          input.expiresAt ?? null,
        ],
      );
    } else {
      isNew = true;
      const inserted = await client.query<{ id: string }>(
        `
          INSERT INTO jobs (
            company_id, company_name, title, normalized_title, location_text, city, region,
            country, country_code, location, work_model, employment_type, seniority, salary_min,
            salary_max, salary_currency, salary_period, required_experience_years,
            preferred_experience_years, languages, description, ai_summary, application_url,
            canonical_url, content_hash, published_at, expires_at, last_verified_at
          ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9,
            CASE WHEN $10::float8 IS NULL OR $11::float8 IS NULL THEN NULL
                 ELSE ST_SetSRID(ST_MakePoint($10::float8, $11::float8), 4326)::geography END,
            $12, $13, $14, $15, $16, $17, $18, $19, $20, $21::text[], $22, $23, $24, $25, $26,
            $27::timestamptz, $28::timestamptz, now()
          )
          RETURNING id
        `,
        params,
      );
      const insertedId = inserted.rows[0]?.id;
      if (!insertedId) throw new Error('Job insert returned no id');
      jobId = insertedId;
    }

    await client.query(
      `
        INSERT INTO job_sources (job_id, provider, url, is_primary, raw_payload)
        VALUES ($1, $2, $3, $4, $5::jsonb)
        ON CONFLICT (job_id, url) DO UPDATE
          SET retrieved_at = now(),
              is_primary = job_sources.is_primary OR EXCLUDED.is_primary
      `,
      [
        jobId,
        input.source.provider,
        input.source.url,
        input.source.isPrimary ?? false,
        input.source.raw === undefined ? null : JSON.stringify(input.source.raw),
      ],
    );

    if (input.skills?.length) {
      await client.query(
        `
          WITH input_skills AS (
            SELECT DISTINCT unnest($2::text[]) AS name
          ), upserted AS (
            INSERT INTO skills (name, normalized_name)
            SELECT name, name FROM input_skills
            ON CONFLICT (normalized_name) DO UPDATE SET name = skills.name
            RETURNING id
          )
          INSERT INTO job_skills (job_id, skill_id, requirement)
          SELECT $1, id, 'required' FROM upserted
          ON CONFLICT (job_id, skill_id) DO NOTHING
        `,
        [jobId, input.skills],
      );
    }

    const row = await client.query<JobRow>(
      `SELECT ${JOB_COLUMNS} FROM jobs j WHERE j.id = $1`,
      [jobId],
    );
    const jobRow = row.rows[0];
    if (!jobRow) throw new Error('Job upsert returned no row');
    return { job: mapJobRow(jobRow), isNew };
  });
}

export async function getJobById(id: string): Promise<Job | undefined> {
  const row = await queryOne<JobRow>(`SELECT ${JOB_COLUMNS} FROM jobs j WHERE j.id = $1`, [id]);
  return row ? mapJobRow(row) : undefined;
}

export interface JobRadiusSearchOptions {
  center: GeoPoint;
  radiusKm: number;
  limit?: number;
  titleQuery?: string;
  skills?: string[];
  workModels?: WorkModel[];
  employmentTypes?: EmploymentType[];
  activeOnly?: boolean;
  /**
   * Query embedding. When supplied, cosine similarity is computed in Postgres
   * so the 1536-float vectors never cross the wire.
   */
  queryEmbedding?: readonly number[];
  /**
   * Include jobs with no coordinates whose company sits inside the radius.
   * Remote-friendly postings frequently omit a location.
   */
  includeCompanyFallback?: boolean;
}

export interface JobWithDistance {
  job: Job;
  distanceKm: number | undefined;
  /** Cosine similarity to the query embedding, normalised to 0..1. */
  semanticSimilarity?: number | undefined;
}

/**
 * pgvector's `<=>` is cosine *distance* in [0, 2]; the matcher wants a 0..1
 * score. Kept here so the SQL and the JS agree on one convention.
 */
function toSemanticScore(distance: number | null): number | undefined {
  if (distance === null || !Number.isFinite(distance)) return undefined;
  return Math.max(0, Math.min(1, (2 - distance) / 2));
}

export async function findJobsWithinRadius(
  options: JobRadiusSearchOptions,
): Promise<JobWithDistance[]> {
  const { center, radiusKm } = options;
  const limit = Math.min(options.limit ?? 200, 1000);
  const point = `SRID=4326;POINT(${center.lon} ${center.lat})`;

  const rows = await queryRows<
    JobRow & { distance_km: number | null; semantic_distance: number | null }
  >(
    `
      SELECT ${JOB_COLUMNS},
             ST_Distance(COALESCE(j.location, c.location), $1::geography) / 1000.0 AS distance_km,
             CASE WHEN $9::vector IS NULL OR j.embedding IS NULL THEN NULL
                  ELSE j.embedding <=> $9::vector END AS semantic_distance
      FROM jobs j
      LEFT JOIN companies c ON c.id = j.company_id
      WHERE COALESCE(j.location, c.location) IS NOT NULL
        AND ST_DWithin(COALESCE(j.location, c.location), $1::geography, $2)
        AND ($3::boolean IS FALSE OR j.is_active)
        AND ($4::text IS NULL OR j.normalized_title % $4 OR j.normalized_title ILIKE '%' || $4 || '%')
        AND ($5::text[] IS NULL OR EXISTS (
              SELECT 1 FROM job_skills js JOIN skills s ON s.id = js.skill_id
              WHERE js.job_id = j.id AND s.normalized_name = ANY($5::text[])
            ))
        AND ($6::text[] IS NULL OR j.work_model = ANY($6::text[]))
        AND ($7::text[] IS NULL OR j.employment_type = ANY($7::text[]))
      ORDER BY distance_km ASC
      LIMIT $8
    `,
    [
      point,
      radiusKm * 1000,
      options.activeOnly ?? true,
      options.titleQuery ? normalizeJobTitle(options.titleQuery) : null,
      options.skills?.length ? options.skills : null,
      options.workModels?.length ? options.workModels : null,
      options.employmentTypes?.length ? options.employmentTypes : null,
      limit,
      options.queryEmbedding ? toVectorLiteral(options.queryEmbedding) : null,
    ],
  );

  return rows.map((row) => ({
    job: mapJobRow(row),
    distanceKm: row.distance_km === null ? undefined : Number(row.distance_km),
    semanticSimilarity: toSemanticScore(
      row.semantic_distance === null ? null : Number(row.semantic_distance),
    ),
  }));
}

export async function findJobsByCompany(companyId: string, activeOnly = true): Promise<Job[]> {
  const rows = await queryRows<JobRow>(
    `
      SELECT ${JOB_COLUMNS} FROM jobs j
      WHERE j.company_id = $1 AND ($2::boolean IS FALSE OR j.is_active)
      ORDER BY j.published_at DESC NULLS LAST
      LIMIT 200
    `,
    [companyId, activeOnly],
  );
  return rows.map(mapJobRow);
}

/**
 * Marks a job inactive rather than deleting it (plan section 32) so that a
 * transient 404 does not destroy history.
 */
export async function markJobInactive(jobId: string): Promise<void> {
  await query(
    `UPDATE jobs SET is_active = FALSE, inactive_since = COALESCE(inactive_since, now()),
       last_verified_at = now() WHERE id = $1`,
    [jobId],
  );
}

export async function markJobVerified(jobId: string): Promise<void> {
  await query(`UPDATE jobs SET last_verified_at = now(), is_active = TRUE WHERE id = $1`, [jobId]);
}

export async function findJobsDueForVerification(
  olderThanHours: number,
  limit = 100,
): Promise<Job[]> {
  const rows = await queryRows<JobRow>(
    `
      SELECT ${JOB_COLUMNS} FROM jobs j
      WHERE j.is_active
        AND (j.last_verified_at IS NULL OR j.last_verified_at < now() - make_interval(hours => $1))
      ORDER BY j.last_verified_at ASC NULLS FIRST
      LIMIT $2
    `,
    [olderThanHours, limit],
  );
  return rows.map(mapJobRow);
}

export async function setJobEmbedding(jobId: string, embedding: readonly number[]): Promise<void> {
  await query(`UPDATE jobs SET embedding = $2::vector WHERE id = $1`, [
    jobId,
    toVectorLiteral(embedding),
  ]);
}

/** Semantic neighbours via pgvector cosine distance. */
export async function findSimilarJobsByEmbedding(
  embedding: readonly number[],
  limit = 20,
): Promise<JobWithDistance[]> {
  const rows = await queryRows<JobRow & { distance_km: null }>(
    `
      SELECT ${JOB_COLUMNS}
      FROM jobs j
      WHERE j.embedding IS NOT NULL AND j.is_active
      ORDER BY j.embedding <=> $1::vector
      LIMIT $2
    `,
    [toVectorLiteral(embedding), limit],
  );
  return rows.map((row) => ({ job: mapJobRow(row), distanceKm: undefined }));
}

export async function countJobs(activeOnly = true): Promise<number> {
  const row = await queryOne<{ count: string }>(
    `SELECT count(*)::text AS count FROM jobs WHERE $1::boolean IS FALSE OR is_active`,
    [activeOnly],
  );
  return Number(row?.count ?? 0);
}

/** Active jobs with no embedding yet, for the backfill worker. */
export async function findJobsMissingEmbedding(limit = 100): Promise<Job[]> {
  const rows = await queryRows<JobRow>(
    `SELECT ${JOB_COLUMNS} FROM jobs j WHERE j.embedding IS NULL AND j.is_active LIMIT $1`,
    [limit],
  );
  return rows.map(mapJobRow);
}
