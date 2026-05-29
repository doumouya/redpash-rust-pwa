-- Case people -> memberships (case CAS_DC7EDAF82F1E494F846D83FA71C411A2).
--
-- Reporter + case-owner (fka assignee) become membership rows on the case,
-- exactly like project/company owners — one polymorphic table for every
-- people-to-object relationship. relationship_attribute carries the relation
-- ('Reporter' / 'Case Owner'); role is the access tier. Reassignment is a
-- human editing the field (admin/manager gives the case to another engineer),
-- same as project ownership. Drop cases.reporter_id + cases.assignee_id.

-- Case owner first (the active relation), reporter second; ON CONFLICT skips
-- the rare case where the same user is both (one membership per user/object).
INSERT INTO memberships (object_redpash_id, user_redpash_id, role, relationship_attribute)
    SELECT redpash_id, assignee_id, 'member', 'Case Owner' FROM cases
    WHERE assignee_id IS NOT NULL
    ON CONFLICT (object_redpash_id, user_redpash_id) DO NOTHING;
INSERT INTO memberships (object_redpash_id, user_redpash_id, role, relationship_attribute)
    SELECT redpash_id, reporter_id, 'member', 'Reporter' FROM cases
    WHERE reporter_id IS NOT NULL
    ON CONFLICT (object_redpash_id, user_redpash_id) DO NOTHING;

ALTER TABLE cases DROP COLUMN assignee_id;
ALTER TABLE cases DROP COLUMN reporter_id;
