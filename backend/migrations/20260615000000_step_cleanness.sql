-- Cleanness score as a field on the step record — the score becomes part of the
-- commit, not a mutable file-level field. Each step row carries the cleanness of
-- the frame AS OF that step, so the project_steps log IS the score trajectory:
-- ordinal 0 (the "original" genesis step) = the as-uploaded baseline, ordinal N =
-- the score after the Nth clean. The before/after the cleaner shows is just
-- "HEAD step vs step 0", read straight off the log. Nullable: a score may be
-- unavailable (empty/degenerate frame → cleanness() returns None).
ALTER TABLE project_steps ADD COLUMN cleanness real;

-- No backfill: files uploaded before this migration have no genesis step, so
-- their trajectory has no persisted baseline until re-uploaded. Acceptable on the
-- rebuild tree (disposable dev data); new uploads write a genesis step (see
-- pipeline::upload_csv).
