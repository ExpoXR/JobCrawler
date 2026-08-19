import { query, queryOne, queryRows } from '../pool';

/**
 * Admin-editable settings and provider registry.
 *
 * API keys are intentionally *not* stored here. `secret_ref` names an
 * environment variable, so rotating a key never means writing to the database
 * and a database dump never leaks credentials (plan sections 22 and 37).
 */

export async function getSetting<T>(key: string): Promise<T | undefined> {
  const row = await queryOne<{ value: T }>(`SELECT value FROM settings WHERE key = $1`, [key]);
  return row?.value;
}

export async function getSettingOr<T>(key: string, fallback: T): Promise<T> {
  return (await getSetting<T>(key)) ?? fallback;
}

export async function setSetting(key: string, value: unknown, updatedBy = 'admin'): Promise<void> {
  await query(
    `
      INSERT INTO settings (key, value, updated_by) VALUES ($1, $2::jsonb, $3)
      ON CONFLICT (key) DO UPDATE
        SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()
    `,
    [key, JSON.stringify(value), updatedBy],
  );
}

export interface SettingRecord {
  key: string;
  value: unknown;
  description: string | null;
  updatedAt: Date;
}

export async function listSettings(): Promise<SettingRecord[]> {
  const rows = await queryRows<{
    key: string;
    value: unknown;
    description: string | null;
    updated_at: Date;
  }>(`SELECT key, value, description, updated_at FROM settings ORDER BY key`);
  return rows.map((row) => ({
    key: row.key,
    value: row.value,
    description: row.description,
    updatedAt: row.updated_at,
  }));
}

/* --- Model provider configuration ---------------------------------------- */

/**
 * The `provider_settings` table, which holds what an administrator configures in
 * the dashboard. Distinct from `source_providers` below: that one mirrors
 * code-defined data sources so they can be toggled, this one *is* the
 * configuration for a model provider.
 *
 * `secret_ciphertext` is written and read only through
 * `encryptSecret`/`decryptSecret`; nothing here ever sees a plaintext key. The
 * older `secret_ref` mode — naming an environment variable instead — remains
 * supported and is still the better option where a deployment can manage it.
 */
export type ModelProviderKind = 'ai' | 'embedding';

export interface ModelProviderRecord {
  id: string;
  providerKey: string;
  kind: ModelProviderKind;
  displayName: string | null;
  enabled: boolean;
  model: string | null;
  baseUrl: string | null;
  /** Name of an environment variable holding the key, if that mode is in use. */
  secretRef: string | null;
  /** The encrypted key, if one is stored. Never leaves the server. */
  secretCiphertext: Buffer | null;
  secretLast4: string | null;
  secretUpdatedAt: Date | null;
  temperature: number | null;
  timeoutMs: number | null;
  maxTokens: number | null;
  options: Record<string, unknown>;
  updatedAt: Date;
}

interface ModelProviderRow {
  id: string;
  provider_key: string;
  kind: ModelProviderKind;
  display_name: string | null;
  enabled: boolean;
  model: string | null;
  base_url: string | null;
  secret_ref: string | null;
  secret_ciphertext: Buffer | null;
  secret_last4: string | null;
  secret_updated_at: Date | null;
  temperature: number | null;
  timeout_ms: number | null;
  max_tokens: number | null;
  options: Record<string, unknown> | null;
  updated_at: Date;
}

const MODEL_PROVIDER_COLUMNS = `
  id, provider_key, kind, display_name, enabled, model, base_url, secret_ref,
  secret_ciphertext, secret_last4, secret_updated_at, temperature, timeout_ms,
  max_tokens, options, updated_at
`;

function mapModelProviderRow(row: ModelProviderRow): ModelProviderRecord {
  return {
    id: row.id,
    providerKey: row.provider_key,
    kind: row.kind,
    displayName: row.display_name,
    enabled: row.enabled,
    model: row.model,
    baseUrl: row.base_url,
    secretRef: row.secret_ref,
    secretCiphertext: row.secret_ciphertext,
    secretLast4: row.secret_last4,
    secretUpdatedAt: row.secret_updated_at,
    temperature: row.temperature,
    timeoutMs: row.timeout_ms,
    maxTokens: row.max_tokens,
    options: row.options ?? {},
    updatedAt: row.updated_at,
  };
}

