# ExpoJobCrawler

A self-hosted, AI-powered **geographic employment research engine** launching in the DACH region.

It works in two directions, and searching in either needs no account:

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
| 5 | Research agent with source provenance | Implemented (`/api/research` + detail-page panel) |
| 6 | Candidate search (GitHub provider, lightweight index, matching) | Implemented |
| 7 | Additional providers | Interfaces ready; only OSM/Overpass/career-page/GitHub shipped |
| 8 | Export & administration | CSV + JSON export, admin dashboard; XLSX/PDF not implemented |
| 9 | Optimisation | Indexes and caching in place; tuning ongoing |

Everything works with **no AI provider configured** — query parsing, matching
and explanations all have deterministic implementations. Configuring an AI or
embedding provider improves quality; it is never required.

---

## Quick start (Docker)

Full instructions, including prerequisites and troubleshooting, are in
[docs/installation.md](docs/installation.md).

```bash
cp .env.example .env
# Set at least POSTGRES_PASSWORD, REDIS_PASSWORD, ADMIN_EMAIL and ADMIN_PASSWORD.

docker compose up -d --build
docker compose run --rm migrate     # apply database migrations — not automatic
docker compose -f docker-compose.nominatim.yml up -d
```

`docker compose up` does **not** run the migrations: the `migrate` service is behind the
`tools` profile, so schema changes stay a deliberate act. Skipping it leaves an app that
starts and then fails on the first query.

Open <http://localhost:3000>.

Searching needs no account. Administration does: sign in at `/login` with the
`ADMIN_EMAIL` / `ADMIN_PASSWORD` pair, which seeds the first administrator on a
deployment whose users table is still empty. Change that password, then clear `ADMIN_PASSWORD` from the environment — the
self-service change-password screen does not exist yet, so until it does that
means the API call documented in
[docs/authentication.md](docs/authentication.md).

A search run while signed in belongs to that account, so its results and export
are private to it. A search run signed out stays readable by anyone holding its
id, exactly as before.

## Quick start (local development)

Requires Node 20.11+ and a PostgreSQL 16 with PostGIS and pgvector, plus Redis. No Node on
the machine? `docker-compose.dev.yml` provides a toolchain container that runs the npm
scripts — see [docs/installation.md](docs/installation.md).

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
| `npm run test:e2e` | Playwright accessibility and responsive checks |

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

## Semantic search

With an embedding provider configured, every discovered job, company and
candidate is queued for embedding as it is written, and a half-hourly sweep
backfills anything the queue missed. Search then computes cosine similarity
**inside Postgres** (`embedding <=> $query`), so the 1536-float vectors never
cross the wire, and feeds the result to the matcher as one scoring component.

With `EMBEDDING_PROVIDER=none` the component is simply absent and scoring falls
back to lexical signals.

## Documentation

Start here:

- [docs/installation.md](docs/installation.md) — install, run, verify, troubleshoot
- [docs/configuration.md](docs/configuration.md) — every environment variable
- [docs/authentication.md](docs/authentication.md) — accounts, roles, sessions

Reference:

- [docs/architecture.md](docs/architecture.md)
- [docs/database.md](docs/database.md)
- [docs/providers.md](docs/providers.md) — how to add a new source
- [docs/crawler.md](docs/crawler.md)
- [docs/ai.md](docs/ai.md)
- [docs/ai-providers.md](docs/ai-providers.md) — configuring OpenAI, Claude, Gemini or a local model
- [docs/maps.md](docs/maps.md) — the OpenStreetMap default, and the optional Google Maps mode
- [docs/deployment.md](docs/deployment.md)
- [docs/security.md](docs/security.md)

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the development setup, the architectural
invariants a change must not break, and the code style. Security issues go through
[SECURITY.md](SECURITY.md), never a public issue. Changes are recorded in
[CHANGELOG.md](CHANGELOG.md).

## Licence

ExpoJobCrawler is free software under the
**[GNU Affero General Public License v3.0](LICENSE)**.

You may run, study, modify and redistribute it. The AGPL's network clause is the reason
for this choice: if you run a modified version as a network service, you must offer its
source to the people who use it. Self-hosting it unmodified, for yourself or inside your
organisation, carries no such obligation.
