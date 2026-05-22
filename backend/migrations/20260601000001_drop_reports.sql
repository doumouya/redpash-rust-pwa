-- ──────────── 018 drop the reports table ────────────
-- Object-model hard-refresh, Phase 1. The `reports` table modelled a
-- saved grouped-query as a stored entity. The locked object model
-- (docs/objects/object-model.md) makes "Report" a derived view over a
-- project's chart-typed files — there is no stored Report row. The
-- table holds 0 rows (audited 2026-05-22): pure deletion, no data to
-- migrate.
--
-- `file_stages` is deliberately NOT touched: since migration 016
-- (chart_files) the view derives the `report` stage from chart files,
-- not from this table — it carries no `reports` dependency. The stage
-- rename (report → design, import → new) is a separate, frontend-
-- coordinated change, not part of this phase.
--
-- Two trigger paths reference `reports` and must be removed first:
--   * mig 013 `project_files_bump_reports` — fires on every
--     project_files UPDATE; its body runs `UPDATE reports …`, which
--     would error once the table is gone. Drop the trigger + function.
--   * mig 013 `reports_bump_dashboards` — attached to `reports`, so it
--     dies with the table; its function is then orphaned. Drop both.
-- mig 012 `reports_bump_project` is attached to `reports` and dies
-- with the table. Its function `bump_project_mtime_from_child()` is
-- shared with the dashboards trigger — it stays.

DROP TRIGGER  IF EXISTS project_files_bump_reports ON project_files;
DROP FUNCTION IF EXISTS bump_reports_from_file();

DROP TRIGGER  IF EXISTS reports_bump_dashboards ON reports;
DROP FUNCTION IF EXISTS bump_dashboards_from_report();

DROP TABLE IF EXISTS reports;
