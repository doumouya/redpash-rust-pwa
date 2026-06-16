-- ============================================================================
-- Preferences as a real builtin TYPE — the Settings page falls out of the
-- schema. A pref is a type_field on the `preference` type; the Settings page
-- chrome (sections + controls) is GENERATED from these rows, exactly like a
-- grid is generated from an object type's field catalog. No per-pref handler,
-- no client-side registry: "a new pref is a row, not a migration" once the
-- type exists.
--
-- Two NEW columns on type_fields carry the pref-only metadata (object-type
-- fields keep the '' / 'user' defaults, harmless):
--   field_group — groups pref fields into Settings sections (Appearance, …).
--   scope       — which settings scope the pref lives in: 'user' | 'role' |
--                 'platform'. The settings API's scope-based can_write is the
--                 real write gate; perm_class stays inert for prefs (it is a
--                 required column on type_fields, nothing more).
-- The DEFAULTS seed platform-scope settings rows so /api/me's resolver returns
-- them when unset — this REPLACES the old client-side registry defaults.
-- ============================================================================

ALTER TABLE type_fields
    ADD COLUMN field_group text NOT NULL DEFAULT '',
    ADD COLUMN scope       text NOT NULL DEFAULT 'user';

-- The `preference` builtin type. grid_served=false (it is never a datatable);
-- scope_parents='[]' (prefs are the caller's own, no cascade). type_cache
-- loads this row at boot with NO code change — it is data, not a typed table.
INSERT INTO type_definitions
  (type_id, rid_prefix, display_name, display_name_plural, rail_icon, is_builtin, grid_served, ordinal, scope_parents) VALUES
  ('preference', 'PRF', 'Preference', 'Preferences', 'bi-sliders', true, false, 95, '[]');

-- The pref catalog. data_type + options drive the control kind (select with
-- {value,label} options vs. bool toggle); field_group → Settings section;
-- scope → settings scope; perm_class is inert (the scope gate is the real one):
-- 'personal' for the user prefs, 'owner_grade' for the app.* platform policies.
INSERT INTO type_fields (type_id, field, label, ordinal, data_type, perm_class, field_group, scope, options) VALUES
  ('preference', 'theme',               'Theme',                          10, 'string', 'personal',    'Appearance', 'user',
     '[{"value":"new-dark","label":"Dark"},{"value":"new-light","label":"Light"}]'),
  ('preference', 'density',             'Density',                        20, 'string', 'personal',    'Appearance', 'user',
     '[{"value":"compact","label":"Compact"},{"value":"default","label":"Default"},{"value":"comfortable","label":"Comfortable"}]'),
  ('preference', 'fontsize',            'Font size',                      30, 'string', 'personal',    'Appearance', 'user',
     '[{"value":"sm","label":"Small"},{"value":"default","label":"Default"},{"value":"lg","label":"Large"}]'),
  ('preference', 'home.show_recents',   'Show recent files on Home',      40, 'bool',   'personal',    'Home',       'user',     NULL),
  ('preference', 'workspace.page_rows', 'Workspace rows fetched per file', 50, 'string', 'personal',   'Studio',     'user',
     '[{"value":"200","label":"200"},{"value":"1000","label":"1,000"},{"value":"5000","label":"5,000"}]'),
  ('preference', 'app.home.enabled',    'Home app enabled',               60, 'bool',   'owner_grade', 'Apps',       'platform', NULL),
  ('preference', 'app.studio.enabled',  'Studio app enabled',             70, 'bool',   'owner_grade', 'Apps',       'platform', NULL),
  ('preference', 'app.admin.enabled',   'Admin app enabled',              80, 'bool',   'owner_grade', 'Apps',       'platform', NULL);

-- The DEFAULTS as platform-scope settings rows — resolved_for returns these
-- when unset (REPLACES the client registry defaults). ON CONFLICT DO NOTHING
-- keeps re-running idempotent against the shared dev DB.
INSERT INTO settings (scope_type, scope_id, key, value) VALUES
  ('platform', '', 'theme',               '"new-dark"'),
  ('platform', '', 'density',             '"default"'),
  ('platform', '', 'fontsize',            '"default"'),
  ('platform', '', 'home.show_recents',   'true'),
  ('platform', '', 'workspace.page_rows', '"1000"'),
  ('platform', '', 'app.home.enabled',    'true'),
  ('platform', '', 'app.studio.enabled',  'true'),
  ('platform', '', 'app.admin.enabled',   'true')
ON CONFLICT DO NOTHING;
