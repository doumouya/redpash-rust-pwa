-- ============================================================================
-- RedPash-next — designed init (NOT a pg_dump baseline).
-- Every locked decision from docs/decisions/day-one.md is carried here:
--   #1 unique RID prefix per type (dashboard = DSH_, never shares FIL_)
--   #2 users AND files are registered entities from birth
--   #3 entity_data.scope_parent_id has a real FK
--   #6 cascade arms are DATA (type_definitions.scope_parents) — the RBAC
--      resolver SQL is GENERATED from these rows, never hand-duplicated
--   #8 observability tables are time-partitioned at schema birth
--   #9 case reporter/assignee are typed workflow FKs; membership context_role
--      stays purely cosmetic (no enforcement path may read it)
-- Derive-don't-store everywhere: per-role field cells, project stage
-- (file_stages view), report/dashboard (file_type slices) are never columns.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Type registry — "a new type is a row, not a migration".
-- ---------------------------------------------------------------------------
CREATE TABLE type_definitions (
    type_id             text PRIMARY KEY,
    rid_prefix          text NOT NULL UNIQUE,          -- #1: globally unique
    display_name        text NOT NULL,
    display_name_plural text NOT NULL,
    rail_icon           text NOT NULL DEFAULT '',
    default_columns     jsonb NOT NULL DEFAULT '[]',
    default_sort        text,
    is_builtin          boolean NOT NULL DEFAULT false,
    grid_served         boolean NOT NULL DEFAULT true,
    ordinal             integer NOT NULL DEFAULT 0,
    -- #6: the RBAC cascade, declared as data. Each entry names a column (on
    -- the subtype table for builtins, or the literal 'scope_parent_id' for
    -- entity_data customs) whose value is a parent entity the grant resolver
    -- climbs. GRANT_SQL and the admin EDGES introspection are both generated
    -- from these rows at type-cache load — one declaration, every consumer.
    scope_parents       jsonb NOT NULL DEFAULT '[]'
);

CREATE TABLE type_fields (
    type_id     text NOT NULL REFERENCES type_definitions(type_id) ON DELETE CASCADE,
    field       text NOT NULL,
    ordinal     integer NOT NULL DEFAULT 0,            -- load-bearing: wire order
    data_type   text NOT NULL DEFAULT 'string',        -- OPEN codec id, not an enum
    perm_class  text NOT NULL DEFAULT 'standard'
                CHECK (perm_class IN ('standard','collaborative','owner_grade','personal','readonly')),
    is_sortable boolean NOT NULL DEFAULT true,
    options     jsonb,
    rel_type    text REFERENCES type_definitions(type_id),
    rel_multi   boolean NOT NULL DEFAULT false,
    validate    jsonb,
    PRIMARY KEY (type_id, field)
);
-- Store INPUTS, re-derive the rest: per-role read/write cells come from
-- perm_class in Rust (PermClass::cells) — never persisted, so seeds can't drift.

CREATE TABLE type_scope_roles (
    scope      text NOT NULL DEFAULT 'object',
    role       text NOT NULL,
    is_context boolean NOT NULL DEFAULT false,
    is_default boolean NOT NULL DEFAULT false,
    ordinal    integer NOT NULL DEFAULT 0,
    PRIMARY KEY (scope, role, is_context)
);

