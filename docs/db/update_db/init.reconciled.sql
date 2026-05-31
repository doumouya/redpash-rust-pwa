-- ============================================================================
-- init.reconciled.sql — the pasted target schema, reconciled to the agreed
-- entity-membership model (docs/internal/specs/rbac/entity-membership-model.md,
-- case CAS_A3B5D5F8E2A3483EA44EAA5B437A6A92).
--
-- Diff vs init.generated.sql is EXACTLY three tables — every change is marked
-- `-- ⟵ CHANGED`. Everything else (functions, triggers, partitioning, audit,
-- the user-specific FKs on sessions/comments/events) is byte-for-byte yours.
--
-- The one move: users rejoin the entity supertype, so `memberships` becomes a
-- symmetric entity→entity→role edge (subject can be a user OR a team), and the
-- key widens so one principal holds many roles. Reporter+assignee, owner+admin,
-- and team-as-grantee all follow.
--
-- SHIPPED NOTE (2026-05-31): the authoritative schema is the sqlx migrations
-- under backend/migrations/ — two of them: `20260531000000_entity_membership_rbac`
-- (the model change) and `20260531000001_rename_membership_subject` (renames
-- the subject column user_redpash_id → member_redpash_id + index). With both
-- applied, this file now matches the live DB exactly (column `member_redpash_id`,
-- index `memberships_member_idx`).
-- ============================================================================
BEGIN;

-- run_diff() (below) references audit.finding before §6 creates it; defer body
-- validation to call time, exactly as pg_dump's restore preamble does.
SET LOCAL check_function_bodies = false;

-- ============================================================================
-- 1. SCHEMAS & FUNCTIONS
-- ============================================================================
CREATE SCHEMA IF NOT EXISTS audit;

CREATE FUNCTION audit.run_diff(cur_id bigint, prev_id bigint) RETURNS TABLE(status text, kind text, finding_key text, severity_cur integer, severity_prev integer)
    LANGUAGE sql STABLE
    AS $$
    WITH
      cur  AS (SELECT kind, finding_key, severity FROM audit.finding WHERE run_id = cur_id),
      prev AS (SELECT kind, finding_key, severity FROM audit.finding WHERE run_id = prev_id)
    SELECT 'new'::TEXT, c.kind, c.finding_key, c.severity, NULL::INTEGER
      FROM cur c LEFT JOIN prev p USING (kind, finding_key) WHERE p.finding_key IS NULL
    UNION ALL
    SELECT 'fixed'::TEXT, p.kind, p.finding_key, NULL::INTEGER, p.severity
      FROM prev p LEFT JOIN cur c USING (kind, finding_key) WHERE c.finding_key IS NULL
    UNION ALL
    SELECT CASE
             WHEN c.severity IS DISTINCT FROM p.severity AND c.severity > p.severity THEN 'regressed'
             WHEN c.severity IS DISTINCT FROM p.severity AND c.severity < p.severity THEN 'improved'
             ELSE 'unchanged'
           END,
           c.kind, c.finding_key, c.severity, p.severity
      FROM cur c JOIN prev p USING (kind, finding_key);
$$;

CREATE FUNCTION public.bump_file_mtime_from_step() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        UPDATE project_files SET updated_at = now() WHERE redpash_id = OLD.file_redpash_id;
    ELSE
        UPDATE project_files SET updated_at = now() WHERE redpash_id = NEW.file_redpash_id;
    END IF;
    RETURN NULL;
END;
$$;

CREATE FUNCTION public.bump_project_mtime_from_file() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        UPDATE projects SET updated_at = now() WHERE redpash_id = OLD.project_redpash_id;
    ELSE
        UPDATE projects SET updated_at = now() WHERE redpash_id = NEW.project_redpash_id;
    END IF;
    RETURN NULL;
END;
$$;

-- ============================================================================
-- 2. THE SUPERTYPE & IDENTITY
-- ============================================================================
CREATE TABLE public.entities (
    id text PRIMARY KEY,
    type text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT entities_type_check CHECK (type IN ('user', 'company', 'project', 'case', 'team'))  -- ⟵ CHANGED: + 'user'
);

