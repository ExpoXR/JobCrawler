-- Search sessions, their results and AI analyses.
--
-- A session is anonymous: no account, no user identifier, only the query that
-- produced it (plan sections 1 and 40).

CREATE TABLE IF NOT EXISTS search_sessions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  mode            TEXT NOT NULL CHECK (mode IN ('jobs', 'candidates')),
  query           JSONB NOT NULL,
  raw_query       TEXT,
  location_text   TEXT,
  location        geography(Point, 4326),
  radius_km       INTEGER NOT NULL DEFAULT 50,
  stage           TEXT NOT NULL DEFAULT 'queued',
  percent         SMALLINT NOT NULL DEFAULT 0 CHECK (percent BETWEEN 0 AND 100),
  status_message  TEXT,
  result_count    INTEGER NOT NULL DEFAULT 0,
  errors          JSONB NOT NULL DEFAULT '[]'::jsonb,
  started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at     TIMESTAMPTZ,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at      TIMESTAMPTZ NOT NULL DEFAULT now() + INTERVAL '30 days'
);

CREATE INDEX IF NOT EXISTS search_sessions_started_idx ON search_sessions (started_at DESC);
CREATE INDEX IF NOT EXISTS search_sessions_expiry_idx ON search_sessions (expires_at);

CREATE TABLE IF NOT EXISTS search_results (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  search_id     UUID NOT NULL REFERENCES search_sessions (id) ON DELETE CASCADE,
  kind          TEXT NOT NULL CHECK (kind IN ('job', 'potential_employer', 'candidate')),
  job_id        UUID REFERENCES jobs (id) ON DELETE CASCADE,
  company_id    UUID REFERENCES companies (id) ON DELETE CASCADE,
  candidate_id  UUID REFERENCES candidates (id) ON DELETE CASCADE,
  score         REAL NOT NULL DEFAULT 0,
  distance_km   REAL,
  components    JSONB NOT NULL DEFAULT '[]'::jsonb,
  evidence      JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT search_results_subject CHECK (
    (kind = 'job' AND job_id IS NOT NULL)
    OR (kind = 'potential_employer' AND company_id IS NOT NULL)
    OR (kind = 'candidate' AND candidate_id IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS search_results_search_idx ON search_results (search_id, score DESC);
CREATE UNIQUE INDEX IF NOT EXISTS search_results_unique_job
  ON search_results (search_id, job_id) WHERE job_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS search_results_unique_company
  ON search_results (search_id, company_id) WHERE kind = 'potential_employer';
CREATE UNIQUE INDEX IF NOT EXISTS search_results_unique_candidate
  ON search_results (search_id, candidate_id) WHERE candidate_id IS NOT NULL;

-- Cached AI output, keyed by subject + kind + prompt version so that a prompt
-- change invalidates naturally instead of serving stale analysis.
CREATE TABLE IF NOT EXISTS ai_analysis (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_type    TEXT NOT NULL CHECK (subject_type IN ('job', 'company', 'candidate', 'query')),
  subject_id      TEXT NOT NULL,
  analysis_kind   TEXT NOT NULL,
  prompt_version  TEXT NOT NULL DEFAULT 'v1',
  provider        TEXT NOT NULL,
  model           TEXT NOT NULL,
  input_hash      TEXT NOT NULL,
  output          JSONB NOT NULL,
  sources         JSONB NOT NULL DEFAULT '[]'::jsonb,
  token_usage     JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at      TIMESTAMPTZ,
  UNIQUE (subject_type, subject_id, analysis_kind, prompt_version, input_hash)
);

CREATE INDEX IF NOT EXISTS ai_analysis_subject_idx ON ai_analysis (subject_type, subject_id);
