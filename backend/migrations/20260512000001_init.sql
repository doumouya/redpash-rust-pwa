-- ──────────────── 001 init — phase 2 persistence ────────────────
-- Mirrors the Django app's core tables, simplified for the Rust port.
-- All ids are RedPash-IDs (typed prefix + uuid hex). Owner FKs are
-- ON DELETE CASCADE so removing a user removes their projects/files
-- transitively.

CREATE TABLE IF NOT EXISTS users (
    redpash_id   TEXT        PRIMARY KEY,
    username     TEXT        NOT NULL UNIQUE,
    email        TEXT,
    display_name TEXT        NOT NULL,
    avatar_url   TEXT,
    job_title    TEXT,
    organisation TEXT,
    use_case     TEXT,
    plan         TEXT        NOT NULL DEFAULT 'free',
    locale       TEXT        NOT NULL DEFAULT 'en',
    prefs        JSONB       NOT NULL DEFAULT '{}'::jsonb,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS projects (
    redpash_id   TEXT        PRIMARY KEY,
    owner_id     TEXT        NOT NULL REFERENCES users(redpash_id) ON DELETE CASCADE,
    name         TEXT        NOT NULL,
    description  TEXT,
    is_default   BOOLEAN     NOT NULL DEFAULT FALSE,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS projects_owner_idx ON projects(owner_id);

-- One default project per user — used by the upload endpoint when the
-- request doesn't specify a project.
CREATE UNIQUE INDEX IF NOT EXISTS projects_owner_default_idx
    ON projects(owner_id) WHERE is_default;

CREATE TABLE IF NOT EXISTS project_files (
    redpash_id         TEXT        PRIMARY KEY,
    project_redpash_id TEXT        NOT NULL REFERENCES projects(redpash_id) ON DELETE CASCADE,
    filename           TEXT        NOT NULL,
    display_name       TEXT,
    file_type          TEXT        NOT NULL DEFAULT 'csv',
    status             TEXT        NOT NULL DEFAULT 'ready',
    row_count          BIGINT,
    col_count          INTEGER,
    file_size_bytes    BIGINT,
    cleanness_pct      REAL,
    encoding           TEXT,
    delimiter          TEXT        DEFAULT ',',
    -- Path on local disk (relative to REDPASH_DATA_DIR/files).
    storage_path       TEXT        NOT NULL,
    -- Cached `Vec<ColumnMeta>` so the redtable doesn't re-summarise on
    -- every page load; recomputed when steps are applied.
    columns_meta       JSONB       NOT NULL DEFAULT '[]'::jsonb,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS project_files_proj_idx ON project_files(project_redpash_id);

-- project_steps — append-only history powering save / undo / redo.
-- `ordinal` is the position in the file's step list; `applied` flips
-- false when the user undoes (so redo can flip it back).
CREATE TABLE IF NOT EXISTS project_steps (
    redpash_id         TEXT        PRIMARY KEY,
    file_redpash_id    TEXT        NOT NULL REFERENCES project_files(redpash_id) ON DELETE CASCADE,
    ordinal            INTEGER     NOT NULL,
    kind               TEXT        NOT NULL,
    params             JSONB       NOT NULL DEFAULT '{}'::jsonb,
    applied            BOOLEAN     NOT NULL DEFAULT TRUE,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS project_steps_file_idx ON project_steps(file_redpash_id, ordinal);
