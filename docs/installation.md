# Installation

Two supported paths: **Docker Compose** (what a deployment should use) and **local
development** (Node on your machine). Both end at the same place — a web app on port 3000, a
worker process, Postgres, and Redis.

Read [configuration.md](configuration.md) alongside this. Everything below assumes `.env`
exists and has the four required values in it.

---

## Prerequisites

### Docker path

- Docker Engine 24+ with the Compose plugin
- 4 GB RAM and 10 GB disk for the application stack
- Optional: another **~180 GB and 24 GB RAM** if you also self-host the DACH Nominatim
  geocoder. This is by far the largest cost of the project and it is optional — see
  *Geocoding* below

### Local development path

- **Node 20.11+** (the repo is npm workspaces; nothing is transpiled ahead of time)
- **PostgreSQL 16** with `postgis`, `vector`, `pg_trgm`, `unaccent` and `pgcrypto` available
- **Redis 7** — optional. Without it, searches return indexed results and report that live
  discovery is unavailable, rather than failing

No Node on the machine? There is a toolchain container for exactly that:

```bash
docker compose -f docker-compose.dev.yml build tools
docker compose -f docker-compose.dev.yml run --rm --user "$(id -u):$(id -g)" tools npm ci
docker compose -f docker-compose.dev.yml run --rm --user "$(id -u):$(id -g)" tools npm run check
```

Pass `--user` explicitly. Bash makes `UID` read-only, so `export UID` does not work and the
container would otherwise run as root and leave root-owned files in your working tree.

---

## Docker Compose

```bash
git clone https://github.com/ExpoXR/ExpoJobCrawler.git
cd ExpoJobCrawler
cp .env.example .env
```

Edit `.env`. At minimum:

```bash
POSTGRES_PASSWORD=…            # Compose refuses to start without it
REDIS_PASSWORD=…               # likewise
ADMIN_EMAIL=you@example.com    # seeds the first administrator
ADMIN_PASSWORD=…               # at least 12 characters
PUBLIC_BASE_URL=https://jobs.example.com
CRAWLER_USER_AGENT=YourProject/0.1 (+https://your-domain.example; you@example.com)
```

Then:

```bash
docker compose up -d --build
docker compose run --rm migrate      # ← not optional, and not automatic
```

**The migration step is easy to miss.** The `migrate` service is `profiles: ['tools']`, so
`docker compose up` does not start it — by design, because schema changes should be a
deliberate act. Skip it on a fresh deployment and the app starts, serves pages, and fails the
moment anything touches the database. Signing in fails with a generic error, because
`relation "users" does not exist` is not something the app shows a visitor.

Verify:

```bash
docker compose run --rm migrate node_modules/.bin/tsx packages/database/src/cli/migrate.ts status
```

Then open <http://localhost:3000> (or `WEB_PORT`).

Only `web` publishes a port. Postgres and Redis stay on the internal Compose network and are
not reachable from the host.

### Upgrading

```bash
git pull
docker compose up -d --build
docker compose run --rm migrate
```

Migrations are forward-only, transactional, and checksummed: the runner refuses to proceed if
an already-applied migration's contents have changed. It is safe to run while the app is up.

---

## Local development

```bash
npm install
cp .env.example .env
# point DATABASE_URL and REDIS_URL at your local services

npm run migrate      # create the schema
npm run seed         # optional: sample companies and jobs around Kempten

npm run dev          # web app on http://localhost:3000
npm run dev:worker   # workers, in a second terminal
```

| Command | Purpose |
| --- | --- |
| `npm run check` | typecheck + lint + test — run this before every commit |
| `npm run migrate:status` | applied and pending migrations |
| `npm test` | Vitest only |
| `npm run test:e2e` | Playwright; expects a running instance (`E2E_BASE_URL`, default `:3005`) |

Packages ship TypeScript source rather than build output: Next transpiles them, the worker
runs them with `tsx`, and Vitest reads them directly. There is no build step between editing
a package and using it.

---

## First run

1. Open `/login` and sign in with `ADMIN_EMAIL` / `ADMIN_PASSWORD`.
   These seed the first administrator **once, while the users table is empty**. They do
   nothing afterwards.
2. Change that password, then clear `ADMIN_PASSWORD` from the environment.
   See [authentication.md](authentication.md) — there is currently no self-service
   change-password screen, and that page documents the workaround.
3. Optional: configure a model provider at `/admin/providers`
   ([ai-providers.md](ai-providers.md)). Everything works without one.

