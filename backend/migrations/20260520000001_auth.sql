-- ──────────────── 006 auth — phase 4 google OAuth ────────────────
-- Adds the `google_sub` claim column on users (the Google OpenID
-- subject, unique per Google account) and a `sessions` table for our
-- own server-issued session cookies. Token exchange happens entirely
-- in the backend so no refresh token leaks to the browser.

ALTER TABLE users
    ADD COLUMN IF NOT EXISTS google_sub TEXT;

-- Partial unique index — old bootstrap users have NULL google_sub
-- and shouldn't conflict with each other.
CREATE UNIQUE INDEX IF NOT EXISTS users_google_sub_idx
    ON users(google_sub)
    WHERE google_sub IS NOT NULL;

CREATE TABLE IF NOT EXISTS sessions (
    redpash_id      TEXT        PRIMARY KEY,
    user_redpash_id TEXT        NOT NULL REFERENCES users(redpash_id) ON DELETE CASCADE,
    expires_at      TIMESTAMPTZ NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_redpash_id);
CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions(expires_at);
