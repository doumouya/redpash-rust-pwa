-- Settings v2 step 7 (CAS_55984AC7) — kebab namespace backfill.
-- ──────────────────────────────────────────────────────────────────────────
-- Em locked the `<page>-<leaf>` pref-key shape in CAS_3FC70F56. Steps 1-6
-- of Settings v2 migrated the FRONTEND (open registry + per-pref
-- migrateFrom dual-read window + every read-site flipped to the kebab
-- keys). The DB side `user_preferences` rows still carry the camelCase
-- legacy keys for users who haven't written via the new keys yet; the
-- frontend dual-read covers them transparently.
--
-- This migration ships the SERVER-SIDE rename so the DB shape catches
-- up with the frontend contract. Per-user, per-key:
--   1. INSERT a kebab-key row carrying the legacy value (IF the kebab
--      row doesn't already exist — preserves the user's freshly-written
--      kebab value over the older camelCase one).
--   2. DELETE the legacy-key row.
--
-- Idempotent: re-running is a no-op once the legacy rows are gone (the
-- INSERT joins against a deleted set; the DELETE removes nothing).
--
-- Rollback safety: the frontend dual-read in prefs.js keeps working
-- with EITHER shape, so reverting this migration is harmless. Users
-- who'd already touched the new keys keep their values; users who
-- hadn't fall back to legacy via getPref's migrateFrom chain.
--
-- Performance: O(rows-matching-legacy-key) — a few hundred rows per
-- user max, total in the low millions across the user base. Runs in
-- a single transaction; the index on user_redpash_id keeps the ON
-- CONFLICT lookup fast.
-- ──────────────────────────────────────────────────────────────────────────

BEGIN;

WITH rename_pairs(legacy_key, kebab_key) AS (VALUES
  -- GENERAL · Appearance
  ('theme',                 'general-theme'),
  ('density',               'general-density'),
  ('fontSize',              'general-fontSize'),
  -- WORKSPACE · Tables
  ('rowsPerPageWorkspace',  'workspace-rowsPerPage'),
  ('rowsPerPageHome',       'home-rowsPerPage'),
  ('rowsPerPageMonitoring', 'monitoring-rowsPerPage'),
  -- WORKSPACE · Workspace
  ('showRowNumbers',        'workspace-showRowNumbers'),
  ('showStageDots',         'workspace-showStageDots'),
  -- WORKSPACE · Data & Export
  ('csvDelimiter',          'workspace-csvDelimiter'),
  ('csvEncoding',           'workspace-csvEncoding'),
  ('exportFormat',          'workspace-exportFormat'),
  -- WORKSPACE rail view (not surfaced in Settings; lives in the rail)
  ('workspaceRailView',     'workspace-railView'),
  -- CASES
  ('casesDoneWindow',       'cases-doneWindow'),
  ('casesRailGroupBy',      'cases-railGroupBy'),
  ('casesDetailPanel',      'cases-detailPanel'),
  ('casesActiveSource',     'cases-activeSource'),
  ('casesFilterAssignee',   'cases-filterAssignee'),
  ('casesFilterStatus',     'cases-filterStatus'),
  -- HOME / MONITORING — chart-layouts pref keys
  ('homeCharts',            'home-charts'),
  ('monitoringCharts',      'monitoring-charts')
)
INSERT INTO user_preferences (user_redpash_id, key, value, updated_at)
SELECT up.user_redpash_id, rp.kebab_key, up.value, now()
FROM   user_preferences up
JOIN   rename_pairs rp ON rp.legacy_key = up.key
ON CONFLICT (user_redpash_id, key) DO NOTHING;
-- ON CONFLICT means a kebab-key row already exists for this user —
-- they wrote it via the new namespace + their value wins. The
-- legacy row is still deleted below so we don't carry both shapes
-- forward.

DELETE FROM user_preferences
WHERE key IN (
  'theme', 'density', 'fontSize',
  'rowsPerPageWorkspace', 'rowsPerPageHome', 'rowsPerPageMonitoring',
  'showRowNumbers', 'showStageDots',
  'csvDelimiter', 'csvEncoding', 'exportFormat',
  'workspaceRailView',
  'casesDoneWindow', 'casesRailGroupBy', 'casesDetailPanel',
  'casesActiveSource', 'casesFilterAssignee', 'casesFilterStatus',
  'homeCharts', 'monitoringCharts'
);

COMMIT;
