-- ============================================================================
-- The behavior registry's VALUE store ("the third framework", Phase 5).
-- Definitions live in code (frontend registerPref/registerPolicy — pages
-- register their knobs at module load); this table holds only the stored
-- values, scoped. Resolution cascade (one resolver, like RBAC's one gate):
--   user > role > company > platform > registered code default.
-- scope_id semantics: platform → '' · role → users.role value ('user','admin';
-- future contract-defined labels) · company → CMP_ rid · user → USR_ rid.
-- Unknown keys are permissively stored and ignored by readers that don't know
-- them — removing a feature orphans its rows harmlessly.
-- NOTE: company scope is stored from day one but the /api/me resolver overlays
-- platform → role → user only until a primary-company concept exists.
-- ============================================================================

CREATE TABLE settings (
    scope_type text NOT NULL CHECK (scope_type IN ('platform','company','role','user')),
    scope_id   text NOT NULL DEFAULT '',
    key        text NOT NULL,
    value      jsonb NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (scope_type, scope_id, key)
);

CREATE INDEX settings_key_idx ON settings (key);
