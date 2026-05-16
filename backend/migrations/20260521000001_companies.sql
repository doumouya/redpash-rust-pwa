-- ──────────── 007 companies — phase 5 multi-tenancy ────────────
-- Ports the Django app's company / membership layer. A company is the
-- top-level tenancy boundary: a user belongs to zero or more companies,
-- and a project is either company-scoped or personal (company_id NULL).
--
-- Membership tables are pure join tables — no redpash_id, composite PK
-- on (parent, user). They're never addressed in a URL, so they don't
-- need a typed id.

CREATE TABLE IF NOT EXISTS companies (
    redpash_id   TEXT        PRIMARY KEY,
    name         TEXT        NOT NULL,
    slug         TEXT        NOT NULL UNIQUE,
    avatar_url   TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- A user holds exactly one role per company.
CREATE TABLE IF NOT EXISTS company_memberships (
    company_id      TEXT        NOT NULL REFERENCES companies(redpash_id) ON DELETE CASCADE,
    user_redpash_id TEXT        NOT NULL REFERENCES users(redpash_id)     ON DELETE CASCADE,
    role            TEXT        NOT NULL DEFAULT 'member'
                    CHECK (role IN ('owner', 'admin', 'member')),
    joined_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (company_id, user_redpash_id)
);
CREATE INDEX IF NOT EXISTS company_memberships_user_idx
    ON company_memberships(user_redpash_id);

-- Grants a user access to a project. The project owner (projects.owner_id)
-- needs no membership row — ownership is tracked directly on projects.
CREATE TABLE IF NOT EXISTS project_memberships (
    project_redpash_id TEXT        NOT NULL REFERENCES projects(redpash_id) ON DELETE CASCADE,
    user_redpash_id    TEXT        NOT NULL REFERENCES users(redpash_id)    ON DELETE CASCADE,
    role               TEXT        NOT NULL DEFAULT 'viewer'
                       CHECK (role IN ('owner', 'collaborator', 'viewer')),
    joined_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (project_redpash_id, user_redpash_id)
);
CREATE INDEX IF NOT EXISTS project_memberships_user_idx
    ON project_memberships(user_redpash_id);

-- A project is company-scoped or personal. SET NULL on company delete
-- so the project survives as a personal project rather than cascading.
ALTER TABLE projects
    ADD COLUMN IF NOT EXISTS company_id TEXT
    REFERENCES companies(redpash_id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS projects_company_idx ON projects(company_id);
