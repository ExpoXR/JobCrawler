-- Extensions required by the platform.
--   postgis  : radius / distance search (plan sections 8, 13)
--   vector   : semantic search and duplicate support (plan section 23)
--   pg_trgm  : fuzzy company/job title matching for deduplication
--   unaccent : Europe-first text folding inside SQL
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS unaccent;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
