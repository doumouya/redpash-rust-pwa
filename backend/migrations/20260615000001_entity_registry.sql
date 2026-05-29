-- Entity Registry (supertype) — step 1a of the membership consolidation
-- (case CAS_DC7EDAF82F1E494F846D83FA71C411A2).
--
-- `entities` is the universal object handle: every top-level entity's
-- redpash_id FKs into it ON DELETE CASCADE, so polymorphic relations
-- (memberships, landing in step 1b) get DB-enforced cascade with no
-- triggers. Delete an object by deleting its entities row — the subtype
-- row and every edge cascade in one shot.
--
-- Scope (Em, 2026-05-29): the membership OBJECT types only —
-- company / project / case. `user` is always the subject side of a
-- membership (it FKs straight to users, never the polymorphic side) and
-- `file` isn't a relation target yet; both are clean additive backfills
-- when something actually points polymorphically at them.

CREATE TABLE IF NOT EXISTS entities (
    id         TEXT        NOT NULL PRIMARY KEY,
    type       TEXT        NOT NULL CHECK (type IN ('company', 'project', 'case')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Backfill existing rows BEFORE adding the FKs (the constraint validates
-- against these). Preserve each row's real created_at so the registry's
-- timestamp matches the object's birth, not the migration time.
INSERT INTO entities (id, type, created_at)
    SELECT redpash_id, 'company', created_at FROM companies
    ON CONFLICT (id) DO NOTHING;
INSERT INTO entities (id, type, created_at)
    SELECT redpash_id, 'project', created_at FROM projects
    ON CONFLICT (id) DO NOTHING;
INSERT INTO entities (id, type, created_at)
    SELECT redpash_id, 'case', created_at FROM cases
    ON CONFLICT (id) DO NOTHING;

-- Each subtype's PK becomes a FK into the registry. ON DELETE CASCADE:
-- deleting the entities row removes the subtype row (and, from 1b, its
-- memberships). The subtype's own outbound FKs/cascades (project_files,
-- project_steps, project_memberships, company_memberships,
-- projects.company_id SET NULL, comments) still fire through the chain.
ALTER TABLE companies
    ADD CONSTRAINT companies_entity_fk
    FOREIGN KEY (redpash_id) REFERENCES entities(id) ON DELETE CASCADE;
ALTER TABLE projects
    ADD CONSTRAINT projects_entity_fk
    FOREIGN KEY (redpash_id) REFERENCES entities(id) ON DELETE CASCADE;
ALTER TABLE cases
    ADD CONSTRAINT cases_entity_fk
    FOREIGN KEY (redpash_id) REFERENCES entities(id) ON DELETE CASCADE;