/** The active configuration for a kind, or undefined to fall back to the environment. */
export async function getActiveModelProvider(
  kind: ModelProviderKind,
): Promise<ModelProviderRecord | undefined> {
  const row = await queryOne<ModelProviderRow>(
    `SELECT ${MODEL_PROVIDER_COLUMNS} FROM provider_settings WHERE kind = $1 AND enabled`,
    [kind],
  );
  return row ? mapModelProviderRow(row) : undefined;
}

export async function listModelProviders(): Promise<ModelProviderRecord[]> {
  const rows = await queryRows<ModelProviderRow>(
    `SELECT ${MODEL_PROVIDER_COLUMNS} FROM provider_settings
     WHERE kind IN ('ai', 'embedding')
     ORDER BY kind, provider_key`,
  );
  return rows.map(mapModelProviderRow);
}

export interface UpsertModelProviderInput {
  providerKey: string;
  kind: ModelProviderKind;
  enabled: boolean;
  displayName?: string | undefined;
  model?: string | undefined;
  baseUrl?: string | undefined;
  temperature?: number | undefined;
  timeoutMs?: number | undefined;
  maxTokens?: number | undefined;
  options?: Record<string, unknown> | undefined;
  /**
   * `undefined` keeps whatever is stored — so saving the form without retyping
   * the key does not wipe it. `null` clears it deliberately.
   */
  secret?: { ciphertext: Buffer; last4: string } | null | undefined;
  secretRef?: string | null | undefined;
}

export async function upsertModelProvider(
  input: UpsertModelProviderInput,
): Promise<ModelProviderRecord> {
  // At most one enabled row per kind (unique partial index in 0010), so a new
  // active provider retires the previous one first.
  if (input.enabled) {
    await query(`UPDATE provider_settings SET enabled = FALSE WHERE kind = $1 AND provider_key <> $2`, [
      input.kind,
      input.providerKey,
    ]);
  }

  const row = await queryOne<ModelProviderRow>(
    `
      INSERT INTO provider_settings (
        provider_key, kind, display_name, enabled, model, base_url,
        temperature, timeout_ms, max_tokens, options,
        secret_ciphertext, secret_last4, secret_updated_at, secret_ref
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, COALESCE($10::jsonb, '{}'::jsonb),
        $11, $12, CASE WHEN $11::bytea IS NULL THEN NULL ELSE now() END, $13
      )
      ON CONFLICT (provider_key) DO UPDATE SET
        kind = EXCLUDED.kind,
        display_name = EXCLUDED.display_name,
        enabled = EXCLUDED.enabled,
        model = EXCLUDED.model,
        base_url = EXCLUDED.base_url,
        temperature = EXCLUDED.temperature,
        timeout_ms = EXCLUDED.timeout_ms,
        max_tokens = EXCLUDED.max_tokens,
        options = EXCLUDED.options,
        -- $14 distinguishes "leave the stored key alone" from "clear it".
        secret_ciphertext = CASE WHEN $14 THEN EXCLUDED.secret_ciphertext
                                 ELSE provider_settings.secret_ciphertext END,
        secret_last4 = CASE WHEN $14 THEN EXCLUDED.secret_last4
                            ELSE provider_settings.secret_last4 END,
        secret_updated_at = CASE WHEN $14 THEN EXCLUDED.secret_updated_at
                                 ELSE provider_settings.secret_updated_at END,
        secret_ref = EXCLUDED.secret_ref,
        updated_at = now()
      RETURNING ${MODEL_PROVIDER_COLUMNS}
    `,
    [
      input.providerKey,
      input.kind,
      input.displayName ?? null,
      input.enabled,
      input.model ?? null,
      input.baseUrl ?? null,
      input.temperature ?? null,
      input.timeoutMs ?? null,
      input.maxTokens ?? null,
      input.options ? JSON.stringify(input.options) : null,
      input.secret ? input.secret.ciphertext : null,
      input.secret ? input.secret.last4 : null,
      input.secretRef ?? null,
      input.secret !== undefined,
    ],
  );
  if (!row) throw new Error('Provider upsert returned no row');
  return mapModelProviderRow(row);
}

