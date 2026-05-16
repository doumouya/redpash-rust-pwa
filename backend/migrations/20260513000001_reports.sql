-- ──────────────── 002 reports — phase 3 MVP ────────────────
-- A report is a saved group-by spec over a project file. The spec
-- (group_by columns + aggregations + optional filter) lives as JSON;
-- the rendered output is regenerated on demand from the source file +
-- current spec. No cached HTML yet — that lands with the export
-- feature (Maud renderer).

CREATE TABLE IF NOT EXISTS reports (
    redpash_id         TEXT        PRIMARY KEY,
    project_redpash_id TEXT        NOT NULL REFERENCES projects(redpash_id) ON DELETE CASCADE,
    source_file_id     TEXT        NOT NULL REFERENCES project_files(redpash_id) ON DELETE CASCADE,
    title              TEXT        NOT NULL,
    spec               JSONB       NOT NULL DEFAULT '{}'::jsonb,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS reports_project_idx ON reports(project_redpash_id);
CREATE INDEX IF NOT EXISTS reports_source_idx  ON reports(source_file_id);
