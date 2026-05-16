-- ──────────── 008 project stage + status ────────────
-- Promotes `stage` and `status` from hard-coded placeholders in
-- `db::row_to_project` to real columns. Mirrors the Django app's
-- RedPashProject:
--   stage  — 4-stage pipeline (import → clean → report → publish),
--            suggested not enforced; default 'clean'.
--   status — lifecycle state (draft → active → archived); default
--            'draft'. (Django named the type `project_status`; here
--            it's a plain TEXT + CHECK to stay consistent with the
--            other enum-ish columns in this schema.)

ALTER TABLE projects
    ADD COLUMN IF NOT EXISTS stage TEXT NOT NULL DEFAULT 'clean'
        CHECK (stage IN ('import', 'clean', 'report', 'publish'));

ALTER TABLE projects
    ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft', 'active', 'archived'));

CREATE INDEX IF NOT EXISTS projects_stage_idx  ON projects(stage);
CREATE INDEX IF NOT EXISTS projects_status_idx ON projects(status);