export async function deleteModelProvider(providerKey: string): Promise<void> {
  await query(`DELETE FROM provider_settings WHERE provider_key = $1`, [providerKey]);
}

/* --- Source provider registry --------------------------------------------- */

export type ProviderKind =
  | 'geocoding'
  | 'company'
  | 'job'
  | 'candidate'
  | 'crawler'
  | 'search';

export interface SourceProviderRecord {
  key: string;
  name: string;
  kind: ProviderKind;
  capabilities: string[];
  enabled: boolean;
  rateLimitPerMinute: number | null;
  config: Record<string, unknown>;
  lastSuccessAt: Date | null;
  lastErrorAt: Date | null;
  lastError: string | null;
}

/** Mirrors a code-defined provider into the registry so admins can toggle it. */
export async function registerSourceProvider(input: {
  key: string;
  name: string;
  kind: ProviderKind;
  capabilities: string[];
  enabledByDefault?: boolean;
  rateLimitPerMinute?: number | undefined;
}): Promise<void> {
  await query(
    `
      INSERT INTO source_providers (key, name, kind, capabilities, enabled, rate_limit_per_minute)
      VALUES ($1, $2, $3, $4::text[], $5, $6)
      ON CONFLICT (key) DO UPDATE SET
        name = EXCLUDED.name,
        kind = EXCLUDED.kind,
        capabilities = EXCLUDED.capabilities,
        rate_limit_per_minute = COALESCE(
          source_providers.rate_limit_per_minute, EXCLUDED.rate_limit_per_minute
        ),
        updated_at = now()
    `,
    [
      input.key,
      input.name,
      input.kind,
      input.capabilities,
      input.enabledByDefault ?? true,
      input.rateLimitPerMinute ?? null,
    ],
  );
}

export async function listSourceProviders(): Promise<SourceProviderRecord[]> {
  const rows = await queryRows<{
    key: string;
    name: string;
    kind: ProviderKind;
    capabilities: string[];
    enabled: boolean;
    rate_limit_per_minute: number | null;
    config: Record<string, unknown>;
    last_success_at: Date | null;
    last_error_at: Date | null;
    last_error: string | null;
  }>(
    `SELECT key, name, kind, capabilities, enabled, rate_limit_per_minute, config,
            last_success_at, last_error_at, last_error
     FROM source_providers ORDER BY kind, name`,
  );
  return rows.map((row) => ({
    key: row.key,
    name: row.name,
    kind: row.kind,
    capabilities: row.capabilities ?? [],
    enabled: row.enabled,
    rateLimitPerMinute: row.rate_limit_per_minute,
    config: row.config ?? {},
    lastSuccessAt: row.last_success_at,
    lastErrorAt: row.last_error_at,
    lastError: row.last_error,
  }));
}

export async function setProviderEnabled(key: string, enabled: boolean): Promise<void> {
  await query(`UPDATE source_providers SET enabled = $2, updated_at = now() WHERE key = $1`, [
    key,
    enabled,
  ]);
}

export async function recordProviderOutcome(
  key: string,
  outcome: { ok: boolean; error?: string },
): Promise<void> {
  await query(
    `
      UPDATE source_providers SET
        last_success_at = CASE WHEN $2 THEN now() ELSE last_success_at END,
        last_error_at = CASE WHEN $2 THEN last_error_at ELSE now() END,
        last_error = CASE WHEN $2 THEN last_error ELSE $3 END,
        updated_at = now()
      WHERE key = $1
    `,
    [key, outcome.ok, outcome.error?.slice(0, 500) ?? null],
  );
}

export async function getEnabledProviderKeys(kind: ProviderKind): Promise<Set<string>> {
  const rows = await queryRows<{ key: string }>(
    `SELECT key FROM source_providers WHERE kind = $1 AND enabled`,
    [kind],
  );
  return new Set(rows.map((row) => row.key));
}
