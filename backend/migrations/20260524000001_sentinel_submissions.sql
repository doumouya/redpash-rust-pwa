-- User-supplied sentinel values that the fix-invalid flow surfaces.
--
-- When a user picks a custom sentinel + consents to sharing
-- (`prefs.share_sentinels = true`), the PATCH /api/me handler upserts
-- one row per (canonical, user_id) into this table.
--
-- A sentinel becomes part of the cleanness scorer's vocabulary once
-- 2 distinct users have submitted it — see the `global_sentinels`
-- view below. Single-user submissions stay personal-only (via
-- `prefs.learned_sentinels`) and don't pollute the shared scoring
-- baseline.
--
-- ON DELETE CASCADE: an account deletion drops that user's
-- submissions. Considered keeping them anonymously (SET NULL) but
-- user_id is part of the PK so NULL isn't allowed; we'd need either a
-- synthetic row id + partial unique index (complicated) or to count
-- nulls as separate identities (clever). Cascade is the honest read:
-- if a contributor leaves, their vote leaves with them — a threshold
-- of 2 is low enough that genuinely-shared sentinels stay promoted.
CREATE TABLE sentinel_submissions (
    canonical    TEXT        NOT NULL,
    user_id      TEXT        NOT NULL REFERENCES users(redpash_id) ON DELETE CASCADE,
    submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (canonical, user_id)
);

-- Promote a sentinel into the global vocabulary once it has been
-- flagged by N distinct users. Threshold lives in the view so we can
-- bump it (3, 5, …) by re-creating the view without a data migration.
CREATE VIEW global_sentinels AS
    SELECT canonical
    FROM sentinel_submissions
    GROUP BY canonical
    HAVING COUNT(DISTINCT user_id) >= 2;
