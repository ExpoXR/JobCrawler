-- Runs once, on first cluster initialisation.
--
-- The migration runner also creates these, but installing them here means the
-- database is usable (and `\dx` is meaningful) before migrations ever run.
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS unaccent;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
