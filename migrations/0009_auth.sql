-- Accounts, sessions and search ownership.
--
-- The system began deliberately account-free (see 0006), with a single operator
-- behind HTTP Basic auth. Distinguishing an administrator from an ordinary user
-- needs real identity, so this migration introduces it.
--
-- Two things this table does *not* store: a plaintext password, and a usable
-- session token. `password_hash` is scrypt with a per-row salt, and `token_hash`
-- is the SHA-256 of the opaque cookie value — a database dump therefore grants
-- no logins.

CREATE TABLE IF NOT EXISTS users (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email          TEXT NOT NULL,
  password_hash  TEXT NOT NULL,
  role           TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin', 'user')),
  is_active      BOOLEAN NOT NULL DEFAULT TRUE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at  TIMESTAMPTZ,
  CONSTRAINT users_email_shape CHECK (position('@' IN email) > 1)
);

-- Case-insensitive uniqueness without the citext extension: 0001 is already
-- applied and must not be edited, and an expression index needs no extension.
CREATE UNIQUE INDEX IF NOT EXISTS users_email_key ON users (lower(email));

CREATE TABLE IF NOT EXISTS sessions (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- SHA-256 of the cookie value. The value itself never reaches the database.
  token_hash           BYTEA NOT NULL UNIQUE,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Sliding window: extended on use.
  expires_at           TIMESTAMPTZ NOT NULL,
  -- Hard cap: never extended, so a stolen session cannot be kept alive forever.
  absolute_expires_at  TIMESTAMPTZ NOT NULL,
  -- Truncated hash, not an address: enough to spot session reuse from elsewhere
  -- without retaining an identifier for every visitor.
  ip_hash              BYTEA,
  user_agent           TEXT
);

CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions (user_id);
CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions (expires_at);

-- Search ownership. Until now the search id was the only credential protecting
-- a result set, so anyone holding a URL could export someone else's search.
-- NULL means an anonymous search, which stays legal.
ALTER TABLE search_sessions
  ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES users (id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS search_sessions_user_idx
  ON search_sessions (user_id, started_at DESC);

-- Reuse the trigger function created in 0008.
DROP TRIGGER IF EXISTS users_set_updated_at ON users;
CREATE TRIGGER users_set_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
