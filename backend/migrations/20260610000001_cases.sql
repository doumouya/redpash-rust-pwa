-- ──────────── 028 cases + comments — Jira-flow workstream v1 ────────────
-- The team-coordination + customer-ticket layer on top of the
-- audit-everything spine. Migrates `/Internal-Slack/*.md` coordination
-- to a queryable ticketing system; the same surface handles customer
-- ticket intake in v3 (RBAC visibility overlay).
--
-- v1 scope: cases + comments tables. Case lifecycle changes are NOT
-- persisted to a parallel history table — they emit `events.kind =
-- 'case_*'` rows via the existing event::record path (cat-3 audit-
-- trail discipline catches mutation handlers that skip the emit).
-- The case detail page's Activity tab is `SELECT * FROM events WHERE
-- context->>'case' = $1`.
--
-- v2 adds sprints + story_points (additive ALTER, no v1 reshape).
-- v3 adds reporter_email + is_public + visibility/RBAC overlays.
--
-- Spec: docs/internal/jira-flow-proposition/proposition.md (commit
-- 36f2c13 + 2 follow-ups). All FKs ON DELETE SET NULL (except
-- comments → cases which is CASCADE) so the audit trail outlives
-- deleted actors. RID format CAS_/CMT_ matches the existing
-- {2-4 uppercase}_{32 hex} convention; id::new("CAS") / id::new("CMT")
-- in the api crate.

-- ── cases ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS cases (
    redpash_id    TEXT        PRIMARY KEY,                              -- CAS_…
    -- Differentiates work. The four-value set is Agile-canonical;
    -- keep narrow — every addition fragments the kanban filter UI.
    type          TEXT        NOT NULL DEFAULT 'task'
                  CHECK (type IN ('bug', 'feature', 'task', 'epic')),
    title         TEXT        NOT NULL,
    description   TEXT,                                                 -- markdown body
    -- Status flow: backlog → todo → in_progress → in_review → done.
    -- Click-cycle on the kanban advances through these (wraps back to
    -- backlog on a done-click). Reopens (done → todo) are allowed; the
    -- `event::record(kind='case_status_change')` row carries the audit.
    status        TEXT        NOT NULL DEFAULT 'backlog'
                  CHECK (status IN ('backlog', 'todo', 'in_progress', 'in_review', 'done')),
    -- `critical` reserved for outages — pages oncall when notifications
    -- ship (v3); today it's just a priority chip color.
    priority      TEXT        NOT NULL DEFAULT 'medium'
                  CHECK (priority IN ('low', 'medium', 'high', 'critical')),
    -- SET NULL (not CASCADE) on every FK below: the ticket outlives
    -- the actors. A deleted user's tickets stay queryable for audit;
    -- the assignment / reporter attribution drops to NULL.
    reporter_id   TEXT        REFERENCES users(redpash_id)     ON DELETE SET NULL,
    assignee_id   TEXT        REFERENCES users(redpash_id)     ON DELETE SET NULL,
    project_id    TEXT        REFERENCES projects(redpash_id)  ON DELETE SET NULL,
    company_id    TEXT        REFERENCES companies(redpash_id) ON DELETE SET NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Status scan for the kanban board view (5 columns, each a status
-- filter). Composite with updated_at DESC so each column renders
-- newest-first without a separate sort step.
CREATE INDEX IF NOT EXISTS cases_status_idx
    ON cases (status, updated_at DESC);

-- "What's on my plate" query: GET /api/cases?assignee=USR_GUS&status=…
-- Partial — anonymous-assignee tickets (the backlog) skip the index.
CREATE INDEX IF NOT EXISTS cases_assignee_idx
    ON cases (assignee_id, status)
    WHERE assignee_id IS NOT NULL;

-- Per-project case list (for the detail page's "related tickets" view).
-- Partial — most cases will be unassigned to a specific project early on.
CREATE INDEX IF NOT EXISTS cases_project_idx
    ON cases (project_id, updated_at DESC)
    WHERE project_id IS NOT NULL;

-- ── comments ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS comments (
    redpash_id  TEXT        PRIMARY KEY,                                -- CMT_…
    -- CASCADE on case_id (unlike every other FK in this migration):
    -- a comment without its parent ticket is meaningless. The history
    -- still survives via events.context.comment + events.context.case
    -- references (which don't enforce FK).
    case_id     TEXT        NOT NULL REFERENCES cases(redpash_id) ON DELETE CASCADE,
    -- SET NULL on author: same rule as reporter/assignee on cases.
    author_id   TEXT        REFERENCES users(redpash_id) ON DELETE SET NULL,
    body        TEXT        NOT NULL,                                   -- markdown
    -- UI indicator. Could be derived from created_at != updated_at but
    -- explicit flag avoids floating-point timestamp comparisons in the
    -- read path.
    is_edited   BOOLEAN     NOT NULL DEFAULT false,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Comments thread render on the case detail page — ASC for chronological
-- read order (oldest first, matches the slack channel + the github PR
-- comment convention).
CREATE INDEX IF NOT EXISTS comments_case_idx
    ON comments (case_id, created_at ASC);
