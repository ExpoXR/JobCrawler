import type {
  MatchResult,
  SearchProgress,
  SearchQuery,
  SearchResultItem,
  SearchResultKind,
  SearchStage,
} from '@ejc/shared';

import { query, queryOne, queryRows } from '../pool';
import { COMPANY_COLUMNS, mapCompanyRow, type CompanyRow } from './companies';
import { JOB_COLUMNS, mapJobRow, type JobRow } from './jobs';

export interface SearchSessionRow {
  id: string;
  mode: 'jobs' | 'candidates';
  query: SearchQuery;
  raw_query: string | null;
  location_text: string | null;
  lat: number | null;
  lon: number | null;
  radius_km: number;
  stage: SearchStage;
  percent: number;
  status_message: string | null;
  result_count: number;
  errors: string[];
  started_at: Date;
  finished_at: Date | null;
  updated_at: Date;
}

const SESSION_COLUMNS = `
  id, mode, query, raw_query, location_text,
  ST_Y(location::geometry) AS lat,
  ST_X(location::geometry) AS lon,
  radius_km, stage, percent, status_message, result_count, errors, started_at, finished_at,
  updated_at
`;

export async function createSearchSession(searchQuery: SearchQuery): Promise<string> {
  const row = await queryOne<{ id: string }>(
    `
      INSERT INTO search_sessions (
        mode, query, raw_query, location_text, location, radius_km, stage, status_message
      ) VALUES (
        $1, $2::jsonb, $3, $4,
        CASE WHEN $5::float8 IS NULL OR $6::float8 IS NULL THEN NULL
             ELSE ST_SetSRID(ST_MakePoint($5::float8, $6::float8), 4326)::geography END,
        $7, 'queued', 'Search queued'
      )
      RETURNING id
    `,
    [
      searchQuery.mode,
      JSON.stringify(searchQuery),
      searchQuery.rawQuery ?? null,
      searchQuery.locationText,
      searchQuery.location?.lon ?? null,
      searchQuery.location?.lat ?? null,
      Math.round(searchQuery.radiusKm),
    ],
  );
  if (!row) throw new Error('Failed to create search session');
  return row.id;
}

export async function getSearchSession(searchId: string): Promise<SearchSessionRow | undefined> {
  return queryOne<SearchSessionRow>(
    `SELECT ${SESSION_COLUMNS} FROM search_sessions WHERE id = $1`,
    [searchId],
  );
}

export interface ProgressUpdate {
  stage: SearchStage;
  percent: number;
  message: string;
  resultCount?: number;
  error?: string;
}

/**
 * Advances a search's progress.
 *
 * `percent` is clamped to be monotonically non-decreasing so the UI progress
 * bar never jumps backwards when workers report out of order.
 */
export async function updateSearchProgress(
  searchId: string,
  update: ProgressUpdate,
): Promise<void> {
  const terminal = update.stage === 'completed' || update.stage === 'failed';
  await query(
    `
      UPDATE search_sessions SET
        stage = $2,
        percent = GREATEST(percent, LEAST(100, GREATEST(0, $3::int))),
        status_message = $4,
        result_count = COALESCE($5, result_count),
        errors = CASE WHEN $6::text IS NULL THEN errors ELSE errors || to_jsonb($6::text) END,
        finished_at = CASE WHEN $7 THEN now() ELSE finished_at END,
        updated_at = now()
      WHERE id = $1
    `,
    [
      searchId,
      update.stage,
      Math.round(update.percent),
      update.message,
      update.resultCount ?? null,
      update.error ?? null,
      terminal,
    ],
  );
}

export async function getSearchProgress(searchId: string): Promise<SearchProgress | undefined> {
  const row = await queryOne<{
    id: string;
    stage: SearchStage;
    percent: number;
    status_message: string | null;
    result_count: number;
    errors: string[];
    updated_at: Date;
  }>(
    `SELECT id, stage, percent, status_message, result_count, errors, updated_at
     FROM search_sessions WHERE id = $1`,
    [searchId],
  );
  if (!row) return undefined;

  return {
    searchId: row.id,
    stage: row.stage,
    percent: row.percent,
    message: row.status_message ?? '',
    resultCount: row.result_count,
    updatedAt: row.updated_at.toISOString(),
    errors: row.errors ?? [],
  };
}

export interface SearchResultInput {
  kind: SearchResultKind;
  jobId?: string | undefined;
  companyId?: string | undefined;
  candidateId?: string | undefined;
  match: MatchResult;
  distanceKm?: number | undefined;
}

