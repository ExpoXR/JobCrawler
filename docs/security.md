# Security and privacy

## SSRF

The highest-severity risk in a crawler: the system fetches URLs derived from
third-party data. `packages/crawler/src/ssrf.ts` applies two layers.

**1. URL shape** (cheap, synchronous)

- `http`/`https` only
- ports restricted to 80, 443, 8080, 8443
- embedded credentials refused
- internal hostnames refused: `localhost`, `metadata.google.internal`,
  `host.docker.internal`, `kubernetes.default`, …
- internal suffixes refused: `.local`, `.internal`, `.lan`, `.svc`,
  `.cluster.local`, `.docker`, …
- a bare hostname with no dot is refused (it is almost always a service name)

**2. Resolved address** (the layer that actually matters)

Every A/AAAA record must be a public unicast address. Blocked: `0.0.0.0/8`,
`10/8`, `100.64/10`, `127/8`, `169.254/16` (cloud metadata), `172.16/12`,
`192.168/16`, documentation and benchmark ranges, multicast, reserved; IPv6
loopback, unspecified, unique-local (`fc00::/7`), link-local (`fe80::/10`),
multicast; and IPv4-mapped IPv6 (`::ffff:127.0.0.1`) re-checked against the IPv4
rules.

**Redirects are followed manually** (`redirect: 'manual'`) and every hop is
re-validated. Automatic redirect following would let a public host bounce us
straight to an internal address.

`CRAWL_ALLOW_PRIVATE_ADDRESSES=true` disables layer 2 for local development.
Never set it in a deployment that crawls third-party URLs.

Covered by 18 tests in `packages/crawler/src/ssrf.test.ts`.

## Injection

**SQL** — every query is parameterised and confined to
`packages/database/src/repositories/`. No string interpolation of values.

**XSS** — scraped HTML is never re-emitted as markup. Descriptions are stored as
plain text (`sanitizeScrapedText` strips control characters) and rendered as
text nodes by React, which escapes by default.

`dangerouslySetInnerHTML` is used in exactly one place: the anti-FOUC theme
script in `apps/web/src/app/layout.tsx`, whose content is a compile-time
constant with no interpolation of any kind. It carries the CSP nonce. If a
second use ever appears, that is worth a hard look.

**XML** — `fast-xml-parser` runs with `processEntities: false`, so entity
expansion and external entity references are inert.

**CSV** — `toCsvValue` prefixes a quote to any cell starting with `=`, `+`, `-`
or `@`, so an exported file cannot execute a formula when opened in a
spreadsheet.

**Command injection** — the system spawns no subprocesses.

## Resource exhaustion

- Response bodies capped while streaming (`CRAWL_MAX_PAGE_BYTES`)
- Per-request timeouts and bounded redirect chains
- Page, domain and sitemap-entry budgets per search
- Bounded worker concurrency; queue jobs capped at 3 attempts with exponential backoff
- Request-body size limit on API routes (256 KB, checked against
  `content-length` before the body is buffered)
- Server-side `statement_timeout` (30 s) and
  `idle_in_transaction_session_timeout` (60 s), so one pathological query cannot
  hold a pooled connection against everyone else
- Per-client fixed-window rate limits on **every** API route, including the SSE
  progress stream — each of those holds a connection for up to ten minutes, so
  opening them is the cheap half of an exhaustion attack

### Rate limiting

Backed by Redis (`apps/web/src/lib/rateLimit.ts`), which the deployment already
runs for queues, so a limit means the same thing across every web instance and
survives a restart. When Redis is unreachable it falls back to the in-memory
limiter and backs off for 30 seconds before trying again — it degrades, it does
not fail open.

**`TRUSTED_PROXY_HOPS` must match your deployment.** `x-forwarded-for` is
appended to by every hop and the *client* controls the leftmost entry, so
trusting that entry makes every limit bypassable by sending a random address.
The limiter counts the configured number of hops from the right; `0` ignores the
header entirely. Too high and it reads a spoofed value; too low and every client
shares one bucket.

## Browser security headers

Static headers come from `apps/web/next.config.ts`; the Content-Security-Policy
is built per request in `apps/web/src/lib/csp.ts` and set by
`apps/web/src/proxy.ts`, because it carries a nonce.

| Header | Value |
| --- | --- |
| `Content-Security-Policy` | see below |
| `X-Content-Type-Options` | `nosniff` |
| `X-Frame-Options` | `DENY` |
| `Referrer-Policy` | `strict-origin-when-cross-origin` |
| `Permissions-Policy` | `geolocation=(self)`, everything else denied |
| `Cross-Origin-Opener-Policy` | `same-origin` |
| `Cross-Origin-Resource-Policy` | `same-origin` |
| `Strict-Transport-Security` | one year, only when `PUBLIC_BASE_URL` is https |

The policy uses a per-request nonce with `'strict-dynamic'`: only scripts this
server marked, and scripts those load, may run — the host allowlist is ignored,
so a permissive CDN entry cannot undermine it. `script-src` never contains
`'unsafe-inline'`. `style-src` does, because MapLibre and Next both inject style
elements that cannot carry a nonce; that is the one loose directive.
`object-src`, `base-uri`, `frame-src` and `frame-ancestors` are `'none'`, and
`form-action` is `'self'`.

The only third-party hosts that ever enter the policy are the map tile server
from `NEXT_PUBLIC_MAP_TILE_URL`, and — only where
`NEXT_PUBLIC_MAP_PROVIDER_ALLOW_GOOGLE=true` — the Google Maps hosts listed in
[maps.md](maps.md). A deployment that does not offer the Google map has no
Google hosts in its policy.

