# Configuring a model provider

Everything works with no provider configured. Query parsing, matching and
explanations all have deterministic implementations, and **an LLM never produces
a match score** — configuring one improves the wording of an explanation and the
quality of a parse, never the ranking. See [ai.md](ai.md) for what the layer
actually does.

There are two ways to configure a provider, and the first wins:

1. **The dashboard** — `/admin/providers`. Stored in `provider_settings`, with
   any API key encrypted at rest.
2. **The environment** — `AI_*` and `EMBEDDING_*`. Better where a deployment
   manages secrets externally; nothing is written to the database at all.

Resolution is *database row → environment → none*, cached for 30 seconds. That
TTL is how a change reaches the **worker**, which is a separate process: expect
up to half a minute, not a restart.

## Before storing a key in the dashboard

Generate an encryption key and put it in the environment:

```bash
openssl rand -base64 32
```

```dotenv
SETTINGS_ENCRYPTION_KEY=<the 32 bytes of base64 from above>
```

Without it the dashboard **refuses to accept an API key** rather than storing one
unencrypted. Providers that need no key — Ollama, most local servers — work
without it.

Both the web and the worker container need this variable; the worker resolves
providers too and cannot decrypt a key it has no key for.

**Changing `SETTINGS_ENCRYPTION_KEY` makes every stored key undecryptable.** The
affected provider degrades to unconfigured and logs it; re-enter the keys.

## OpenAI

| Field | Value |
| --- | --- |
| Provider | `openai` |
| Model | `gpt-4o-mini` is a sensible default; `gpt-4o` for better parses |
| Endpoint | leave blank |
| API key | from <https://platform.openai.com/api-keys> |

Embeddings: provider `openai`, model `text-embedding-3-small`. Set
`EMBEDDING_DIMENSIONS` to match — the schema's vector column is sized by it, so
changing it later means re-embedding everything.

## Anthropic

| Field | Value |
| --- | --- |
| Provider | `anthropic` |
| Model | `claude-sonnet-4-5` |
| Endpoint | leave blank |
| API key | from <https://console.anthropic.com/settings/keys> |

Anthropic has no embedding API; pair it with OpenAI or a local embedder.

## Google Gemini

| Field | Value |
| --- | --- |
| Provider | `gemini` |
| Model | `gemini-2.0-flash` |
| Endpoint | leave blank |
| API key | from <https://aistudio.google.com/apikey> |

## Ollama (local)

No API key, no data leaving the host, no per-token cost.

```bash
ollama pull llama3.1
ollama pull nomic-embed-text
```

| Field | Value |
| --- | --- |
| Provider | `ollama` |
| Model | `llama3.1` (chat), `nomic-embed-text` (embeddings) |
| Endpoint | `http://localhost:11434`, or `http://host.docker.internal:11434` from a container |

Running in Docker, `localhost` is the *container*. Use the host's address, and
make sure Ollama listens on it (`OLLAMA_HOST=0.0.0.0`) rather than only on
loopback.

`nomic-embed-text` produces 768 dimensions, so set `EMBEDDING_DIMENSIONS=768`.

## Anything OpenAI-compatible

`openai_compatible` is a wire format, not a vendor: any server implementing
OpenAI's `/chat/completions`. One option therefore covers a large family.

| Server | Endpoint |
| --- | --- |
| LM Studio | `http://localhost:1234/v1` |
| vLLM | `http://localhost:8000/v1` |
| llama.cpp (`llama-server`) | `http://localhost:8080/v1` |
| OpenRouter | `https://openrouter.ai/api/v1` (needs a key) |
| Groq | `https://api.groq.com/openai/v1` (needs a key) |
| Together | `https://api.together.xyz/v1` (needs a key) |

The endpoint is required; the API key is optional, because a local server
usually wants none. Include the `/v1` suffix — the path is appended to whatever
you give.

Two differences from `openai` proper: no `dimensions` parameter is sent on
embedding requests, because local servers commonly reject unknown fields and
their models have a fixed width anyway; and an empty key sends no
`Authorization` header at all rather than an empty bearer token, which some
servers reject.

## Testing

**Test connection** on `/admin/providers` runs a one-token completion (or a
single embedding) against the stored configuration and reports what answered,
how long it took, and which source the configuration came from.

It deliberately tests what is *saved*, not what is typed in the form, so the
endpoint cannot be used to make the server call an arbitrary address with an
arbitrary credential. Save first, then test.

## Cost control

- `AI_MAX_CONCURRENCY` and `EMBEDDING_MAX_CONCURRENCY` bound parallel calls.
- Research output is cached in `ai_analysis`, keyed by subject, prompt version
  and an input hash, so re-opening a result costs nothing.
- Embeddings are cached in-process and stored on the row; the half-hourly
  backfill only touches rows that have none.
- `/api/research` is rate limited to 6/min per client, the tightest budget in the
  application, because it is the only route that can spend money per request.

## Security notes

- An **endpoint pointing at a private address is intended** for local models, so
  this field deliberately bypasses the crawler's SSRF guard. That is why only an
  administrator can set it, why only `http`/`https` are accepted, why embedded
  credentials are refused, and why every change is logged.
- **No response ever contains a stored key.** The API returns `hasSecret` and the
  last four characters only.
- A provider's raw error body is never forwarded to the browser: some vendors
  echo the submitted key back in an error message.
