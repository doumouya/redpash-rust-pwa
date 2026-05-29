-- Unified memberships (step 1b of the membership consolidation,
-- case CAS_DC7EDAF82F1E494F846D83FA71C411A2).
--
-- Replaces company_memberships + project_memberships with ONE polymorphic
-- table FK'd into the entity registry (1a) — DB-enforced cascade, no
-- triggers. role is unified to a 4-tier enum across every scope; the
-- descriptor fields (display_name + relationship_attribute) separate "who
-- you are here" (cosmetic, e.g. "CEO" / "Job Title") from "what you can do"
-- (role). meaning of a (object_type, role) pair resolves later via the
-- deferred role-grants table.

CREATE TABLE IF NOT EXISTS memberships (
    object_redpash_id      TEXT        NOT NULL
                           REFERENCES entities(id) ON DELETE CASCADE,
    user_redpash_id        TEXT        NOT NULL
                           REFERENCES users(redpash_id) ON DELETE CASCADE,
    role                   TEXT        NOT NULL DEFAULT 'member'
                           CHECK (role IN ('owner', 'admin', 'member', 'viewer')),
    display_name           TEXT,                          -- descriptor value
    relationship_attribute TEXT,                          -- descriptor label
    joined_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (object_redpash_id, user_redpash_id)      -- "who is in this object"
);

-- "what objects is this user in" — per-user RBAC resolution + /api/me.
CREATE INDEX IF NOT EXISTS memberships_user_idx
    ON memberships (user_redpash_id, object_redpash_id);

-- Migrate existing rows. Company roles (owner/admin/member) already fit the
-- unified enum. Project roles map into it: owner->owner, viewer->viewer
-- (both already in the 4-tier set), collaborator->member (the edit-capable
-- participant tier). joined_at preserved. Object rids exist in `entities`
-- (1a backfilled every company/project), so the polymorphic FK is satisfied.
INSERT INTO memberships (object_redpash_id, user_redpash_id, role, joined_at)
    SELECT company_id, user_redpash_id, role, joined_at
    FROM company_memberships
    ON CONFLICT DO NOTHING;

INSERT INTO memberships (object_redpash_id, user_redpash_id, role, joined_at)
    SELECT project_redpash_id, user_redpash_id,
           CASE role WHEN 'collaborator' THEN 'member' ELSE role END,
           joined_at
    FROM project_memberships
    ON CONFLICT DO NOTHING;

DROP TABLE project_memberships;
DROP TABLE company_memberships;
