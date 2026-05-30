-- ============================================================================
-- RedPash unified baseline (consolidates migrations 001–038).
--
-- Derived from a verified `pg_dump --schema-only` of the live prerelease DB,
-- so it is byte-faithful to what the running code expects — every view,
-- trigger, function, and index is preserved. Four deliberate changes ride on
-- top of that faithful base (each called out inline with `-- CHANGE:`):
--
--   1. entities.type CHECK gains 'team'.
--   2. New `teams` table (company-scoped, entity-registered) — RBAC pre-stage.
--   3. users.status (active/suspended/archived) — RBAC pre-stage.
--   4. memberships: display_name + relationship_attribute collapse into a
--      single `context_role` descriptor (rbac.md model). Code updated to match.
--   +  case_categories: the single UNIQUE(parent_id,name,company_id) is replaced
--      with two partial-unique indexes that actually dedup NULL company_id and
--      NULL parent_id (the old constraint let duplicate roots/globals through).
--
-- sqlx wraps this file in a transaction automatically; no explicit BEGIN/COMMIT.
-- ============================================================================

-- ── Polymorphic supertype ───────────────────────────────────────────────────
CREATE TABLE entities (
    id         TEXT PRIMARY KEY,
    -- CHANGE 1: 'team' added to the discriminator.
    type       TEXT NOT NULL CHECK (type IN ('company', 'project', 'case', 'team')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Identity ────────────────────────────────────────────────────────────────
CREATE TABLE users (
    redpash_id         TEXT PRIMARY KEY,
    username           TEXT NOT NULL UNIQUE,
    email              TEXT,
    display_name       TEXT NOT NULL,
    avatar_url         TEXT,
    job_title          TEXT,
    organisation       TEXT,
    use_case           TEXT,
    plan               TEXT NOT NULL DEFAULT 'free',
    locale             TEXT NOT NULL DEFAULT 'en',
    google_sub         TEXT,
    first_name         TEXT,
    last_name          TEXT,
    default_project_id TEXT,   -- FK → projects added after that table exists
    -- CHANGE 3: account lifecycle for the RBAC / scrub-retain work.
    status             TEXT NOT NULL DEFAULT 'active'
                       CHECK (status IN ('active', 'suspended', 'archived')),
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX users_google_sub_idx ON users (google_sub) WHERE google_sub IS NOT NULL;

-- ── Organizations & teams ─────────────────────────────────────────────────--
CREATE TABLE companies (
    redpash_id TEXT PRIMARY KEY REFERENCES entities(id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    slug       TEXT NOT NULL UNIQUE,
    avatar_url TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- CHANGE 2: teams — company-scoped, entity-registered so memberships can FK it.
-- Unused by application code today; pre-stages the RBAC team-inheritance model.
CREATE TABLE teams (
    redpash_id TEXT PRIMARY KEY REFERENCES entities(id) ON DELETE CASCADE,
    company_id TEXT NOT NULL REFERENCES companies(redpash_id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX teams_company_idx ON teams (company_id);

-- ── Projects ─────────────────────────────────────────────────────────────--
CREATE TABLE projects (
    redpash_id  TEXT PRIMARY KEY REFERENCES entities(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    description TEXT,
    company_id  TEXT REFERENCES companies(redpash_id) ON DELETE SET NULL,
    status      TEXT NOT NULL DEFAULT 'draft'
                CHECK (status IN ('draft', 'active', 'archived')),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX projects_company_idx ON projects (company_id);
CREATE INDEX projects_status_idx  ON projects (status);

-- Wire the user's default project now that `projects` exists.
ALTER TABLE users
    ADD CONSTRAINT users_default_project_id_fkey
    FOREIGN KEY (default_project_id) REFERENCES projects(redpash_id) ON DELETE SET NULL;

-- ── Sessions & preferences ─────────────────────────────────────────────────--
CREATE TABLE sessions (
    redpash_id      TEXT PRIMARY KEY,
    user_redpash_id TEXT NOT NULL REFERENCES users(redpash_id) ON DELETE CASCADE,
    expires_at      TIMESTAMPTZ NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX sessions_user_idx   ON sessions (user_redpash_id);
CREATE INDEX sessions_expiry_idx ON sessions (expires_at);

CREATE TABLE user_preferences (
    user_redpash_id TEXT NOT NULL REFERENCES users(redpash_id) ON DELETE CASCADE,
    key             TEXT NOT NULL,
    value           JSONB NOT NULL,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_redpash_id, key)
);
CREATE INDEX user_preferences_user_idx ON user_preferences (user_redpash_id);

-- ── Unified memberships ─────────────────────────────────────────────────────
CREATE TABLE memberships (
    object_redpash_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    user_redpash_id   TEXT NOT NULL REFERENCES users(redpash_id) ON DELETE CASCADE,
    role              TEXT NOT NULL DEFAULT 'member'
                      CHECK (role IN ('owner', 'admin', 'member', 'viewer')),
    -- CHANGE 4: single descriptor replacing display_name + relationship_attribute.
    -- Holds 'Reporter' / 'Case Owner' on cases; 'CEO' / 'Department' etc. on
    -- company/project rows; NULL when there's no business label.
    context_role      TEXT,
    joined_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (object_redpash_id, user_redpash_id)
);
CREATE INDEX memberships_user_idx ON memberships (user_redpash_id, object_redpash_id);

-- ── Files & steps ───────────────────────────────────────────────────────────
CREATE TABLE project_files (
    redpash_id         TEXT PRIMARY KEY,
    project_redpash_id TEXT NOT NULL REFERENCES projects(redpash_id) ON DELETE CASCADE,
    filename           TEXT NOT NULL,
    display_name       TEXT,
    file_type          TEXT NOT NULL DEFAULT 'csv',
    row_count          BIGINT,
    col_count          INTEGER,
    file_size_bytes    BIGINT,
    cleanness_pct      REAL,
    encoding           TEXT,
    delimiter          TEXT DEFAULT ',',
    storage_path       TEXT NOT NULL,
    columns_meta       JSONB NOT NULL DEFAULT '[]'::jsonb,
    spec               JSONB NOT NULL DEFAULT '{}'::jsonb,
    source_file_id     TEXT REFERENCES project_files(redpash_id) ON DELETE CASCADE,
    is_public          BOOLEAN NOT NULL DEFAULT FALSE,
    is_favorite        BOOLEAN NOT NULL DEFAULT FALSE,
    folder             TEXT,
    description        TEXT,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX project_files_proj_idx   ON project_files (project_redpash_id);
CREATE INDEX project_files_source_idx ON project_files (source_file_id);
CREATE INDEX project_files_type_idx   ON project_files (file_type);

CREATE TABLE project_steps (
    redpash_id      TEXT PRIMARY KEY,
    file_redpash_id TEXT NOT NULL REFERENCES project_files(redpash_id) ON DELETE CASCADE,
    ordinal         INTEGER NOT NULL,
    kind            TEXT NOT NULL,
    params          JSONB NOT NULL DEFAULT '{}'::jsonb,
    applied         BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX project_steps_file_idx ON project_steps (file_redpash_id, ordinal);

-- ── Cases ─────────────────────────────────────────────────────────────────--
CREATE TABLE case_categories (
    redpash_id TEXT PRIMARY KEY,
    parent_id  TEXT REFERENCES case_categories(redpash_id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    company_id TEXT REFERENCES companies(redpash_id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- CHANGE +: real dedup. The old single UNIQUE(parent_id,name,company_id) let
-- duplicate roots and duplicate globals slip through because Postgres treats
-- NULLs as distinct. COALESCE collapses NULL company_id; the partials split
-- root (parent NULL) from child so each scope dedups correctly.
CREATE UNIQUE INDEX case_categories_root_uq
    ON case_categories (name, COALESCE(company_id, '')) WHERE parent_id IS NULL;
CREATE UNIQUE INDEX case_categories_child_uq
    ON case_categories (parent_id, name, COALESCE(company_id, '')) WHERE parent_id IS NOT NULL;
CREATE INDEX case_categories_company_idx ON case_categories (company_id) WHERE company_id IS NOT NULL;
CREATE INDEX case_categories_parent_idx  ON case_categories (parent_id);

CREATE TABLE cases (
    redpash_id    TEXT PRIMARY KEY REFERENCES entities(id) ON DELETE CASCADE,
    type          TEXT NOT NULL DEFAULT 'task'
                  CHECK (type IN ('bug', 'feature', 'task', 'epic')),
    title         TEXT NOT NULL,
    description   TEXT,
    status        TEXT NOT NULL DEFAULT 'backlog'
                  CHECK (status IN ('backlog', 'todo', 'in_progress', 'in_review', 'done')),
    priority      TEXT NOT NULL DEFAULT 'medium'
                  CHECK (priority IN ('low', 'medium', 'high', 'critical')),
    project_id    TEXT REFERENCES projects(redpash_id) ON DELETE SET NULL,
    company_id    TEXT REFERENCES companies(redpash_id) ON DELETE SET NULL,
    category_id   TEXT REFERENCES case_categories(redpash_id) ON DELETE SET NULL,
    error_message TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX cases_status_idx   ON cases (status, updated_at DESC);
CREATE INDEX cases_project_idx  ON cases (project_id, updated_at DESC) WHERE project_id IS NOT NULL;
CREATE INDEX cases_category_idx ON cases (category_id) WHERE category_id IS NOT NULL;

CREATE TABLE comments (
    redpash_id TEXT PRIMARY KEY,
    case_id    TEXT NOT NULL REFERENCES cases(redpash_id) ON DELETE CASCADE,
    author_id  TEXT REFERENCES users(redpash_id) ON DELETE SET NULL,
    body       TEXT NOT NULL,
    is_edited  BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX comments_case_idx ON comments (case_id, created_at);

-- ── Shared-vocabulary promotion ─────────────────────────────────────────────
CREATE TABLE sentinel_submissions (
    canonical    TEXT NOT NULL,
    user_id      TEXT NOT NULL REFERENCES users(redpash_id) ON DELETE CASCADE,
    submitted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (canonical, user_id)
);

CREATE VIEW global_sentinels AS
    SELECT canonical
      FROM sentinel_submissions
     GROUP BY canonical
    HAVING count(DISTINCT user_id) >= 2;

-- ── Observability ───────────────────────────────────────────────────────────
CREATE TABLE events (
    redpash_id      TEXT PRIMARY KEY,
    occurred_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    origin          TEXT NOT NULL DEFAULT 'backend' CHECK (origin IN ('backend', 'frontend')),
    level           TEXT NOT NULL DEFAULT 'info'    CHECK (level IN ('debug', 'info', 'warn', 'error')),
    kind            TEXT NOT NULL,
    message         TEXT NOT NULL,
    source          TEXT,
    user_redpash_id TEXT REFERENCES users(redpash_id) ON DELETE SET NULL,
    session_id      TEXT,
    request_id      TEXT,
    http_method     TEXT,
    http_path       TEXT,
    http_status     INTEGER,
    duration_ms     INTEGER,
    context         JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX events_occurred_idx ON events (occurred_at DESC);
CREATE INDEX events_level_idx    ON events (level, occurred_at DESC);
CREATE INDEX events_kind_idx     ON events (kind, occurred_at DESC);
CREATE INDEX events_user_idx     ON events (user_redpash_id, occurred_at DESC);
CREATE INDEX events_request_idx  ON events (request_id);

CREATE TABLE request_log (
    id              BIGSERIAL PRIMARY KEY,
    at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    method          TEXT NOT NULL,
    route           TEXT NOT NULL,
    status          SMALLINT NOT NULL,
    duration_ms     INTEGER NOT NULL,
    request_id      TEXT,
    user_redpash_id TEXT,
    session_id      TEXT
);
CREATE INDEX request_log_at_idx      ON request_log (at DESC);
CREATE INDEX request_log_route_idx   ON request_log (route, at DESC);
CREATE INDEX request_log_user_idx    ON request_log (user_redpash_id, at DESC) WHERE user_redpash_id IS NOT NULL;
CREATE INDEX request_log_session_idx ON request_log (session_id, at DESC) WHERE session_id IS NOT NULL;

CREATE TABLE db_query_log (
    id              BIGSERIAL PRIMARY KEY,
    at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    query_template  TEXT NOT NULL,
    duration_ms     INTEGER NOT NULL,
    rows            BIGINT,
    status          SMALLINT NOT NULL DEFAULT 0,
    error_kind      TEXT,
    request_id      TEXT,
    user_redpash_id TEXT,
    route           TEXT
);
CREATE INDEX db_query_log_at_idx       ON db_query_log (at DESC);
CREATE INDEX db_query_log_template_idx ON db_query_log (query_template, at DESC);
CREATE INDEX db_query_log_request_idx  ON db_query_log (request_id) WHERE request_id IS NOT NULL;

CREATE TABLE optimization_points (
    id               BIGSERIAL PRIMARY KEY,
    subsystem        TEXT NOT NULL,
    phase            TEXT NOT NULL,
    current_cost     TEXT NOT NULL,
    horizon          TEXT NOT NULL,
    status           TEXT NOT NULL DEFAULT 'open'
                     CHECK (status IN ('open', 'planned', 'done', 'wontfix')),
    measurement_kind TEXT,
    measurement_key  TEXT,
    threshold_value  DOUBLE PRECISION,
    threshold_unit   TEXT,
    notes            TEXT,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (subsystem, phase)
);
CREATE INDEX optimization_points_status_idx    ON optimization_points (status);
CREATE INDEX optimization_points_subsystem_idx ON optimization_points (subsystem);

-- ── file_stages view (computed pipeline stage) ─────────────────────────────--
CREATE VIEW file_stages AS
    SELECT pf.redpash_id AS file_redpash_id,
           pf.project_redpash_id,
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
              WHEN EXISTS (
                  SELECT 1
                    FROM project_files c
                    JOIN project_files d
                      ON d.file_type = 'dashboard' AND d.is_public
                     AND jsonb_typeof(d.spec -> 'widgets') = 'array'
                    CROSS JOIN LATERAL jsonb_array_elements(d.spec -> 'widgets') w(value)
                   WHERE c.file_type = 'chart'
                     AND c.source_file_id = pf.redpash_id
                     AND ((w.value -> 'spec') ->> 'chart_id') = c.redpash_id
              ) THEN 'publish'
              WHEN EXISTS (
                  SELECT 1 FROM project_files c
                   WHERE c.file_type = 'chart' AND c.source_file_id = pf.redpash_id
              ) THEN 'design'
              WHEN EXISTS (
                  SELECT 1 FROM project_steps st WHERE st.file_redpash_id = pf.redpash_id
              ) THEN 'clean'
              ELSE 'new'
          END AS stage
      ) s;

-- ── mtime cascade triggers (child write bumps parent.updated_at) ───────────--
CREATE FUNCTION bump_file_mtime_from_step() RETURNS trigger
    LANGUAGE plpgsql AS $$
DECLARE fid TEXT;
BEGIN
    IF TG_OP = 'DELETE' THEN fid := OLD.file_redpash_id; ELSE fid := NEW.file_redpash_id; END IF;
    IF fid IS NOT NULL THEN
        UPDATE project_files SET updated_at = now() WHERE redpash_id = fid;
    END IF;
    RETURN NULL;
END;
$$;

CREATE FUNCTION bump_project_mtime_from_file() RETURNS trigger
    LANGUAGE plpgsql AS $$
DECLARE pid TEXT;
BEGIN
    IF TG_OP = 'DELETE' THEN pid := OLD.project_redpash_id; ELSE pid := NEW.project_redpash_id; END IF;
    IF pid IS NOT NULL THEN
        UPDATE projects SET updated_at = now() WHERE redpash_id = pid;
    END IF;
    RETURN NULL;
END;
$$;

CREATE TRIGGER project_steps_bump_file
    AFTER INSERT OR DELETE OR UPDATE ON project_steps
    FOR EACH ROW EXECUTE FUNCTION bump_file_mtime_from_step();

CREATE TRIGGER project_files_bump_project
    AFTER INSERT OR DELETE OR UPDATE ON project_files
    FOR EACH ROW EXECUTE FUNCTION bump_project_mtime_from_file();

-- ── Audit schema (dev-meta; not on the request path) ───────────────────────--
CREATE SCHEMA audit;

CREATE TABLE audit.run (
    id         BIGSERIAL PRIMARY KEY,
    tool       TEXT NOT NULL
               CHECK (tool IN ('css', 'html', 'parallel', 'tab-compare', 'cross-page', 'ui-snapshot')),
    ran_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    git_sha    TEXT,
    git_branch TEXT,
    stats      JSONB NOT NULL,
    payload    JSONB NOT NULL,
    UNIQUE (tool, git_sha, ran_at)
);
CREATE INDEX audit_run_tool_time_idx ON audit.run (tool, ran_at DESC);

CREATE TABLE audit.finding (
    run_id      BIGINT NOT NULL REFERENCES audit.run(id) ON DELETE CASCADE,
    tool        TEXT NOT NULL,
    kind        TEXT NOT NULL,
    finding_key TEXT NOT NULL,
    severity    INTEGER,
    detail      JSONB NOT NULL,
    PRIMARY KEY (run_id, finding_key)
);
CREATE INDEX audit_finding_key_idx ON audit.finding (tool, kind, finding_key);

CREATE FUNCTION audit.run_diff(cur_id bigint, prev_id bigint)
    RETURNS TABLE(status text, kind text, finding_key text, severity_cur integer, severity_prev integer)
    LANGUAGE sql STABLE AS $$
    WITH
      cur  AS (SELECT kind, finding_key, severity FROM audit.finding WHERE run_id = cur_id),
      prev AS (SELECT kind, finding_key, severity FROM audit.finding WHERE run_id = prev_id)
    SELECT 'new'::TEXT, c.kind, c.finding_key, c.severity, NULL::INTEGER
      FROM cur c LEFT JOIN prev p USING (kind, finding_key)
     WHERE p.finding_key IS NULL
    UNION ALL
    SELECT 'fixed'::TEXT, p.kind, p.finding_key, NULL::INTEGER, p.severity
      FROM prev p LEFT JOIN cur c USING (kind, finding_key)
     WHERE c.finding_key IS NULL
    UNION ALL
    SELECT CASE
             WHEN c.severity IS DISTINCT FROM p.severity AND c.severity > p.severity THEN 'regressed'
             WHEN c.severity IS DISTINCT FROM p.severity AND c.severity < p.severity THEN 'improved'
             ELSE 'unchanged'
           END,
           c.kind, c.finding_key, c.severity, p.severity
      FROM cur c JOIN prev p USING (kind, finding_key);
$$;
