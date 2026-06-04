-- Allow the `api-doc` audit tool (tools/api-doc-audit) to ingest into audit.run.
--
-- The baseline (20260529000000_init.sql) defines the tool whitelist as an inline
-- column CHECK on audit.run.tool — Postgres auto-names it `run_tool_check`. Drop
-- it and re-add a named one widened to include 'api-doc'. Re-run-safe: the
-- DROP IF EXISTS lets this apply cleanly whether the prior constraint was the
-- baseline auto-name or this migration's named one.
ALTER TABLE audit.run DROP CONSTRAINT IF EXISTS run_tool_check;
ALTER TABLE audit.run ADD CONSTRAINT run_tool_check
    CHECK (tool IN ('css', 'html', 'parallel', 'tab-compare', 'cross-page', 'ui-snapshot', 'api-doc'));
