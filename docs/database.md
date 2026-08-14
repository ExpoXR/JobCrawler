# Database

PostgreSQL 16 with **PostGIS** (radius search), **pgvector** (semantic search),
**pg_trgm** (fuzzy title/company matching) and **unaccent**.

No official image ships both PostGIS and pgvector, so `docker/postgres/Dockerfile`
installs `postgresql-16-pgvector` on top of `postgis/postgis:16-3.4`.

## Migrations

Plain SQL in `migrations/`, applied in filename order by
`packages/database/src/cli/migrate.ts`.

```bash
npm run migrate          # apply pending
npm run migrate:status   # list applied / pending / drifted
```

Each file runs in its own transaction and is recorded in `schema_migrations`
with a SHA-256 checksum. **Editing an applied migration is an error**: the
runner refuses to continue on checksum drift rather than silently skipping it.
Roll forward with a new file.

| File | Contents |
| --- | --- |
| `0001_extensions.sql` | postgis, vector, pg_trgm, unaccent, pgcrypto |
| `0002_companies.sql` | `companies`, `company_locations`, `skills`, `technologies`, `company_technologies` |
| `0003_jobs.sql` | `jobs`, `job_sources`, `job_skills` |
| `0004_candidates.sql` | `candidates`, `candidate_sources`, `candidate_skills`, `removal_requests` |
| `0005_crawler.sql` | `crawled_pages`, `crawl_jobs`, `robots_cache`, `source_providers`, `blocked_domains`, `geocode_cache` |
| `0006_search.sql` | `search_sessions`, `search_results`, `ai_analysis` |
| `0007_settings.sql` | `settings`, `provider_settings` + defaults |
| `0008_indexes_triggers.sql` | HNSW vector indexes, `updated_at` triggers |

## Key modelling decisions

**Geography, not geometry.** Location columns are `geography(Point, 4326)`, so
`ST_DWithin` and `ST_Distance` return real metres without a projection step.
GiST indexes back every one of them.

**Identity.** A company is identified by its `domain` when one is known, and by
`(normalized_name, city)` otherwise. Both are partial unique indexes, so a
company discovered without a website can later gain one without a duplicate row.
`normalized_name` comes from `normalizeCompanyName`, which strips European legal
forms — "Müller Software GmbH & Co. KG" and "Mueller Software" collapse together.

**Job dedup at the storage layer.** `jobs_dedup_key` is unique over
`(company_id, normalized_title, city)`, and `job_sources` is many-to-one with a
unique `(job_id, url)`. One logical job, every place it was seen.

**Inactive, not deleted.** A vacancy that disappears gets `is_active = false`
and an `inactive_since` timestamp. History survives a flaky origin.

**Merging never blanks data.** Upserts use `COALESCE(new, old)` for scalars and
union arrays, because discovery runs repeatedly and a later, poorer pass must
not erase what an earlier, richer one found.

**Embeddings are `vector(1536)`.** That matches OpenAI `text-embedding-3-small`
and is what `EMBEDDING_DIMENSIONS` defaults to. A model with a different width
needs a migration altering the column — the dimension is part of the schema.

HNSW indexes (rather than IVFFlat) are used because they need no training pass,
which matters when the index is built while the tables are still empty.

**Search sessions are anonymous.** No user identifier is stored — only the query
that produced the session — and rows expire after 30 days via `expires_at`.

## Access pattern

All SQL lives in `packages/database/src/repositories/`. Nothing outside that
directory builds a query, and every value is passed as a bound parameter; string
interpolation into SQL is never acceptable.

`getPool()` is the single connection pool. `withTransaction` wraps multi-statement
work such as `upsertJob`, which must insert the job, its sources and its skills
atomically.
