-- Kafka connection setup — persist the user's CHOSEN destination so the loader
-- reads it instead of the load.sh env hardcode (Em: "ask the user which project
-- he wants to add the file"). Finishes connector-through-framework: the connector
-- behaves like a real UI upload, and a UI upload asks which project.
--
-- A connection is a first-class entity in the polymorphic registry — sibling of
-- project / case / team — so future connectors (S3, DB CDC) reuse the same
-- 'connection' type + inherit cascade-delete + (later) membership-based access.

-- 1) 'connection' joins the entity supertype CHECK (additive; was
--    user/company/project/case/team — see 20260531000000_entity_membership_rbac).
ALTER TABLE entities DROP CONSTRAINT entities_type_check;
ALTER TABLE entities ADD  CONSTRAINT entities_type_check
    CHECK (type IN ('user', 'company', 'project', 'case', 'team', 'connection'));

-- 2) the connectors subtype row. redpash_id FKs into entities (ON DELETE CASCADE,
--    so delete_entity drops it). project_id = the user-CHOSEN destination;
--    as_user = the identity the load is attributed to (RBAC-checked at load time
--    by pipeline::upload_csv — no platform-admin bypass); created_by = who made it.
--    config holds non-secret kafka specifics (forward-compat); the cluster SASL
--    creds stay in the connector's .env for the RC (per the plan's cheapest-first).
CREATE TABLE connectors (
    redpash_id  TEXT PRIMARY KEY REFERENCES entities(id)        ON DELETE CASCADE,
    project_id  TEXT NOT NULL    REFERENCES projects(redpash_id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    kind        TEXT NOT NULL DEFAULT 'kafka',
    topic       TEXT,
    as_user     TEXT NOT NULL    REFERENCES users(redpash_id),
    created_by  TEXT NOT NULL    REFERENCES users(redpash_id),
    config      JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- the loader resolves a connection by id; lists filter by project.
CREATE INDEX connectors_project_idx ON connectors (project_id);
