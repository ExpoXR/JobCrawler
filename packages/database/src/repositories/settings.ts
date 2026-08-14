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
