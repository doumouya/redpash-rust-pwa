-- ============================================================================
-- S7: the org-builtin field catalogs (type_fields seeds) + the label column.
-- Derive-don't-store: per-role read/write cells are NEVER persisted — they
-- DERIVE from perm_class in Rust (field_perms::PermClass::cells) and the
-- sparse field_permissions override table (init migration) layers on top.
-- Only the INPUTS live here, so seeds cannot drift from the derivation.
-- `label` is a presentation INPUT (not always derivable: company_id → the
-- human label is a product choice), added with the first seeded catalog.
-- ============================================================================

ALTER TABLE type_fields ADD COLUMN label text NOT NULL DEFAULT '';

INSERT INTO type_fields (type_id, field, label, ordinal, data_type, perm_class, options) VALUES
  -- user — username is system-derived (readonly RRRR); role/status are org
  -- management knobs (owner_grade WRRR: owner writes, admin and below read).
  ('user',    'display_name', 'Display Name', 10, 'string', 'standard',    NULL),
  ('user',    'username',     'Username',     20, 'string', 'readonly',    NULL),
  ('user',    'email',        'Email',        30, 'string', 'standard',    NULL),
  ('user',    'role',         'Role',         40, 'string', 'owner_grade', '["user","admin"]'),
  ('user',    'status',       'Status',       50, 'string', 'owner_grade', '["active","archived"]'),
  -- company
  ('company', 'name',         'Name',         10, 'string', 'standard',    NULL),
  -- team — company_id is the scope parent: re-parenting is not a field edit
  -- (readonly); kind flips team/department semantics (owner_grade).
  ('team',    'name',         'Name',         10, 'string', 'standard',    NULL),
  ('team',    'kind',         'Kind',         20, 'string', 'owner_grade', '["team","department"]'),
  ('team',    'company_id',   'Company ID',   30, 'string', 'readonly',    NULL);
