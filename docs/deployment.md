# Deployment

Two application processes (`web`, `worker`) plus PostgreSQL, Redis, and an internal DACH Nominatim service.

For a first install — prerequisites, the local-development path, first-run
bootstrap and troubleshooting — start with [installation.md](installation.md).
This page covers running it in production.

## Docker Compose

```bash
cp .env.example .env
# Required: POSTGRES_PASSWORD, REDIS_PASSWORD, ADMIN_EMAIL, ADMIN_PASSWORD
# Recommended: CRAWLER_USER_AGENT, CRAWLER_CONTACT_EMAIL, PUBLIC_BASE_URL

docker compose up -d --build
docker compose run --rm migrate
docker compose -f docker-compose.nominatim.yml up -d
```

Only `web` publishes a loopback port. Postgres, Redis, and Nominatim stay on the shared Docker network.

| Service | Image | Notes |
| --- | --- | --- |
| `postgres` | built from `docker/postgres/Dockerfile` | PostGIS 3.4 + pgvector on PG 16 |
| `redis` | pinned `redis` digest | Password-protected, AOF on, `maxmemory-policy noeviction` so queue jobs are never evicted |
| `web` | `docker/web/Dockerfile` | Next.js standalone output, non-root |
| `worker` | `docker/worker/Dockerfile` | runs TypeScript via `tsx`, non-root |
| `migrate` | same image as worker | one-shot, `profiles: [tools]` |
| `nominatim` | pinned `mediagis/nominatim:5.3` digest | DACH import and continuous Geofabrik replication; separate Compose file |

## DACH Nominatim

Create the persistent dataset before the first import:

```bash
zfs create -o mountpoint=/apps/docker/expoxr/jobcrawler-nominatim \
  -o compression=zstd -o atime=off -o refquota=180G \
  apps/docker/expoxr/jobcrawler-nominatim
mkdir -p /mnt/apps/docker/expoxr/jobcrawler-nominatim/{postgres,flatnode}
docker compose -f docker-compose.nominatim.yml up -d
```

TrueNAS applies the pool altroot, so the ZFS property is `/apps/...` while the
host-visible path used by Compose is `/mnt/apps/...`.

The initial Geofabrik DACH import can take hours. Watch it with
`docker logs -f expojobcrawler-nominatim`; readiness is `GET /status`. Daily
diffs are applied continuously from the DACH replication endpoint. No host port
is published.

For a clean rebuild, stop the service, snapshot or move the existing dataset,
create an empty dataset with the properties above, and start the service. Do
not delete the old dataset until `/status`, a forward geocode, and replication
state have been verified.

Interactive map tiles remain browser-fetched from the configured
`NEXT_PUBLIC_MAP_TILE_URL`. Keep visible OpenStreetMap attribution, cache tiles
in the browser, and configure another policy-compliant provider before traffic
outgrows the public tile service.

Google Maps is available as an opt-in alternative, off unless
`NEXT_PUBLIC_MAP_PROVIDER_ALLOW_GOOGLE=true` is set **and the web image is
rebuilt** — `NEXT_PUBLIC_*` values are inlined at build time. The deployment
holds no Google key; each viewer supplies their own, and it stays in their
browser. See [maps.md](maps.md).

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

`X-Forwarded-For` matters: the API rate limiter keys on it — and **set
`TRUSTED_PROXY_HOPS` to the number of proxies you actually run**. The header is
appended to by every hop and the client controls the leftmost entry, so trusting
more hops than exist makes every rate limit forgeable, and trusting fewer makes
the limiter key on your proxy instead of the visitor.

Headers the app sets for itself — do not duplicate them in the proxy, and do not
strip them:

- `Strict-Transport-Security`, emitted only when `PUBLIC_BASE_URL` is `https://`
- `Content-Security-Policy`, built per request because it carries a nonce.
  `CSP_MODE` ships as `report-only`; flip it to `enforce` once you have loaded
  every page and confirmed no violations
- `Cross-Origin-Opener-Policy`, `Cross-Origin-Resource-Policy`,
  `X-Frame-Options`, `X-Content-Type-Options`, `Referrer-Policy`,
  `Permissions-Policy`

Set `PUBLIC_BASE_URL` to the URL the **browser** uses. Behind a port mapping or
a proxy the app otherwise sees its internal listen address, and every
state-changing request is rejected as cross-origin.

## Configuration

Every variable is documented in [configuration.md](configuration.md); `.env.example`
carries the same set with inline comments. The ones to review before going live:

| Variable | Why |
| --- | --- |
| `POSTGRES_PASSWORD` | Compose refuses to start without it |
| `REDIS_PASSWORD` | Likewise. Redis starts with `--requirepass` and both app services build their `REDIS_URL` from it |
| `PUBLIC_BASE_URL` | Same-origin checks, the `Secure` cookie flag and HSTS all derive from it |
| `TRUSTED_PROXY_HOPS` | Wrong value ⇒ rate limits either forgeable or blind |
| `CSP_MODE` | `report-only` enforces nothing |
| `SETTINGS_ENCRYPTION_KEY` | Required before the dashboard will accept an API key |
| `ADMIN_EMAIL` + `ADMIN_PASSWORD` | Seed the first administrator; no account exists without them |
| `CRAWLER_USER_AGENT`, `CRAWLER_CONTACT_EMAIL` | Required by the OSM usage policy and basic crawling etiquette |
| `NOMINATIM_BASE_URL` | Self-host for anything beyond light use |
| `OVERPASS_BASE_URL`, `OVERPASS_FALLBACK_URLS` | Approved public instances are shared and rate limited; keep an identified fallback configured |
| `CRAWL_ALLOW_PRIVATE_ADDRESSES` | Must stay `false` in production (SSRF) |
| `CRAWL_MAX_DOMAINS_PER_SEARCH`, `CRAWL_MAX_PAGES_PER_DOMAIN` | Bound the cost of one search |
| `WORKER_CONCURRENCY` | Crawling is I/O bound; 4–8 per worker is reasonable |

The config schema (`packages/shared/src/config.ts`) validates and range-checks
every value at startup, so a typo fails fast instead of silently defaulting.

## Health and monitoring

`GET /api/health` returns 200 when Postgres, required extensions, and cached
Nominatim readiness pass; it returns 503 with a clear geocoding degraded state
otherwise. Redis and provider status are also reported. Runtime containers
carry explicit health checks.

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

The application stack is bounded to roughly 2.5 GB. The initial DACH Nominatim
import is separately bounded to 24 GB RAM and 8 CPUs; its persistent dataset has
a 180 GB quota. Monitor pool free space throughout imports and rebuilds.
