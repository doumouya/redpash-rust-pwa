-- ──────────── 029 cases.error_message — raw error payload field ────────────
-- Em ask (CAS_B4F36A776029475180B255BBA2E51492 follow-up): cases that
-- get auto-triaged from error-class events (FE crashes / panics /
-- 5xx) need a dedicated `error_message` slot — distinct from the
-- markdown `description` so:
--
--   * dedup hashes over (kind, error_message) for cheap "is this the
--     same crash" comparisons without parsing free-form description
--     prose;
--   * the FE renders it as a monospace <pre> code block (the error
--     SHAPE matters), not as prose-formatted markdown;
--   * "find every case with this error string" becomes a clean SQL
--     `WHERE error_message ILIKE '%…%'` query.
--
-- Nullable: most manually-filed cases (today + going forward) carry
-- no error_message; auto-triaged ones will populate it from
-- `events.message` + the airlock's `events.context.error_chain` slot.
-- No index in v1 — add a GIN trigram (`pg_trgm`) when "find similar
-- errors" becomes a query the operator actually runs. Today the
-- dedup query is exact-string-equality which an expression index
-- (md5(error_message)) handles cheaper if needed.

ALTER TABLE cases
    ADD COLUMN IF NOT EXISTS error_message TEXT;
