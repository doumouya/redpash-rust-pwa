-- ──── 027 request_log gains user + session columns (slice B, audit-everything) ────
-- Per the observability investigations doc (I-1 / I-7), pulling "every
-- request user X made" or "every request in session Y" requires the
-- correlation columns on request_log itself. Joining through sessions
-- would lose rows once sessions roll over.
--
-- Both columns are nullable: anonymous / pre-login requests carry
-- neither. user_redpash_id is populated by capture_mw via the same
-- find_session_user lookup the 4xx/5xx event path already uses; the
-- lookup is fire-and-forget post-response so it doesn't add to the
-- user-facing latency.

ALTER TABLE request_log
    ADD COLUMN IF NOT EXISTS user_redpash_id TEXT,
    ADD COLUMN IF NOT EXISTS session_id      TEXT;

-- Per-user latency / activity scans for I-1 ("user X reports slow").
CREATE INDEX IF NOT EXISTS request_log_user_idx
    ON request_log (user_redpash_id, at DESC)
    WHERE user_redpash_id IS NOT NULL;

-- Per-session replay scans for I-7 ("replay user's session").
CREATE INDEX IF NOT EXISTS request_log_session_idx
    ON request_log (session_id, at DESC)
    WHERE session_id IS NOT NULL;