/** Upserts scored results; re-running the matcher refreshes scores in place. */
export async function saveSearchResults(
  searchId: string,
  results: readonly SearchResultInput[],
): Promise<void> {
  if (results.length === 0) return;

  for (const result of results) {
    await query(
      `
        INSERT INTO search_results (
          search_id, kind, job_id, company_id, candidate_id, score, distance_km, components, evidence
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb)
        ON CONFLICT DO NOTHING
      `,
      [
        searchId,
        result.kind,
        result.jobId ?? null,
        result.companyId ?? null,
        result.candidateId ?? null,
        result.match.score,
        result.distanceKm ?? null,
        JSON.stringify(result.match.components),
        JSON.stringify(result.match.evidence),
      ],
    );
  }

  await query(
    `UPDATE search_sessions SET result_count = (
       SELECT count(*) FROM search_results WHERE search_id = $1
     ), updated_at = now() WHERE id = $1`,
    [searchId],
  );
}

interface ResultRow {
  result_id: string;
  kind: SearchResultKind;
  score: number;
  distance_km: number | null;
  components: MatchResult['components'];
  evidence: MatchResult['evidence'];
  job_id: string | null;
  company_id: string | null;
  candidate_id: string | null;
}

export interface ListResultsOptions {
  limit?: number;
  offset?: number;
  minScore?: number;
  kinds?: SearchResultKind[];
}

export async function listSearchResults(
  searchId: string,
  options: ListResultsOptions = {},
): Promise<SearchResultItem[]> {
  const limit = Math.min(options.limit ?? 100, 500);

  const rows = await queryRows<ResultRow>(
    `
      SELECT id AS result_id, kind, score, distance_km, components, evidence,
             job_id, company_id, candidate_id
      FROM search_results
      WHERE search_id = $1
        AND score >= $2
        AND ($3::text[] IS NULL OR kind = ANY($3::text[]))
      ORDER BY score DESC, distance_km ASC NULLS LAST
      LIMIT $4 OFFSET $5
    `,
    [
      searchId,
      options.minScore ?? 0,
      options.kinds?.length ? options.kinds : null,
      limit,
      options.offset ?? 0,
    ],
  );

  // Batch-load the referenced entities so the result query stays a simple scan
  // over the (search_id, score) index.
  const jobIds = [...new Set(rows.flatMap((row) => (row.job_id ? [row.job_id] : [])))];
  const companyIds = [...new Set(rows.flatMap((row) => (row.company_id ? [row.company_id] : [])))];

  const [jobRows, companyRows] = await Promise.all([
    jobIds.length
      ? queryRows<JobRow>(`SELECT ${JOB_COLUMNS} FROM jobs j WHERE j.id = ANY($1::uuid[])`, [jobIds])
      : Promise.resolve([]),
    companyIds.length
      ? queryRows<CompanyRow>(
          `SELECT ${COMPANY_COLUMNS} FROM companies WHERE id = ANY($1::uuid[])`,
          [companyIds],
        )
      : Promise.resolve([]),
  ]);

  const jobsById = new Map(jobRows.map((row) => [row.id, mapJobRow(row)]));
  const companiesById = new Map(companyRows.map((row) => [row.id, mapCompanyRow(row)]));

  return rows.map((row) => {
    const item: SearchResultItem = {
      id: row.result_id,
      kind: row.kind,
      match: {
        score: Number(row.score),
        rejected: false,
        rejectionReasons: [],
        components: row.components ?? [],
        evidence: row.evidence ?? [],
      },
    };
    if (row.distance_km !== null) item.distanceKm = Number(row.distance_km);

    const job = row.job_id ? jobsById.get(row.job_id) : undefined;
    if (job) item.job = job;

    const companyId = row.company_id ?? job?.companyId;
    const company = companyId ? companiesById.get(companyId) : undefined;
    if (company) item.company = company;

    return item;
  });
}

export async function deleteExpiredSearchSessions(): Promise<number> {
  const result = await query(`DELETE FROM search_sessions WHERE expires_at < now()`);
  return result.rowCount ?? 0;
}

export interface SearchStats {
  total: number;
  last24h: number;
  averageResults: number;
}

export async function getSearchStats(): Promise<SearchStats> {
  const row = await queryOne<{ total: string; last24h: string; avg: string | null }>(
    `
      SELECT
        count(*)::text AS total,
        count(*) FILTER (WHERE started_at > now() - interval '24 hours')::text AS last24h,
        avg(result_count)::text AS avg
      FROM search_sessions
    `,
  );
  return {
    total: Number(row?.total ?? 0),
    last24h: Number(row?.last24h ?? 0),
    averageResults: Math.round(Number(row?.avg ?? 0)),
  };
}
