-- Entity-Membership RBAC foundation — restore users to the entity supertype
-- so `memberships` is a symmetric entity→entity→role edge (subject may be a
-- user OR a team), and widen the key so one principal holds many roles.
--
-- Spec:  docs/internal/specs/rbac/entity-membership-model.md
-- Schema: docs/db/update_db/init.reconciled.sql
-- Case:  CAS_A3B5D5F8E2A3483EA44EAA5B437A6A92
--
-- NOTE: the subject column keeps the name `user_redpash_id` for now (it now
-- REFERENCES entities and may hold a team rid). The cosmetic rename to
-- `member_redpash_id` is a deferred, mechanical follow-up — surface debt, not
-- foundation. Data-preserving, in-place ALTERs.

-- 1) users join the entity supertype --------------------------------------
ALTER TABLE entities DROP CONSTRAINT entities_type_check;
ALTER TABLE entities ADD  CONSTRAINT entities_type_check
    CHECK (type IN ('user', 'company', 'project', 'case', 'team'));

INSERT INTO entities (id, type)
    SELECT redpash_id, 'user' FROM users
    ON CONFLICT (id) DO NOTHING;

ALTER TABLE users
    ADD CONSTRAINT users_entity_fk
    FOREIGN KEY (redpash_id) REFERENCES entities(id) ON DELETE CASCADE;

-- 2) memberships: subject FK users→entities; context_role NOT NULL; widen PK
ALTER TABLE memberships DROP CONSTRAINT memberships_user_redpash_id_fkey;
ALTER TABLE memberships
    ADD CONSTRAINT memberships_member_fk
    FOREIGN KEY (user_redpash_id) REFERENCES entities(id) ON DELETE CASCADE;

UPDATE memberships SET context_role = '' WHERE context_role IS NULL;
ALTER TABLE memberships ALTER COLUMN context_role SET DEFAULT '';
ALTER TABLE memberships ALTER COLUMN context_role SET NOT NULL;

ALTER TABLE memberships DROP CONSTRAINT memberships_pkey;
ALTER TABLE memberships
    ADD PRIMARY KEY (object_redpash_id, user_redpash_id, role, context_role);

-- 3) teams: a department is a KIND of team ---------------------------------
ALTER TABLE teams
    ADD COLUMN kind text NOT NULL DEFAULT 'team' CHECK (kind IN ('team', 'department'));

-- 4) one-department-per-user-per-company (Option B) ------------------------
-- Trigger, not a unique index: the widened key must keep allowing MULTIPLE
-- roles on a user's OWN department, which UNIQUE(member,company) would forbid.
-- The advisory lock serializes concurrent dept-joins → closes the count→raise
-- TOCTOU race. (Validated live 2026-05-31.)
CREATE FUNCTION public.enforce_one_department_per_user() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
    target_team_kind    text;
    target_company_id   text;
    existing_dept_count integer;
BEGIN
    SELECT kind, company_id INTO target_team_kind, target_company_id
      FROM public.teams WHERE redpash_id = NEW.object_redpash_id;

    IF target_team_kind = 'department' THEN
        PERFORM pg_advisory_xact_lock(
            hashtextextended(NEW.user_redpash_id || '|' || target_company_id, 0));

        SELECT count(*) INTO existing_dept_count
          FROM public.memberships m
          JOIN public.teams t ON m.object_redpash_id = t.redpash_id
         WHERE m.user_redpash_id   = NEW.user_redpash_id
           AND t.company_id        = target_company_id
           AND t.kind              = 'department'
           AND m.object_redpash_id <> NEW.object_redpash_id;

        IF existing_dept_count > 0 THEN
            RAISE EXCEPTION
              'User % is already a member of a department in company %. A user can belong to only one department per company.',
              NEW.user_redpash_id, target_company_id;
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER trigger_one_department_per_user
    BEFORE INSERT OR UPDATE ON public.memberships
    FOR EACH ROW EXECUTE FUNCTION public.enforce_one_department_per_user();
