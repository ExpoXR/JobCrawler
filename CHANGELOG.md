# Changelog

All notable changes to ExpoJobCrawler are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Every code change adds an entry under `[Unreleased]` in the same commit.

## [Unreleased]

### Added

- Global footer with ExpoXR attribution and the current web app version.

- Favicon endpoint and standalone-image public asset copy so local fonts and browser icons
  load in production.

- **`docs/installation.md`** — prerequisites for both paths, the Docker and local-development
  setups, the toolchain container for machines without Node, first-run bootstrap, how to
  verify a deployment, a least-privilege database role, and a troubleshooting table. It says
  plainly that `docker compose up` does *not* run the migrations, which is the single easiest
  way to end up with a deployment that starts and then fails on the first query.
- **`docs/configuration.md`** — every environment variable in one place, derived from
  `packages/shared/src/config.ts`, including the three whose wrong values break a deployment
  quietly (`TRUSTED_PROXY_HOPS`, `CSP_MODE`, `CRAWL_ALLOW_PRIVATE_ADDRESSES`), which
  variables are build-time only, and which are read by Compose rather than by the app.
- **`docs/authentication.md`** — roles, the one-shot bootstrap and its failure modes, session
  lifetime and everything that ends one, the password hashing parameters, which layer is
  actually load-bearing for authorisation, and how to recover a lost administrator password.

- **Optional Google Maps, with a key that never reaches this server.** `ResultMap` is now a
  provider switch over `MapLibreMap` (the unchanged default) and a new `GoogleMap`. The
  viewer pastes their own Maps JavaScript key; it is held in that tab's `sessionStorage` and
  discarded when the tab closes, on sign-out, after 30 minutes without interaction, on
  **Forget key**, and when Google rejects it. It is never POSTed, stored or logged. The whole
  option is gated behind `NEXT_PUBLIC_MAP_PROVIDER_ALLOW_GOOGLE`, and the Google hosts enter
  the Content-Security-Policy only under that flag.
- `docs/maps.md` — creating a Google Cloud project, enabling the Maps JavaScript API,
  restricting the key by referrer *and* by API, setting a billing budget, and why the key is
  session-scoped here.

- **Crawling is opt-in.** A search no longer visits third-party websites unless asked:
  a checkbox on the search form, or a **Crawl these websites** action on a finished result
  set (`POST /api/search/{id}/crawl`, one job per *domain* rather than per result, capped
  by role, rate limited 2/min, and closed to anonymous callers).
- `crawler.enabled` — seeded in `settings` since migration 0007 with nothing reading it — is
  now the deployment-wide kill switch for both entry points.
- `robots.txt` responses are cached in `robots_cache` for 24 hours (1 hour for a 5xx, which
  keeps meaning "assume disallowed" until it expires). That table has existed since
  migration 0005 unused, so every crawl was re-fetching `robots.txt`.

- **Model providers are configurable from `/admin/providers`.** `provider_settings` — a
  table that existed since 0007 with no code behind it — now backs a real form: provider,
  model, endpoint, a write-only API key field, and a **Test connection** button that runs a
  one-token completion against the *saved* configuration.
- **API keys are encrypted at rest** with AES-256-GCM (`packages/shared/src/secrets.ts`),
  keyed by `SETTINGS_ENCRYPTION_KEY` from the environment. Without that variable the app
  refuses to store a key rather than storing it unencrypted. No response ever contains a
  stored key — only `hasSecret` and the last four characters.
- **`openai_compatible` provider**, covering LM Studio, vLLM, llama.cpp, OpenRouter, Groq and
  Together in one option: the wire format is OpenAI's, so only the endpoint differs. This is
  how a local model is configured.
- `docs/ai-providers.md`, and an `EMBEDDING_TIMEOUT_MS` so embedding calls stop inheriting
  the chat timeout.

- **Accounts, sessions and roles.** `users` and `sessions` tables, scrypt password
  hashing from `node:crypto`, opaque session tokens in an `httpOnly` cookie whose SHA-256
  alone is stored, a `/login` page and a `/admin/users` management screen. Two roles:
  `admin` and `user`. The first administrator is seeded from `ADMIN_EMAIL` /
  `ADMIN_PASSWORD`, once, while the users table is empty.
- Search ownership: a search created while signed in records a `user_id`, and its results,
  progress stream and export become readable only by that account or an administrator.
  Anonymous searches are unaffected.
- `assertSameOrigin` on every state-changing route.
- **Content-Security-Policy** with a per-request nonce and `'strict-dynamic'`, plus
  `Cross-Origin-Opener-Policy`, `Cross-Origin-Resource-Policy`, and
  `Strict-Transport-Security` on https deployments. `CSP_MODE` ships as
  `report-only` — **set it to `enforce` once you have confirmed no violations**.
