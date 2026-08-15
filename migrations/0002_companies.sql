-- Companies and their physical locations (plan section 14).

CREATE TABLE IF NOT EXISTS companies (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                TEXT NOT NULL,
  normalized_name     TEXT NOT NULL,
  domain              TEXT,
  website             TEXT,
  description         TEXT,
  industry            TEXT,
  address             TEXT,
  city                TEXT,
  region              TEXT,
  country             TEXT,
  country_code        CHAR(2),
  location            geography(Point, 4326),
  technologies        TEXT[] NOT NULL DEFAULT '{}',
  services            TEXT[] NOT NULL DEFAULT '{}',
  size_bucket         TEXT,
  employee_count_min  INTEGER,
  employee_count_max  INTEGER,
  social_links        JSONB NOT NULL DEFAULT '{}'::jsonb,
  career_page_url     TEXT,
  contact_page_url    TEXT,
  public_email        TEXT,
  public_phone        TEXT,
  sitemap_urls        TEXT[] NOT NULL DEFAULT '{}',
  active_job_count    INTEGER NOT NULL DEFAULT 0,
  ai_summary          TEXT,
  embedding           vector(1536),
  relevance_hint      REAL,
  osm_id              TEXT,
  last_crawled_at     TIMESTAMPTZ,
  last_verified_at    TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT companies_employee_range CHECK (
    employee_count_min IS NULL
    OR employee_count_max IS NULL
    OR employee_count_min <= employee_count_max
  )
);

-- A domain identifies a company; rows without one are matched by name instead.
CREATE UNIQUE INDEX IF NOT EXISTS companies_domain_key ON companies (domain)
  WHERE domain IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS companies_name_city_key
  ON companies (normalized_name, COALESCE(city, ''))
  WHERE domain IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS companies_osm_id_key ON companies (osm_id)
  WHERE osm_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS companies_location_idx ON companies USING GIST (location);
CREATE INDEX IF NOT EXISTS companies_name_trgm_idx ON companies USING GIN (normalized_name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS companies_technologies_idx ON companies USING GIN (technologies);
CREATE INDEX IF NOT EXISTS companies_last_verified_idx ON companies (last_verified_at NULLS FIRST);

-- Additional sites/branches of the same company.
CREATE TABLE IF NOT EXISTS company_locations (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    UUID NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  label         TEXT,
  address       TEXT,
  city          TEXT,
  region        TEXT,
  country       TEXT,
  country_code  CHAR(2),
  postal_code   TEXT,
  location      geography(Point, 4326),
  is_primary    BOOLEAN NOT NULL DEFAULT FALSE,
  source_url    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS company_locations_company_idx ON company_locations (company_id);
CREATE INDEX IF NOT EXISTS company_locations_location_idx ON company_locations USING GIST (location);

-- Canonical skill/technology vocabulary. `kind` separates the two so a UI can
-- filter on either without a second table.
CREATE TABLE IF NOT EXISTS skills (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name            TEXT NOT NULL,
  normalized_name TEXT NOT NULL UNIQUE,
  kind            TEXT NOT NULL DEFAULT 'skill' CHECK (kind IN ('skill', 'technology', 'language')),
  aliases         TEXT[] NOT NULL DEFAULT '{}',
  embedding       vector(1536),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS skills_name_trgm_idx ON skills USING GIN (normalized_name gin_trgm_ops);

CREATE TABLE IF NOT EXISTS technologies (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name            TEXT NOT NULL,
  normalized_name TEXT NOT NULL UNIQUE,
  category        TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS company_technologies (
  company_id    UUID NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  technology_id UUID NOT NULL REFERENCES technologies (id) ON DELETE CASCADE,
  confidence    REAL NOT NULL DEFAULT 0.5,
  source_url    TEXT,
  PRIMARY KEY (company_id, technology_id)
);