-- ---------------------------------------------------------------------------
-- Spine 1: the Entity Registry. Every top-level object's PK FKs into it
-- ON DELETE CASCADE — one delete path, zero per-table triggers, and
-- polymorphic edges are cascade-safe for free.
-- ---------------------------------------------------------------------------
CREATE TABLE entities (
    id         text PRIMARY KEY,                       -- <PREFIX>_<32-hex>
    type       text NOT NULL REFERENCES type_definitions(type_id),
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX entities_type_idx ON entities (type);

-- Invariants enforced in the db helper layer (entities.rs port):
--   register_entity FIRST in the same tx as the subtype insert;
--   delete THROUGH the registry, never the subtype table.

-- ---------------------------------------------------------------------------
-- Users — registered entities from birth (#2). Scrub & Retain deletion:
-- tombstone PII in place, keep membership edges (they are the audit trail).
-- ---------------------------------------------------------------------------
CREATE TABLE users (
    redpash_id         text PRIMARY KEY REFERENCES entities(id) ON DELETE CASCADE,
    google_sub         text UNIQUE,                    -- identity key: sub, never email
    email              text,
    username           text UNIQUE,
    display_name       text NOT NULL DEFAULT '',
    avatar_url         text,
    role               text NOT NULL DEFAULT 'user' CHECK (role IN ('user','admin')),
    status             text NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
    plan               text NOT NULL DEFAULT 'free',   -- pre-staged; billing wires later
    locale             text NOT NULL DEFAULT 'en',     -- pre-staged; i18n wires later
    default_project_id text,                           -- FK added after projects exists
    created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
    id         text PRIMARY KEY,                       -- SES_<32-hex>, opaque
    user_id    text NOT NULL REFERENCES users(redpash_id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL
);
CREATE INDEX sessions_user_idx ON sessions (user_id);
-- find_session_user deletes expired rows on read — the table self-GCs.

CREATE TABLE user_preferences (
    user_id text PRIMARY KEY REFERENCES users(redpash_id) ON DELETE CASCADE,
    prefs   jsonb NOT NULL DEFAULT '{}'
);

CREATE TABLE user_sentinels (
    user_id text NOT NULL REFERENCES users(redpash_id) ON DELETE CASCADE,
    token   text NOT NULL,
    PRIMARY KEY (user_id, token)
);
-- Global learned sentinels = tokens submitted by >= 2 users (derived by query,
-- never stored — derive-don't-store).

-- ---------------------------------------------------------------------------
-- Org objects.
-- ---------------------------------------------------------------------------
CREATE TABLE companies (
    redpash_id text PRIMARY KEY REFERENCES entities(id) ON DELETE CASCADE,
    name       text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE teams (
    redpash_id text PRIMARY KEY REFERENCES entities(id) ON DELETE CASCADE,
    company_id text NOT NULL REFERENCES companies(redpash_id) ON DELETE CASCADE,
    name       text NOT NULL,
    kind       text NOT NULL DEFAULT 'team' CHECK (kind IN ('team','department')),
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX teams_company_idx ON teams (company_id);

-- ---------------------------------------------------------------------------
-- Data-work objects: the locked 2-entity model. A Project is a folder; a
-- File is a File (csv | chart | dashboard discriminated by file_type — no
-- reports/dashboards tables, ever). project.stage is the file_stages view.
-- NO owner_id columns anywhere: ownership is a membership row.
-- ---------------------------------------------------------------------------
CREATE TABLE projects (
    redpash_id text PRIMARY KEY REFERENCES entities(id) ON DELETE CASCADE,
    company_id text REFERENCES companies(redpash_id) ON DELETE SET NULL,
    name       text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX projects_company_idx ON projects (company_id);

ALTER TABLE users
    ADD CONSTRAINT users_default_project_fk
    FOREIGN KEY (default_project_id) REFERENCES projects(redpash_id) ON DELETE SET NULL;
-- is_default on a project is DERIVED from users.default_project_id.

CREATE TABLE project_files (
    redpash_id     text PRIMARY KEY REFERENCES entities(id) ON DELETE CASCADE,  -- #2: files are entities
    project_id     text NOT NULL REFERENCES projects(redpash_id) ON DELETE CASCADE,
    filename       text NOT NULL,
    file_type      text NOT NULL DEFAULT 'csv' CHECK (file_type IN ('csv','chart','dashboard')),
    storage_path   text NOT NULL DEFAULT '',           -- empty for chart/dashboard
    row_count      bigint,
    col_count      integer,
    cleanness_pct  real,
    encoding       text,
    delimiter      text,
    columns_meta   jsonb NOT NULL DEFAULT '[]',        -- ColumnMeta[]: storage + semantic dtype
    spec           jsonb NOT NULL DEFAULT '{}',        -- chart/dashboard spec; widgets[].spec.chart_id links
    source_file_id text REFERENCES project_files(redpash_id) ON DELETE SET NULL,  -- lineage
    is_public      boolean NOT NULL DEFAULT false,
    is_favorite    boolean NOT NULL DEFAULT false,
    folder         text,
    created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX project_files_project_idx ON project_files (project_id);
CREATE INDEX project_files_type_idx ON project_files (file_type);
-- Bytes live at <data_dir>/files/<rid>.bin, IMMUTABLE. The visible frame is
-- always base-parse + replay of applied steps. User data never enters Postgres.

CREATE TABLE project_steps (
    id         text PRIMARY KEY,                       -- STP_<32-hex>
    file_id    text NOT NULL REFERENCES project_files(redpash_id) ON DELETE CASCADE,
    ordinal    integer NOT NULL,
    kind       text NOT NULL,                          -- OPEN string (step registry)
    params     jsonb NOT NULL DEFAULT '{}',
    applied    boolean NOT NULL DEFAULT true,          -- undo = flip false; redo = flip true
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (file_id, ordinal)
);

-- ---------------------------------------------------------------------------
-- Spine 2: the single polymorphic membership edge — the entire RBAC layer
-- AND the org chart. Both ends are entities (users, teams, anything), which
-- is why team grants / team nesting / multi-role-per-object are one fact.
-- Wide PK on purpose: one principal can hold many roles on one object.
-- context_role is FREE-TEXT DISPLAY ONLY (#9) — no enforcement or identity
-- path may ever branch on it.
-- ---------------------------------------------------------------------------
CREATE TABLE memberships (
    object_redpash_id text NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    member_redpash_id text NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    role              text NOT NULL CHECK (role IN ('owner','admin','member','viewer')),
    context_role      text NOT NULL DEFAULT '',
    created_at        timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (object_redpash_id, member_redpash_id, role, context_role)
);
CREATE INDEX memberships_member_idx ON memberships (member_redpash_id);
-- App-layer invariants (members.rs port): only an owner grants owner;
-- last-owner guard; auto-grant creator's owner edge in every create tx
-- ("there is no object without an owner"); cross-tenant team grants 404.

-- Race-safe backstop for one-direct-department-per-member-per-company.
-- The app layer surfaces the clean 409; this trigger only closes the TOCTOU.
CREATE FUNCTION enforce_one_department() RETURNS trigger AS $$
DECLARE
    dept_company text;
BEGIN
    SELECT t.company_id INTO dept_company
    FROM teams t
    WHERE t.redpash_id = NEW.object_redpash_id AND t.kind = 'department';
    IF dept_company IS NULL THEN
        RETURN NEW; -- not a department membership
    END IF;
    PERFORM pg_advisory_xact_lock(hashtext(NEW.member_redpash_id));
    IF EXISTS (
        SELECT 1 FROM memberships m
        JOIN teams t2 ON t2.redpash_id = m.object_redpash_id
        WHERE m.member_redpash_id = NEW.member_redpash_id
          AND t2.kind = 'department'
          AND t2.company_id = dept_company
          AND m.object_redpash_id <> NEW.object_redpash_id
    ) THEN
        RAISE EXCEPTION 'one_department_per_member';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER memberships_one_department
    BEFORE INSERT ON memberships
    FOR EACH ROW EXECUTE FUNCTION enforce_one_department();

-- ---------------------------------------------------------------------------
-- Cases — kanban + tickets + agent handoff bus in one table.
-- Reporter/assignee are TYPED WORKFLOW REFS (#9) — they are not access edges;
-- access still flows through memberships. Activity = the events table
-- (context->>'case'), never a parallel activity store.
-- ---------------------------------------------------------------------------
CREATE TABLE cases (
    redpash_id    text PRIMARY KEY REFERENCES entities(id) ON DELETE CASCADE,
    company_id    text REFERENCES companies(redpash_id) ON DELETE SET NULL,
    project_id    text REFERENCES projects(redpash_id) ON DELETE SET NULL,
    title         text NOT NULL,
    description   text NOT NULL DEFAULT '',
    type          text NOT NULL DEFAULT 'task' CHECK (type IN ('bug','feature','task','epic')),
    status        text NOT NULL DEFAULT 'backlog'
                  CHECK (status IN ('backlog','todo','in_progress','in_review','done')),
    source        text NOT NULL DEFAULT 'internal' CHECK (source IN ('internal','external')),
    reporter_id   text REFERENCES users(redpash_id) ON DELETE SET NULL,
    assignee_id   text REFERENCES users(redpash_id) ON DELETE SET NULL,
    error_message text,
    attachments   jsonb NOT NULL DEFAULT '[]',         -- metadata only
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX cases_status_idx ON cases (status);
CREATE INDEX cases_company_idx ON cases (company_id);

CREATE TABLE case_comments (
    id         text PRIMARY KEY,                       -- CMT_<32-hex>
    case_id    text NOT NULL REFERENCES cases(redpash_id) ON DELETE CASCADE,
    author_id  text REFERENCES users(redpash_id) ON DELETE SET NULL,
    body       text NOT NULL,                          -- sanitized whitelist-rebuild HTML
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX case_comments_case_idx ON case_comments (case_id);

-- ---------------------------------------------------------------------------
-- Custom objects: one open JSONB store behind the generic /api/objects/:type
-- handler (Hybrid-C: builtins keep typed tables, customs live here).
-- ---------------------------------------------------------------------------
CREATE TABLE entity_data (
    object_id       text PRIMARY KEY REFERENCES entities(id) ON DELETE CASCADE,
    type_id         text NOT NULL REFERENCES type_definitions(type_id) ON DELETE RESTRICT,
    owner_id        text REFERENCES users(redpash_id) ON DELETE SET NULL,
    -- #3: a REAL FK — the create-time reach check (the IDOR guard) is the
    -- policy layer; this constraint makes a dangling/foreign parent
    -- unrepresentable even for direct-DB writes and future code paths.
    scope_parent_id text REFERENCES entities(id) ON DELETE SET NULL,
    data            jsonb NOT NULL DEFAULT '{}',
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX entity_data_scope_idx ON entity_data (scope_parent_id) WHERE scope_parent_id IS NOT NULL;
CREATE INDEX entity_data_type_idx ON entity_data (type_id);

-- Sparse per-field permission OVERRIDES only — defaults derive from perm_class.
CREATE TABLE field_permissions (
    type_id   text NOT NULL,
    field     text NOT NULL,
    role      text NOT NULL CHECK (role IN ('owner','admin','member','viewer')),
    can_read  boolean NOT NULL DEFAULT true,
    can_write boolean NOT NULL DEFAULT false,
    PRIMARY KEY (type_id, field, role),
    FOREIGN KEY (type_id, field) REFERENCES type_fields(type_id, field) ON DELETE CASCADE
);

-- Per-company horizontal RBAC contract: append-only, versioned, active = max.
-- Every policy change is a new row — a provable, rollback-able audit trail.
CREATE TABLE company_rbac (
    company_id text NOT NULL REFERENCES companies(redpash_id) ON DELETE CASCADE,
    version    integer NOT NULL,
    contract   jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (company_id, version)
);

-- ---------------------------------------------------------------------------
-- Connectors (sources). ALL credential values in config are stored encrypted
-- (v1:<base64(nonce||ct||tag)> under REDPASH_MASTER_KEY) — plaintext secrets
-- in this column are a Phase-4 audit failure, not a convention.
-- ---------------------------------------------------------------------------
CREATE TABLE connectors (
    redpash_id text PRIMARY KEY REFERENCES entities(id) ON DELETE CASCADE,
    kind       text NOT NULL CHECK (kind IN ('postgres','mysql','kafka')),
    name       text NOT NULL,
    config     jsonb NOT NULL DEFAULT '{}',
    watermark  jsonb,                                  -- incremental-pull state
    created_at timestamptz NOT NULL DEFAULT now()
);

-- Async connector sync jobs (#Phase-4: never in-request ETL).
CREATE TABLE connector_jobs (
    id           text PRIMARY KEY,                     -- JOB_<32-hex>
    connector_id text NOT NULL REFERENCES connectors(redpash_id) ON DELETE CASCADE,
    status       text NOT NULL DEFAULT 'queued'
                 CHECK (status IN ('queued','running','succeeded','failed')),
    detail       jsonb NOT NULL DEFAULT '{}',
    created_at   timestamptz NOT NULL DEFAULT now(),
    finished_at  timestamptz
);

-- ---------------------------------------------------------------------------
-- Observability — time-partitioned at birth (#8). Retention = DROP PARTITION,
-- never DELETE. Writes are fire-and-forget from the app (failures swallowed).
-- ---------------------------------------------------------------------------
CREATE TABLE events (
    id         text NOT NULL,                          -- EVT_<32-hex>
    at         timestamptz NOT NULL DEFAULT now(),
    kind       text NOT NULL,
    level      text NOT NULL DEFAULT 'info' CHECK (level IN ('info','warn','error')),
    message    text NOT NULL DEFAULT '',
    user_id    text,
    session_id text,
    request_id text,
    context    jsonb NOT NULL DEFAULT '{}',            -- redacted; strings capped at write
    PRIMARY KEY (id, at)
) PARTITION BY RANGE (at);
CREATE TABLE events_default PARTITION OF events DEFAULT;
CREATE INDEX events_kind_idx ON events (kind, at);
CREATE INDEX events_case_idx ON events ((context->>'case'), at) WHERE context ? 'case';

CREATE TABLE request_log (
    id         bigint GENERATED ALWAYS AS IDENTITY,
    at         timestamptz NOT NULL DEFAULT now(),
    method     text NOT NULL,
    route      text NOT NULL,                          -- normalized: rids -> :id
    status     smallint NOT NULL,
    latency_ms integer NOT NULL,
    user_id    text,
    request_id text,
    PRIMARY KEY (id, at)
) PARTITION BY RANGE (at);
CREATE TABLE request_log_default PARTITION OF request_log DEFAULT;
CREATE INDEX request_log_route_idx ON request_log (route, at);

CREATE TABLE db_query_log (
    id         bigint GENERATED ALWAYS AS IDENTITY,
    at         timestamptz NOT NULL DEFAULT now(),
    query      text NOT NULL,
    latency_ms integer NOT NULL,
    request_id text,
    PRIMARY KEY (id, at)
) PARTITION BY RANGE (at);
CREATE TABLE db_query_log_default PARTITION OF db_query_log DEFAULT;

-- ---------------------------------------------------------------------------
-- Derived views — derive-don't-store made executable.
-- ---------------------------------------------------------------------------
-- Stage per data file: publish > design > clean > new.
CREATE VIEW file_stages AS
SELECT f.redpash_id AS file_id,
       CASE
         WHEN EXISTS (                                  -- a chart built on f sits on a public dashboard
           SELECT 1
           FROM project_files c
           JOIN project_files d ON d.file_type = 'dashboard' AND d.is_public
           CROSS JOIN LATERAL jsonb_array_elements(coalesce(d.spec->'widgets','[]'::jsonb)) w
           WHERE c.file_type = 'chart' AND c.source_file_id = f.redpash_id
             AND w->'spec'->>'chart_id' = c.redpash_id
         ) THEN 'publish'
         WHEN EXISTS (
           SELECT 1 FROM project_files c
           WHERE c.file_type = 'chart' AND c.source_file_id = f.redpash_id
         ) THEN 'design'
         WHEN EXISTS (
           SELECT 1 FROM project_steps s WHERE s.file_id = f.redpash_id AND s.applied
         ) THEN 'clean'
         ELSE 'new'
       END AS stage
FROM project_files f
WHERE f.file_type = 'csv';

-- project.stage = max stage of its files (pure function, correct by construction).
CREATE VIEW project_stages AS
SELECT p.redpash_id AS project_id,
       coalesce(
         (SELECT s.stage FROM file_stages s
          JOIN project_files f ON f.redpash_id = s.file_id
          WHERE f.project_id = p.redpash_id
          ORDER BY array_position(ARRAY['new','clean','design','publish'], s.stage) DESC
          LIMIT 1),
         'new') AS stage
FROM projects p;

-- ---------------------------------------------------------------------------
-- Seeds: the builtin type registry. Unique prefixes (#1) — note DSH_.
-- scope_parents drive the generated RBAC cascade (#6).
-- ---------------------------------------------------------------------------
INSERT INTO type_definitions
  (type_id, rid_prefix, display_name, display_name_plural, rail_icon, is_builtin, grid_served, ordinal, scope_parents) VALUES
  ('user',       'USR', 'User',       'Users',       'bi-person',        true, true,  10, '[]'),
  ('company',    'CMP', 'Company',    'Companies',   'bi-building',      true, true,  20, '[]'),
  ('team',       'TEM', 'Team',       'Teams',       'bi-people',        true, true,  30, '["company_id"]'),
  ('project',    'PRJ', 'Project',    'Projects',    'bi-folder',        true, true,  40, '["company_id"]'),
  ('file',       'FIL', 'File',       'Files',       'bi-file-earmark',  true, true,  50, '["project_id"]'),
  ('chart',      'CHT', 'Chart',      'Charts',      'bi-bar-chart',     true, true,  60, '["project_id"]'),
  ('dashboard',  'DSH', 'Dashboard',  'Dashboards',  'bi-grid-1x2',      true, true,  70, '["project_id"]'),
  ('case',       'CAS', 'Case',       'Cases',       'bi-kanban',        true, true,  80, '["company_id","project_id"]'),
  ('connection', 'CON', 'Connection', 'Connections', 'bi-plug',          true, false, 90, '[]');
-- chart/dashboard rows live in project_files (file_type slices) — they are
-- registry types so RIDs resolve and TypeDefinitions serve field metadata,
-- not separate tables.

INSERT INTO type_scope_roles (scope, role, is_context, is_default, ordinal) VALUES
  ('object', 'owner',  false, false, 1),
  ('object', 'admin',  false, false, 2),
  ('object', 'member', false, true,  3),
  ('object', 'viewer', false, false, 4);
-- Full per-type field catalogs (type_fields) port in Phase 2 with field_perms.
