-- ──────────── 009 computed pipeline stages ────────────
-- Stage stops being a stored column and becomes a *derived* value:
--
--   file stage  — the furthest point a file has reached in the
--                 import → clean → report → publish pipeline:
--                   publish — the file's report is wired into a
--                             public (shared) dashboard
--                   report  — the file is the source of ≥1 report
--                   clean   — the file has ≥1 cleaning step
--                   import  — uploaded, nothing done yet
--   project stage — the most advanced stage of any file it holds.
--
-- So migration 008's `projects.stage` column goes away (it's computed
-- now), and `project_files.status` is replaced by the computed file
-- stage. `projects.status` stays a real, manually-editable column —
-- the API just overlays a 'published' value on read when the project
-- has a public dashboard.
--
-- The `file_stages` view is the single source of truth; db.rs joins
-- it for the file list and aggregates it for the project list.

DROP INDEX IF EXISTS projects_stage_idx;
ALTER TABLE projects      DROP COLUMN IF EXISTS stage;
ALTER TABLE project_files DROP COLUMN IF EXISTS status;

CREATE OR REPLACE VIEW file_stages AS
SELECT
    pf.redpash_id         AS file_redpash_id,
    pf.project_redpash_id AS project_redpash_id,
    s.stage,
    CASE s.stage
        WHEN 'publish' THEN 3
        WHEN 'report'  THEN 2
        WHEN 'clean'   THEN 1
        ELSE 0
    END AS stage_rank
FROM project_files pf
CROSS JOIN LATERAL (
    SELECT CASE
        -- publish: a report sourced from this file is referenced by a
        -- widget inside a public dashboard's spec.
        WHEN EXISTS (
            SELECT 1
            FROM reports r
            JOIN dashboards d
              ON d.is_public
             AND jsonb_typeof(d.spec -> 'widgets') = 'array'
            CROSS JOIN LATERAL jsonb_array_elements(d.spec -> 'widgets') w
            WHERE r.source_file_id = pf.redpash_id
              AND w -> 'spec' ->> 'report_id' = r.redpash_id
        ) THEN 'publish'
        -- report: the file is the source of at least one report.
        WHEN EXISTS (
            SELECT 1 FROM reports r WHERE r.source_file_id = pf.redpash_id
        ) THEN 'report'
        -- clean: the file has at least one cleaning step (applied or
        -- undone — any step history counts as "touched in the cleaner").
        WHEN EXISTS (
            SELECT 1 FROM project_steps st WHERE st.file_redpash_id = pf.redpash_id
        ) THEN 'clean'
        ELSE 'import'
    END AS stage
) s;
