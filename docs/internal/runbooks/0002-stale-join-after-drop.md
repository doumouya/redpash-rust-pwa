---
title: 0002 — Stale join after a table drop
section: Runbook
order: 2
last modified date: 2026-05-23
---

# 0002 — Stale join after a table drop

## Problem Statement

`GET /api/projects` and `GET /api/projects/:rid` returned 500 for every
request after the object-model hard-refresh Phase 2 landed (`92fcf87`,
2026-05-22). Postgres reported `relation "dashboards" does not exist`
on the projects path. Surfaced when the `frontend-reset` rebuild wired
the Workspace page's project list against `/api/projects` and got a
500 on every call — silent until then because nothing else was
listing projects post-migration.

## Troubleshooting steps

1. **Backend log** captured the SQL error verbatim —
   `relation "dashboards" does not exist` on `/api/projects`. Pointed
   straight at a query still referencing the table Phase 2 had dropped.
2. **Grep `db.rs`** for `dashboards`. Hit on `PROJECT_SELECT` — the
   shared SELECT used by `list_projects` + `get_project` — carrying a
   subquery `EXISTS (SELECT 1 FROM dashboards d WHERE d.project_redpash_id = p.redpash_id AND d.is_public)`
   that powered the "published" status overlay.
3. **Re-checked the Phase 2 commit** (`92fcf87`): the diff touched the
   `// ─── dashboards ───` block in `db.rs`, `dashboard_owner`, and
   `shared/dashboard.rs`. It did **not** touch `PROJECT_SELECT`.

## RCA

Phase 2 dropped the `dashboards` table and folded dashboards into
`project_files` as `file_type='dashboard'` rows. The dashboards-specific
helpers were re-pointed correctly. **`PROJECT_SELECT` was missed because
the reference to the dropped table lived in a *different resource's*
code path** — projects, not dashboards.

The Phase 2 audit scoped its search to the dashboards block in `db.rs`
(rg the dashboards section, edit the dashboards helpers). Cross-resource
joins that referenced `dashboards` for an *ancillary* reason — here, a
projects-side status overlay — were invisible to that scope.

Generalizes: when a table is dropped, references to it can live anywhere
— shared SQL constants, `EXISTS` subqueries in unrelated helpers,
trigger functions, views, the frontend. The table's own module is
necessary to audit but not sufficient.

## Solution

`84f3939` — `PROJECT_SELECT`'s published-status subquery now reads
`project_files WHERE file_type='dashboard' AND is_public` (the
post-migration shape, using the `is_public` column Phase 2 added). No
other queries referenced the dropped table; confirmed by a whole-tree
grep after the fix.

**Adopt as a drop-table rule.** Before dropping a table, run
`grep -rni '<table>' backend/ frontend/ docs/` and *read every hit*.
The table name can appear in:

- shared SQL constants (`*_SELECT`, `*_COLS` strings)
- `EXISTS` / subqueries inside *other resources'* helpers (the case here)
- trigger functions (Postgres validates function bodies at call time, not at function-creation time — a stale reference inside a function only blows up when the trigger next fires)
- views beyond `file_stages`
- frontend callers (the soon-defunct endpoint)
- the migration SQL itself

After the migration applies, smoke-test **a representative endpoint per
resource** — `/api/projects`, `/api/files`, `/api/charts`,
`/api/dashboards` — not just the resource the migration nominally
targets. A 500 here would have been caught the moment the backend
served its first project list.

## Post Checking

- `cargo check -p api` clean after `84f3939`.
- `grep -rni 'dashboards' backend/crates/api/src/db/` — only the
  re-pointed dashboards helpers remain, all on `project_files`.
- `GET /api/projects` returns 200 with the project list (verified on
  the `frontend-reset` Workspace wiring).
- Captured the lesson as feedback memory `drop-table-grep-everywhere`
  so future migrations carry the rule.
