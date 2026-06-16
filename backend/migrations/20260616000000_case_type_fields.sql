-- Display catalog for `case`, so /objects/case renders through the generic
-- builtin_list (which reads type_fields at objects.rs:catalog_fields — without a
-- catalog that path errors "no field catalog for case"). Mirrors the registry
-- seed (20260615000002) for file/project: every `field` is a REAL column of the
-- `cases` table (builtin_view/list cast `::text`, so non-text columns decode
-- uniformly), data_type stays 'string', perm_class 'readonly' — the Cases page
-- browses + DELETEs; cases are created/advanced by agents on the dedicated
-- /api/cases surface (the status workflow), not this generic registry view.
-- The type/status/source `options` record the CHECK vocabularies for downstream
-- UIs (the kanban); they are inert for these readonly fields.
INSERT INTO type_fields (type_id, field, label, ordinal, data_type, perm_class, options) VALUES
  ('case', 'title',       'Title',       10, 'string', 'readonly', NULL),
  ('case', 'description', 'Description', 20, 'string', 'readonly', NULL),
  ('case', 'type',        'Type',        30, 'string', 'readonly', '["bug","feature","task","epic"]'),
  ('case', 'status',      'Status',      40, 'string', 'readonly', '["backlog","todo","in_progress","in_review","done"]'),
  ('case', 'source',      'Source',      50, 'string', 'readonly', '["internal","external"]'),
  ('case', 'assignee_id', 'Assignee',    60, 'string', 'readonly', NULL),
  ('case', 'reporter_id', 'Reporter',    70, 'string', 'readonly', NULL),
  ('case', 'project_id',  'Project',     80, 'string', 'readonly', NULL),
  ('case', 'company_id',  'Company',     90, 'string', 'readonly', NULL),
  ('case', 'created_at',  'Created',    100, 'string', 'readonly', NULL),
  ('case', 'updated_at',  'Updated',    110, 'string', 'readonly', NULL);
