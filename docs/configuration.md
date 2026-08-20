# Configuration

Every setting is an environment variable. There is no configuration file, and nothing is
configurable at runtime except the model providers and the handful of rows in `settings`.

`packages/shared/src/config.ts` is the single source of truth: it validates and range-checks
the whole environment with Zod at startup and **throws on the first invalid value**, naming
it. A typo fails the process rather than silently falling back to a default.

```text
Invalid environment configuration: CRAWL_TIMEOUT_MS: Number must be less than or equal to 120000
```

Copy `.env.example` to `.env` and edit. Anything you leave out takes the default in the
tables below — every variable has one except the four listed as required.

---

## Required

| Variable | Consumed by | Notes |
| --- | --- | --- |
| `POSTGRES_PASSWORD` | Compose | Compose refuses to start without it (`:?` guard) |
| `REDIS_PASSWORD` | Compose | Same. Redis starts with `--requirepass`, and the web and worker services build their `REDIS_URL` from it |
| `ADMIN_EMAIL` | app | Seeds the first administrator |
| `ADMIN_PASSWORD` | app | Seeds the first administrator; minimum 12 characters, or seeding is refused with a warning |

Without `ADMIN_EMAIL` and `ADMIN_PASSWORD` the deployment still runs and still searches —
there is simply no account to sign in as, so `/admin` is unreachable. See
[authentication.md](authentication.md).

`NOMINATIM_PASSWORD` is required as well if you run the optional Nominatim stack
(`docker-compose.nominatim.yml`).

---

## The three that quietly break a deployment

| Variable | Wrong value | Consequence |
| --- | --- | --- |
| `TRUSTED_PROXY_HOPS` | too high | `x-forwarded-for` is client-controlled. Trusting more hops than actually exist lets a caller forge the address the rate limiter keys on, and every limit becomes bypassable |
| | too low | The limiter keys on your proxy's address instead of the client's, so one visitor's burst throttles everyone |
| `CSP_MODE` | left at `report-only` | The Content-Security-Policy is *observed and not enforced*. It ships this way so a policy mistake cannot take a deployment down; until you flip it to `enforce`, it is documentation |
| `CRAWL_ALLOW_PRIVATE_ADDRESSES` | `true` | Disables part of the SSRF guard, so a crawled page can point the crawler at your internal network. Only ever set this in an isolated test environment |

Set `TRUSTED_PROXY_HOPS` to the number of reverse proxies **you** operate in front of the
app: `0` behind nothing (the header is then ignored entirely), `1` behind a single nginx or
Traefik, `2` behind a CDN in front of that.

---

## Core

| Variable | Default | Meaning |
| --- | --- | --- |
| `NODE_ENV` | `development` | `development` \| `test` \| `production` |
| `LOG_LEVEL` | `info` | `trace` … `error`, or `silent` |
| `DATABASE_URL` | local Postgres | Postgres 16 with PostGIS, pgvector, pg_trgm and pgcrypto |
| `DATABASE_POOL_MAX` | `10` | Connections per process. Web *and* worker each open a pool |
| `REDIS_URL` | `redis://localhost:6379` | Compose overrides this with the password-bearing URL |
| `WORKER_CONCURRENCY` | `4` | Jobs in flight per worker process. Crawling is I/O bound; 4–8 is reasonable |
| `PUBLIC_BASE_URL` | `http://localhost:3000` | The origin browsers use. Drives same-origin checks, the `Secure` flag on the session cookie, and whether HSTS is emitted |

## Accounts and sessions

| Variable | Default | Meaning |
| --- | --- | --- |
| `ADMIN_EMAIL` | — | Bootstrap administrator, seeded once while the users table is empty |
| `ADMIN_PASSWORD` | — | Bootstrap password. Clear it once you have changed the password |
| `ADMIN_USERNAME` | `admin` | **Authenticates nothing.** A leftover from the HTTP Basic era, kept so existing `.env` files do not fail validation |
| `AUTH_SESSION_TTL_HOURS` | `168` (7 days) | Sliding window, extended while the session is in use |
| `AUTH_SESSION_ABSOLUTE_TTL_HOURS` | `720` (30 days) | Hard cap, never extended |

## Security

| Variable | Default | Meaning |
| --- | --- | --- |
| `TRUSTED_PROXY_HOPS` | `0` | See above |
| `CSP_MODE` | `report-only` | `enforce` \| `report-only` \| `off` |
| `SETTINGS_ENCRYPTION_KEY` | — | 32 bytes of base64 (`openssl rand -base64 32`). Required before `/admin/providers` will accept an API key. Changing it makes every stored key undecryptable |

## Geocoding and geography

| Variable | Default | Meaning |
| --- | --- | --- |
| `GEOCODING_PROVIDER` | `nominatim` | Only Nominatim is implemented |
| `NOMINATIM_BASE_URL` | public instance | Self-host for anything beyond light use; the public instance's policy forbids bulk queries |
| `OVERPASS_BASE_URL` | `overpass-api.de` | Company discovery inside the radius |
| `OVERPASS_FALLBACK_URLS` | — | Comma-separated. Public Overpass instances are shared and rate limited; keep at least one fallback |

## Crawler