- Redis-backed rate limiting, shared across web instances, falling back to the previous
  in-memory limiter when Redis is unreachable. Coverage extended to every API route,
  including the SSE progress stream and `/api/admin/*`.
- `TRUSTED_PROXY_HOPS`: the rate limiter previously trusted the leftmost
  `x-forwarded-for` entry, which the client controls, making every limit bypassable.
- `statement_timeout` and `idle_in_transaction_session_timeout` on the database pool.
- Redis now requires a password in the Compose stack (`REDIS_PASSWORD`).
- Queue payloads are re-validated with `parseSearchQuery` on dequeue — the one trust
  boundary that was not applying the project's own Zod rule.
- Tests for the rate limiter, proxy-hop parsing, CSP construction, `readJsonBody` and
  `assertSameOrigin`.

- Result pagination: a per-page selector (10 / 25 / 50 / 100, default 25, remembered in
  `localStorage`) with previous/next controls and a "showing X–Y of Z" status. The map
  continues to plot every match, not only the current page.
- The filter panel now shows how many filters are active and offers a **Reset**, and its
  fields are grouped into collapsible sections.
- End-to-end coverage asserting the filter panel scrolls independently of the page, and
  unit coverage for the paging arithmetic.

- Licensed the project under the GNU Affero General Public License v3.0. Added `LICENSE`
  and a `license` field to the root manifest and all ten workspace manifests.
- `CHANGELOG.md`, `SECURITY.md` and `CONTRIBUTING.md`.
- Continuous integration: `.github/workflows/ci.yml` runs `npm run check` and `npm audit`;
  `.github/dependabot.yml` keeps dependencies current.
- Development toolchain image (`docker/dev/Dockerfile`, `docker-compose.dev.yml`) so the
  npm scripts can be run without installing Node on the host.
- `docker-compose.ci.yml`, a CI-only overlay that publishes Postgres and Redis to
  localhost. The production stack deliberately keeps both off the host.

### Changed

- `README.md` now points at the installation guide, warns about the migration step, and no
  longer claims the seeded password can be changed under `/admin/users` — that screen does
  not exist yet. `docs/deployment.md` gained the reverse-proxy header and trusted-proxy-hop
  guidance and defers variable documentation to `docs/configuration.md`.
- Removed `POSTGRES_PORT` and `REDIS_PORT` from `.env.example`. Nothing read them: the
  production stack deliberately publishes neither service, and CI uses an overlay with fixed
  loopback ports.
- Admin authentication moved from HTTP Basic to session cookies. `ADMIN_USERNAME` no longer
  authenticates anything; `ADMIN_PASSWORD` now seeds the first account instead of guarding
  the area directly. **Every `/api/admin/*` route now performs its own `requireAdmin()`
  check** rather than relying on middleware, because the edge runtime cannot reach the
  database to verify a session.

### Fixed

- `assertSameOrigin` fell back to `request.url` when the `Origin` did not match
  `PUBLIC_BASE_URL`. Behind a port mapping or a reverse proxy that reports the address the
  server listens on internally, not the one the browser used, so a container published on
  one port while listening on another rejected every request it received. It now compares
  against the `Host` header.
- A cross-origin rejection and a missing administrator role both surfaced as "Your account
  is not allowed to do that", in the UI and in the logs, which made the two impossible to
  tell apart. Both now report what actually happened, and a rejection names the origin.
- `/api/export` treated the search id as the only credential, so anyone with the URL could
  download another account's results. Owned searches now require their owner.
- The **Admin** link was rendered in the header for every anonymous visitor.
- The filter sidebar could not be scrolled. `.filter-disclosure` bounded its height but set
  no `overflow`, while the scrollable `.filters-column` had no bounded height, so the form
  overflowed its clipped box and the Search button became unreachable on short viewports.
  The panel is now a flex column whose middle band scrolls, with `overscroll-behavior:
  contain` so the wheel no longer chains into the results list, and Search pinned to a
  footer outside the scrolling area.
- The map legend was pushed outside the sticky viewport because `.map-container` was
  `height: 100%` of a fixed-height aside. The map now takes the space the legend does not.
- `docs/security.md` pointed at `apps/web/src/middleware.ts` for the admin authentication
  boundary. Next 16 renamed that file to `apps/web/src/proxy.ts`.
- `docs/security.md` still stated that API keys come from the environment only and that
  `provider_settings` holds nothing but a variable name. Encrypted storage landed in the same
  release, so the section described a rule the code no longer follows.

## [0.1.0]

Initial implementation: geographic discovery over OpenStreetMap, polite crawling with an
SSRF guard, deterministic matching, an optional AI layer, and the search workspace UI.
