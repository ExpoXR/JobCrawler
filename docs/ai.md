# AI and embeddings

The AI layer is optional. Every feature it touches has a deterministic
implementation underneath, and `AI_PROVIDER=none` is a fully supported
configuration — not a degraded one.

## Providers

`packages/ai/src/providers.ts` implements four chat providers and two embedding
providers against their HTTP APIs directly, with no vendor SDKs. That keeps the
dependency surface small and the request shapes explicit.

| `AI_PROVIDER` | Default model | Notes |
| --- | --- | --- |
| `none` | — | Heuristics only. The default. |
| `openai` | `gpt-4o-mini` | Native JSON mode |
| `anthropic` | `claude-sonnet-4-5` | System prompt is a top-level field |
| `gemini` | `gemini-2.0-flash` | `responseMimeType: application/json` |
| `ollama` | `llama3.1` | Local; needs an endpoint, not a key |

| `EMBEDDING_PROVIDER` | Default model |
| --- | --- |
| `none` | — (lexical scoring only) |
| `openai` | `text-embedding-3-small` |
| `ollama` | `nomic-embed-text` |

Configuration is environment-only (`AI_API_KEY`, `AI_BASE_URL`, `AI_MODEL`,
`AI_TEMPERATURE`, `AI_TIMEOUT_MS`, `AI_MAX_CONCURRENCY`). Keys are never written
to the database: `provider_settings.secret_ref` names an environment variable
instead, so a database dump cannot leak a credential and rotating a key needs no
write.

Adding a provider means implementing `AiProvider` or `EmbeddingProvider` and
adding a case to `getAiProvider()` / `getEmbeddingProvider()`.

## Query parsing

`packages/ai/src/queryParser.ts`.

The **heuristic parser is primary**, not a fallback: deterministic, instant,
free, offline, and testable. It extracts location, radius, role, skills,
seniority, employment type, work model, experience, languages, salary, company
size and exclusions from German and English text using the shared vocabulary.

When an AI provider is configured, its output is:

1. requested as strict JSON,
2. validated against `parsedQuerySchema`,
3. **merged over** the heuristic result — arrays are unioned, empty values are
   ignored.

So enabling AI can only add signal. It can never silently drop a filter the
deterministic parser already found, and a malformed or hallucinated response
falls back rather than corrupting the search.

Parsed filters are always shown in the UI and remain editable before the search
runs (plan section 6). The parse is never applied invisibly.

`parseJobDescription` reuses the same machinery for a pasted job ad, then
promotes skills appearing before any "nice to have" section to *required*.

## Embeddings

`packages/ai/src/embeddings.ts` owns the text that gets embedded, in one place,
so a job and a query are always described in the same vocabulary. Change a
builder and existing vectors are stale — hence `EMBEDDING_TEXT_VERSION`, which
is part of the cache key.

Embedding failures are swallowed: `embedTexts` returns `undefined` per item and
the matcher simply omits the semantic component. Batched (16 per request),
concurrency-limited, and memoised in-process because the same company recurs
across many results in one search.

Similarity is mapped from cosine `[-1, 1]` to `[0, 1]` before it is used as a
score component.

## Research agent

`packages/ai/src/research.ts`. Two hard rules:

1. **The agent never produces the match score.** Scores come from
   `@ejc/matching` so they stay reproducible and testable.
2. **Every claim must cite a source we actually fetched.** The prompt is built
   only from material already in the database, sources are handed to the model
   as an indexed list, and the response must return the indexes it used. The
   output is schema-validated before a user sees it.

With no AI configured, `explainMatchWithoutAi` produces the explanation from the
scoring evidence — which already states why a result ranked where it did. This
is a real feature, not a placeholder.

Analyses are cached in `ai_analysis`, keyed by subject, kind, prompt version and
an input hash, so repeated "research this" clicks do not re-bill the provider
and a prompt change invalidates naturally.

## Cost control

- `AI_MAX_CONCURRENCY` / `EMBEDDING_MAX_CONCURRENCY` bound parallel calls.
- `AI_TIMEOUT_MS` bounds each call.
- Research runs on demand, not for every result.
- `ai_analysis` and the in-process embedding cache remove repeat work.
- Ollama gives a zero-marginal-cost local option for both roles.
