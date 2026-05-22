-- ──────────── 017 user first / last name ────────────
-- Structured name fields on the user. `display_name` stays — it's the
-- friendly label that drives avatar initials and the UI; first_name /
-- last_name are the additive structured identity beside it.
--
-- Backfill: split the existing display_name on its first space — the
-- first token → first_name, the remainder → last_name. A single-word
-- display_name leaves last_name NULL. The WHERE guard keeps the
-- migration idempotent — a re-run won't clobber edited names.

ALTER TABLE users
    ADD COLUMN IF NOT EXISTS first_name TEXT,
    ADD COLUMN IF NOT EXISTS last_name  TEXT;

UPDATE users SET
    first_name = CASE WHEN position(' ' in display_name) > 0
                      THEN split_part(display_name, ' ', 1)
                      ELSE display_name END,
    last_name  = CASE WHEN position(' ' in display_name) > 0
                      THEN trim(substring(display_name from position(' ' in display_name) + 1))
                      ELSE NULL END
WHERE first_name IS NULL AND last_name IS NULL;
