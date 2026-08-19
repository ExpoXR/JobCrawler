import { listModelProviders } from '@ejc/database';
import { AI_PROVIDERS, EMBEDDING_PROVIDERS, isSecretStorageConfigured } from '@ejc/shared';
import type { Metadata } from 'next';
import Link from 'next/link';

import { ModelProviderForm, type ProviderView } from '@/components/ModelProviderForm';
import { guardAdminPage } from '@/lib/auth';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Model providers' };

/**
 * Model provider configuration.
 *
 * Nothing on this page can reveal a stored key: `listModelProviders` returns the
 * ciphertext, and only the last four characters cross into the client component.
 */
export default async function AdminProvidersPage() {
  await guardAdminPage('/admin/providers');

  const configured = await listModelProviders();
  const secretStorageConfigured = isSecretStorageConfigured();

  const view = (kind: 'ai' | 'embedding'): ProviderView | undefined => {
    const row = configured.find((entry) => entry.kind === kind && entry.enabled);
    if (!row) return undefined;
    return {
      providerKey: row.providerKey,
      kind: row.kind,
      enabled: row.enabled,
      model: row.model,
      baseUrl: row.baseUrl,
      temperature: row.temperature,
      timeoutMs: row.timeoutMs,
      secretRef: row.secretRef,
      hasSecret: row.secretCiphertext !== null,
      last4: row.secretLast4,
    };
  };

  return (
    <div className="container">
      <p className="ex-kicker">
        <Link href="/admin">Admin</Link> · Model providers
      </p>
      <h1>Model providers</h1>

      <p className="admin-intro">
        Configured here, these override the <code>AI_*</code> and <code>EMBEDDING_*</code>{' '}
        environment variables. Leave both set to <strong>None</strong> and the system still
        works end to end — an LLM never produces a match score, so scoring is unaffected
        either way. See <Link href="/admin">the dashboard</Link> for what is currently live.
      </p>

      {!secretStorageConfigured ? (
        <p className="notice error" role="alert">
          <code>SETTINGS_ENCRYPTION_KEY</code> is not set, so API keys cannot be stored. Generate
          one with <code>openssl rand -base64 32</code> and restart. Providers that need no key —
          Ollama, and most OpenAI-compatible servers — can still be configured.
        </p>
      ) : null}

      <div className="provider-grid">
        <ModelProviderForm
          kind="ai"
          available={AI_PROVIDERS}
          current={view('ai')}
          secretStorageConfigured={secretStorageConfigured}
        />
        <ModelProviderForm
          kind="embedding"
          available={EMBEDDING_PROVIDERS}
          current={view('embedding')}
          secretStorageConfigured={secretStorageConfigured}
        />
      </div>
    </div>
  );
}
