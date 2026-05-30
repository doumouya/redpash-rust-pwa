-- Case attachments (Em 2026-05-30) — file references on a case: the
-- bug-report evidence (server.log, error screenshots, repro CSVs, …).
--
-- v1 stores metadata only. Each array entry is
--   { "name": "server.log", "mime": "text/plain", "size": 20480,
--     "uploaded_at": "2026-05-30T…Z" }
-- Byte upload + blob storage + download is a later slice (it can reuse the
-- project_files blob path). JSONB array, default '[]' so existing rows and
-- inserts that don't set it are valid without a backfill.
ALTER TABLE cases
    ADD COLUMN attachments JSONB NOT NULL DEFAULT '[]'::jsonb;
