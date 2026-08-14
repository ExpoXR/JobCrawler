-- Public professional profiles (plan section 16).
--
-- GDPR note: this table stores the minimum needed to point a recruiter back at
-- a public source. No full profile copies, no contact harvesting, and every row
-- carries its provenance so it can be deleted on request (plan section 40).

CREATE TABLE IF NOT EXISTS candidates (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  public_name           TEXT,
  public_title          TEXT,
  approximate_location  TEXT,
  city                  TEXT,
  country_code          CHAR(2),
  location              geography(Point, 4326),
  skills                TEXT[] NOT NULL DEFAULT '{}',
  technologies          TEXT[] NOT NULL DEFAULT '{}',
  profile_url           TEXT NOT NULL UNIQUE,
  portfolio_url         TEXT,
  github_url            TEXT,
  ai_summary            TEXT,
  embedding             vector(1536),
  is_removed            BOOLEAN NOT NULL DEFAULT FALSE,
  removal_reason        TEXT,
  discovered_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_checked_at       TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS candidates_location_idx ON candidates USING GIST (location);
CREATE INDEX IF NOT EXISTS candidates_skills_idx ON candidates USING GIN (skills);
CREATE INDEX IF NOT EXISTS candidates_active_idx ON candidates (is_removed, last_checked_at NULLS FIRST);

CREATE TABLE IF NOT EXISTS candidate_sources (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  candidate_id  UUID NOT NULL REFERENCES candidates (id) ON DELETE CASCADE,
  provider      TEXT NOT NULL,
  url           TEXT NOT NULL,
  retrieved_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (candidate_id, url)
);

CREATE TABLE IF NOT EXISTS candidate_skills (
  candidate_id  UUID NOT NULL REFERENCES candidates (id) ON DELETE CASCADE,
  skill_id      UUID NOT NULL REFERENCES skills (id) ON DELETE CASCADE,
  confidence    REAL NOT NULL DEFAULT 0.5,
  source_url    TEXT,
  PRIMARY KEY (candidate_id, skill_id)
);

-- Suppression list: a removal request must survive re-discovery.
CREATE TABLE IF NOT EXISTS removal_requests (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_type  TEXT NOT NULL CHECK (subject_type IN ('candidate', 'domain', 'company')),
  subject_key   TEXT NOT NULL,
  reason        TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (subject_type, subject_key)
);
