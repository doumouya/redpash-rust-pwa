--
-- PostgreSQL database dump
--

\restrict 8nLNaTr2snURLWYUcFSjbMmspECfMuffguC41tGnhDAd7nVYXKEqgf8RtqyXfdH

-- Dumped from database version 18.4 (Ubuntu 18.4-0ubuntu0.26.04.1)
-- Dumped by pg_dump version 18.4 (Ubuntu 18.4-0ubuntu0.26.04.1)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: audit; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA audit;


--
-- Name: run_diff(bigint, bigint); Type: FUNCTION; Schema: audit; Owner: -
--

CREATE FUNCTION audit.run_diff(cur_id bigint, prev_id bigint) RETURNS TABLE(status text, kind text, finding_key text, severity_cur integer, severity_prev integer)
    LANGUAGE sql STABLE
    AS $$
    WITH
      cur  AS (SELECT kind, finding_key, severity FROM audit.finding WHERE run_id = cur_id),
      prev AS (SELECT kind, finding_key, severity FROM audit.finding WHERE run_id = prev_id)
    SELECT 'new'::TEXT,
           c.kind, c.finding_key, c.severity, NULL::INTEGER
      FROM cur c
      LEFT JOIN prev p USING (kind, finding_key)
     WHERE p.finding_key IS NULL
    UNION ALL
    SELECT 'fixed'::TEXT,
           p.kind, p.finding_key, NULL::INTEGER, p.severity
      FROM prev p
      LEFT JOIN cur c USING (kind, finding_key)
     WHERE c.finding_key IS NULL
    UNION ALL
    SELECT CASE
             WHEN c.severity IS DISTINCT FROM p.severity
                  AND c.severity > p.severity THEN 'regressed'
             WHEN c.severity IS DISTINCT FROM p.severity
                  AND c.severity < p.severity THEN 'improved'
             ELSE 'unchanged'
           END,
           c.kind, c.finding_key, c.severity, p.severity
      FROM cur c
      JOIN prev p USING (kind, finding_key);
$$;


