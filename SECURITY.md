# Security policy

## Reporting a vulnerability

Please report security issues **privately**, not as a public issue.

Two ways, either is fine:

- GitHub's private vulnerability reporting on this repository
  (**Security → Report a vulnerability**). It creates a draft advisory visible only to you
  and the maintainers.
- Email **hallo@expoxr.com** with `SECURITY` in the subject line.

Include what you need to make the issue reproducible: affected version or commit, the
component (web, worker, crawler, database), a proof of concept, and the impact you think it
has. If you have a suggested fix, say so — it usually shortens the turnaround considerably.

Expect an acknowledgement within a few days. We will tell you whether the report is
accepted, keep you updated while a fix is prepared, and credit you in the advisory and in
`CHANGELOG.md` unless you would rather stay anonymous.

Please give us a reasonable window to ship a fix before disclosing publicly.

## Supported versions

The project is pre-1.0. Only the `main` branch receives security fixes.

## Scope

In scope — anything that lets someone:

- reach an internal address through the crawler (an SSRF-guard bypass),
- read or modify another user's searches, results or exports,
- reach admin functionality without admin credentials,
- extract a stored provider API key, a session token or a password hash,
- inject SQL, script or markup through scraped content, a query, or an AI response,
- exhaust resources at a cost disproportionate to the request.

Out of scope:

- Findings that require an operator to have already misconfigured the deployment in a way
  the documentation warns against — for example `CRAWL_ALLOW_PRIVATE_ADDRESSES=true`, or
  exposing Postgres or Redis directly to a network.
- Missing hardening on a deployment that is not ours. This is self-hosted software; the
  operator owns the TLS termination, the reverse proxy and the network boundary.
- Reports from automated scanners with no demonstrated impact.

## Design notes relevant to security researchers

These are deliberate properties of the system, documented in
[docs/security.md](docs/security.md):

- Every outbound fetch goes through `safeFetch`, which applies the SSRF guard to the
  original URL **and to every redirect hop**, checking resolved IP addresses rather than
  hostnames.
- Scraped HTML is never rendered as markup.
- All SQL is parameterised and lives only in `packages/database/src/repositories/`.
- The structured logger redacts any key matching
  `api_key|password|secret|token|authorization|cookie|credential`.
- An AI provider never produces a match score, and never receives a database credential.