**`CSP_MODE` ships as `report-only`, which enforces nothing.** A policy mistake
takes an application down silently, so the default observes instead. Load every
page, confirm the browser console reports no violations, then set
`CSP_MODE=enforce`. Until you do, the policy is documentation.

## Cross-site request forgery

Session cookies are `SameSite=Lax`, which stops the classic cross-site form
post. On top of that, every state-changing route calls `assertSameOrigin`, which
rejects a request whose `Origin` is neither the configured `PUBLIC_BASE_URL` nor
the request's own origin. Requests with no `Origin` at all are allowed through —
curl and native clients send none, and CSRF requires a browser to begin with.

## Queue payloads

A job payload round-trips through Redis as JSON, which makes it a trust boundary
like an HTTP body. The discovery handlers re-validate their `SearchQuery` with
`parseSearchQuery` on dequeue rather than trusting the shape they were given.

## Secrets

- Model-provider API keys reach the app one of two ways: from the environment, or
  from `/admin/providers`. A key entered in the admin UI is stored in
  `provider_settings.secret_ciphertext` **encrypted with AES-256-GCM**
  (`packages/shared/src/secrets.ts`), keyed by `SETTINGS_ENCRYPTION_KEY`. Without
  that variable the app refuses to store a key at all rather than storing it in
  the clear. The older `secret_ref` mode — which holds the *name* of an
  environment variable, never a value — still works and is still the stricter
  choice
- No response ever contains a stored key: the API returns `hasSecret` and the
  last four characters, nothing more
- **A Google Maps key is never stored server-side at all.** It is supplied by the
  viewer, lives in their tab's `sessionStorage`, and is never sent to this server
  — see [maps.md](maps.md)
- The structured logger redacts any key matching
  `api_key|password|secret|token|authorization|cookie|credential`
- Secrets never cross into client components; every route touching them is
  `runtime: 'nodejs'` and server-only
- `.env` is git-ignored, along with anything derived from it (`.env.bak*`);
  `.env.example` carries placeholders

## Admin access

Accounts live in `users`, with exactly two roles: `admin` and `user`.

- **Passwords** are scrypt (N=2^15, r=8, p=1) with a 32-byte per-row salt, in
  `apps/web/src/lib/password.ts`. Verification is `timingSafeEqual`, and a login
  for an account that does not exist still performs a full hash comparison
  against a dummy record, so neither the response nor its timing reveals whether
  an email is registered.
- **Sessions** are opaque 32-byte random tokens in an `httpOnly`, `SameSite=Lax`
  cookie, `Secure` whenever `PUBLIC_BASE_URL` is https. The database stores only
  their SHA-256, so a dump grants no logins. A sliding window (default 7 days)
  is capped by an absolute one (default 30 days) that is never extended.
  Changing a password, changing a role or deactivating an account deletes every
  session for that user immediately — which is why these are not JWTs.
- **The authorisation check is `requireAdmin()` in each route handler and page**,
  on the Node runtime, against the database. `apps/web/src/proxy.ts` runs on the
  edge runtime and can only see whether a session cookie is *present*, so it
  redirects; it never authorises. Nothing security-relevant depends on it.
- **The first administrator** is seeded from `ADMIN_EMAIL` / `ADMIN_PASSWORD`,
  and only ever when the users table is empty, so it cannot overwrite an account
  an operator has since changed. Clear `ADMIN_PASSWORD` once you have signed in.
- **The last active administrator** cannot be demoted, deactivated or deleted;
  the alternative is a deployment nobody can administer.

Searching still requires no account. What changed is ownership: a search created
while signed in records a `user_id`, and its results, its progress stream and its
export are then readable only by that account or an administrator. A search
created signed out has no owner and stays readable by anyone holding its id, as
before. A search that does not exist and one belonging to somebody else fail
identically, so the endpoint cannot be used to discover which ids exist.

## Error handling

`handleRouteError` maps the internal error taxonomy to status codes and returns
only `publicErrorMessage`, so no stack trace, connection string or provider
detail reaches a client. Full context goes to the structured log.

---

# GDPR and privacy

Treated as an architectural concern, not a policy document (plan section 40).

**Public professional data only.** Candidate records store what a public profile
already publishes: name, headline, approximate location, visible skills, and
links. No emails are harvested, no profiles are mirrored, and the intent is to
point a recruiter at the original source — not to replace it.

**Data minimisation.** `candidates` is deliberately the thinnest table in the
schema. Searches are anonymous: no user identifier is recorded, only the query.

**Provenance.** Every job, company and candidate carries source URLs and
retrieval timestamps, so any stored claim can be traced to the page it came from
and checked.

**Erasure that sticks.** Removing a candidate or a domain tombstones the record
*and* writes a `removal_requests` entry. Every write path checks that
suppression list first, so a later crawl cannot silently re-add what was
removed. Blocking a domain optionally purges everything already indexed for it.

**Retention.** Search sessions expire after 30 days; caches expire on their own
schedule; `DATA_RETENTION_DAYS` bounds the rest. The `cleanup` queue enforces all
of it.

**Operator responsibilities.** This is self-hosted software. Whoever runs it is
the controller: set an honest `CRAWLER_USER_AGENT` and `CRAWLER_CONTACT_EMAIL`,
honour removal requests through the admin endpoints, and check that the sources
you enable permit the use you intend.