--
-- Name: bump_file_mtime_from_step(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.bump_file_mtime_from_step() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
    fid TEXT;
BEGIN
    IF TG_OP = 'DELETE' THEN
        fid := OLD.file_redpash_id;
    ELSE
        fid := NEW.file_redpash_id;
    END IF;
    IF fid IS NOT NULL THEN
        UPDATE project_files SET updated_at = now() WHERE redpash_id = fid;
    END IF;
    RETURN NULL;
END;
$$;


--
-- Name: bump_project_mtime_from_file(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.bump_project_mtime_from_file() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
    pid TEXT;
BEGIN
    IF TG_OP = 'DELETE' THEN
        pid := OLD.project_redpash_id;
    ELSE
        pid := NEW.project_redpash_id;
    END IF;
    IF pid IS NOT NULL THEN
        UPDATE projects SET updated_at = now() WHERE redpash_id = pid;
    END IF;
    RETURN NULL;
END;
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: finding; Type: TABLE; Schema: audit; Owner: -
--

CREATE TABLE audit.finding (
    run_id bigint NOT NULL,
    tool text NOT NULL,
    kind text NOT NULL,
    finding_key text NOT NULL,
    severity integer,
    detail jsonb NOT NULL
);


--
-- Name: run; Type: TABLE; Schema: audit; Owner: -
--

CREATE TABLE audit.run (
    id bigint NOT NULL,
    tool text NOT NULL,
    ran_at timestamp with time zone DEFAULT now() NOT NULL,
    git_sha text,
    git_branch text,
    stats jsonb NOT NULL,
    payload jsonb NOT NULL,
    CONSTRAINT audit_run_tool_check CHECK ((tool = ANY (ARRAY['css'::text, 'html'::text, 'parallel'::text, 'tab-compare'::text, 'cross-page'::text, 'ui-snapshot'::text])))
);


--
-- Name: run_id_seq; Type: SEQUENCE; Schema: audit; Owner: -
--

CREATE SEQUENCE audit.run_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: run_id_seq; Type: SEQUENCE OWNED BY; Schema: audit; Owner: -
--

ALTER SEQUENCE audit.run_id_seq OWNED BY audit.run.id;


--
-- Name: _sqlx_migrations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public._sqlx_migrations (
    version bigint NOT NULL,
    description text NOT NULL,
    installed_on timestamp with time zone DEFAULT now() NOT NULL,
    success boolean NOT NULL,
    checksum bytea NOT NULL,
    execution_time bigint NOT NULL
);


--
-- Name: case_categories; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.case_categories (
    redpash_id text NOT NULL,
    parent_id text,
    name text NOT NULL,
    company_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: cases; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cases (
    redpash_id text NOT NULL,
    type text DEFAULT 'task'::text NOT NULL,
    title text NOT NULL,
    description text,
    status text DEFAULT 'backlog'::text NOT NULL,
    priority text DEFAULT 'medium'::text NOT NULL,
    project_id text,
    company_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    error_message text,
    category_id text,
    CONSTRAINT cases_priority_check CHECK ((priority = ANY (ARRAY['low'::text, 'medium'::text, 'high'::text, 'critical'::text]))),
    CONSTRAINT cases_status_check CHECK ((status = ANY (ARRAY['backlog'::text, 'todo'::text, 'in_progress'::text, 'in_review'::text, 'done'::text]))),
    CONSTRAINT cases_type_check CHECK ((type = ANY (ARRAY['bug'::text, 'feature'::text, 'task'::text, 'epic'::text])))
);


--
-- Name: comments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.comments (
    redpash_id text NOT NULL,
    case_id text NOT NULL,
    author_id text,
    body text NOT NULL,
    is_edited boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: companies; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.companies (
    redpash_id text NOT NULL,
    name text NOT NULL,
    slug text NOT NULL,
    avatar_url text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: db_query_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.db_query_log (
    id bigint NOT NULL,
    at timestamp with time zone DEFAULT now() NOT NULL,
    query_template text NOT NULL,
    duration_ms integer NOT NULL,
    rows bigint,
    status smallint DEFAULT 0 NOT NULL,
    error_kind text,
    request_id text,
    user_redpash_id text,
    route text
);


--
-- Name: db_query_log_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.db_query_log_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: db_query_log_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.db_query_log_id_seq OWNED BY public.db_query_log.id;


--
-- Name: entities; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.entities (
    id text NOT NULL,
    type text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT entities_type_check CHECK ((type = ANY (ARRAY['company'::text, 'project'::text, 'case'::text])))
);


--
-- Name: events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.events (
    redpash_id text NOT NULL,
    occurred_at timestamp with time zone DEFAULT now() NOT NULL,
    origin text DEFAULT 'backend'::text NOT NULL,
    level text DEFAULT 'info'::text NOT NULL,
    kind text NOT NULL,
    message text NOT NULL,
    source text,
    user_redpash_id text,
    session_id text,
    request_id text,
    http_method text,
    http_path text,
    http_status integer,
    duration_ms integer,
    context jsonb DEFAULT '{}'::jsonb NOT NULL,
    CONSTRAINT events_level_check CHECK ((level = ANY (ARRAY['debug'::text, 'info'::text, 'warn'::text, 'error'::text]))),
    CONSTRAINT events_origin_check CHECK ((origin = ANY (ARRAY['backend'::text, 'frontend'::text])))
);


--
-- Name: project_files; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.project_files (
    redpash_id text NOT NULL,
    project_redpash_id text NOT NULL,
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
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    spec jsonb DEFAULT '{}'::jsonb NOT NULL,
    source_file_id text,
    is_public boolean DEFAULT false NOT NULL,
    is_favorite boolean DEFAULT false NOT NULL,
    folder text,
    description text
);


--
-- Name: project_steps; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.project_steps (
    redpash_id text NOT NULL,
    file_redpash_id text NOT NULL,
    ordinal integer NOT NULL,
    kind text NOT NULL,
    params jsonb DEFAULT '{}'::jsonb NOT NULL,
    applied boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: file_stages; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.file_stages AS
 SELECT pf.redpash_id AS file_redpash_id,
    pf.project_redpash_id,
    s.stage,
        CASE s.stage
            WHEN 'publish'::text THEN 3
            WHEN 'design'::text THEN 2
            WHEN 'clean'::text THEN 1
            ELSE 0
        END AS stage_rank
   FROM (public.project_files pf
     CROSS JOIN LATERAL ( SELECT
                CASE
                    WHEN (EXISTS ( SELECT 1
                       FROM ((public.project_files c
                         JOIN public.project_files d ON (((d.file_type = 'dashboard'::text) AND d.is_public AND (jsonb_typeof((d.spec -> 'widgets'::text)) = 'array'::text))))
                         CROSS JOIN LATERAL jsonb_array_elements((d.spec -> 'widgets'::text)) w(value))
                      WHERE ((c.file_type = 'chart'::text) AND (c.source_file_id = pf.redpash_id) AND (((w.value -> 'spec'::text) ->> 'chart_id'::text) = c.redpash_id)))) THEN 'publish'::text
                    WHEN (EXISTS ( SELECT 1
                       FROM public.project_files c
                      WHERE ((c.file_type = 'chart'::text) AND (c.source_file_id = pf.redpash_id)))) THEN 'design'::text
                    WHEN (EXISTS ( SELECT 1
                       FROM public.project_steps st
                      WHERE (st.file_redpash_id = pf.redpash_id))) THEN 'clean'::text
                    ELSE 'new'::text
                END AS stage) s);


--
-- Name: sentinel_submissions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sentinel_submissions (
    canonical text NOT NULL,
    user_id text NOT NULL,
    submitted_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: global_sentinels; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.global_sentinels AS
 SELECT canonical
   FROM public.sentinel_submissions
  GROUP BY canonical
 HAVING (count(DISTINCT user_id) >= 2);


--
-- Name: memberships; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.memberships (
    object_redpash_id text NOT NULL,
    user_redpash_id text NOT NULL,
    role text DEFAULT 'member'::text NOT NULL,
    display_name text,
    relationship_attribute text,
    joined_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT memberships_role_check CHECK ((role = ANY (ARRAY['owner'::text, 'admin'::text, 'member'::text, 'viewer'::text])))
);


--
-- Name: optimization_points; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.optimization_points (
    id bigint NOT NULL,
    subsystem text NOT NULL,
    phase text NOT NULL,
    current_cost text NOT NULL,
    horizon text NOT NULL,
    status text DEFAULT 'open'::text NOT NULL,
    measurement_kind text,
    measurement_key text,
    threshold_value double precision,
    threshold_unit text,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT optimization_points_status_check CHECK ((status = ANY (ARRAY['open'::text, 'planned'::text, 'done'::text, 'wontfix'::text])))
);


--
-- Name: optimization_points_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.optimization_points_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: optimization_points_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.optimization_points_id_seq OWNED BY public.optimization_points.id;


--
-- Name: projects; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.projects (
    redpash_id text NOT NULL,
    name text NOT NULL,
    description text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    company_id text,
    status text DEFAULT 'draft'::text NOT NULL,
    CONSTRAINT projects_status_check CHECK ((status = ANY (ARRAY['draft'::text, 'active'::text, 'archived'::text])))
);


--
-- Name: request_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.request_log (
    id bigint NOT NULL,
    at timestamp with time zone DEFAULT now() NOT NULL,
    method text NOT NULL,
    route text NOT NULL,
    status smallint NOT NULL,
    duration_ms integer NOT NULL,
    request_id text,
    user_redpash_id text,
    session_id text
);


--
-- Name: request_log_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.request_log_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: request_log_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.request_log_id_seq OWNED BY public.request_log.id;


--
-- Name: sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sessions (
    redpash_id text NOT NULL,
    user_redpash_id text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: user_preferences; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_preferences (
    user_redpash_id text NOT NULL,
    key text NOT NULL,
    value jsonb NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.users (
    redpash_id text NOT NULL,
    username text NOT NULL,
    email text,
    display_name text NOT NULL,
    avatar_url text,
    job_title text,
    organisation text,
    use_case text,
    plan text DEFAULT 'free'::text NOT NULL,
    locale text DEFAULT 'en'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    google_sub text,
    first_name text,
    last_name text,
    default_project_id text
);


--
-- Name: run id; Type: DEFAULT; Schema: audit; Owner: -
--

ALTER TABLE ONLY audit.run ALTER COLUMN id SET DEFAULT nextval('audit.run_id_seq'::regclass);


--
-- Name: db_query_log id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.db_query_log ALTER COLUMN id SET DEFAULT nextval('public.db_query_log_id_seq'::regclass);


--
-- Name: optimization_points id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.optimization_points ALTER COLUMN id SET DEFAULT nextval('public.optimization_points_id_seq'::regclass);


--
-- Name: request_log id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.request_log ALTER COLUMN id SET DEFAULT nextval('public.request_log_id_seq'::regclass);


--
-- Name: finding finding_pkey; Type: CONSTRAINT; Schema: audit; Owner: -
--

ALTER TABLE ONLY audit.finding
    ADD CONSTRAINT finding_pkey PRIMARY KEY (run_id, finding_key);


--
-- Name: run run_pkey; Type: CONSTRAINT; Schema: audit; Owner: -
--

ALTER TABLE ONLY audit.run
    ADD CONSTRAINT run_pkey PRIMARY KEY (id);


--
-- Name: run run_tool_git_sha_ran_at_key; Type: CONSTRAINT; Schema: audit; Owner: -
--

ALTER TABLE ONLY audit.run
    ADD CONSTRAINT run_tool_git_sha_ran_at_key UNIQUE (tool, git_sha, ran_at);


--
-- Name: _sqlx_migrations _sqlx_migrations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public._sqlx_migrations
    ADD CONSTRAINT _sqlx_migrations_pkey PRIMARY KEY (version);


--
-- Name: case_categories case_categories_parent_id_name_company_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.case_categories
    ADD CONSTRAINT case_categories_parent_id_name_company_id_key UNIQUE (parent_id, name, company_id);


--
-- Name: case_categories case_categories_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.case_categories
    ADD CONSTRAINT case_categories_pkey PRIMARY KEY (redpash_id);


--
-- Name: cases cases_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cases
    ADD CONSTRAINT cases_pkey PRIMARY KEY (redpash_id);


--
-- Name: comments comments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.comments
    ADD CONSTRAINT comments_pkey PRIMARY KEY (redpash_id);


--
-- Name: companies companies_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.companies
    ADD CONSTRAINT companies_pkey PRIMARY KEY (redpash_id);


--
-- Name: companies companies_slug_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.companies
    ADD CONSTRAINT companies_slug_key UNIQUE (slug);


--
-- Name: db_query_log db_query_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.db_query_log
    ADD CONSTRAINT db_query_log_pkey PRIMARY KEY (id);


--
-- Name: entities entities_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entities
    ADD CONSTRAINT entities_pkey PRIMARY KEY (id);


--
-- Name: events events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.events
    ADD CONSTRAINT events_pkey PRIMARY KEY (redpash_id);


--
-- Name: memberships memberships_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memberships
    ADD CONSTRAINT memberships_pkey PRIMARY KEY (object_redpash_id, user_redpash_id);


--
-- Name: optimization_points optimization_points_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.optimization_points
    ADD CONSTRAINT optimization_points_pkey PRIMARY KEY (id);


--
-- Name: optimization_points optimization_points_subsystem_phase_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.optimization_points
    ADD CONSTRAINT optimization_points_subsystem_phase_key UNIQUE (subsystem, phase);


--
-- Name: project_files project_files_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_files
    ADD CONSTRAINT project_files_pkey PRIMARY KEY (redpash_id);


--
-- Name: project_steps project_steps_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_steps
    ADD CONSTRAINT project_steps_pkey PRIMARY KEY (redpash_id);


--
-- Name: projects projects_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.projects
    ADD CONSTRAINT projects_pkey PRIMARY KEY (redpash_id);


--
-- Name: request_log request_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.request_log
    ADD CONSTRAINT request_log_pkey PRIMARY KEY (id);


--
-- Name: sentinel_submissions sentinel_submissions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sentinel_submissions
    ADD CONSTRAINT sentinel_submissions_pkey PRIMARY KEY (canonical, user_id);


--
-- Name: sessions sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_pkey PRIMARY KEY (redpash_id);


--
-- Name: user_preferences user_preferences_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_preferences
    ADD CONSTRAINT user_preferences_pkey PRIMARY KEY (user_redpash_id, key);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (redpash_id);


--
-- Name: users users_username_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_username_key UNIQUE (username);


--
-- Name: audit_finding_key_idx; Type: INDEX; Schema: audit; Owner: -
--

CREATE INDEX audit_finding_key_idx ON audit.finding USING btree (tool, kind, finding_key);


--
-- Name: audit_run_tool_time_idx; Type: INDEX; Schema: audit; Owner: -
--

CREATE INDEX audit_run_tool_time_idx ON audit.run USING btree (tool, ran_at DESC);


--
-- Name: case_categories_company_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX case_categories_company_idx ON public.case_categories USING btree (company_id) WHERE (company_id IS NOT NULL);


--
-- Name: case_categories_parent_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX case_categories_parent_idx ON public.case_categories USING btree (parent_id);


--
-- Name: cases_category_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX cases_category_idx ON public.cases USING btree (category_id) WHERE (category_id IS NOT NULL);


--
-- Name: cases_project_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX cases_project_idx ON public.cases USING btree (project_id, updated_at DESC) WHERE (project_id IS NOT NULL);


--
-- Name: cases_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX cases_status_idx ON public.cases USING btree (status, updated_at DESC);


--
-- Name: comments_case_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX comments_case_idx ON public.comments USING btree (case_id, created_at);


--
-- Name: db_query_log_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX db_query_log_at_idx ON public.db_query_log USING btree (at DESC);


--
-- Name: db_query_log_request_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX db_query_log_request_idx ON public.db_query_log USING btree (request_id) WHERE (request_id IS NOT NULL);


--
-- Name: db_query_log_template_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX db_query_log_template_idx ON public.db_query_log USING btree (query_template, at DESC);


--
-- Name: events_kind_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX events_kind_idx ON public.events USING btree (kind, occurred_at DESC);


--
-- Name: events_level_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX events_level_idx ON public.events USING btree (level, occurred_at DESC);


--
-- Name: events_occurred_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX events_occurred_idx ON public.events USING btree (occurred_at DESC);


--
-- Name: events_request_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX events_request_idx ON public.events USING btree (request_id);


--
-- Name: events_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX events_user_idx ON public.events USING btree (user_redpash_id, occurred_at DESC);


--
-- Name: memberships_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX memberships_user_idx ON public.memberships USING btree (user_redpash_id, object_redpash_id);


--
-- Name: optimization_points_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX optimization_points_status_idx ON public.optimization_points USING btree (status);


--
-- Name: optimization_points_subsystem_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX optimization_points_subsystem_idx ON public.optimization_points USING btree (subsystem);


--
-- Name: project_files_proj_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX project_files_proj_idx ON public.project_files USING btree (project_redpash_id);


--
-- Name: project_files_source_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX project_files_source_idx ON public.project_files USING btree (source_file_id);


--
-- Name: project_files_type_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX project_files_type_idx ON public.project_files USING btree (file_type);


--
-- Name: project_steps_file_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX project_steps_file_idx ON public.project_steps USING btree (file_redpash_id, ordinal);


--
-- Name: projects_company_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX projects_company_idx ON public.projects USING btree (company_id);


--
-- Name: projects_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX projects_status_idx ON public.projects USING btree (status);


--
-- Name: request_log_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX request_log_at_idx ON public.request_log USING btree (at DESC);


--
-- Name: request_log_route_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX request_log_route_idx ON public.request_log USING btree (route, at DESC);


--
-- Name: request_log_session_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX request_log_session_idx ON public.request_log USING btree (session_id, at DESC) WHERE (session_id IS NOT NULL);


--
-- Name: request_log_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX request_log_user_idx ON public.request_log USING btree (user_redpash_id, at DESC) WHERE (user_redpash_id IS NOT NULL);


--
-- Name: sessions_expiry_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sessions_expiry_idx ON public.sessions USING btree (expires_at);


--
-- Name: sessions_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sessions_user_idx ON public.sessions USING btree (user_redpash_id);


--
-- Name: user_preferences_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX user_preferences_user_idx ON public.user_preferences USING btree (user_redpash_id);


--
-- Name: users_google_sub_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX users_google_sub_idx ON public.users USING btree (google_sub) WHERE (google_sub IS NOT NULL);


--
-- Name: project_files project_files_bump_project; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER project_files_bump_project AFTER INSERT OR DELETE OR UPDATE ON public.project_files FOR EACH ROW EXECUTE FUNCTION public.bump_project_mtime_from_file();


--
-- Name: project_steps project_steps_bump_file; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER project_steps_bump_file AFTER INSERT OR DELETE OR UPDATE ON public.project_steps FOR EACH ROW EXECUTE FUNCTION public.bump_file_mtime_from_step();


--
-- Name: finding finding_run_id_fkey; Type: FK CONSTRAINT; Schema: audit; Owner: -
--

ALTER TABLE ONLY audit.finding
    ADD CONSTRAINT finding_run_id_fkey FOREIGN KEY (run_id) REFERENCES audit.run(id) ON DELETE CASCADE;


--
-- Name: case_categories case_categories_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.case_categories
    ADD CONSTRAINT case_categories_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(redpash_id) ON DELETE CASCADE;


--
-- Name: case_categories case_categories_parent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.case_categories
    ADD CONSTRAINT case_categories_parent_id_fkey FOREIGN KEY (parent_id) REFERENCES public.case_categories(redpash_id) ON DELETE CASCADE;


--
-- Name: cases cases_category_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cases
    ADD CONSTRAINT cases_category_id_fkey FOREIGN KEY (category_id) REFERENCES public.case_categories(redpash_id) ON DELETE SET NULL;


--
-- Name: cases cases_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cases
    ADD CONSTRAINT cases_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(redpash_id) ON DELETE SET NULL;


--
-- Name: cases cases_entity_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cases
    ADD CONSTRAINT cases_entity_fk FOREIGN KEY (redpash_id) REFERENCES public.entities(id) ON DELETE CASCADE;


--
-- Name: cases cases_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cases
    ADD CONSTRAINT cases_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(redpash_id) ON DELETE SET NULL;


--
-- Name: comments comments_author_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.comments
    ADD CONSTRAINT comments_author_id_fkey FOREIGN KEY (author_id) REFERENCES public.users(redpash_id) ON DELETE SET NULL;


--
-- Name: comments comments_case_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.comments
    ADD CONSTRAINT comments_case_id_fkey FOREIGN KEY (case_id) REFERENCES public.cases(redpash_id) ON DELETE CASCADE;


--
-- Name: companies companies_entity_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.companies
    ADD CONSTRAINT companies_entity_fk FOREIGN KEY (redpash_id) REFERENCES public.entities(id) ON DELETE CASCADE;


--
-- Name: events events_user_redpash_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.events
    ADD CONSTRAINT events_user_redpash_id_fkey FOREIGN KEY (user_redpash_id) REFERENCES public.users(redpash_id) ON DELETE SET NULL;


--
-- Name: memberships memberships_object_redpash_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memberships
    ADD CONSTRAINT memberships_object_redpash_id_fkey FOREIGN KEY (object_redpash_id) REFERENCES public.entities(id) ON DELETE CASCADE;


--
-- Name: memberships memberships_user_redpash_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memberships
    ADD CONSTRAINT memberships_user_redpash_id_fkey FOREIGN KEY (user_redpash_id) REFERENCES public.users(redpash_id) ON DELETE CASCADE;


--
-- Name: project_files project_files_project_redpash_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_files
    ADD CONSTRAINT project_files_project_redpash_id_fkey FOREIGN KEY (project_redpash_id) REFERENCES public.projects(redpash_id) ON DELETE CASCADE;


--
-- Name: project_files project_files_source_file_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_files
    ADD CONSTRAINT project_files_source_file_id_fkey FOREIGN KEY (source_file_id) REFERENCES public.project_files(redpash_id) ON DELETE CASCADE;


--
-- Name: project_steps project_steps_file_redpash_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_steps
    ADD CONSTRAINT project_steps_file_redpash_id_fkey FOREIGN KEY (file_redpash_id) REFERENCES public.project_files(redpash_id) ON DELETE CASCADE;


--
-- Name: projects projects_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.projects
    ADD CONSTRAINT projects_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(redpash_id) ON DELETE SET NULL;


--
-- Name: projects projects_entity_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.projects
    ADD CONSTRAINT projects_entity_fk FOREIGN KEY (redpash_id) REFERENCES public.entities(id) ON DELETE CASCADE;


--
-- Name: sentinel_submissions sentinel_submissions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sentinel_submissions
    ADD CONSTRAINT sentinel_submissions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(redpash_id) ON DELETE CASCADE;


--
-- Name: sessions sessions_user_redpash_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_user_redpash_id_fkey FOREIGN KEY (user_redpash_id) REFERENCES public.users(redpash_id) ON DELETE CASCADE;


--
-- Name: user_preferences user_preferences_user_redpash_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_preferences
    ADD CONSTRAINT user_preferences_user_redpash_id_fkey FOREIGN KEY (user_redpash_id) REFERENCES public.users(redpash_id) ON DELETE CASCADE;


--
-- Name: users users_default_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_default_project_id_fkey FOREIGN KEY (default_project_id) REFERENCES public.projects(redpash_id) ON DELETE SET NULL;


--
-- PostgreSQL database dump complete
--

\unrestrict 8nLNaTr2snURLWYUcFSjbMmspECfMuffguC41tGnhDAd7nVYXKEqgf8RtqyXfdH

