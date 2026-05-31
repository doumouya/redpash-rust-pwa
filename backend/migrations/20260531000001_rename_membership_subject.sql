-- Deferred surface cleanup from 20260531000000: rename the membership subject
-- column user_redpash_id → member_redpash_id (it references entities and may
-- hold a team, so "user" was misleading). DB-side only here; the backend SQL,
-- the CompanyMember DTO field, and the frontend membership view rename in the
-- same commit. Other tables' user_redpash_id (sessions/events/request_log/
-- db_query_log) are unrelated and untouched.

ALTER TABLE memberships RENAME COLUMN user_redpash_id TO member_redpash_id;
ALTER INDEX  memberships_user_idx  RENAME TO memberships_member_idx;

-- The dept trigger function references the column by name in its body — rebind.
CREATE OR REPLACE FUNCTION public.enforce_one_department_per_user() RETURNS trigger
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
            hashtextextended(NEW.member_redpash_id || '|' || target_company_id, 0));

        SELECT count(*) INTO existing_dept_count
          FROM public.memberships m
          JOIN public.teams t ON m.object_redpash_id = t.redpash_id
         WHERE m.member_redpash_id = NEW.member_redpash_id
           AND t.company_id        = target_company_id
           AND t.kind              = 'department'
           AND m.object_redpash_id <> NEW.object_redpash_id;

        IF existing_dept_count > 0 THEN
            RAISE EXCEPTION
              'User % is already a member of a department in company %. A user can belong to only one department per company.',
              NEW.member_redpash_id, target_company_id;
        END IF;
    END IF;

    RETURN NEW;
END;
$$;
