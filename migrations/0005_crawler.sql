-- Crawler bookkeeping: fetched pages, crawl attempts, provider registry and
-- the domain blocklist that backs both admin removals and SSRF defence.

CREATE TABLE IF NOT EXISTS crawled_pages (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      UUID REFERENCES companies (id) ON DELETE CASCADE,
  url             TEXT NOT NULL UNIQUE,
  domain          TEXT NOT NULL,
  canonical_url   TEXT,
  category        TEXT NOT NULL DEFAULT 'other'
                    CHECK (category IN ('career', 'job', 'company', 'contact', 'other')),
  status_code     INTEGER,
  content_type    TEXT,
  content_hash    TEXT,
  title           TEXT,
  text_excerpt    TEXT,
  byte_size       INTEGER,
  fetch_duration_ms INTEGER,
  error_type      TEXT,
  error_message   TEXT,
  fetched_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at      TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS crawled_pages_domain_idx ON crawled_pages (domain);
CREATE INDEX IF NOT EXISTS crawled_pages_company_idx ON crawled_pages (company_id);
CREATE INDEX IF NOT EXISTS crawled_pages_expiry_idx ON crawled_pages (expires_at);

-- One row per crawl attempt against a domain, for the admin crawler view.
CREATE TABLE IF NOT EXISTS crawl_jobs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  search_id     UUID,
  company_id    UUID REFERENCES companies (id) ON DELETE SET NULL,
  domain        TEXT NOT NULL,
  start_url     TEXT NOT NULL,
  queue         TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'queued'
                  CHECK (status IN ('queued', 'running', 'completed', 'failed', 'skipped')),
  pages_fetched INTEGER NOT NULL DEFAULT 0,
  jobs_found    INTEGER NOT NULL DEFAULT 0,
  retry_count   INTEGER NOT NULL DEFAULT 0,
  error_type    TEXT,
  error_message TEXT,
  started_at    TIMESTAMPTZ,
  finished_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS crawl_jobs_status_idx ON crawl_jobs (status, created_at DESC);
CREATE INDEX IF NOT EXISTS crawl_jobs_search_idx ON crawl_jobs (search_id);

-- Cached robots.txt decisions, so a domain is fetched once per TTL.
CREATE TABLE IF NOT EXISTS robots_cache (
  domain        TEXT PRIMARY KEY,
  body          TEXT,
  crawl_delay_ms INTEGER,
  status_code   INTEGER,
  fetched_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at    TIMESTAMPTZ NOT NULL
);

-- Registry of external sources (plan section 11): capabilities are advertised
-- by the provider implementation and mirrored here so admins can toggle them.
CREATE TABLE IF NOT EXISTS source_providers (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key           TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('geocoding', 'company', 'job', 'candidate', 'crawler', 'search')),
  capabilities  TEXT[] NOT NULL DEFAULT '{}',
  enabled       BOOLEAN NOT NULL DEFAULT TRUE,
  rate_limit_per_minute INTEGER,
  config        JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_success_at TIMESTAMPTZ,
  last_error_at   TIMESTAMPTZ,
  last_error     TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS blocked_domains (
  domain      TEXT PRIMARY KEY,
  reason      TEXT,
  created_by  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Geocoding cache (plan section 34): Nominatim's usage policy expects it.
CREATE TABLE IF NOT EXISTS geocode_cache (
  query_key   TEXT PRIMARY KEY,
  provider    TEXT NOT NULL,
  results     JSONB NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS geocode_cache_expiry_idx ON geocode_cache (expires_at);
