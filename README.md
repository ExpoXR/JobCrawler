# ExpoJobCrawler

A self-hosted, AI-powered **geographic employment research engine** for Europe.

It works in two directions and needs no account in either:

- **Job seekers** enter a city, a radius and a role, and get active vacancies *plus*
  nearby companies that plausibly employ people like them.
- **Companies** describe a role (or paste a job ad) and get publicly available
  professional profiles in the area.

The difference from a job board is where the data comes from: OpenStreetMap for
geography, company websites for vacancies, and public profiles for people —
crawled politely, deduplicated across sources, scored deterministically, and
always linked back to the original page.

---

## Status

| Phase | Scope | State |
| --- | --- | --- |
| 1 | Monorepo, Docker, Postgres/PostGIS/pgvector, Redis/BullMQ, schema, search UI, map | Implemented |
| 2 | Geocoding, radius search, OSM/Overpass discovery, sitemap crawler, company extraction | Implemented |
| 3 | Career-page detection, JSON-LD extraction, job normalisation, dedup, verification | Implemented |
| 4 | AI provider abstraction, NL query parsing, embeddings, match scoring, explanations | Implemented |
| 5 | Research agent with source provenance | Implemented (single-result analysis) |
| 6 | Candidate search (GitHub provider, lightweight index, matching) | Implemented |
| 7 | Additional providers | Interfaces ready; only OSM/Overpass/career-page/GitHub shipped |
| 8 | Export & administration | CSV + JSON export, admin dashboard; XLSX/PDF not implemented |
| 9 | Optimisation | Indexes and caching in place; tuning ongoing |

Everything works with **no AI provider configured** — query parsing, matching
and explanations all have deterministic implementations. Configuring an AI or
embedding provider improves quality; it is never required.

---

## Quick start (Docker)

```bash
cp .env.example .env
# Set at least POSTGRES_PASSWORD and ADMIN_PASSWORD.

docker compose up -d --build
docker compose run --rm migrate     # apply database migrations
```

Open <http://localhost:3000>.

The admin dashboard is at `/admin` behind HTTP Basic auth. It is **disabled**
(HTTP 503) until `ADMIN_PASSWORD` is set — it fails closed, not open.

## Quick start (local development)

Requires Node 20.11+ and a PostgreSQL 16 with PostGIS and pgvector, plus Redis.

```bash
npm install
cp .env.example .env

npm run migrate      # create the schema
npm run seed         # optional: sample companies and jobs around Kempten

npm run dev          # web app on http://localhost:3000
npm run dev:worker   # background workers (separate terminal)
```

Without Redis the app still runs: searches return indexed results and report
that live discovery is unavailable, rather than failing.

## Commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Next.js dev server |
| `npm run dev:worker` | BullMQ workers |
| `npm run build` / `npm start` | Production build / serve |
| `npm run migrate` | Apply pending migrations |
| `npm run migrate:status` | Show applied and pending migrations |
| `npm run seed` | Insert development data |
| `npm run typecheck` | `tsc --noEmit` over the whole monorepo |
| `npm run lint` | ESLint |
| `npm test` | Vitest |
| `npm run check` | typecheck + lint + test |

---

## Repository layout

```text
apps/
  web/         Next.js app: public UI, admin UI, API routes
  worker/      BullMQ workers (discovery, crawling, enrichment, verification)
packages/
  shared/      Types, Zod schemas, config, logging, geo maths, vocabulary
  database/    Postgres access, repositories, migration runner
  crawler/     SSRF guard, robots.txt, sitemaps, fetching, extraction
  providers/   Provider interfaces + OSM/Overpass/Nominatim/career-page/GitHub
  ai/          AI + embedding abstraction, query parsing, research agent
  matching/    Deterministic scoring and duplicate detection
  search/      Hybrid search orchestration and export
  queue/       Queue definitions and worker helpers
docker/        Dockerfiles for web, worker and Postgres
migrations/    Forward-only SQL migrations
docs/          Architecture, database, providers, crawler, AI, deployment, security
```

## How a search runs

```text
POST /api/search
      │
      ├─ parse natural language (heuristic, then AI if configured)
      ├─ geocode the location (Nominatim, cached)
      ├─ search the local index (PostGIS radius query)   ──► results returned now
      └─ enqueue live discovery
             │
             ├─ Overpass: companies inside the radius
             ├─ per company: robots.txt → sitemap → classify URLs → selected pages
             ├─ extract JobPosting JSON-LD, else heuristic extraction
             ├─ deduplicate across sources, keeping every source URL
             └─ score, explain, and append to the same search session
                    │
                    └─ UI follows progress over SSE (/api/search/{id}/events)
```

## Matching

Scores are computed, not generated: a weighted mean over components that have a
signal (skills, semantic similarity, role, experience, distance, industry,
employment type, work model, salary, freshness). Hard requirements *reject* a
result rather than downranking it. Every result carries the evidence behind its
score, with source URLs. See [docs/architecture.md](docs/architecture.md).

## Crawling policy

The crawler respects `robots.txt`, crawl delays, rate limits and per-domain page
budgets, and prefers sitemaps over blind crawling. It never attempts to bypass
CAPTCHAs, authentication, bot protection or paywalls. Every outbound URL passes
an SSRF guard that re-validates each redirect hop against the resolved IP.
See [docs/crawler.md](docs/crawler.md) and [docs/security.md](docs/security.md).

## Privacy

Only publicly available professional information is indexed, candidate records
are deliberately minimal pointers back to the source, and removals are recorded
in a suppression list so a later crawl cannot silently undo them.
See [docs/security.md](docs/security.md).

## Documentation

- [docs/architecture.md](docs/architecture.md)
- [docs/database.md](docs/database.md)
- [docs/providers.md](docs/providers.md) — how to add a new source
- [docs/crawler.md](docs/crawler.md)
- [docs/ai.md](docs/ai.md)
- [docs/deployment.md](docs/deployment.md)
- [docs/security.md](docs/security.md)
