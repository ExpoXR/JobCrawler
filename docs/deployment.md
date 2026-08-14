# Deployment

Two application processes (`web`, `worker`) plus PostgreSQL and Redis.

## Docker Compose

```bash
cp .env.example .env
# Required: POSTGRES_PASSWORD, ADMIN_PASSWORD
# Recommended: CRAWLER_USER_AGENT, CRAWLER_CONTACT_EMAIL, PUBLIC_BASE_URL

docker compose up -d --build
docker compose run --rm migrate
```

Only `web` publishes a port. Postgres and Redis stay on the internal network.

| Service | Image | Notes |
| --- | --- | --- |
| `postgres` | built from `docker/postgres/Dockerfile` | PostGIS 3.4 + pgvector on PG 16 |
| `redis` | `redis:7-alpine` | AOF on, `maxmemory-policy noeviction` so queue jobs are never evicted |
| `web` | `docker/web/Dockerfile` | Next.js standalone output, non-root |
| `worker` | `docker/worker/Dockerfile` | runs TypeScript via `tsx`, non-root |
| `migrate` | same image as worker | one-shot, `profiles: [tools]` |

Scale crawling with `docker compose up -d --scale worker=3`. Workers are
stateless and coordinate through Redis.

## Migrations

Run `docker compose run --rm migrate` after every deploy. The runner is
idempotent and refuses to proceed if an applied migration's checksum has
changed. It is safe to run while the app is up; each migration is transactional.

## Reverse proxy

Terminate TLS in front of `web`. Two requirements:

- **Do not buffer `/api/search/*/events`.** The SSE stream sets
  `X-Accel-Buffering: no`; nginx also needs `proxy_buffering off;`.
- Allow a long read timeout on that path (streams run up to 10 minutes).

```nginx
location /api/search/ {
    proxy_pass http://web:3000;
    proxy_buffering off;
    proxy_read_timeout 600s;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
}
```

`X-Forwarded-For` matters: the API rate limiter keys on it.

## Configuration

All settings are documented in `.env.example`. The ones to review before going
live:

| Variable | Why |
| --- | --- |
| `POSTGRES_PASSWORD` | Compose refuses to start without it |
| `ADMIN_PASSWORD` | Admin area returns 503 until set |
| `CRAWLER_USER_AGENT`, `CRAWLER_CONTACT_EMAIL` | Required by the OSM usage policy and basic crawling etiquette |
| `NOMINATIM_BASE_URL` | Self-host for anything beyond light use |
| `OVERPASS_BASE_URL` | Same — the public instance is shared and rate limited |
| `CRAWL_ALLOW_PRIVATE_ADDRESSES` | Must stay `false` in production (SSRF) |
| `CRAWL_MAX_DOMAINS_PER_SEARCH`, `CRAWL_MAX_PAGES_PER_DOMAIN` | Bound the cost of one search |
| `WORKER_CONCURRENCY` | Crawling is I/O bound; 4–8 per worker is reasonable |

The config schema (`packages/shared/src/config.ts`) validates and range-checks
every value at startup, so a typo fails fast instead of silently defaulting.

## Health and monitoring

`GET /api/health` returns 200 when Postgres is reachable with both extensions
installed, 503 otherwise, and reports Redis and provider status. Both containers
carry Docker healthchecks.

Logs are one JSON object per line with `searchId`, `provider`, `domain`,
`status`, `durationMs`, `retryCount` and `errorType` where relevant — ready to
ship to any log aggregator. Secrets are redacted before serialisation.

The admin dashboard shows queue depths, recent crawls, provider status and
counts.

## Backups

Back up the Postgres volume. Redis holds only in-flight queue state; losing it
costs pending discovery work, not data.

```bash
docker compose exec -T postgres pg_dump -U expojobcrawler expojobcrawler | gzip > backup.sql.gz
```

## Resource guidance

A small deployment (one worker, light traffic) runs comfortably in ~2 GB RAM.
Postgres dominates as the index grows; the HNSW vector indexes are the memory
hungry part, so size for the corpus you expect rather than the one you start
with.