Searching needs no account at all. A search run while signed in belongs to that account and
its results and export become private to it; a search run signed out stays readable by anyone
holding its id.

---

## Geocoding

A location has to be resolved to a point before anything else can happen, so **geocoding is
the one external dependency that is not optional**.

- **Default:** the public Nominatim instance. Fine for trying the app out. Its
  [usage policy](https://operations.osmfoundation.org/policies/nominatim/) forbids bulk use,
  so it is not fine for a deployment.
- **Self-hosted:** `docker-compose.nominatim.yml` imports the Geofabrik DACH extract. The
  initial import takes **hours** and the dataset needs ~180 GB. Details, including the ZFS
  dataset setup, are in [deployment.md](deployment.md).

```bash
docker compose -f docker-compose.nominatim.yml up -d
docker logs -f expojobcrawler-nominatim     # readiness is GET /status
```

Company discovery additionally uses Overpass. The public instances are shared and rate
limited; keep `OVERPASS_FALLBACK_URLS` populated.

---

## Verifying

```bash
curl -s http://localhost:3000/api/health | jq
```

```json
{
  "status": "ok",
  "database": { "ok": true, "postgis": true, "pgvector": true },
  "redis": { "ok": true },
  "ai": { "provider": "none", "configured": false },
  "geocoding": { "provider": "nominatim", "ok": true }
}
```

**`/api/health` returns 503 whenever geocoding is unreachable**, even though the rest of the
app works. That is intentional — a deployment that cannot geocode cannot search — but it
makes the endpoint a poor readiness probe while Nominatim is still importing. CI waits on
`/` for that reason. The body always names which dependency failed; the top-level status is
`degraded` rather than `ok`.

Then, end to end: search for a location, confirm results appear, and confirm the map plots
them.

---

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `POSTGRES_PASSWORD must be set` | Compose `:?` guard | Set it in `.env` |
| Sign-in fails with a generic error, logs show `relation "users" does not exist` | Migrations never ran — `docker compose up` skips the `tools`-profile `migrate` service | `docker compose run --rm migrate` |
| Sign-in fails and the users table is empty | `ADMIN_EMAIL`/`ADMIN_PASSWORD` were unset on first run, or the password was under 12 characters. Seeding only happens while the table is empty | Set both, restart, try again |
| Every request rejected as cross-origin | `PUBLIC_BASE_URL` does not match the origin the browser actually uses — common behind a port mapping | Set it to the browser-visible URL |
| `type "geometry" does not exist` | Plain Postgres, no PostGIS | Use the built image (`docker/postgres/Dockerfile`), or install PostGIS and pgvector |
| Searches return only indexed results | Either no Redis, or the crawl checkbox is unticked — crawling is opt-in | Check the message under the progress bar; it distinguishes the two |
| `/api/health` is 503 with `geocoding.ok: false` | Nominatim unreachable, or still importing | Expected during import; otherwise check `NOMINATIM_BASE_URL` |
| Admin dashboard shows no queue statistics | Redis unreachable | Check `REDIS_PASSWORD` matches on both sides |
| Map is blank | Blocked tiles, or no WebGL | The list still has every result; see [maps.md](maps.md) |
| Provider form refuses an API key | `SETTINGS_ENCRYPTION_KEY` is unset | `openssl rand -base64 32` |
| Root-owned files after using the dev container | `--user` was omitted | `sudo chown -R "$(id -u):$(id -g)" .` |

Logs are one JSON object per line:

```bash
docker compose logs -f web
docker compose logs -f worker
```

---

## Hardening the database role

The application connects as the database owner by default, which is more than it needs. For a
deployment, give it a role that cannot change the schema, and run migrations as the owner:

```sql
-- as the owner
CREATE ROLE ejc_app LOGIN PASSWORD 'change-me';
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO ejc_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ejc_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ejc_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ejc_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO ejc_app;
```

Point `DATABASE_URL` at `ejc_app` and give the `migrate` service the owner's URL. The role
needs no `SUPERUSER` and no `CREATE`; extensions are created by the migrations, which run as
the owner. Re-run the two `GRANT … ON ALL TABLES` statements after a migration adds a table,
or rely on the `ALTER DEFAULT PRIVILEGES` above to cover new ones.

---

## Uninstalling

```bash
docker compose down            # keeps the volumes
docker compose down -v         # deletes pgdata and redisdata — all crawled data with them
```

`down -v` is irreversible. Take a dump first if the data matters:

```bash
docker compose exec -T postgres pg_dump -U expojobcrawler expojobcrawler | gzip > backup.sql.gz
```
