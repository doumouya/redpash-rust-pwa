-- Step 2: ownership -> memberships (case CAS_DC7EDAF82F1E494F846D83FA71C411A2).
--
-- Project ownership stops being the `projects.owner_id` column and becomes a
-- `memberships` row (role='owner', object = the project) — same model
-- companies already use. The default-project flag moves off the project and
-- onto the user (`users.default_project_id`), so "one default per user" is
-- enforced by it being a single column rather than a partial-unique index.
--
-- This makes the account-deletion BLOCKER uniform: a sole owner of ANY object
-- (company or project) is one query — SELECT ... FROM memberships WHERE
-- user = $X AND role = 'owner'. No object is ever orphaned (the blocker stops
-- the close until ownership is transferred/deleted); user PII is tombstoned
-- separately (is_deleted + scrub), retaining history.

-- 1. Default project -> a column on users (one default per user by construction).
ALTER TABLE users ADD COLUMN default_project_id TEXT
    REFERENCES projects(redpash_id) ON DELETE SET NULL;
UPDATE users u SET default_project_id = (
    SELECT p.redpash_id FROM projects p
     WHERE p.owner_id = u.redpash_id AND p.is_default
     LIMIT 1);

-- 2. Owner -> a membership row (role='owner', object = the project). owner_id
--    is NOT NULL today, so every project gets exactly one owner membership;
--    created_at carries over as joined_at. Object rids are in `entities` (1a),
--    so the polymorphic FK holds.
INSERT INTO memberships (object_redpash_id, user_redpash_id, role, joined_at)
    SELECT redpash_id, owner_id, 'owner', created_at FROM projects
    ON CONFLICT (object_redpash_id, user_redpash_id) DO NOTHING;

-- 3. Drop the old ownership column + the default flag + its partial-unique idx.
DROP INDEX IF EXISTS projects_owner_default_idx;
ALTER TABLE projects DROP COLUMN owner_id;
ALTER TABLE projects DROP COLUMN is_default;
