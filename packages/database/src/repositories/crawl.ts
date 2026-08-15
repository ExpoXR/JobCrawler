import { query, queryOne, queryRows } from '../pool';

/** Cached page fetches, robots decisions and the domain blocklist. */

export interface CrawledPageInput {
  url: string;
  domain: string;
  companyId?: string | undefined;
  canonicalUrl?: string | undefined;
  category?: 'career' | 'job' | 'company' | 'contact' | 'other';
  statusCode?: number | undefined;
  contentType?: string | undefined;
  contentHash?: string | undefined;
  title?: string | undefined;
  textExcerpt?: string | undefined;
  byteSize?: number | undefined;
  fetchDurationMs?: number | undefined;
  errorType?: string | undefined;
  errorMessage?: string | undefined;
  /** How long the cached copy stays valid. */
  ttlHours?: number;
}

export async function recordCrawledPage(input: CrawledPageInput): Promise<void> {
  await query(
    `
      INSERT INTO crawled_pages (
        url, domain, company_id, canonical_url, category, status_code, content_type,
        content_hash, title, text_excerpt, byte_size, fetch_duration_ms, error_type,
        error_message, fetched_at, expires_at
      ) VALUES (
        $1, $2, $3, $4, COALESCE($5, 'other'), $6, $7, $8, $9, $10, $11, $12, $13, $14,
        now(), now() + make_interval(hours => $15)
      )
      ON CONFLICT (url) DO UPDATE SET
        domain = EXCLUDED.domain,
        company_id = COALESCE(EXCLUDED.company_id, crawled_pages.company_id),
        canonical_url = COALESCE(EXCLUDED.canonical_url, crawled_pages.canonical_url),
        category = EXCLUDED.category,
        status_code = EXCLUDED.status_code,
        content_type = EXCLUDED.content_type,
        content_hash = EXCLUDED.content_hash,
        title = COALESCE(EXCLUDED.title, crawled_pages.title),
        text_excerpt = COALESCE(EXCLUDED.text_excerpt, crawled_pages.text_excerpt),
        byte_size = EXCLUDED.byte_size,
        fetch_duration_ms = EXCLUDED.fetch_duration_ms,
        error_type = EXCLUDED.error_type,
        error_message = EXCLUDED.error_message,
        fetched_at = now(),
        expires_at = EXCLUDED.expires_at
    `,
    [
      input.url,
      input.domain,
      input.companyId ?? null,
      input.canonicalUrl ?? null,
      input.category ?? null,
      input.statusCode ?? null,
      input.contentType ?? null,
      input.contentHash ?? null,
      input.title ?? null,
      input.textExcerpt ?? null,
      input.byteSize ?? null,
      input.fetchDurationMs ?? null,
      input.errorType ?? null,
      input.errorMessage ?? null,
      input.ttlHours ?? 24 * 7,
    ],
  );
}

export interface CachedPage {
  url: string;
  statusCode: number | null;
  contentHash: string | null;
  title: string | null;
  textExcerpt: string | null;
  fetchedAt: Date;
}

/** Returns a still-valid cached fetch, or undefined when the TTL has passed. */
export async function getFreshCrawledPage(url: string): Promise<CachedPage | undefined> {
  const row = await queryOne<{
    url: string;
    status_code: number | null;
    content_hash: string | null;
    title: string | null;
    text_excerpt: string | null;
    fetched_at: Date;
  }>(
    `SELECT url, status_code, content_hash, title, text_excerpt, fetched_at
     FROM crawled_pages WHERE url = $1 AND expires_at > now()`,
    [url],
  );
  if (!row) return undefined;
  return {
    url: row.url,
    statusCode: row.status_code,
    contentHash: row.content_hash,
    title: row.title,
    textExcerpt: row.text_excerpt,
    fetchedAt: row.fetched_at,
  };
}

export interface RobotsCacheEntry {
  domain: string;
  body: string | null;
  crawlDelayMs: number | null;
  statusCode: number | null;
}

export async function getRobotsCache(domain: string): Promise<RobotsCacheEntry | undefined> {
  const row = await queryOne<{
    domain: string;
    body: string | null;
    crawl_delay_ms: number | null;
    status_code: number | null;
  }>(
    `SELECT domain, body, crawl_delay_ms, status_code FROM robots_cache
     WHERE domain = $1 AND expires_at > now()`,
    [domain],
  );
  if (!row) return undefined;
  return {
    domain: row.domain,
    body: row.body,
    crawlDelayMs: row.crawl_delay_ms,
    statusCode: row.status_code,
  };
}

export async function setRobotsCache(
  entry: RobotsCacheEntry & { ttlHours?: number },
): Promise<void> {
  await query(
    `
      INSERT INTO robots_cache (domain, body, crawl_delay_ms, status_code, fetched_at, expires_at)
      VALUES ($1, $2, $3, $4, now(), now() + make_interval(hours => $5))
      ON CONFLICT (domain) DO UPDATE SET
        body = EXCLUDED.body,
        crawl_delay_ms = EXCLUDED.crawl_delay_ms,
        status_code = EXCLUDED.status_code,
        fetched_at = now(),
        expires_at = EXCLUDED.expires_at
    `,
    [entry.domain, entry.body, entry.crawlDelayMs, entry.statusCode, entry.ttlHours ?? 24],
  );
}

