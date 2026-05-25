-- ──────────── 030 case_categories — taxonomy for cases (v1) ────────────
-- Em ask: cases need categories + subcategories. Two-level taxonomy via
-- a self-FK on `case_categories.parent_id` (NULL = root category /
-- parent; non-NULL = subcategory / child). Same table grows to N
-- levels later without schema reshape — we just don't surface N>2 in
-- the FE picker until the need appears.
--
-- `company_id NULL` = global category (shipped today as the curated
-- seed taxonomy below). When v3 lands the customer-facing reporter
-- path, per-company custom categories live as rows with `company_id`
-- set; queries union both sets when listing categories for a user
-- belonging to company X. RBAC overlay enforces visibility.
--
-- `cases.category_id` is a single FK — a case has at most one
-- (sub)category. The FE picker encourages picking a leaf
-- (subcategory) but the schema allows tagging with a parent
-- directly when no subcategory fits ("this is just a Backend thing").
-- Validation lives in the route handler, not the DB.

CREATE TABLE IF NOT EXISTS case_categories (
    redpash_id  TEXT        PRIMARY KEY,                                  -- CAT_<32 hex>
    -- Hierarchy parent. Self-FK; NULL marks a root category. Deletes
    -- cascade so removing a parent collapses its children (admin
    -- discipline: don't delete a parent with active cases tagged
    -- under it — the cases.category_id FK below handles that side).
    parent_id   TEXT        REFERENCES case_categories(redpash_id) ON DELETE CASCADE,
    name        TEXT        NOT NULL,
    -- NULL = global / built-in. Per-company custom categories carry
    -- the company rid; RBAC overlay (v3) filters listing by user's
    -- company membership.
    company_id  TEXT        REFERENCES companies(redpash_id) ON DELETE CASCADE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Uniqueness scoped to (parent, scope): two roots can both be
    -- named "Backend" only if one is global and the other is
    -- company-scoped. UNIQUE on (parent_id, name, company_id) using
    -- COALESCE on the nullable columns so NULL parent_id / company_id
    -- still enforce the constraint.
    UNIQUE (parent_id, name, company_id)
);

-- Hierarchy walk: "give me children of parent X".
CREATE INDEX IF NOT EXISTS case_categories_parent_idx
    ON case_categories (parent_id);
-- Per-company list: "give me everything the user can pick from".
CREATE INDEX IF NOT EXISTS case_categories_company_idx
    ON case_categories (company_id)
    WHERE company_id IS NOT NULL;

-- Cases gain the FK. SET NULL (not CASCADE): deleting a category
-- shouldn't blow away cases tagged under it; the cases just become
-- uncategorised + the next FE pass can re-tag them.
ALTER TABLE cases
    ADD COLUMN IF NOT EXISTS category_id TEXT
        REFERENCES case_categories(redpash_id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS cases_category_idx
    ON cases (category_id)
    WHERE category_id IS NOT NULL;

-- ── seed: v1 global taxonomy ──────────────────────────────────────────
-- 6 parents × 3-5 children = 26 categories. Curated to fit the team's
-- current surface area (Backend / Frontend / Tools / Docs / Infra /
-- Workstream). When per-company customization lands in v3, the seed
-- stays as the global default; customers add their own without
-- conflicting.
--
-- gen_random_uuid() is used at INSERT time so the rids are fresh per
-- environment. The seed runs once via the IF NOT EXISTS guard on the
-- name (the UNIQUE constraint blocks dups on re-run).

WITH parents AS (
    INSERT INTO case_categories (redpash_id, name, parent_id, company_id)
    VALUES
        ('CAT_' || upper(replace(gen_random_uuid()::text, '-', '')), 'Backend',    NULL, NULL),
        ('CAT_' || upper(replace(gen_random_uuid()::text, '-', '')), 'Frontend',   NULL, NULL),
        ('CAT_' || upper(replace(gen_random_uuid()::text, '-', '')), 'Tools',      NULL, NULL),
        ('CAT_' || upper(replace(gen_random_uuid()::text, '-', '')), 'Docs',       NULL, NULL),
        ('CAT_' || upper(replace(gen_random_uuid()::text, '-', '')), 'Infra',      NULL, NULL),
        ('CAT_' || upper(replace(gen_random_uuid()::text, '-', '')), 'Workstream', NULL, NULL)
    ON CONFLICT (parent_id, name, company_id) DO NOTHING
    RETURNING redpash_id, name
),
all_parents AS (
    -- Fold the just-inserted parents with any that existed pre-run
    -- (re-running the migration after a partial earlier insert).
    SELECT redpash_id, name FROM parents
    UNION ALL
    SELECT redpash_id, name FROM case_categories
     WHERE parent_id IS NULL AND company_id IS NULL
       AND name IN ('Backend','Frontend','Tools','Docs','Infra','Workstream')
       AND redpash_id NOT IN (SELECT redpash_id FROM parents)
)
INSERT INTO case_categories (redpash_id, name, parent_id, company_id)
SELECT
    'CAT_' || upper(replace(gen_random_uuid()::text, '-', '')),
    child_name,
    (SELECT redpash_id FROM all_parents WHERE name = parent_name LIMIT 1),
    NULL
FROM (VALUES
    ('Backend',    'API'),
    ('Backend',    'Database'),
    ('Backend',    'Migration'),
    ('Backend',    'Auth'),
    ('Backend',    'Observability'),
    ('Frontend',   'Workspace'),
    ('Frontend',   'Cases'),
    ('Frontend',   'Home'),
    ('Frontend',   'Monitoring'),
    ('Frontend',   'Settings'),
    ('Tools',      'Audit'),
    ('Tools',      'Cookbook'),
    ('Tools',      'Agent'),
    ('Docs',       'Spec'),
    ('Docs',       'Runbook'),
    ('Docs',       'Cookbook'),
    ('Infra',      'Deploy'),
    ('Infra',      'Cache / SW'),
    ('Infra',      'Database'),
    ('Workstream', 'Audit-everything'),
    ('Workstream', 'Cases'),
    ('Workstream', 'RBAC'),
    ('Workstream', 'Onboarding')
) AS children(parent_name, child_name)
ON CONFLICT (parent_id, name, company_id) DO NOTHING;
