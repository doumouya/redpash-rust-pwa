-- ──────────── 022 stage labels: import → new, report → design ────────────
-- Renames two of the four computed stage labels to match user mental
-- model:
--   - import → new   (the file just landed; doesn't presume the data
--                     is raw — a user uploading already-clean data
--                     goes new → design directly. "raw" would have
--                     baked in a presumption "new" doesn't.)
--   - report → design (the chart-typed file is the *design surface*,
--                      not the finished report. "report" conflates
--                      the activity with the artifact.)
-- `clean` and `publish` keep their labels — they earned them.
--
-- The stage labels are emitted by the `file_stages` view and consumed
-- by:
--   - backend/crates/api/src/routes/admin.rs (COALESCE defaults)
--   - backend/crates/api/src/db.rs (PROJECT_SELECT's CASE)
--   - frontend/scripts/pages/home.js (STAGES list + stageChip mapping)
-- All four sites move atomically with this migration in the same
-- commit. The stage_rank ordering is unchanged — only the strings.
--
-- Idempotent via `CREATE OR REPLACE VIEW`.

CREATE OR REPLACE VIEW file_stages AS
SELECT
    pf.redpash_id         AS file_redpash_id,
    pf.project_redpash_id AS project_redpash_id,
    s.stage,
    CASE s.stage
        WHEN 'publish' THEN 3
        WHEN 'design'  THEN 2
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
        -- design: the file is the source of >=1 chart file. The chart
        -- file IS the design surface; until publish, the project is
        -- being designed (the activity), not yet a finished report
        -- (the artifact). Renamed from `report` 2026-06-05.
        WHEN EXISTS (
            SELECT 1 FROM project_files c
            WHERE c.file_type = 'chart'
              AND c.source_file_id = pf.redpash_id
        ) THEN 'design'
        -- clean: the file has at least one cleaning step.
        WHEN EXISTS (
            SELECT 1 FROM project_steps st WHERE st.file_redpash_id = pf.redpash_id
        ) THEN 'clean'
        -- new: the file just arrived; no steps applied, no charts
        -- derived. Doesn't presume the data is raw — a user uploading
        -- already-clean data sits here until they go to design.
        -- Renamed from `import` 2026-06-05.
        ELSE 'new'
    END AS stage
) s;
