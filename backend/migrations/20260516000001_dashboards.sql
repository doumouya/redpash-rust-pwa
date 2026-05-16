-- ──────────────── 005 dashboards + sharing-prep ────────────────
-- Phase 3 dashboards: each one belongs to a project, holds a layout
-- spec (template + widgets) in JSONB, and supports the same favorite +
-- folder organisation as reports.
--
-- Also adds two future-proofing columns to reports + dashboards:
--   description : long-form blurb (for tooltips, share previews)
--   is_public   : when Phase 4 auth lands, a single-click toggle that
--                 makes the resource accessible via its RID without
--                 the viewer needing an account. Cheap to add now.

ALTER TABLE reports
    ADD COLUMN IF NOT EXISTS description TEXT,
    ADD COLUMN IF NOT EXISTS is_public   BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS dashboards (
    redpash_id         TEXT        PRIMARY KEY,
    project_redpash_id TEXT        NOT NULL REFERENCES projects(redpash_id) ON DELETE CASCADE,
    title              TEXT        NOT NULL,
    description        TEXT,
    spec               JSONB       NOT NULL DEFAULT '{}'::jsonb,
    folder             TEXT,
    is_favorite        BOOLEAN     NOT NULL DEFAULT FALSE,
    is_public          BOOLEAN     NOT NULL DEFAULT FALSE,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS dashboards_project_idx  ON dashboards(project_redpash_id);
CREATE INDEX IF NOT EXISTS dashboards_folder_idx   ON dashboards(project_redpash_id, folder);
CREATE INDEX IF NOT EXISTS dashboards_favorite_idx ON dashboards(is_favorite) WHERE is_favorite;
