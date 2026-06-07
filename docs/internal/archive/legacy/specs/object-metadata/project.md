---
title: Project — object metadata
section: Internal
order: 44
last modified date: 2026-05-30
owner: Torv
status: draft — per the object-metadata sweep ([index](index.md))
---

# Project (PRJ_)

A workspace container. Every file lives in exactly one project; every
user has exactly one **default** project (auto-created on first
sign-in by `ensure_default_project`). Projects can be personal
(`company_id = NULL`) or company-scoped. Stage is **computed** from
file activity (no `projects.stage` column post-mig-023); status is
the stored column.

**Backing table:** `projects` (migration `20260512000001_init.sql`
+ follow-ups `20260521000001_companies.sql` (added `company_id`)
+ `20260522000001_project_stage_status.sql` (added `status`; added a
  `stage` column subsequently dropped)
+ `20260523000001_computed_stages.sql` (dropped `projects.stage`,
  introduced the `file_stages` view; stage is now derived per-file
  + aggregated at SELECT time)
+ `20260605000001_stage_rename.sql` (relabeled the stage enum:
  `import → new`, `report → design`)).
**DTO:** `backend/crates/shared/src/project.rs` (`ProjectSummary` +
`ProjectDetail`).
**Routes:** `backend/crates/api/src/routes/projects.rs`.

---

## Supported calls

