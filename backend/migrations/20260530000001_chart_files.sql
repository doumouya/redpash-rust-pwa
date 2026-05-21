-- ──────────── 016 chart files ────────────
-- Saved charts become first-class Files. A chart authored on the
-- Reports page is stored as a `project_files` row with file_type
-- 'chart' — consistent with the "everything is a File" object model.
--
-- Two new columns carry the chart:
--   spec           — the chart's self-contained definition: kind,
--                    group_by / agg, the baked-in ECharts `option`,
--                    and an SVG snapshot. Mirrors reports.spec /
--                    dashboards.spec.
--   source_file_id — the data file the chart was built from. Self-FK
--                    with ON DELETE CASCADE: drop the data file and
--                    its charts go with it. NULL for ordinary data
--                    files.
--
-- A chart has no on-disk byte file — its whole content lives in `spec`
-- — so chart rows carry an empty-string `storage_path` (the column
-- stays NOT NULL; '' reads clearly as "no backing file").
--
-- file_stages is rewired off the legacy (empty) `reports` table onto
-- chart files: a data file reaches `report` when it is the source of
-- >=1 chart file, and `publish` when such a chart sits in a public
-- dashboard's widgets — keyed on the new widget shape (spec.chart_id).

ALTER TABLE project_files
    ADD COLUMN IF NOT EXISTS spec JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE project_files
    ADD COLUMN IF NOT EXISTS source_file_id TEXT
        REFERENCES project_files(redpash_id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS project_files_source_idx
    ON project_files(source_file_id);
CREATE INDEX IF NOT EXISTS project_files_type_idx
    ON project_files(file_type);

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
        -- publish: a chart sourced from this file is referenced by a
        -- widget inside a public dashboard's spec (widget shape:
        -- spec.chart_id).
        WHEN EXISTS (
            SELECT 1
            FROM project_files c
            JOIN dashboards d
              ON d.is_public
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
        -- clean: the file has at least one cleaning step (applied or
        -- undone — any step history counts as "touched in the cleaner").
        WHEN EXISTS (
            SELECT 1 FROM project_steps st WHERE st.file_redpash_id = pf.redpash_id
        ) THEN 'clean'
        ELSE 'import'
    END AS stage
) s;
