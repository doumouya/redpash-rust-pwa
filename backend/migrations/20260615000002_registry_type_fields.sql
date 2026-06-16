-- Registry display catalogs for file + project, so /objects/file and
-- /objects/project render through the generic builtin_list (which reads
-- type_fields at objects.rs:catalog_fields). Without a catalog, that path errors
-- "no field catalog for <type>". All fields READONLY: the registry browses +
-- DELETES these objects; they're created/edited by their own flows (upload,
-- /projects, the rename endpoint). The `field` names are REAL columns of the
-- typed tables (project_files / projects) — builtin_view/list cast `::text`, so
-- the non-text ones (row_count, col_count, cleanness_pct, created_at) decode
-- uniformly. data_type stays 'string' (the only seeded vocabulary; the values
-- arrive text-cast regardless).
INSERT INTO type_fields (type_id, field, label, ordinal, data_type, perm_class, options) VALUES
  ('file',    'filename',      'Filename', 10, 'string', 'readonly', NULL),
  ('file',    'project_id',    'Project',  20, 'string', 'readonly', NULL),
  ('file',    'row_count',     'Rows',     30, 'string', 'readonly', NULL),
  ('file',    'col_count',     'Columns',  40, 'string', 'readonly', NULL),
  ('file',    'cleanness_pct', 'Score',    50, 'string', 'readonly', NULL),
  ('file',    'created_at',    'Created',  60, 'string', 'readonly', NULL),
  ('project', 'name',          'Name',     10, 'string', 'readonly', NULL),
  ('project', 'created_at',    'Created',  20, 'string', 'readonly', NULL);
