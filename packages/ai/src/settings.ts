import { getActiveModelProvider, type ModelProviderKind } from '@ejc/database';
import {
  type AiProviderName,
  decryptSecret,
  type EmbeddingProviderName,
  getConfig,
  getLogger,
} from '@ejc/shared';

/**
 * Where a model provider's configuration comes from.
 *
 * Resolution order is **database row → environment → `none`**. The dashboard is
 * the more convenient path; the environment remains available and is still the
 * better one for deployments that manage secrets externally.
 *
 * The result is cached for a short interval rather than for the process
 * lifetime, because **web and worker are separate processes sharing no memory**.
 * A TTL is what makes an administrator's change take effect in the worker
 * without restarting it; the web process additionally clears the cache on save
 * so the dashboard reflects itself immediately.
 */

const CACHE_TTL_MS = 30_000;

export interface ResolvedProviderSettings {
  provider: string;
  apiKey: string;
  baseUrl: string;
  model: string;
  temperature: number;
  timeoutMs: number;
  /** Where the configuration came from, for the dashboard and the logs. */
  source: 'database' | 'environment' | 'unconfigured';
}

interface CacheEntry {
  value: ResolvedProviderSettings;
  expiresAt: number;
}

const cache = new Map<ModelProviderKind, CacheEntry>();

/** Called after an administrator saves, so the change is visible at once. */
export function resetSettingsCache(): void {
  cache.clear();
}

/**
 * Reads the stored key.
 *
 * A row can carry either an encrypted secret or the *name* of an environment
 * variable. Failure to decrypt is logged and treated as "no key" — a provider
 * that cannot authenticate should degrade to the deterministic path, not take
 * a search down.
 */
function secretFrom(row: {
  secretCiphertext: Buffer | null;
  secretRef: string | null;
}): string {
  if (row.secretCiphertext) {
    try {
      return decryptSecret(row.secretCiphertext);
    } catch (error) {
      getLogger('ai').error('Stored provider secret could not be decrypted', {
        errorType: 'not_configured',
        message: error instanceof Error ? error.message : String(error),
      });
      return '';
    }
  }

  if (row.secretRef) return process.env[row.secretRef] ?? '';
  return '';
}

async function resolve(kind: ModelProviderKind): Promise<ResolvedProviderSettings> {
  const config = getConfig();
  const envSide = kind === 'ai' ? config.ai : config.embedding;

  const fromEnvironment: ResolvedProviderSettings = {
    provider: envSide.provider,
    apiKey: envSide.apiKey,
    baseUrl: envSide.baseUrl,
    model: envSide.model,
    temperature: kind === 'ai' ? config.ai.temperature : 0,
    timeoutMs: kind === 'ai' ? config.ai.timeoutMs : config.embedding.timeoutMs,
    source: envSide.provider === 'none' ? 'unconfigured' : 'environment',
  };

  let row;
  try {
    row = await getActiveModelProvider(kind);
  } catch (error) {
    // No database, or a migration not yet applied: fall back rather than fail.
    getLogger('ai').warn('Could not read provider settings; using the environment', {
      message: error instanceof Error ? error.message : String(error),
    });
    return fromEnvironment;
  }

  if (!row) return fromEnvironment;

  return {
    provider: row.providerKey,
    apiKey: secretFrom(row),
    baseUrl: row.baseUrl ?? '',
    model: row.model ?? '',
    temperature: row.temperature ?? fromEnvironment.temperature,
    timeoutMs: row.timeoutMs ?? fromEnvironment.timeoutMs,
    source: 'database',
  };
}

async function resolveCached(kind: ModelProviderKind): Promise<ResolvedProviderSettings> {
  const cached = cache.get(kind);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const value = await resolve(kind);
  cache.set(kind, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  return value;
}

export async function resolveAiSettings(): Promise<
  ResolvedProviderSettings & { provider: AiProviderName | string }
> {
  return resolveCached('ai');
}

export async function resolveEmbeddingSettings(): Promise<
  ResolvedProviderSettings & { provider: EmbeddingProviderName | string }
> {
  return resolveCached('embedding');
}
