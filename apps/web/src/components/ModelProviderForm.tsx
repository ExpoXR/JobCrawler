'use client';

import { useId, useState } from 'react';

/**
 * Configures one model provider.
 *
 * The API key field is **write-only**: the server never sends a stored key back,
 * so the field starts empty even when a key is configured, and leaving it empty
 * on save keeps whatever is stored. `last4` is shown so an administrator can
 * tell *which* key is in place without being able to read it.
 */

export interface ProviderView {
  providerKey: string;
  kind: 'ai' | 'embedding';
  enabled: boolean;
  model: string | null;
  baseUrl: string | null;
  temperature: number | null;
  timeoutMs: number | null;
  secretRef: string | null;
  hasSecret: boolean;
  last4: string | null;
}

interface TestResult {
  ok: boolean;
  provider?: string;
  model?: string;
  source?: string;
  durationMs?: number;
  reply?: string;
  dimensions?: number;
  error?: string;
}

/** Providers that authenticate with a key, as opposed to a bare endpoint. */
const NEEDS_KEY = new Set(['openai', 'anthropic', 'gemini']);
/** Providers that are addressed by URL rather than a vendor default. */
const NEEDS_URL = new Set(['ollama', 'openai_compatible']);

const LABELS: Record<string, string> = {
  none: 'None (deterministic only)',
  openai: 'OpenAI',
  anthropic: 'Anthropic (Claude)',
  gemini: 'Google Gemini',
  ollama: 'Ollama (local)',
  openai_compatible: 'OpenAI-compatible (LM Studio, vLLM, llama.cpp, OpenRouter…)',
};

export function ModelProviderForm({
  kind,
  available,
  current,
  secretStorageConfigured,
}: {
  kind: 'ai' | 'embedding';
  available: readonly string[];
  current: ProviderView | undefined;
  secretStorageConfigured: boolean;
}) {
  const id = useId();
  const [providerKey, setProviderKey] = useState(current?.providerKey ?? 'none');
  const [model, setModel] = useState(current?.model ?? '');
  const [baseUrl, setBaseUrl] = useState(current?.baseUrl ?? '');
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [test, setTest] = useState<TestResult | undefined>();

  const needsKey = NEEDS_KEY.has(providerKey);
  const needsUrl = NEEDS_URL.has(providerKey);

  async function save(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    setTest(undefined);

    try {
      const response = await fetch('/api/admin/model-providers', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          kind,
          providerKey,
          enabled: providerKey !== 'none',
          model: model || undefined,
          baseUrl: baseUrl || undefined,
          // Omitted entirely when untouched, so saving keeps the stored key.
          ...(apiKey ? { apiKey } : {}),
        }),
      });

      const payload = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) {
        setError(payload.error ?? 'The change could not be saved.');
        return;
      }

      setApiKey('');
      setNotice('Saved. The worker picks this up within 30 seconds.');
    } catch {
      setError('Could not reach the server.');
    } finally {
      setBusy(false);
    }
  }

  async function runTest(): Promise<void> {
    setBusy(true);
    setTest(undefined);
    try {
      const response = await fetch('/api/admin/model-providers/test', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind }),
      });
      setTest((await response.json()) as TestResult);
    } catch {
      setTest({ ok: false, error: 'Could not reach the server.' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="panel provider-form" onSubmit={(event) => void save(event)}>
      <h3>{kind === 'ai' ? 'Language model' : 'Embeddings'}</h3>

      {error ? (
        <p className="notice error" role="alert">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p className="notice" role="status">
          {notice}
        </p>
      ) : null}

      <div className="field">
        <label htmlFor={`${id}-provider`}>Provider</label>
        <select
          id={`${id}-provider`}
          value={providerKey}
          onChange={(event) => setProviderKey(event.target.value)}
        >
          {available.map((entry) => (
            <option key={entry} value={entry}>
              {LABELS[entry] ?? entry}
            </option>
          ))}
        </select>
      </div>

      {providerKey !== 'none' ? (
        <>
          <div className="field">
            <label htmlFor={`${id}-model`}>Model</label>
            <input
              id={`${id}-model`}
              type="text"
              value={model}
              placeholder={kind === 'ai' ? 'gpt-4o-mini' : 'text-embedding-3-small'}
              onChange={(event) => setModel(event.target.value)}
            />
          </div>

          <div className="field">
            <label htmlFor={`${id}-url`}>
              Endpoint {needsUrl ? '*' : '(optional)'}
            </label>
            <input
              id={`${id}-url`}
              type="url"
              value={baseUrl}
              required={needsUrl}
              placeholder={
                providerKey === 'ollama' ? 'http://localhost:11434' : 'http://localhost:1234/v1'
              }
              onChange={(event) => setBaseUrl(event.target.value)}
            />
            {needsUrl ? (
              <p className="hint">
                A local address is expected here. This field bypasses the crawler&rsquo;s SSRF
                guard by design, which is why only administrators can set it.
              </p>
            ) : null}
          </div>

          {needsKey || apiKey ? (
            <div className="field">
              <label htmlFor={`${id}-key`}>API key</label>
              <input
                id={`${id}-key`}
                type="password"
                autoComplete="off"
                value={apiKey}
                disabled={!secretStorageConfigured}
                placeholder={
                  current?.hasSecret ? `stored, ending ${current.last4 ?? '••••'}` : ''
                }
                onChange={(event) => setApiKey(event.target.value)}
              />
              {!secretStorageConfigured ? (
                <p className="hint">
                  Set <code>SETTINGS_ENCRYPTION_KEY</code> (<code>openssl rand -base64 32</code>)
                  before storing a key. Until then the app refuses to hold one rather than
                  holding it unencrypted.
                </p>
              ) : (
                <p className="hint">
                  Encrypted with AES-256-GCM before storage and never sent back to the browser.
                  Leave blank to keep the stored key.
                </p>
              )}
            </div>
          ) : null}
        </>
      ) : (
        <p className="hint">
          Everything still works: query parsing, matching and explanations all have
          deterministic implementations.
        </p>
      )}

      <div className="provider-actions">
        <button className="button" type="submit" disabled={busy}>
          {busy ? 'Working…' : 'Save'}
        </button>
        <button
          type="button"
          className="button secondary"
          onClick={() => void runTest()}
          disabled={busy}
        >
          Test connection
        </button>
      </div>

      {test ? (
        <p className={test.ok ? 'notice' : 'notice error'} role="status">
          {test.ok
            ? `OK — ${test.provider}${test.model ? ` / ${test.model}` : ''}` +
              `${test.durationMs !== undefined ? ` in ${test.durationMs} ms` : ''}` +
              `${test.dimensions ? `, ${test.dimensions} dimensions` : ''}` +
              ` (from the ${test.source})`
            : `Failed: ${test.error ?? 'unknown error'}`}
        </p>
      ) : null}
    </form>
  );
}
