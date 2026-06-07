-- Object-registry Stage 2: the polymorphic custom-object store. A TypeDefinition
-- + a row here = a fully RBAC'd, audited, field-validated object with zero new
-- code (the generic /api/objects/:type handler is the only reader/writer).
-- Builtins keep their typed tables (Hybrid-C storage); custom types live here as
-- JSONB — jsonb is Postgres's own catalog escape hatch, so this mirrors the
-- typed-known + one-open-type split pg_catalog itself ships.
--
--   object_id  → entities(id) CASCADE  : the polymorphic id space (delete the
--                entity → the data row goes with it).
--   type_id    → type_definitions      : RESTRICT — can't drop a type that still
--                has live objects.
--   owner_id   : the creator (also auto-granted an `owner` membership, so RBAC
--                resolves without the scope cascade).
--   scope_parent_id : optional company/project the object cascades RBAC from
--                (Stage 3 adds the GRANT_SQL/EDGES_SQL arm; until then access is
--                direct-membership only).

CREATE TABLE entity_data (
    object_id       TEXT PRIMARY KEY REFERENCES entities(id) ON DELETE CASCADE,
    type_id         TEXT NOT NULL REFERENCES type_definitions(type_id) ON DELETE RESTRICT,
    owner_id        TEXT NOT NULL,
    scope_parent_id TEXT,
    data            JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX entity_data_type         ON entity_data (type_id);
CREATE INDEX entity_data_scope_parent ON entity_data (scope_parent_id) WHERE scope_parent_id IS NOT NULL;
