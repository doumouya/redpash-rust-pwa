-- ──────────── 019 fold dashboards into project_files ────────────
-- Object-model hard-refresh, Phase 2. A dashboard is a File — a
-- project_files row with file_type='dashboard' — not its own entity
-- (docs/objects/object-model.md). This folds the `dashboards` table in
-- and drops it. One live row to migrate.
--
-- project_files gains four columns a dashboard needs: is_public (the
-- D3 Publish trigger), is_favorite, folder, description. They default
-- harmlessly for csv / chart files.
--
-- The dashboard row is re-keyed to a FIL_ id — the object model has no
-- DSH_ ids. Nothing in the DB references a dashboard by id (widgets
-- reference charts, not the dashboard), so the re-key is safe.

-- 1. the columns a dashboard-file needs.
ALTER TABLE project_files ADD COLUMN IF NOT EXISTS is_public   BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE project_files ADD COLUMN IF NOT EXISTS is_favorite BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE project_files ADD COLUMN IF NOT EXISTS folder      TEXT;
ALTER TABLE project_files ADD COLUMN IF NOT EXISTS description TEXT;

-- 2. copy each dashboard in as a dashboard-typed file. No byte file
--    (storage_path = ''), no source file. title -> filename + display_name.
INSERT INTO project_files
    (redpash_id, project_redpash_id, filename, display_name, file_type,
     storage_path, spec, is_public, is_favorite, folder, description,
     created_at, updated_at)
SELECT
    'FIL_' || upper(replace(gen_random_uuid()::text, '-', '')),
    project_redpash_id, title, title, 'dashboard',
    '', spec, is_public, is_favorite, folder, description,
    created_at, updated_at
FROM dashboards;

-- 3. file_stages — repoint the Publish clause off the dashboards table
--    onto dashboard-typed project_files rows (same spec.widgets shape).
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
        -- publish: a chart sourced from this file sits in a widget of a
        -- public dashboard-file's spec (widget shape: spec.chart_id).
        WHEN EXISTS (
            SELECT 1
            FROM project_files c
            JOIN project_files d
              ON d.file_type = 'dashboard'
             AND d.is_public
             AND jsonb_typeof(d.spec -> 'widgets') = 'array'
            CROSS JOIN LATERAL jsonb_array_elements(d.spec -> 'widgets') w
            WHERE c.file_type = 'chart'
              AND c.source_file_id = pf.redpash_id
              AND w -> 'spec' ->> 'chart_id' = c.redpash_id
        ) THEN 'publish'
        -- report: the file is the source of >=1 chart file.
        WHEN EXISTS (
            SELECT 1 FROM project_files c
            WHERE c.file_type = 'chart'
              AND c.source_file_id = pf.redpash_id
        ) THEN 'report'
        -- clean: the file has at least one cleaning step.
        WHEN EXISTS (
            SELECT 1 FROM project_steps st WHERE st.file_redpash_id = pf.redpash_id
        ) THEN 'clean'
        ELSE 'import'
    END AS stage
) s;

-- 4. drop the table. `dashboards_bump_project` (mig 012) dies with it;
--    bump_project_mtime_from_child() is then orphaned — reports' use of
--    it went in Phase 1 — so drop it too. A dashboard-file's mtime now
--    cascades through the existing project_files_bump_project trigger.
DROP TABLE IF EXISTS dashboards;
DROP FUNCTION IF EXISTS bump_project_mtime_from_child();
