-- Field-level permission overrides (CAS_C4219F2B slice 2).
-- Sparse: a row exists only where an admin has overridden the catalog default
-- for a (object_type, field, role) cell. The served matrix is
-- default_registry() (code) ⊕ these rows. Reverting a cell to its default
-- deletes the row, so the table stays minimal.
CREATE TABLE IF NOT EXISTS field_permissions (
    object_type text        NOT NULL,
    field       text        NOT NULL,
    role        text        NOT NULL CHECK (role IN ('owner', 'admin', 'member', 'viewer')),
    permission  text        NOT NULL CHECK (permission IN ('write', 'read', 'none')),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    updated_by  text,
    PRIMARY KEY (object_type, field, role)
);
