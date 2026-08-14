# Architecture

## Components

```text
                    ┌──────────────┐
   browser ────────►│  apps/web    │  Next.js: public UI, admin UI, API routes
                    └──────┬───────┘
                           │
         ┌─────────────────┼──────────────────┐
         ▼                 ▼                  ▼
  ┌────────────┐   ┌───────────────┐   ┌──────────────┐
  │ PostgreSQL │   │ Redis + BullMQ│   │  providers   │
  │  PostGIS   │   │    queues     │   │ OSM/Overpass │
  │  pgvector  │   └───────┬───────┘   │ career pages │
  └────────────┘           │           │   GitHub     │
         ▲                 ▼           └──────────────┘
         │         ┌───────────────┐
         └─────────│ apps/worker   │  discovery · crawling · enrichment
                   └───────────────┘  verification · cleanup
```

Two processes: `web` and `worker`. Both talk to the same Postgres and Redis and
share every package. The web process never crawls — it queues.

## Package boundaries

| Package | Owns | Depends on |
| --- | --- | --- |
| `shared` | Types, Zod schemas, config, logging, geo maths, vocabulary | — |
| `database` | SQL, repositories, migrations | `shared` |
| `crawler` | SSRF guard, robots, sitemaps, fetch, extraction | `shared`, `database` |
| `providers` | Provider contracts and implementations | `shared`, `database`, `crawler` |
| `ai` | AI/embedding abstraction, query parsing, research | `shared`, `database` |
| `matching` | Scoring, duplicate detection | `shared` |
| `queue` | Queue definitions, worker factory | `shared` |
| `search` | Orchestration, discovery, export | all of the above |

The dependency graph is acyclic and `matching` deliberately depends only on
`shared`: scoring must be testable without a database, a network or a model.

Packages ship TypeScript source rather than build output. Next compiles them via
`transpilePackages`, the worker runs them through `tsx`, and Vitest reads them
directly — one toolchain, no build artefacts to keep in sync.

## The hybrid search contract

`startSearch` (in `packages/search/src/orchestrator.ts`) does four things and
returns:

1. parse free text into structured filters (heuristic first, AI as an overlay)
2. geocode the location
3. run the PostGIS radius query and **store those results immediately**
4. enqueue `company-discovery`

Everything after step 4 happens in workers, appending to the same
`search_sessions` row. The UI subscribes to `/api/search/{id}/events` (SSE) and
re-reads results whenever the stage changes.

This is what makes the product feel fast despite crawling being slow: the first
response is a database query, and crawling only ever *adds*.

### Progress stages

`queued → searching_database → discovering_companies → searching_job_sources →
checking_company_websites → reading_sitemaps → analyzing_career_pages →
extracting_jobs → searching_profiles → generating_embeddings →
calculating_matches → researching_top_results → completed | failed`

Each stage maps to a fixed percentage, and `updateSearchProgress` clamps the
value to be monotonically non-decreasing so out-of-order worker reports never
make the bar jump backwards.

## Matching model

Implemented in `packages/matching/src/score.ts`.

```text
Final score = Σ(componentScore × weight) / Σ(weight)   over components with a signal
```

Components: `requiredSkills`, `preferredSkills`, `semantic`, `role`,
`experience`, `seniority`, `distance`, `industry`, `employmentType`,
`workModel`, `salary`, `freshness`.

Two design decisions worth stating plainly:

- **An LLM never produces the score.** Scores must be reproducible, testable and
  explainable; a model's opinion is none of those. The AI layer explains and
  researches, and contributes at most a semantic-similarity component derived
  from embeddings.
- **Components with no data are dropped, not zeroed.** A job that lists no
  salary is scored on everything else, rather than being punished for a field
  the employer chose not to publish.

Hard requirements (`requiredSkills`, radius, excluded work models, exclusion
terms) *reject* a result: score 0 and a stated reason.

Potential employers use a different weight set: no vacancy exists, so
employment type, salary and freshness carry no weight, and a missing required
skill does not reject — a website that never mentions Rust is not evidence that
the company avoids Rust.

## Deduplication

`packages/matching/src/dedupe.ts`. The same vacancy typically appears on the
employer's site and on two or three aggregators.

- Identical canonical URL (tracking parameters stripped) → conclusive duplicate.
- Otherwise duplicates need agreement across independent signals: same employer
  *and* near-identical normalised title *and* the same city. Titles alone repeat
  constantly.
- Merging keeps every source URL, the longest description, the earliest
  publication date, and the union of skills.
- The application link prefers the employer's own domain over any aggregator.

At the database level the same rule is enforced by the `jobs_dedup_key` unique
index over `(company_id, normalized_title, city)`.

## Failure model

Every external interaction is expected to fail sometimes, so:

- one provider failing degrades a search and is reported in `search_sessions.errors`
- one page failing does not fail a domain crawl
- an AI outage falls back to the deterministic path
- an inconclusive job re-check (timeout, 429, 5xx) leaves the job untouched;
  only a 404/410 or a page that no longer contains a posting marks it inactive

Errors are classified into a fixed taxonomy (`packages/shared/src/errors.ts`) so
that logs carry a stable `errorType` and retry decisions are consistent.
