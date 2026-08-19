# Contributing to ExpoJobCrawler

Thanks for considering a contribution. This guide covers what you need to get a change
merged.

## Getting set up

Requires Node 20.11+ and PostgreSQL 16 with PostGIS and pgvector, plus Redis. See
[README.md](README.md) for both the Docker and local paths.

```bash
npm install
cp .env.example .env
npm run migrate
npm run seed          # sample data around Kempten
npm run dev           # web app
npm run dev:worker    # workers, separate terminal
```

### Without Node on the host

If you would rather not install Node, the `tools` image carries the whole toolchain and
mounts the working tree:

```bash
docker compose -f docker-compose.dev.yml build tools
docker compose -f docker-compose.dev.yml run --rm --user "$(id -u):$(id -g)" tools npm ci
docker compose -f docker-compose.dev.yml run --rm --user "$(id -u):$(id -g)" tools npm run check
```

Pass `--user` explicitly — bash makes `UID` readonly, so `export UID` silently
fails and the container would leave root-owned files in your working tree. Postgres and
Redis still come from `docker-compose.yml`; migrations have their own one-shot service
there (`docker compose run --rm migrate`).

## Before every commit

```bash
npm run check         # typecheck + lint + test — must pass
```

Add a line to the `[Unreleased]` section of [CHANGELOG.md](CHANGELOG.md) in the same commit
as the change. This is not optional; it is how the release notes get written.

## Architectural invariants

These are load-bearing. A change that breaks one needs a discussion first, not a review
comment. They are explained in [docs/architecture.md](docs/architecture.md).

- **An LLM never produces a match score.** Scoring lives in `packages/matching` and stays
  reproducible and testable. AI explains a result; it does not rank one.
- **Everything works with `AI_PROVIDER=none`.** Query parsing, matching and explanations all
  have deterministic implementations, and they are the reference behaviour.
- **All SQL lives in `packages/database/src/repositories/`,** always parameterised.
- **Every outbound fetch goes through `safeFetch`,** which applies the SSRF guard to each
  redirect hop.
- **Scraped HTML is never rendered as markup.**
- **A job is marked inactive, never deleted,** and only on a conclusive negative (404/410),
  never on a timeout or a 5xx.
- **Discovery upserts merge, never blank:** `COALESCE(new, old)` for scalars, union for
  arrays.

## Code style

- TypeScript strict mode plus `noUncheckedIndexedAccess`. No `any`.
- Zod at every trust boundary: HTTP bodies, queue payloads, AI output, scraped structured
  data.
- Explicit return types on exported functions.
- Comments explain *why*, not *what* — skip them where the code already says it.
- No business logic in React components; no giant route files.
- Structured logging only, never log secrets.
- Providers and AI vendors are pluggable; never hard-code one at a call site.

## Tests

Vitest files sit next to the code they test (`*.test.ts`); Playwright specs live in `e2e/`.

New behaviour needs a test. Bug fixes need a test that fails before the fix. Scoring,
deduplication, the SSRF guard and extraction are the areas where regressions are most
expensive — they carry the densest test suites for that reason.

```bash
npm test                 # Vitest
npm run test:watch
npm run test:e2e         # Playwright; set E2E_BASE_URL to your dev server
```

## Adding a data source

`packages/providers` documents the contract in [docs/providers.md](docs/providers.md). A
provider must degrade rather than fail, respect its own rate limits, and record its outcome
through `recordProviderOutcome` so the admin dashboard can show it.

## Pull requests

Keep a PR to one logical change. Describe *why*, link any issue, and note anything a
reviewer would otherwise have to discover — a migration, a new environment variable, a
behaviour change behind a flag.

New environment variables go in three places at once: the Zod schema in
`packages/shared/src/config.ts`, `.env.example`, and the configuration documentation.

## Licence

ExpoJobCrawler is licensed under the **GNU Affero General Public License v3.0**. By
contributing you agree that your contribution is licensed under the same terms.

The AGPL's network clause matters here: if you run a modified version of this software as a
network service, you must offer its source to the people using it.

## Reporting security issues

Do not open a public issue. Follow [SECURITY.md](SECURITY.md).
