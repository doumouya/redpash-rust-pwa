-- ──────── 013 dependency mtime cascade (reports + dashboards) ────────
-- Companion to migration 012 (project-as-folder parent cascade). Reports
-- and dashboards depend on the data underneath them: editing a CSV the
-- report sources from should bump the report's "Modified" date, and
-- editing a report (or its source CSV) should bump any dashboard that
-- references it. Without these, the Objects page "Modified" columns on
-- reports and dashboards stay frozen even when the underlying CSV is
-- being actively cleaned.
--
-- Scope rule (file_stages view encodes this conceptually):
--   import / clean   — file is upstream of nothing; only the project
--                      cascade from 012 fires.
--   report           — file is the source of ≥1 report. The file→report
--                      trigger below cascades.
--   publish          — file's report is wired into a public dashboard.
--                      The report→dashboard trigger picks this up via
--                      the JSON-contains scan on dashboards.spec.widgets.
--
-- The triggers don't read file_stages — they fire on every file/report
-- UPDATE and rely on the cascade UPDATE itself to no-op when there's
-- no matching dependent row (empty UPDATE = free). So the "stage rules
-- scope" mental model lines up with reality without paying for a view
-- lookup per trigger fire.
--
-- INSERT/DELETE are skipped:
--   INSERT — a brand-new file has zero dependents; a brand-new report's
--            mtime cascade lands via the projects trigger from 012.
--   DELETE — ON DELETE CASCADE in the reports FK drops dependent rows;
--            nothing left to bump.
--
-- Cycle guard: file → report → dashboard → project. project has no
-- trigger pointing back at child tables, so no risk of recursion.

-- File mtime → bump reports that source from this file.
CREATE OR REPLACE FUNCTION bump_reports_from_file()
RETURNS TRIGGER AS $$
BEGIN
    UPDATE reports SET updated_at = now()
    WHERE source_file_id = NEW.redpash_id;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS project_files_bump_reports ON project_files;
CREATE TRIGGER project_files_bump_reports
AFTER UPDATE ON project_files
FOR EACH ROW EXECUTE FUNCTION bump_reports_from_file();

-- Report mtime → bump dashboards whose widget spec references this
-- report. Narrowed by project_redpash_id first so the JSON contains
-- check only scans dashboards in the same project (always a small set,
-- since dashboards are project-scoped). spec.widgets is an array of
-- widget objects shaped like { slot, kind, spec: { report_id, ... } };
-- @> with a partial widget object matches any widget that carries
-- spec.report_id = <this report>.
CREATE OR REPLACE FUNCTION bump_dashboards_from_report()
RETURNS TRIGGER AS $$
BEGIN
    UPDATE dashboards SET updated_at = now()
    WHERE project_redpash_id = NEW.project_redpash_id
      AND spec -> 'widgets' @> jsonb_build_array(
              jsonb_build_object('spec',
                  jsonb_build_object('report_id', to_jsonb(NEW.redpash_id))
              )
          );
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS reports_bump_dashboards ON reports;
CREATE TRIGGER reports_bump_dashboards
AFTER UPDATE ON reports
FOR EACH ROW EXECUTE FUNCTION bump_dashboards_from_report();
