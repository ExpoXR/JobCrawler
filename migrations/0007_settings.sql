-- Runtime settings editable from the admin dashboard (plan sections 22 and 33).
--
-- Secrets are never stored here in plaintext by the application: the AI/embedding
-- API keys come from the environment. `provider_settings.secret_ref` names the
-- environment variable to read instead, so the database never holds a key.

CREATE TABLE IF NOT EXISTS settings (
  key         TEXT PRIMARY KEY,
  value       JSONB NOT NULL,
  description TEXT,
  updated_by  TEXT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS provider_settings (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_key  TEXT NOT NULL UNIQUE,
  kind          TEXT NOT NULL CHECK (kind IN ('ai', 'embedding', 'geocoding', 'company', 'job', 'candidate', 'search')),
  enabled       BOOLEAN NOT NULL DEFAULT FALSE,
  model         TEXT,
  base_url      TEXT,
  secret_ref    TEXT,
  temperature   REAL,
  timeout_ms    INTEGER,
  max_tokens    INTEGER,
  options       JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO settings (key, value, description)
VALUES
  ('crawler.enabled', 'true'::jsonb, 'Master switch for live crawling'),
  ('crawler.max_domains_per_search', '25'::jsonb, 'Domains visited per search'),
  ('crawler.max_pages_per_domain', '15'::jsonb, 'Pages fetched per domain'),
  ('recrawl.job_hours', '24'::jsonb, 'Re-verify active jobs after N hours'),
  ('recrawl.company_days', '14'::jsonb, 'Re-verify companies after N days'),
  ('recrawl.candidate_days', '30'::jsonb, 'Re-check candidate profiles after N days'),
  ('search.max_results', '200'::jsonb, 'Maximum results returned per search')
ON CONFLICT (key) DO NOTHING;
