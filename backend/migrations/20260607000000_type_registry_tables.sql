-- Object-registry Stage 1 (CAS_0FBF301F): move the code-side type / field /
-- scope-role registries into DATA. Seeded byte-identically from the builtins
-- (field_perms::default_registry + type_registry::builtin_meta + the admin.rs
-- role const arrays); the parity test guards the transcription. After this,
-- `entities.type` is an FK on `type_definitions` (the closed CHECK becomes an
-- open registry — a new type is a row insert, not a migration).
--
-- Storage rule (L6): type_fields stores INPUTS only (data_type / perm_class /
-- is_sortable / options / rel). The per-role cells + default editor + is_editable
-- are RE-DERIVED in Rust (TypeDefCache) via the same PermClass::cells() /
-- default_editor() logic, so the seed can't drift from the derivation.
-- Field order is load-bearing for the /admin/types + /admin/fields wire (L5):
-- `ordinal` preserves the authoring order; every cache load is ORDER BY ordinal.

-- ── tables ────────────────────────────────────────────────────────────────
CREATE TABLE type_definitions (
    type_id              TEXT PRIMARY KEY,
    rid_prefix           TEXT NOT NULL,
    display_name         TEXT NOT NULL,
    display_name_plural  TEXT NOT NULL,
    rail_icon            TEXT,
    default_columns      JSONB NOT NULL DEFAULT '[]'::jsonb,
    default_sort         TEXT,
    is_builtin           BOOLEAN NOT NULL DEFAULT TRUE,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- User-defined prefixes are unique; builtins may share (file + dashboard = FIL_),
-- so the uniqueness is partial (L10). A user prefix colliding with a builtin is
-- rejected in app-layer (register_type), not here.
CREATE UNIQUE INDEX type_definitions_rid_prefix_udef
    ON type_definitions (rid_prefix) WHERE NOT is_builtin;

CREATE TABLE type_fields (
    type_id      TEXT    NOT NULL REFERENCES type_definitions(type_id) ON DELETE CASCADE,
    field        TEXT    NOT NULL,
    ordinal      INTEGER NOT NULL,
    data_type    TEXT    NOT NULL,
    perm_class   TEXT    NOT NULL,
    is_sortable  BOOLEAN NOT NULL DEFAULT TRUE,
    options      JSONB   NOT NULL DEFAULT '[]'::jsonb,
    rel_type     TEXT,
    rel_multi    BOOLEAN NOT NULL DEFAULT FALSE,
    validate     JSONB   NOT NULL DEFAULT '[]'::jsonb,
    PRIMARY KEY (type_id, field)
);
CREATE INDEX type_fields_type_ordinal ON type_fields (type_id, ordinal);

CREATE TABLE type_scope_roles (
    scope       TEXT    NOT NULL,   -- project / company / case / team
    role        TEXT    NOT NULL,
    is_context  BOOLEAN NOT NULL DEFAULT FALSE,  -- false = system role, true = context_role
    is_default  BOOLEAN NOT NULL DEFAULT FALSE,  -- the role applied when a membership omits `role`
    ordinal     INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (scope, role, is_context)
);

-- ── seed: type_definitions (9) ──────────────────────────────────────────────
-- The 7 grid types (builtin_meta) + `user` (rel-only subject, no fields, but an
-- entities.type value → needs a row for the FK) + `connection` (entities.type
-- value; also gives the Stage-2 generic-handler proof its field catalog, L13).
INSERT INTO type_definitions
    (type_id, rid_prefix, display_name, display_name_plural, rail_icon, default_columns, default_sort, is_builtin)
VALUES
    ('company',    'CMP_', 'Company',    'Companies',   'bi-building',                 '["name","slug","member_count"]',        'name',         TRUE),
    ('project',    'PRJ_', 'Project',    'Projects',    'bi-folder',                   '["name","status","stage","file_count"]','name',         TRUE),
    ('case',       'CAS_', 'Case',       'Cases',       'bi-card-list',                '["title","status","priority","assignee"]','updated_at',  TRUE),
    ('team',       'TEM_', 'Team',       'Teams',       'bi-people',                   '["name","kind","member_count"]',        'name',         TRUE),
    ('file',       'FIL_', 'File',       'Files',       'bi-file-earmark-spreadsheet', '["display_name","stage","row_count"]',  'display_name', TRUE),
    ('chart',      'CHT_', 'Chart',      'Charts',      'bi-bar-chart',                '["title","source_file_id"]',            'title',        TRUE),
    ('dashboard',  'FIL_', 'Dashboard',  'Dashboards',  'bi-grid-1x2',                 '["title","folder","is_public"]',        'title',        TRUE),
    ('user',       'USR_', 'User',       'Users',       'bi-person',                   '[]',                                    'redpash_id',   TRUE),
    ('connection', 'CON_', 'Connection', 'Connections', 'bi-plug',                     '["name","kind","topic"]',               'name',         TRUE)
ON CONFLICT (type_id) DO NOTHING;

-- ── seed: type_fields ───────────────────────────────────────────────────────
-- Transcribed from field_perms::default_registry() in authoring order (ordinal).
-- (type_id, field, ordinal, data_type, perm_class, is_sortable, options, rel_type, rel_multi)
INSERT INTO type_fields
    (type_id, field, ordinal, data_type, perm_class, is_sortable, options, rel_type, rel_multi)
VALUES
    -- company
    ('company', 'name',         0, 'string',   'standard',  TRUE,  '[]', NULL, FALSE),
    ('company', 'slug',         1, 'string',   'standard',  TRUE,  '[]', NULL, FALSE),
    ('company', 'avatar_url',   2, 'string',   'standard',  FALSE, '[]', NULL, FALSE),
    ('company', 'redpash_id',   3, 'rid',      'readonly',  FALSE, '[]', NULL, FALSE),
    ('company', 'member_count', 4, 'int',      'readonly',  TRUE,  '[]', NULL, FALSE),
    ('company', 'created_at',   5, 'datetime', 'readonly',  TRUE,  '[]', NULL, FALSE),
    -- project
    ('project', 'name',         0, 'string',   'standard',    TRUE,  '[]', NULL, FALSE),
    ('project', 'description',  1, 'markdown', 'standard',    FALSE, '[]', NULL, FALSE),
    ('project', 'status',       2, 'enum',     'standard',    TRUE,  '["draft","active","archived"]', NULL, FALSE),
    ('project', 'is_default',   3, 'boolean',  'owner_grade', TRUE,  '[]', NULL, FALSE),
    ('project', 'owner',        4, 'rid',      'owner_grade', TRUE,  '[]', 'user',    FALSE),
    ('project', 'company',      5, 'rid',      'owner_grade', TRUE,  '[]', 'company', FALSE),
    ('project', 'redpash_id',   6, 'rid',      'readonly',    FALSE, '[]', NULL, FALSE),
    ('project', 'stage',        7, 'string',   'readonly',    TRUE,  '[]', NULL, FALSE),
    ('project', 'file_count',   8, 'int',      'readonly',    TRUE,  '[]', NULL, FALSE),
    ('project', 'created_at',   9, 'datetime', 'readonly',    TRUE,  '[]', NULL, FALSE),
    ('project', 'updated_at',  10, 'datetime', 'readonly',    TRUE,  '[]', NULL, FALSE),
    -- case
    ('case', 'title',         0, 'string',   'collaborative', TRUE,  '[]', NULL, FALSE),
    ('case', 'description',   1, 'markdown', 'collaborative', FALSE, '[]', NULL, FALSE),
    ('case', 'status',        2, 'enum',     'collaborative', TRUE,  '["backlog","todo","in_progress","in_review","done"]', NULL, FALSE),
    ('case', 'priority',      3, 'enum',     'collaborative', TRUE,  '["low","medium","high","critical"]', NULL, FALSE),
    ('case', 'type',          4, 'enum',     'collaborative', TRUE,  '["bug","feature","task","epic"]', NULL, FALSE),
    ('case', 'assignee',      5, 'rid',      'collaborative', TRUE,  '[]', 'user',          FALSE),
    ('case', 'category',      6, 'rid',      'collaborative', TRUE,  '[]', 'case_category', FALSE),
    ('case', 'error_message', 7, 'string',   'standard',      FALSE, '[]', NULL, FALSE),
    ('case', 'project',       8, 'rid',      'standard',      TRUE,  '[]', 'project', FALSE),
    ('case', 'company',       9, 'rid',      'standard',      TRUE,  '[]', 'company', FALSE),
    ('case', 'redpash_id',   10, 'rid',      'readonly',      FALSE, '[]', NULL, FALSE),
    ('case', 'reporter_id',  11, 'rid',      'readonly',      TRUE,  '[]', 'user', FALSE),
    ('case', 'created_at',   12, 'datetime', 'readonly',      TRUE,  '[]', NULL, FALSE),
    ('case', 'updated_at',   13, 'datetime', 'readonly',      TRUE,  '[]', NULL, FALSE),
    -- team
    ('team', 'name',         0, 'string',   'standard',    TRUE,  '[]', NULL, FALSE),
    ('team', 'company_id',   1, 'rid',      'owner_grade', TRUE,  '[]', 'company', FALSE),
    ('team', 'kind',         2, 'enum',     'owner_grade', TRUE,  '["team","department"]', NULL, FALSE),
    ('team', 'redpash_id',   3, 'rid',      'readonly',    FALSE, '[]', NULL, FALSE),
    ('team', 'member_count', 4, 'int',      'readonly',    TRUE,  '[]', NULL, FALSE),
    ('team', 'created_at',   5, 'datetime', 'readonly',    TRUE,  '[]', NULL, FALSE),
    -- file
    ('file', 'display_name', 0, 'string',   'standard', TRUE,  '[]', NULL, FALSE),
    ('file', 'encoding',     1, 'string',   'standard', FALSE, '[]', NULL, FALSE),
    ('file', 'delimiter',    2, 'string',   'standard', FALSE, '[]', NULL, FALSE),
    ('file', 'project',      3, 'rid',      'standard', TRUE,  '[]', 'project', FALSE),
    ('file', 'redpash_id',   4, 'rid',      'readonly', FALSE, '[]', NULL, FALSE),
    ('file', 'filename',     5, 'string',   'readonly', TRUE,  '[]', NULL, FALSE),
    ('file', 'stage',        6, 'string',   'readonly', TRUE,  '[]', NULL, FALSE),
    ('file', 'row_count',    7, 'int',      'readonly', TRUE,  '[]', NULL, FALSE),
    ('file', 'created_at',   8, 'datetime', 'readonly', TRUE,  '[]', NULL, FALSE),
    -- chart
    ('chart', 'title',          0, 'string',   'standard', TRUE,  '[]', NULL, FALSE),
    ('chart', 'spec',           1, 'json',     'standard', FALSE, '[]', NULL, FALSE),
    ('chart', 'source_file_id', 2, 'rid',      'standard', TRUE,  '[]', 'file',    FALSE),
    ('chart', 'project',        3, 'rid',      'standard', TRUE,  '[]', 'project', FALSE),
    ('chart', 'redpash_id',     4, 'rid',      'readonly', FALSE, '[]', NULL, FALSE),
    ('chart', 'created_at',     5, 'datetime', 'readonly', TRUE,  '[]', NULL, FALSE),
    -- dashboard
    ('dashboard', 'title',       0, 'string',   'standard', TRUE,  '[]', NULL, FALSE),
    ('dashboard', 'description', 1, 'markdown', 'standard', FALSE, '[]', NULL, FALSE),
    ('dashboard', 'spec',        2, 'json',     'standard', FALSE, '[]', NULL, FALSE),
    ('dashboard', 'folder',      3, 'string',   'standard', TRUE,  '[]', NULL, FALSE),
    ('dashboard', 'is_public',   4, 'boolean',  'standard', TRUE,  '[]', NULL, FALSE),
    ('dashboard', 'is_favorite', 5, 'boolean',  'personal', TRUE,  '[]', NULL, FALSE),
    ('dashboard', 'redpash_id',  6, 'rid',      'readonly', FALSE, '[]', NULL, FALSE),
    ('dashboard', 'created_at',  7, 'datetime', 'readonly', TRUE,  '[]', NULL, FALSE),
    -- connection (NEW catalog — minimal; the Stage-2 proof edits `name`)
    ('connection', 'name',       0, 'string', 'standard', TRUE,  '[]', NULL, FALSE),
    ('connection', 'kind',       1, 'string', 'readonly', TRUE,  '[]', NULL, FALSE),
    ('connection', 'topic',      2, 'string', 'readonly', TRUE,  '[]', NULL, FALSE),
    ('connection', 'project',    3, 'rid',    'readonly', TRUE,  '[]', 'project', FALSE),
    ('connection', 'redpash_id', 4, 'rid',    'readonly', FALSE, '[]', NULL, FALSE)
ON CONFLICT (type_id, field) DO NOTHING;

-- ── seed: type_scope_roles ──────────────────────────────────────────────────
-- System roles (is_context=false, one is_default per scope) + context roles
-- (is_context=true). From admin.rs PROJECT_ROLES/COMPANY_ROLES/CASE_ROLES/
-- TEAM_ROLES + *_CONTEXT_ROLES; the default per scope is project→viewer,
-- company/case/team→member.
INSERT INTO type_scope_roles (scope, role, is_context, is_default, ordinal) VALUES
    -- project system roles (default viewer)
    ('project', 'owner',  FALSE, FALSE, 0),
    ('project', 'member', FALSE, FALSE, 1),
    ('project', 'viewer', FALSE, TRUE,  2),
    -- company system roles (default member)
    ('company', 'owner',  FALSE, FALSE, 0),
    ('company', 'admin',  FALSE, FALSE, 1),
    ('company', 'member', FALSE, TRUE,  2),
    -- case system roles (default member)
    ('case', 'owner',  FALSE, FALSE, 0),
    ('case', 'member', FALSE, TRUE,  1),
    ('case', 'viewer', FALSE, FALSE, 2),
    -- team system roles (default member)
    ('team', 'owner',  FALSE, FALSE, 0),
    ('team', 'admin',  FALSE, FALSE, 1),
    ('team', 'member', FALSE, TRUE,  2),
    -- project context roles
    ('project', 'Project Owner',   TRUE, FALSE, 0),
    ('project', 'Project Manager', TRUE, FALSE, 1),
    ('project', 'Data Analyst',    TRUE, FALSE, 2),
    ('project', 'Reviewer',        TRUE, FALSE, 3),
    -- company context roles
    ('company', 'CEO',              TRUE, FALSE, 0),
    ('company', 'CTO',              TRUE, FALSE, 1),
    ('company', 'Operations Lead',  TRUE, FALSE, 2),
    ('company', 'HR Generalist',    TRUE, FALSE, 3),
    ('company', 'Support Engineer', TRUE, FALSE, 4),
    ('company', 'Engineer',         TRUE, FALSE, 5),
    ('company', 'Manager',          TRUE, FALSE, 6),
    ('company', 'Founder',          TRUE, FALSE, 7),
    ('company', 'Investor',         TRUE, FALSE, 8),
    -- case context roles
    ('case', 'Reporter',   TRUE, FALSE, 0),
    ('case', 'Case Owner', TRUE, FALSE, 1),
    ('case', 'Watcher',    TRUE, FALSE, 2),
    ('case', 'Assignee',   TRUE, FALSE, 3),
    -- team context roles
    ('team', 'Team Manager', TRUE, FALSE, 0),
    ('team', 'Team Lead',    TRUE, FALSE, 1),
    ('team', 'Team Member',  TRUE, FALSE, 2)
ON CONFLICT (scope, role, is_context) DO NOTHING;

-- ── entities.type: closed CHECK → open FK on type_definitions ────────────────
-- The seed above guarantees every live entities.type value
-- (user/company/project/case/team/connection) has a type_definitions row, so the
-- FK validates. DROP CONSTRAINT is metadata-only (fast ACCESS EXCLUSIVE); the FK
-- is added NOT VALID then VALIDATEd. A new type is now a row, not a migration.
ALTER TABLE entities DROP CONSTRAINT entities_type_check;
ALTER TABLE entities ADD  CONSTRAINT entities_type_fk
    FOREIGN KEY (type) REFERENCES type_definitions(type_id) NOT VALID;
ALTER TABLE entities VALIDATE CONSTRAINT entities_type_fk;
