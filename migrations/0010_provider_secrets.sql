-- Encrypted provider credentials.
--
-- 0007 created `provider_settings` with `secret_ref`, which names an environment
-- variable rather than holding a value, on the principle that the database never
-- stores a credential. That principle stands, and `secret_ref` remains the
-- better option — but it cannot serve an administrator configuring a provider
-- from the dashboard, which is what this adds.
--
-- The relaxation is narrow: the ciphertext is AES-256-GCM and the key lives only
-- in SETTINGS_ENCRYPTION_KEY, in the environment. A database dump on its own
-- therefore still yields nothing, which is the property the original rule
-- existed to protect. See packages/shared/src/secrets.ts.

ALTER TABLE provider_settings
  ADD COLUMN IF NOT EXISTS secret_ciphertext BYTEA,
  -- Last four characters, so the dashboard can show *which* key is configured
  -- without revealing it. Blank for anything too short to abbreviate safely.
  ADD COLUMN IF NOT EXISTS secret_last4 TEXT,
  ADD COLUMN IF NOT EXISTS secret_updated_at TIMESTAMPTZ;

-- Free-text label for the dashboard, e.g. "Ollama on the NAS".
ALTER TABLE provider_settings
  ADD COLUMN IF NOT EXISTS display_name TEXT;

-- 0007's CHECK allows the seven kinds the registry uses. Only 'ai' and
-- 'embedding' rows carry credentials, and each kind has at most one active
-- configuration, which this enforces rather than leaving to the application.
CREATE UNIQUE INDEX IF NOT EXISTS provider_settings_active_kind
  ON provider_settings (kind) WHERE enabled;
