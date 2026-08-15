-- Vector indexes and updated_at bookkeeping.

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE
  target TEXT;
BEGIN
  FOREACH target IN ARRAY ARRAY['companies', 'jobs', 'candidates', 'source_providers', 'provider_settings']
  LOOP
    EXECUTE format(
      'DROP TRIGGER IF EXISTS %I ON %I',
      target || '_set_updated_at', target
    );
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION set_updated_at()',
      target || '_set_updated_at', target
    );
  END LOOP;
END;
$$;

-- HNSW gives good recall without needing a trained list count, which matters
-- because the index is built while the tables are still nearly empty.
CREATE INDEX IF NOT EXISTS jobs_embedding_idx
  ON jobs USING hnsw (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS companies_embedding_idx
  ON companies USING hnsw (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS candidates_embedding_idx
  ON candidates USING hnsw (embedding vector_cosine_ops);
