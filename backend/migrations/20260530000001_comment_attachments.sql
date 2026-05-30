-- Per-message attachments (Em 2026-05-30) — files shared inside a specific
-- comment, rendered inline in that message's bubble. Distinct from
-- `cases.attachments` (the case's pinned evidence): this is "files shared in
-- the conversation". v1 metadata-only ({name, mime, size, uploaded_at}); byte
-- upload + download is a later slice. JSONB array, default '[]'.
ALTER TABLE comments
    ADD COLUMN attachments JSONB NOT NULL DEFAULT '[]'::jsonb;
