-- ──────────── 023 user_preferences — promote prefs to a first-class object ────────────
-- Phase 1 of the user-prefs migration spec
-- (docs/internal/spec-user-preferences.md). Creates the new table and
-- COPIES existing keys out of users.prefs. The `users.prefs` JSONB
-- column is intentionally NOT dropped here — that's Phase 2, after
-- the API code is verified pointing at the new table.
--
-- Decisions baked in (from spec §7):
--   - JSONB value (not TEXT) — accepts scalars, arrays, booleans
--     without an enum-of-shapes per key.
--   - PK on (user_redpash_id, key) — ON CONFLICT ... DO UPDATE is the
--     write pattern; one row per (user, key) by construction.
--   - No FK or CHECK on `key` — the pref catalog lives in the client
--     (prefs.js PREFS registry) + future server-side defaults
--     registry, not in the DB. Adding a new pref needs zero schema
--     change.
--
-- Idempotent (IF NOT EXISTS throughout) — safe to re-apply.

CREATE TABLE IF NOT EXISTS user_preferences (
    user_redpash_id  TEXT        NOT NULL
                     REFERENCES users(redpash_id) ON DELETE CASCADE,
    key              TEXT        NOT NULL,
    value            JSONB       NOT NULL,
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_redpash_id, key)
);
CREATE INDEX IF NOT EXISTS user_preferences_user_idx
    ON user_preferences (user_redpash_id);

-- Copy every existing user's prefs JSONB keys into rows. `jsonb_each`
-- yields one row per top-level key; we land each as a (user, key,
-- value) tuple. ON CONFLICT DO NOTHING keeps this re-runnable — if
-- someone re-applies the migration, we don't clobber values that
-- might have been edited since the first apply.
INSERT INTO user_preferences (user_redpash_id, key, value)
SELECT u.redpash_id, kv.key, kv.value
  FROM users u,
       jsonb_each(u.prefs) AS kv(key, value)
 WHERE u.prefs <> '{}'::jsonb
ON CONFLICT (user_redpash_id, key) DO NOTHING;