| Verb | Wire | Notes |
|---|---|---|
| `create` | `POST /api/projects` | Server assigns `PRJ_<32hex>`. Body: `{ name, description?, company_id?, is_default? }`. The creator is seated as the project's `owner` in the same TX via a `memberships` row (`role='owner'`) — ownership lives there, not in a column. `company_id` (when set) gated on caller's membership — non-members get 404. `is_default: true` writes `UPDATE users SET default_project_id = $rid` in the same TX (one column = one default per user; no sibling flip-off needed). Returns `201 Created` with the joined `ProjectSummary`. |
| `read` | `GET /api/projects/:rid` | Returns the full `ProjectSummary` (owner-gated). |
| `read (with files)` | `GET /api/projects/:rid/files` | Returns `{ items: Vec<FileSummary> }` — files in this project, owner-gated. NOT a separate Project endpoint — listed here because it's the canonical "open a project" call from the Workspace rail. |
| `update` | `PATCH /api/projects/:rid` | Sparse — name / description / is_default / owner_id / company_id / status. Owner-gated. `is_default` writes `users.default_project_id` (set on `true`, clear on `false` when this is the current default), all in one TX. `owner_id` reassignment transfers the owner-membership (DELETE the existing `role='owner'` row + UPSERT the new user to `owner`); the target must exist (404 `not_found` for unknown user). `company_id` reassignment gated on caller's membership in the target company. Empty `name` / `owner_id` / `company_id` are dropped so they can't blank a required field; `company_id` can be re-scoped but not cleared back to personal via this path (a dedicated unset path lands with the company UI). |
| `delete` | `DELETE /api/projects/:rid` | Owner-gated. Refuses to delete the owner's default project (return `400 is_default`). Cascades files + steps via FK; on-disk blob cleanup is a follow-up TODO. |
| `list` | `GET /api/projects` | Returns `{ items: Vec<ProjectSummary> }` — owner-scoped (the session user's projects only). **No pagination today**, no sort param, no `q=` filter. Backend `Page<T>` conversion + `?status=` / `?q=` / `?sort=` queued as a follow-up. Hardcoded `ORDER BY is_default DESC, created_at ASC` (default project first). |
| `search` | — | **Not supported.** No `q=` param on `/api/projects`. |

---

## Fields

```
redpash_id
  Type:        TEXT / String — format PRJ_<32 uppercase hex>
  Properties:  Layout
  Description: Primary key. Server-assigned via id::new("PRJ").
               Never settable by clients. Hidden by default in
               the Home Projects tab.
```

```
owner_id
  Type:        String — DTO / PATCH field, NOT a projects column
  Properties:  Update, Layout
  Description: Owner. NOT a column on projects — ownership is a
               `memberships` row with role='owner' (FK
               object_redpash_id → entities.id). Server-seats the
               caller as owner on Create (membership INSERT);
               clients can't fork creation. The PATCH body still
               accepts `owner_id` as input + the DTO hydrates it
               as output — a reassignment transfers the
               owner-membership (target must be a real USR_, 404
               on unknown). NOT a Create-property (caller wins).
```

```
name
  Type:        TEXT NOT NULL / String
  Properties:  Create, Update, Layout
  Description: Display name. Required on Create. Inline-editable
               in the rail (pencil affordance on `.rt-group-head`)
               and in the Home Projects tab. Empty PATCHes are
               dropped — can't blank the column.
```

```
description
  Type:        TEXT / Option<String>
  Properties:  Create, Update, Nillable, Layout
  Description: Optional long-form description. Hidden by default
               in the Home Projects tab.
```

```
is_default
  Type:        bool — DTO / PATCH field, NOT a projects column
  Properties:  Create, Update, Layout
  Description: Marks the owner's default project — the implicit
               target for uploads when no `project_name` is sent.
               NOT a column on projects: the default lives on
               `users.default_project_id` (one column = one
               default per user, so no per-project flag or
               partial-unique index). The DTO derives this field
               as `users.default_project_id == redpash_id`; the
               Create/PATCH handlers write `default_project_id` in
               a TX (set on true, clear on false). The user's
               default project can't be deleted (400 `is_default`).
               Hidden by default in the Home Projects tab.
```

```
status
  Type:        TEXT NOT NULL DEFAULT 'draft' / String — enum (see "Enum constraints")
  Properties:  Update, Layout
  Description: Workflow position. Added mig 022. CHECK-constrained.
               NOT a Create-property — every new project starts
               'draft'. Surfaced on the Home Projects tab.
```

```
company_id
  Type:        TEXT / Option<String> — FK to companies.redpash_id
  Properties:  Create, Update, Nillable, Layout
  Description: Optional company scoping. NULL = personal project.
               SET NULL on company delete (project survives as
               personal rather than cascading). Membership-gated
               on both Create and PATCH-reassign. Hidden by
               default in the Home Projects tab.
```

```
created_at
  Type:        TIMESTAMPTZ NOT NULL DEFAULT now() / chrono::DateTime<Utc>
  Properties:  Layout
  Description: Auto-set on INSERT. Hidden by default in the Home
               Projects tab.
```

```
updated_at
  Type:        TIMESTAMPTZ NOT NULL DEFAULT now() / chrono::DateTime<Utc>
  Properties:  Layout
  Description: Auto-bumped on every UPDATE by the route handler.
               Surfaced as the "Updated" column on the Home
               Projects tab.
```

### Hydrated read-only fields

These appear on `ProjectSummary` (every read response) but aren't
columns on `projects` — they're computed at SELECT time via the
shared `PROJECT_SELECT` in `db/projects.rs`.

```
owner_display_name, owner_username
  Type:        TEXT / String
  Properties:  Layout
  Description: users.display_name + users.username resolved via the
               owner-membership LATERAL (the `memberships` row with
               role='owner') joined to users — there's no
               projects.owner_id to join on. Hidden by default in
               the Home Projects tab (the inline owner picker on the
               Objects page uses owner_display_name to label the
               chip).
```

```
file_count
  Type:        BIGINT / u32
  Properties:  Layout
  Description: COUNT(*) FROM project_files WHERE
               project_redpash_id = projects.redpash_id AND
               file_type <> 'chart' — charts excluded from the
               user-facing file count (they're files in the
               schema but designer-mode artifacts in UX). Drives
               the rail's per-group count badge + the Home
               Projects tab's "Files" column.
```

```
cleanness_pct
  Type:        REAL / Option<f32>
  Properties:  Nillable, Layout
  Description: Aggregated cleanness across the project's csv-
               typed files. Null when no files have been scored
               yet. Hidden by default in the Home Projects tab.
```

```
stage
  Type:        TEXT / String — enum (see "Enum constraints")
  Properties:  Layout
  Description: **Computed**, not stored. Folded in via the
               `file_stages` view: stage = the most-advanced
               stage of any file in the project (`MAX(stage_rank)`
               on file_stages, mapped back through the CASE in
               PROJECT_SELECT). Drives the rail's stage dot +
               the Home Projects tab's "Stage" column.
```

---

## Enum constraints

`status ∈ { draft, active, archived }` — DB-side CHECK constraint
in migration 022 line 18. The route handler also validates against
this set in `PROJECT_STATUSES` (`projects.rs:140`) so a bad value
is a clean 400 `bad_request` rather than a 23514 CHECK violation
bubbling up as a 500.

`stage ∈ { new, clean, design, publish }` — **computed**, not stored.
- `new`: file just arrived; no steps applied, no charts derived
  (renamed from `import` 2026-06-05).
- `clean`: file has at least one cleaning step.
- `design`: file is the source of at least one chart file (renamed
  from `report` 2026-06-05). The chart file IS the design surface;
  until publish, the project is being designed (the activity),
  not yet a finished report (the artifact).
- `publish`: a chart sourced from a file in the project sits in a
  widget of a public dashboard-file's spec.

The labels live in the `file_stages` view definition (mig 023 +
renamed in mig 022). Stage-rank ordering: publish=3 > design=2 >
clean=1 > new=0; the project rolls up to the highest-ranked file.

---

## Relationships

```
owner (via memberships role='owner') → User (USR_)
  Cardinality:  N:1 (a User owns many Projects)
  Backing:      a `memberships` row (object_redpash_id = the
                project, role='owner') — NOT a projects.owner_id
                column. On user delete the membership row CASCADEs
                (FK user_redpash_id → users), leaving the project
                ownerless for admin reassignment rather than
                dropping the project itself.
  Hydrated as:  owner_id, owner_display_name, owner_username
```

```
company_id → Company (CMP_)
  Cardinality:  N:1
  On delete:    SET NULL (company-scoped projects survive as
                personal projects rather than cascading)
  Hydrated as:  — (company_id surfaced as-is; no company_name
                hydration on ProjectSummary today)
```

### Inverse relationships

```
Project has many Files
  Backing:       project_files (FK project_redpash_id)
  Cardinality:   1:N
  On delete:     CASCADE (deleting a project drops every file —
                csv data files, chart specs, dashboard specs)
  Surfaced as:   GET /api/projects/:rid/files → { items: Vec<FileSummary> }
                 (owner-gated). Also reachable on ProjectDetail's
                 `files` field, though ProjectDetail isn't wired to
                 a route today.
                 See [file](file.md).
```

```
Project has many Steps (via Files)
  Cardinality:   1:N transitively (Project → File → Step)
  On delete:     CASCADE through the File chain
  Surfaced as:   — (steps are per-file, not per-project; no
                /api/projects/:rid/steps endpoint)
```

```
Project has many Membership rows
  Backing:       memberships (the ONE polymorphic table; composite
                 PK on (object_redpash_id, user_redpash_id), FK
                 object_redpash_id → entities.id)
  Cardinality:   1:N
  On delete:     CASCADE (via the entities registry row)
  Status:        Live now — ownership IS membership-backed: a
                 `role='owner'` row is written on project create and
                 read by `db::project_owner`. Additional roles
                 (admin/member/viewer) fill in as project RBAC lands.
                 See [membership](membership.md).
```

```
Case.project_id → Project
  See [case](case.md) — N:1, SET NULL on project delete.
```

---

## Audit events

| `kind` | Emitted on | Context shape |
|---|---|---|
| `project_create` | `POST /api/projects` | `{ project }` |
| `project_patch` | `PATCH /api/projects/:rid` (any field change) | `{ project, fields: [<names>] }` — bundled list of fields that changed; no per-field split today |

`delete_project` does NOT emit an event today (TODO — should match
the `case_delete` / `company_delete` pattern with a level=warn
record). Flagged here so it surfaces in the RBAC-pre-work audit;
add when the cleanup-on-delete blob path lands.
