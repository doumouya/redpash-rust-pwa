-- Truthful column doc for case_comments.body (privacy finding F-L).
--
-- The init migration's inline comment calls this column "sanitized
-- whitelist-rebuild HTML" — that is STALE. The column holds RAW user text;
-- the FE renders it via textContent (escaped), NEVER innerHTML, and there is
-- no server-side HTML sanitizer by design (comments are plain text). This
-- COMMENT ON COLUMN is the authoritative, truthful contract and supersedes the
-- inline note (which can't be edited — init is checksum-locked once applied).
COMMENT ON COLUMN case_comments.body IS
  'Raw user text (plain-text comments). The FE renders via textContent (escaped), never innerHTML; no server-side HTML sanitizer by design. Supersedes the stale "sanitized HTML" note in the init migration. (privacy F-L)';
