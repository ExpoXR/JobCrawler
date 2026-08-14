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
text nodes by React, which escapes by default. `dangerouslySetInnerHTML` appears
nowhere in the codebase.

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
- Request-body size limit on API routes
- Per-IP fixed-window rate limits on `/api/search`, `/api/geocode`, `/api/parse`
  and `/api/export` (in-memory, therefore per instance — front a multi-instance
  deployment with a shared limiter)

## Secrets

- API keys come from the environment only; `provider_settings.secret_ref` stores
  the *name* of an environment variable, never a value
- The structured logger redacts any key matching
  `api_key|password|secret|token|authorization|cookie|credential`
- Secrets never cross into client components; every route touching them is
  `runtime: 'nodejs'` and server-only
- `.env` is git-ignored; `.env.example` carries placeholders

## Admin access

`/admin` and `/api/admin/*` sit behind HTTP Basic auth in
`apps/web/src/middleware.ts`, compared with a timing-safe function. With no
`ADMIN_PASSWORD` set the area returns 503 — **it fails closed, not open**. Serve
it over TLS; Basic auth is only as private as its transport.

The public application requires no account, by design.

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