export async function listBlockedDomains(): Promise<string[]> {
  const rows = await queryRows<{ domain: string }>(
    `SELECT domain FROM blocked_domains ORDER BY domain`,
  );
  return rows.map((row) => row.domain);
}

export async function blockDomain(domain: string, reason?: string, by?: string): Promise<void> {
  await query(
    `INSERT INTO blocked_domains (domain, reason, created_by) VALUES ($1, $2, $3)
     ON CONFLICT (domain) DO UPDATE SET reason = EXCLUDED.reason`,
    [domain.toLowerCase(), reason ?? null, by ?? null],
  );
}

export async function unblockDomain(domain: string): Promise<void> {
  await query(`DELETE FROM blocked_domains WHERE domain = $1`, [domain.toLowerCase()]);
}

export async function isDomainBlocked(domain: string): Promise<boolean> {
  const row = await queryOne<{ exists: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM blocked_domains WHERE domain = $1) AS exists`,
    [domain.toLowerCase()],
  );
  return row?.exists ?? false;
}

export interface CrawlJobRecord {
  id: string;
  domain: string;
  startUrl: string;
  status: string;
  pagesFetched: number;
  jobsFound: number;
  errorType: string | null;
  errorMessage: string | null;
  createdAt: Date;
  finishedAt: Date | null;
}

export async function startCrawlJob(input: {
  searchId?: string | undefined;
  companyId?: string | undefined;
  domain: string;
  startUrl: string;
  queue: string;
}): Promise<string> {
  const row = await queryOne<{ id: string }>(
    `
      INSERT INTO crawl_jobs (search_id, company_id, domain, start_url, queue, status, started_at)
      VALUES ($1, $2, $3, $4, $5, 'running', now())
      RETURNING id
    `,
    [input.searchId ?? null, input.companyId ?? null, input.domain, input.startUrl, input.queue],
  );
  if (!row) throw new Error('Failed to create crawl job');
  return row.id;
}

export async function finishCrawlJob(
  id: string,
  outcome: {
    status: 'completed' | 'failed' | 'skipped';
    pagesFetched?: number;
    jobsFound?: number;
    errorType?: string | undefined;
    errorMessage?: string | undefined;
  },
): Promise<void> {
  await query(
    `
      UPDATE crawl_jobs SET
        status = $2,
        pages_fetched = COALESCE($3, pages_fetched),
        jobs_found = COALESCE($4, jobs_found),
        error_type = $5,
        error_message = $6,
        finished_at = now()
      WHERE id = $1
    `,
    [
      id,
      outcome.status,
      outcome.pagesFetched ?? null,
      outcome.jobsFound ?? null,
      outcome.errorType ?? null,
      outcome.errorMessage ?? null,
    ],
  );
}

export async function listRecentCrawlJobs(limit = 50): Promise<CrawlJobRecord[]> {
  const rows = await queryRows<{
    id: string;
    domain: string;
    start_url: string;
    status: string;
    pages_fetched: number;
    jobs_found: number;
    error_type: string | null;
    error_message: string | null;
    created_at: Date;
    finished_at: Date | null;
  }>(
    `SELECT id, domain, start_url, status, pages_fetched, jobs_found, error_type, error_message,
            created_at, finished_at
     FROM crawl_jobs ORDER BY created_at DESC LIMIT $1`,
    [Math.min(limit, 200)],
  );
  return rows.map((row) => ({
    id: row.id,
    domain: row.domain,
    startUrl: row.start_url,
    status: row.status,
    pagesFetched: row.pages_fetched,
    jobsFound: row.jobs_found,
    errorType: row.error_type,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    finishedAt: row.finished_at,
  }));
}

/** Geocoding cache — Nominatim's usage policy expects results to be reused. */
export async function getCachedGeocode<T>(key: string): Promise<T | undefined> {
  const row = await queryOne<{ results: T }>(
    `SELECT results FROM geocode_cache WHERE query_key = $1 AND expires_at > now()`,
    [key],
  );
  return row?.results;
}

export async function setCachedGeocode(
  key: string,
  provider: string,
  results: unknown,
  ttlDays = 30,
): Promise<void> {
  await query(
    `
      INSERT INTO geocode_cache (query_key, provider, results, expires_at)
      VALUES ($1, $2, $3::jsonb, now() + make_interval(days => $4))
      ON CONFLICT (query_key) DO UPDATE SET
        results = EXCLUDED.results, provider = EXCLUDED.provider, expires_at = EXCLUDED.expires_at
    `,
    [key, provider, JSON.stringify(results), ttlDays],
  );
}

export async function clearExpiredCaches(): Promise<{ pages: number; geocode: number }> {
  const pages = await query(`DELETE FROM crawled_pages WHERE expires_at < now()`);
  const geocode = await query(`DELETE FROM geocode_cache WHERE expires_at < now()`);
  return { pages: pages.rowCount ?? 0, geocode: geocode.rowCount ?? 0 };
}
