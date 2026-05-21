-- ──────────── events — runtime observability log ────────────
-- Append-only log of failures + lifecycle actions, captured from both
-- the backend (HTTP errors via the capture middleware + explicit
-- lifecycle calls) and the frontend (POST /api/events — JS errors,
-- failed user actions). Powers the internal monitoring tool.
--
-- The reserved `EVT` RID prefix (docs/db/schema.md) is now live. A
-- future `cases` table (CAS prefix) will pin a slice of these rows as
-- troubleshooting evidence for user support tickets.
--
-- Idempotent (IF NOT EXISTS) so a manual psql apply and the later
-- sqlx::migrate! pass at backend boot don't collide.

CREATE TABLE IF NOT EXISTS events (
    redpash_id       TEXT        PRIMARY KEY,                   -- EVT_…
    occurred_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    origin           TEXT        NOT NULL DEFAULT 'backend'
                     CHECK (origin IN ('backend', 'frontend')),
    level            TEXT        NOT NULL DEFAULT 'info'
                     CHECK (level IN ('debug', 'info', 'warn', 'error')),
    kind             TEXT        NOT NULL,                      -- machine type: http_error | auth_login | step_apply …
    message          TEXT        NOT NULL,
    source           TEXT,                                     -- emitting site: routes::files::upload | cleaner.js
    -- SET NULL (not CASCADE): troubleshooting history outlives a deleted user.
    user_redpash_id  TEXT        REFERENCES users(redpash_id) ON DELETE SET NULL,
    session_id       TEXT,                                     -- rp_session RID — plain TEXT (sessions expire), not an FK
    request_id       TEXT,                                     -- correlates one request's events, frontend + backend
    http_method      TEXT,
    http_path        TEXT,
    http_status      INTEGER,
    duration_ms      INTEGER,
    context          JSONB       NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS events_occurred_idx ON events (occurred_at DESC);
CREATE INDEX IF NOT EXISTS events_level_idx    ON events (level, occurred_at DESC);
CREATE INDEX IF NOT EXISTS events_kind_idx     ON events (kind,  occurred_at DESC);
CREATE INDEX IF NOT EXISTS events_user_idx     ON events (user_redpash_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS events_request_idx  ON events (request_id);