CREATE TABLE public.users (
    redpash_id text PRIMARY KEY REFERENCES public.entities(id) ON DELETE CASCADE,  -- ⟵ CHANGED: users are now an entity subtype (app inserts the entity row, then the user)
    username text NOT NULL UNIQUE,
    email text,
    display_name text NOT NULL,
    first_name text,
    last_name text,
    avatar_url text,
    organisation text,
    use_case text,
    plan text DEFAULT 'free'::text NOT NULL,
    locale text DEFAULT 'en'::text NOT NULL,
    google_sub text,
    default_project_id text, -- FK added below
    status text DEFAULT 'active'::text NOT NULL CHECK (status IN ('active', 'suspended', 'archived')),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX users_google_sub_idx ON public.users (google_sub) WHERE google_sub IS NOT NULL;

CREATE TABLE public.sessions (
    redpash_id text PRIMARY KEY,
    user_redpash_id text NOT NULL REFERENCES public.users(redpash_id) ON DELETE CASCADE,  -- user-specific: stays → users (correct)
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.user_preferences (
    user_redpash_id text NOT NULL REFERENCES public.users(redpash_id) ON DELETE CASCADE,  -- user-specific: stays → users (correct)
    key text NOT NULL,
    value jsonb NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    PRIMARY KEY (user_redpash_id, key)
);

-- ============================================================================
-- 3. RBAC & ORGANIZATIONS
-- ============================================================================
CREATE TABLE public.companies (
    redpash_id text PRIMARY KEY REFERENCES public.entities(id) ON DELETE CASCADE,
    name text NOT NULL,
    slug text NOT NULL UNIQUE,
    avatar_url text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.teams (
    redpash_id text PRIMARY KEY REFERENCES public.entities(id) ON DELETE CASCADE,
    company_id text NOT NULL REFERENCES public.companies(redpash_id) ON DELETE CASCADE,
    name text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

-- The membership edge: SUBJECT (member) and OBJECT are BOTH entities, so a
-- grant's holder can be a user OR a team. The key spans (object, member, role,
-- context_role) so one principal holds as many roles as the org gives them.
CREATE TABLE public.memberships (
    object_redpash_id text NOT NULL REFERENCES public.entities(id) ON DELETE CASCADE,
    member_redpash_id text NOT NULL REFERENCES public.entities(id) ON DELETE CASCADE,  -- ⟵ CHANGED: was user_redpash_id → users; now any entity (user|team)
    role text DEFAULT 'viewer'::text NOT NULL CHECK (role IN ('owner', 'admin', 'member', 'viewer')),
    context_role text DEFAULT ''::text NOT NULL, -- ⟵ CHANGED: NOT NULL DEFAULT '' (it sits in the PK). Free-text label; never overrides role.
    joined_at timestamp with time zone DEFAULT now() NOT NULL,
    PRIMARY KEY (object_redpash_id, member_redpash_id, role, context_role)  -- ⟵ CHANGED: was (object_redpash_id, user_redpash_id)
);
CREATE INDEX memberships_member_idx ON public.memberships (member_redpash_id, object_redpash_id);  -- ⟵ CHANGED: renamed from memberships_user_idx

-- ============================================================================
-- 4. PROJECTS & DATA PIPELINE
-- ============================================================================
CREATE TABLE public.projects (
    redpash_id text PRIMARY KEY REFERENCES public.entities(id) ON DELETE CASCADE,
    company_id text REFERENCES public.companies(redpash_id) ON DELETE SET NULL,
    name text NOT NULL,
    description text,
    status text DEFAULT 'draft'::text NOT NULL CHECK (status IN ('draft', 'active', 'archived')),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);
-- Wire up User's Default Project
ALTER TABLE public.users ADD CONSTRAINT users_default_project_id_fkey FOREIGN KEY (default_project_id) REFERENCES public.projects(redpash_id) ON DELETE SET NULL;

CREATE TABLE public.project_files (
    redpash_id text PRIMARY KEY,
    project_redpash_id text NOT NULL REFERENCES public.projects(redpash_id) ON DELETE CASCADE,
    filename text NOT NULL,
    display_name text,
    file_type text DEFAULT 'csv'::text NOT NULL,
    row_count bigint,
    col_count integer,
    file_size_bytes bigint,
    cleanness_pct real,
    encoding text,
    delimiter text DEFAULT ','::text,
    storage_path text NOT NULL,
    columns_meta jsonb DEFAULT '[]'::jsonb NOT NULL,
    spec jsonb DEFAULT '{}'::jsonb NOT NULL,
    source_file_id text REFERENCES public.project_files(redpash_id) ON DELETE CASCADE,
    is_public boolean DEFAULT false NOT NULL,
    is_favorite boolean DEFAULT false NOT NULL,
    folder text,
    description text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.project_steps (
    redpash_id text PRIMARY KEY,
    file_redpash_id text NOT NULL REFERENCES public.project_files(redpash_id) ON DELETE CASCADE,
    ordinal integer NOT NULL,
    kind text NOT NULL,
    params jsonb DEFAULT '{}'::jsonb NOT NULL,
    applied boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX project_steps_file_idx ON public.project_steps (file_redpash_id, ordinal);

-- Apply Triggers
CREATE TRIGGER trigger_bump_file_mtime AFTER INSERT OR DELETE OR UPDATE ON public.project_steps FOR EACH ROW EXECUTE FUNCTION public.bump_file_mtime_from_step();
CREATE TRIGGER trigger_bump_project_mtime AFTER INSERT OR DELETE OR UPDATE ON public.project_files FOR EACH ROW EXECUTE FUNCTION public.bump_project_mtime_from_file();

-- ============================================================================
-- 5. CASES & TICKETING
-- ============================================================================
CREATE TABLE public.case_categories (
    redpash_id text PRIMARY KEY,
    parent_id text REFERENCES public.case_categories(redpash_id) ON DELETE CASCADE,
    name text NOT NULL,
    company_id text REFERENCES public.companies(redpash_id) ON DELETE CASCADE,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX case_categories_root_idx ON public.case_categories (name, company_id) WHERE parent_id IS NULL;
CREATE UNIQUE INDEX case_categories_child_idx ON public.case_categories (parent_id, name, company_id) WHERE parent_id IS NOT NULL;

CREATE TABLE public.cases (
    redpash_id text PRIMARY KEY REFERENCES public.entities(id) ON DELETE CASCADE,
    type text DEFAULT 'task'::text NOT NULL CHECK (type IN ('bug', 'feature', 'task', 'epic')),
    title text NOT NULL,
    description text,
    status text DEFAULT 'backlog'::text NOT NULL CHECK (status IN ('backlog', 'todo', 'in_progress', 'in_review', 'done')),
    priority text DEFAULT 'medium'::text NOT NULL CHECK (priority IN ('low', 'medium', 'high', 'critical')),
    project_id text REFERENCES public.projects(redpash_id) ON DELETE SET NULL,
    company_id text REFERENCES public.companies(redpash_id) ON DELETE SET NULL,
    category_id text REFERENCES public.case_categories(redpash_id) ON DELETE SET NULL,
    error_message text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);
-- NOTE: cases has no reporter_id/assignee_id columns — case people are
-- memberships(object=case, member=user, role, context_role). With the
-- symmetric edge above, a user can now hold BOTH 'Reporter' and 'Case Owner'
-- on the same case (distinct context_role rows) — the original bug is fixed.

CREATE TABLE public.comments (
    redpash_id text PRIMARY KEY,
    case_id text NOT NULL REFERENCES public.cases(redpash_id) ON DELETE CASCADE,
    author_id text REFERENCES public.users(redpash_id) ON DELETE SET NULL,  -- user-specific: stays → users (correct). Scrub-Retain keeps the row, so this renders "Deleted User" rather than firing SET NULL.
    body text NOT NULL,
    is_edited boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

-- ============================================================================
-- 6. AUDIT & METRICS
-- ============================================================================
CREATE TABLE audit.run (
    id bigserial PRIMARY KEY,
    tool text NOT NULL CHECK (tool IN ('css', 'html', 'parallel', 'tab-compare', 'cross-page', 'ui-snapshot')),
    ran_at timestamp with time zone DEFAULT now() NOT NULL,
    git_sha text,
    git_branch text,
    stats jsonb NOT NULL,
    payload jsonb NOT NULL,
    UNIQUE (tool, git_sha, ran_at)
);

CREATE TABLE audit.finding (
    run_id bigint NOT NULL REFERENCES audit.run(id) ON DELETE CASCADE,
    tool text NOT NULL,
    kind text NOT NULL,
    finding_key text NOT NULL,
    severity integer,
    detail jsonb NOT NULL,
    PRIMARY KEY (run_id, finding_key)
);

CREATE TABLE public.optimization_points (
    id bigserial PRIMARY KEY,
    subsystem text NOT NULL,
    phase text NOT NULL,
    current_cost text NOT NULL,
    horizon text NOT NULL,
    status text DEFAULT 'open'::text NOT NULL CHECK (status IN ('open', 'planned', 'done', 'wontfix')),
    measurement_kind text,
    measurement_key text,
    threshold_value double precision,
    threshold_unit text,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    UNIQUE (subsystem, phase)
);

CREATE TABLE public.sentinel_submissions (
    canonical text NOT NULL,
    user_id text NOT NULL REFERENCES public.users(redpash_id) ON DELETE CASCADE,  -- user-specific: stays → users (correct)
    submitted_at timestamp with time zone DEFAULT now() NOT NULL,
    PRIMARY KEY (canonical, user_id)
);

CREATE VIEW public.global_sentinels AS
 SELECT canonical FROM public.sentinel_submissions GROUP BY canonical HAVING count(DISTINCT user_id) >= 2;

-- ============================================================================
-- 7. OBSERVABILITY (PARTITIONED)
-- ============================================================================
CREATE TABLE public.events (
    redpash_id text NOT NULL,
    occurred_at timestamp with time zone DEFAULT now() NOT NULL,
    origin text DEFAULT 'backend'::text NOT NULL CHECK (origin IN ('backend', 'frontend')),
    level text DEFAULT 'info'::text NOT NULL CHECK (level IN ('debug', 'info', 'warn', 'error')),
    kind text NOT NULL,
    message text NOT NULL,
    source text,
    user_redpash_id text REFERENCES public.users(redpash_id) ON DELETE SET NULL,  -- user-specific: stays → users (correct)
    session_id text,
    request_id text,
    http_method text,
    http_path text,
    http_status integer,
    duration_ms integer,
    context jsonb DEFAULT '{}'::jsonb NOT NULL,
    PRIMARY KEY (redpash_id, occurred_at)
) PARTITION BY RANGE (occurred_at);
CREATE INDEX events_occurred_idx ON public.events (occurred_at DESC);

CREATE TABLE public.request_log (
    id bigserial NOT NULL,
    at timestamp with time zone DEFAULT now() NOT NULL,
    method text NOT NULL,
    route text NOT NULL,
    status smallint NOT NULL,
    duration_ms integer NOT NULL,
    request_id text,
    user_redpash_id text,
    session_id text,
    PRIMARY KEY (id, at)
) PARTITION BY RANGE (at);
CREATE INDEX request_log_at_idx ON public.request_log (at DESC);

CREATE TABLE public.db_query_log (
    id bigserial NOT NULL,
    at timestamp with time zone DEFAULT now() NOT NULL,
    query_template text NOT NULL,
    duration_ms integer NOT NULL,
    rows bigint,
    status smallint DEFAULT 0 NOT NULL,
    error_kind text,
    request_id text,
    user_redpash_id text,
    route text,
    PRIMARY KEY (id, at)
) PARTITION BY RANGE (at);
CREATE INDEX db_query_log_at_idx ON public.db_query_log (at DESC);

-- Setup Default Partitions so it works locally immediately
CREATE TABLE events_default PARTITION OF public.events DEFAULT;
CREATE TABLE request_log_default PARTITION OF public.request_log DEFAULT;
CREATE TABLE db_query_log_default PARTITION OF public.db_query_log DEFAULT;

-- ============================================================================
-- 8. TEAM KINDS & DEPARTMENT CONSTRAINT  (Option B — department ⊂ team)
--    Em 2026-05-31: a department is a KIND of team. One department per user
--    per company; a user may still sit on many ad-hoc teams.
--    Enforced by trigger, NOT a unique index — the widened key must keep
--    allowing MULTIPLE roles on a user's OWN department, which a unique index
--    on (member, company) would forbid. The advisory lock closes the
--    count→raise TOCTOU race (proven: without it, two concurrent joins to
--    different departments both commit). Validated live 2026-05-31.
-- ============================================================================
ALTER TABLE public.teams
    ADD COLUMN kind text NOT NULL DEFAULT 'team' CHECK (kind IN ('team', 'department'));

CREATE FUNCTION public.enforce_one_department_per_user() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
    target_team_kind    text;
    target_company_id   text;
    existing_dept_count integer;
BEGIN
    -- No rid-prefix guard: a non-team object yields NULL kind here and
    -- self-skips the department branch (the teams PK lookup is negligible).
    SELECT kind, company_id INTO target_team_kind, target_company_id
      FROM public.teams WHERE redpash_id = NEW.object_redpash_id;

    IF target_team_kind = 'department' THEN
        -- Serialize concurrent department-joins for this (member, company) so
        -- the count-then-raise below is race-safe — re-buys the atomicity a
        -- unique index would have given (which we can't use; see header).
        PERFORM pg_advisory_xact_lock(
            hashtextextended(NEW.member_redpash_id || '|' || target_company_id, 0));

        SELECT count(*) INTO existing_dept_count
          FROM public.memberships m
          JOIN public.teams t ON m.object_redpash_id = t.redpash_id
         WHERE m.member_redpash_id = NEW.member_redpash_id
           AND t.company_id        = target_company_id
           AND t.kind              = 'department'
           AND m.object_redpash_id <> NEW.object_redpash_id;  -- rows on the SAME dept don't count → multi-role on own dept stays allowed

        IF existing_dept_count > 0 THEN
            RAISE EXCEPTION
              'User % is already a member of a department in company %. A user can belong to only one department per company.',
              NEW.member_redpash_id, target_company_id;
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER trigger_one_department_per_user
    BEFORE INSERT OR UPDATE ON public.memberships
    FOR EACH ROW EXECUTE FUNCTION public.enforce_one_department_per_user();

COMMIT;

-- ============================================================================
-- FOLLOW-UP (not yet enforced) — teams.kind promotion.
-- The trigger fires only on `memberships` writes, so flipping an existing
-- ad-hoc team to kind='department' can retroactively land a user in two
-- departments with no membership write to catch it. Guard `UPDATE OF kind ON
-- teams` (or check existing members at promotion time) when the team-admin UI
-- lands. Low severity — kind changes are rare/admin-only.
-- ============================================================================
