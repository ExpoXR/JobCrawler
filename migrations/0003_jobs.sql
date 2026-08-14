-- Jobs, their provenance and their skill links (plan sections 15 and 17).

CREATE TABLE IF NOT EXISTS jobs (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id                  UUID REFERENCES companies (id) ON DELETE SET NULL,
  company_name                TEXT,
  title                       TEXT NOT NULL,
  normalized_title            TEXT NOT NULL,
  location_text               TEXT,
  city                        TEXT,
  region                      TEXT,
  country                     TEXT,
  country_code                CHAR(2),
  location                    geography(Point, 4326),
  work_model                  TEXT NOT NULL DEFAULT 'unknown'
                                CHECK (work_model IN ('remote', 'hybrid', 'onsite', 'unknown')),
  employment_type             TEXT NOT NULL DEFAULT 'unknown',
  seniority                   TEXT NOT NULL DEFAULT 'unknown',
  salary_min                  NUMERIC(12, 2),
  salary_max                  NUMERIC(12, 2),
  salary_currency             CHAR(3),
  salary_period               TEXT CHECK (salary_period IN ('hour', 'day', 'month', 'year')),
  required_experience_years   SMALLINT,
  preferred_experience_years  SMALLINT,
  languages                   TEXT[] NOT NULL DEFAULT '{}',
  description                 TEXT,
  ai_summary                  TEXT,
  application_url             TEXT,
  canonical_url               TEXT,
  content_hash                TEXT,
  embedding                   vector(1536),
  published_at                TIMESTAMPTZ,
  expires_at                  TIMESTAMPTZ,
  discovered_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_verified_at            TIMESTAMPTZ,
  is_active                   BOOLEAN NOT NULL DEFAULT TRUE,
  inactive_since              TIMESTAMPTZ,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT jobs_salary_range CHECK (
    salary_min IS NULL OR salary_max IS NULL OR salary_min <= salary_max
  )
);

-- Primary dedup key: same employer + same normalised title + same city.
CREATE UNIQUE INDEX IF NOT EXISTS jobs_dedup_key
  ON jobs (COALESCE(company_id::text, ''), normalized_title, COALESCE(city, ''));
CREATE UNIQUE INDEX IF NOT EXISTS jobs_canonical_url_key ON jobs (canonical_url)
  WHERE canonical_url IS NOT NULL;

CREATE INDEX IF NOT EXISTS jobs_location_idx ON jobs USING GIST (location);
CREATE INDEX IF NOT EXISTS jobs_company_idx ON jobs (company_id);
CREATE INDEX IF NOT EXISTS jobs_active_idx ON jobs (is_active, published_at DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS jobs_title_trgm_idx ON jobs USING GIN (normalized_title gin_trgm_ops);
CREATE INDEX IF NOT EXISTS jobs_verify_idx ON jobs (last_verified_at NULLS FIRST) WHERE is_active;

-- Every place a job was seen. Merged duplicates keep all their sources
-- (plan section 17); `is_primary` marks the employer's own posting.
CREATE TABLE IF NOT EXISTS job_sources (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id        UUID NOT NULL REFERENCES jobs (id) ON DELETE CASCADE,
  provider      TEXT NOT NULL,
  url           TEXT NOT NULL,
  is_primary    BOOLEAN NOT NULL DEFAULT FALSE,
  raw_payload   JSONB,
  retrieved_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (job_id, url)
);

CREATE INDEX IF NOT EXISTS job_sources_job_idx ON job_sources (job_id);
CREATE INDEX IF NOT EXISTS job_sources_url_idx ON job_sources (url);

CREATE TABLE IF NOT EXISTS job_skills (
  job_id      UUID NOT NULL REFERENCES jobs (id) ON DELETE CASCADE,
  skill_id    UUID NOT NULL REFERENCES skills (id) ON DELETE CASCADE,
  requirement TEXT NOT NULL DEFAULT 'required'
                CHECK (requirement IN ('required', 'preferred', 'mentioned')),
  PRIMARY KEY (job_id, skill_id)
);

CREATE INDEX IF NOT EXISTS job_skills_skill_idx ON job_skills (skill_id);