| Variable | Default | Meaning |
| --- | --- | --- |
| `CRAWLER_USER_AGENT` | project default | Identifies you to every site you visit. **Set this**, with a contact URL — the OSM usage policy requires it and site operators expect it |
| `CRAWLER_CONTACT_EMAIL` | — | Sent as a `From:` header on **geocoding** requests, which Nominatim's usage policy asks for. Crawled sites see only the user agent, so put a contact address in that too |
| `CRAWL_MAX_DOMAINS_PER_SEARCH` | `25` | Domain cap for one opt-in crawl |
| `CRAWL_MAX_PAGES_PER_DOMAIN` | `15` | Page budget per site |
| `CRAWL_MAX_SITEMAP_ENTRIES` | `2000` | Sitemap URLs read before giving up |
| `CRAWL_MAX_PAGE_BYTES` | `2000000` | Response body cap |
| `CRAWL_TIMEOUT_MS` | `15000` | Per request |
| `CRAWL_DEFAULT_DELAY_MS` | `1000` | Between requests to one host, unless `robots.txt` asks for more |
| `CRAWL_MAX_REDIRECTS` | `5` | Every hop is re-checked by the SSRF guard |
| `CRAWL_MAX_RETRIES` | `2` | |
| `CRAWL_RESPECT_ROBOTS` | `true` | Leave it true. Turning it off is a licence and reputation problem, not a performance tuning knob |
| `CRAWL_BLOCKED_DOMAINS` | — | Comma-separated hostnames never to visit |
| `CRAWL_ALLOW_PRIVATE_ADDRESSES` | `false` | See above |

## Search

| Variable | Default | Meaning |
| --- | --- | --- |
| `SEARCH_MAX_RESULTS` | `200` | Results stored per search. The repository clamps to 500 regardless |
| `SEARCH_MAX_DURATION_MS` | `180000` | Ceiling for one live discovery run |
| `SEARCH_DEFAULT_RADIUS_KM` | `50` | |
| `SEARCH_MAX_RADIUS_KM` | `250` | A larger radius in a request is clamped, not rejected |

## AI and embeddings

Both are optional and both default to `none`. Everything works without them — query parsing,
matching and explanations all have deterministic implementations, and **an LLM never produces
a match score**. See [ai-providers.md](ai-providers.md) for the step-by-step.

| Variable | Default | Meaning |
| --- | --- | --- |
| `AI_PROVIDER` | `none` | `none` \| `openai` \| `anthropic` \| `gemini` \| `ollama` \| `openai_compatible` |
| `AI_MODEL` | provider default | |
| `AI_API_KEY` | — | Not needed by `ollama`, nor by a local `openai_compatible` server |
| `AI_BASE_URL` | — | Required for `ollama` and `openai_compatible` |
| `AI_TEMPERATURE` | `0.2` | 0–2 |
| `AI_TIMEOUT_MS` | `30000` | |
| `AI_MAX_CONCURRENCY` | `2` | |
| `EMBEDDING_PROVIDER` | `none` | `none` \| `openai` \| `ollama` \| `openai_compatible` |
| `EMBEDDING_MODEL` | provider default | |
| `EMBEDDING_API_KEY` | — | |
| `EMBEDDING_BASE_URL` | — | |
| `EMBEDDING_DIMENSIONS` | `1536` | **Must match the column.** The `vector(1536)` type is fixed by migration; a model with another width needs a migration |
| `EMBEDDING_MAX_CONCURRENCY` | `2` | |
| `EMBEDDING_TIMEOUT_MS` | `20000` | Separate from the chat timeout — embedding calls are short |

**Precedence: a provider configured in `/admin/providers` wins over these variables**, which
are the fallback. The resolution order is *database row → environment → none*, cached for 30
seconds; that TTL is also how a change reaches the separate worker process.

## Retention and re-crawl

| Variable | Default | Meaning |
| --- | --- | --- |
| `RECRAWL_JOB_HOURS` | `24` | How stale a job may be before it is re-verified |
| `RECRAWL_COMPANY_DAYS` | `14` | |
| `RECRAWL_CANDIDATE_DAYS` | `30` | |
| `DATA_RETENTION_DAYS` | `365` | |

---

## Build-time variables

`NEXT_PUBLIC_*` values are **inlined into the client bundle when the image is built**.
Changing one in `.env` and restarting does nothing; the web image has to be rebuilt:

```bash
docker compose up -d --build web
```

| Variable | Default | Meaning |
| --- | --- | --- |
| `NEXT_PUBLIC_MAP_TILE_URL` | OpenStreetMap tiles | Tile template. Its origin is added to the CSP automatically |
| `NEXT_PUBLIC_MAP_PROVIDER_ALLOW_GOOGLE` | `false` | Offer Google Maps alongside the default map. The deployment holds no Google key — see [maps.md](maps.md) |
| `PUBLIC_ROBOTS_NOINDEX` | `true` | Serves `noindex` and a disallow-all `robots.txt`. Set to `false` only for a deployment you actually want indexed |

## Compose-only variables

Read by `docker-compose.yml`, not by the application:

| Variable | Default | Meaning |
| --- | --- | --- |
| `POSTGRES_USER` | `expojobcrawler` | |
| `POSTGRES_PASSWORD` | — | Required |
| `POSTGRES_DB` | `expojobcrawler` | |
| `REDIS_PASSWORD` | — | Required |
| `WEB_PORT` | `3000` | Host port for the web service. Postgres and Redis are deliberately not published |
| `NOMINATIM_PASSWORD` | — | Required by `docker-compose.nominatim.yml` |
| `MIGRATIONS_DIR` | `migrations/` | Set to `/app/migrations` inside the containers; only override it if you keep migrations elsewhere |

## Secrets hygiene

- `.env` is git-ignored, and so is anything derived from it (`.env.bak*`, `.env.*.bak*`)
- The structured logger redacts any field matching
  `api_key|password|secret|token|authorization|cookie|credential`
- API keys entered in `/admin/providers` are encrypted at rest with AES-256-GCM; no response
  ever returns one, only `hasSecret` and the last four characters
- A Google Maps key is never sent to the server at all

See [security.md](security.md).
