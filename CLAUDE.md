# ExpoJobCrawler

## Project Overview

ExpoJobCrawler is a self-hosted, AI-powered geographic employment research
engine for Europe. It discovers jobs, employers and public professional profiles
around a location by combining OpenStreetMap geography, polite website crawling,
deterministic matching and an optional AI layer.

Full documentation lives in `docs/`. Start with `docs/architecture.md`.

## Development Guidelines

- Follow clean code principles
- Write tests for new features
- Use descriptive commit messages
- Keep dependencies up to date

## Commands

```bash
npm install
npm run migrate        # apply SQL migrations (needs Postgres + PostGIS + pgvector)
npm run seed           # sample data around Kempten
npm run dev            # Next.js dev server
npm run dev:worker     # BullMQ workers
npm run check          # typecheck + lint + test — run before every commit
npm test               # Vitest only
```

## Architecture

npm workspaces monorepo. Two processes (`apps/web`, `apps/worker`) over shared
packages:

```text
shared → database → crawler → providers ┐
      ↘ matching                        ├→ search → web / worker
      ↘ ai ────────────────────────────┘
        queue
```

- `shared` — types, Zod schemas, config, logging, geo maths, multilingual vocabulary
- `database` — all SQL, repositories, migration runner
- `crawler` — SSRF guard, robots.txt, sitemaps, fetching, extraction
- `providers` — provider contracts + OSM/Overpass/Nominatim/career-page/GitHub
- `ai` — provider-independent AI/embeddings, query parsing, research agent
- `matching` — deterministic scoring and duplicate detection
- `search` — hybrid orchestration (indexed results now, live discovery after)
- `queue` — BullMQ queue definitions

Packages ship TypeScript source, not build output: Next transpiles them, the
worker runs them with `tsx`, Vitest reads them directly.

### Invariants worth keeping

- **An LLM never produces a match score.** Scoring lives in `matching` and must
  stay reproducible and testable. AI explains; it does not rank.
- **Everything works with `AI_PROVIDER=none`.** Query parsing, matching and
  explanations all have deterministic implementations.
- **All SQL lives in `packages/database/src/repositories/`,** always
  parameterised.
- **Every outbound fetch goes through `safeFetch`,** which applies the SSRF
  guard to each redirect hop.
- **Scraped HTML is never rendered as markup.**
- **A job is marked inactive, never deleted,** and only on a conclusive negative
  (404/410), not on a timeout or 5xx.
- **Discovery upserts merge, never blank:** `COALESCE(new, old)` for scalars,
  union for arrays.

## Code Style

- TypeScript strict mode, plus `noUncheckedIndexedAccess`; no `any`
- Zod at every trust boundary (HTTP bodies, queue payloads, AI output, scraped
  structured data)
- Explicit return types on exported functions
- Comments explain *why*, not *what*; skip them where the code already says it
- No business logic in React components; no giant route files
- Structured logging only — never log secrets
- Providers and AI vendors are pluggable; never hard-code one at a call site

## Caveman Skills

Ultra-compressed communication mode available. Cuts ~75% output tokens, full technical accuracy.

| Command | What |
|---------|------|
| `/caveman` | Activate (full mode default) |
| `/caveman lite\|full\|ultra` | Switch intensity |
| `/caveman-commit` | Terse Conventional Commits message |
| `/caveman-review` | One-line PR comments: `L42: 🔴 bug: user null. Add guard.` |
| `/caveman-help` | Quick-reference card |
| `/caveman-compress <file>` | Compress .md file → ~46% fewer input tokens |

Stop: "stop caveman" or "normal mode". Skills in `.claude/skills/`, commands in `.claude/commands/`.

## Skills Reference / Agent communication

Caveman skill is available for terse AI communication:

```
/caveman        — activate full caveman mode
/caveman lite   — no filler, keep full sentences
/caveman ultra  — maximum abbreviation
stop caveman    — return to normal mode
```

Location: `.claude/skills/caveman/`. Caveman mode stays active across responses. Terse chat is
fine; **write full normal prose in code, commits, PRs, and these docs.** Never let terse wording
weaken security warnings, irreversible-action confirmations, or release steps.
