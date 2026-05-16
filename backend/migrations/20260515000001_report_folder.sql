-- ──────────────── 004 report folders ────────────────
-- Optional folder label per report. NULL / empty = uncategorised.
-- Folders are flat strings (no nesting) for now — the list page groups
-- by exact match. Nested folders would need a path string + index.

ALTER TABLE reports ADD COLUMN IF NOT EXISTS folder TEXT;
CREATE INDEX IF NOT EXISTS reports_folder_idx ON reports(project_redpash_id, folder);
