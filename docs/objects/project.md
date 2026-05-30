---
title: Project
section: Objects
order: 1
last modified date: 2026-05-30
---

# Project (`ProjectSummary`)

**DTO:** `shared::project::ProjectSummary`
**Table:** `projects`
**RID prefix:** `PRJ`
**Migration:** 001 init; 008 added `status` (+ `stage`); 009 dropped `stage` (now computed)

---

## What a Project is

A user's workspace. Holds files, reports, and dashboards. Every
session user has at least one project — the **default project** —
created idempotently on first sign-in (or on first upload via
`db::ensure_default_project`).

The schema permits multiple projects per user, but the frontend
currently only surfaces the default workspace; multi-project UI is
Phase 4c+.

---

## Fields

The DTO exposes the stored project columns plus an owner-membership →
`users` join for the owner (so the Objects page can show + reassign the
owner). The table:

| Field | DB column | Type | Nullable | Default | Description |
|---|---|---|---|---|---|
| `redpash_id` | `redpash_id` | `TEXT` PK | NO | — | `PRJ_…` → `entities.id` ON DELETE CASCADE |
| `company_id` | `company_id` | `TEXT` FK | YES | — | Mig 007. → `companies.redpash_id` ON DELETE SET NULL. `null` = personal project |
| `name` | `name` | `TEXT` | NO | — | Workspace label. `"Workspace"` for auto-created default. |
| `description` | `description` | `TEXT` | YES | — | Free-text |
| `status` | `status` | `TEXT` | NO | `'draft'` | Mig 008. `CHECK (draft / active / archived)` — lifecycle state. The DTO overlays a read-only `published` value on top — see below. |
| `created_at` | `created_at` | `TIMESTAMPTZ` | NO | `now()` | |
| `updated_at` | `updated_at` | `TIMESTAMPTZ` | NO | `now()` | |

### `ProjectSummary` DTO

```rust
pub struct ProjectSummary {
    pub redpash_id:         String,
    pub name:               String,
    pub description:        Option<String>,
    pub file_count:         u32,         // computed subquery
    pub cleanness_pct:      Option<f32>, // not yet populated
    pub stage:              String,      // computed — max file stage (import | clean | report | publish)
    pub status:             String,      // stored draft | active | archived, with a read-only 'published' overlay
    pub is_default:         bool,        // derived: users.default_project_id == redpash_id (not a projects column)
    pub owner_id:           String,      // derived: the owner-membership's user (role='owner') — not a projects column
    pub owner_display_name: String,      // from the owner-membership → users join
    pub owner_username:     String,      // from the owner-membership → users join
    pub company_id:         Option<String>, // FK → companies; None = personal
    pub created_at:         DateTime<Utc>,
    pub updated_at:         DateTime<Utc>,
}
```

`file_count` is computed at query time via a `COUNT(*)` subquery over
`project_files`. `owner_id` / `owner_display_name` / `owner_username`
resolve through an owner-membership LATERAL (`memberships` row with
`role='owner'`) joined to `users` — there's no `projects.owner_id`
column (see `PROJECT_SELECT` in `db/projects.rs`). `is_default` is
likewise derived (`users.default_project_id == p.redpash_id`), not a
stored column. `cleanness_pct` is still a placeholder (`None`) for
future per-project scoring.

### `ProjectDetail` DTO

A second DTO wraps `ProjectSummary` with the project's files inline — for
a single-project detail fetch:

```rust
pub struct ProjectDetail {
    #[serde(flatten)]
    pub summary: ProjectSummary,    // all ProjectSummary fields, flattened
    pub files:   Vec<FileSummary>,  // the project's files
}
```

`#[serde(flatten)]` keeps the wire shape flat — every `ProjectSummary`
field sits at the top level alongside a `files` array, not under a nested
`summary` key.

### `stage` / `status` (computed)

Neither field is read straight from a stored column:

- **`stage`** — the most advanced stage of any file in the project.
  `PROJECT_SELECT` aggregates `MAX(stage_rank)` from the `file_stages`
  view (see [file.md](file.md)) and maps it back to the stage name:
  `import` (no files, or all files still `import`) → `clean` → `report`
  → `publish`. Read-only — there's no stored `projects.stage` column
  (migration 009 dropped it).
- **`status`** — the stored `projects.status` column
  (`draft` / `active` / `archived`, manually editable via PATCH), with
  one overlay: `PROJECT_SELECT` returns `published` instead whenever
  the project has a public dashboard (`dashboards.is_public`). The
  `published` value is never persisted — it's a read-time view of the
  underlying stored status.

---

## Indexes & constraints

| Index | Columns | Notes |
|---|---|---|
| `projects_pkey` | `redpash_id` | PK (`redpash_id → entities.id`) |
| `projects_company_idx` | `company_id` | Company-scope lookups |
| `projects_status_idx` | `status` | Status filtering |

There's no `owner_id` or `is_default` column (so no owner/default
indexes). Ownership lives in a `memberships` row (`role='owner'`); the
list query keys off that membership, not a project column. The project
`redpash_id` is `REFERENCES entities(id) ON DELETE CASCADE` — deleting
the entity wipes the project (and transitively all its files, steps,
reports, dashboards, and memberships).

---

## DB helpers (`crates/api/src/db/projects.rs`)

| Helper | SQL | Used by |
|---|---|---|
| `list_projects(owner)` | `PROJECT_SELECT` (+ owner-membership LATERAL → `users` join) `WHERE om.user_redpash_id = $1 ORDER BY is_default DESC, p.created_at ASC` | `routes::projects::list` |
| `get_project(rid)` | `PROJECT_SELECT WHERE p.redpash_id = $1` → `Option<ProjectSummary>` | `update_project_meta` (re-fetch after update) |
| `update_project_meta(rid, owner, name, description, is_default, owner_id, company_id, status)` | tx: optional `users.default_project_id` write (is_default) + optional owner-membership transfer (DELETE+INSERT `memberships`, owner_id) + `UPDATE projects SET … = COALESCE($n, …)`, then `get_project` | `routes::projects::patch_project` |
| `delete_project(rid)` | `DELETE FROM entities WHERE id = $1 AND EXISTS(project) AND NOT EXISTS(user WHERE default_project_id=$1)` → `bool` (`false` = was the default, blocked) | `routes::projects::delete_project` |
| `project_file_rids(project_rid)` | `SELECT redpash_id FROM project_files WHERE project_redpash_id = $1` | `delete_project` handler — blob cleanup + cache eviction |
| `find_default_project(owner)` | `SELECT default_project_id FROM users WHERE redpash_id = $1` | `bootstrap`, `db::ensure_default_project` |
| `insert_project(rid, owner, name, is_default)` | tx: register entity + INSERT project + INSERT owner `memberships` row + (if default) write `users.default_project_id` | `bootstrap`, `db::ensure_default_project` |
| `ensure_default_project(owner)` | `find_default_project` → if missing → `insert_project("Workspace", is_default=true)` | `routes::auth::callback`, `routes::files::upload` |

`PROJECT_SELECT` is a shared `const &str` — the `SELECT … FROM projects p
JOIN LATERAL (owner membership) … JOIN users u …` body; `list_projects`
/ `get_project` splice their own `WHERE`. `row_to_project` is the shared
`PgRow → ProjectSummary` mapper.

`ensure_default_project` is the idempotent helper everyone reaches for
— call it whenever you need to land a file in *some* project and you
don't have a specific one yet.

---

## Lifecycle

```
Bootstrap (first cargo run)
  └─► users (dev_user)            INSERT
      └─► projects ("Workspace")  INSERT + owner membership row
          └─► users.default_project_id ← the new PRJ (marks default)

Google OAuth first sign-in
  /api/auth/google/callback
  └─► upsert_google_user           INSERT INTO users
      └─► ensure_default_project   INSERT INTO projects (idempotent)

Upload before user has a default project
  POST /api/files/upload
  └─► resolve_user_rid             → user RID
      └─► ensure_default_project   → project RID (auto-create if missing)
          └─► db::insert_file       → project_files row
```

---

## API

### `GET /api/projects`

**Auth:** session cookie / dev_user fallback

Returns the session user's projects (sorted: default first, then by
`created_at` ASC).

```json
{
  "items": [
    {
      "redpash_id":         "PRJ_5F3C7A21…",
      "name":               "Workspace",
      "description":        null,
      "file_count":         7,
      "cleanness_pct":      null,
      "stage":              "clean",
      "status":             "draft",
      "is_default":         true,
      "owner_id":           "USR_9A2B…",
      "owner_display_name": "Jane Smith",
      "owner_username":     "jane.9a2b3c4d",
      "company_id":         null,
      "created_at":         "2026-05-12T14:32:11Z",
      "updated_at":         "2026-05-12T14:32:11Z"
    }
  ]
}
```

### `GET /api/projects/:rid/files`

**Auth:** session required + owner-match (Phase 4c). The handler pairs
`resolve_user_rid` with `db::project_owner(rid)` via
`routes::ensure_owner` — 404 `not_found` on missing project or owner
mismatch (same message either way so existence isn't leaked).

Returns the files in a project as `FileSummary` records — same DTO
shape as `GET /api/files/:rid`'s `summary` field. Used by the home
page / future project-detail UI.

### `PATCH /api/projects/:rid`

**Auth:** session required + owner-match (`ensure_owner`).

Sparse metadata update from the Objects overview's inline edit-mode.
Body — all fields optional, only the present ones change (COALESCE):

```jsonc
{ "name": "Q4 Cleanup", "description": "…", "is_default": true,
  "owner_id": "USR_…", "company_id": "CMP_…", "status": "active" }
```

Empty `name` / `owner_id` / `company_id` are dropped server-side so they
can't blank a required field. A supplied `company_id` must be a company
the editing user belongs to (validated via `db::company_role`) — and
this path can set or re-scope `company_id` but not clear it back to a
personal project. `status` is validated against `draft|active|archived`
— a bad value is a `400 invalid`, not a CHECK-constraint `500`. `stage`
is **not** accepted here — it's computed from the project's files.
Returns the updated `ProjectSummary` (re-fetched through the owner
join). The Objects page wires `name` / `description` (text),
`is_default` (toggle), `owner` (user picker) and `status` (enum picker)
as inline edit cells; `stage` is a read-only badge.

### `DELETE /api/projects/:rid`

**Auth:** session required + owner-match (`ensure_owner`).

Deletes the project; `project_files` (→ `project_steps`), `reports`,
`dashboards` and the project's `memberships` cascade via FK (the delete
runs against the `entities` registry row, so every edge drops in one
shot). The on-disk file blobs are unlinked best-effort afterwards and
the hot-frame cache entries are evicted.

**The owner's default project can't be deleted.** `delete_project`
runs `DELETE FROM entities WHERE id = $1 AND EXISTS(project) AND NOT
EXISTS(SELECT 1 FROM users WHERE default_project_id = $1)`, so the
guard is atomic with the delete — a request against the default project
is a no-op that the handler turns into `400 is_default` ("set another
project as default before deleting it"). The user must promote another
project to default (`PATCH … { "is_default": true }`) first. The
Objects page disables the trash button on the default project's row to
surface this before the request is even made.

Returns `204 No Content` on success. See
[api/projects.md](../api/projects.md#delete-apiprojectsrid) for the
full error table.

### `POST /api/projects` *(planned)*

Not yet implemented. Multi-project UI lands when the user actually
needs more than one workspace.

---

## Frontend

| Asset | Location |
|---|---|
| **Home page** | `partials/home.html` lists projects via `GET /api/projects` |
| **Mount** | `scripts/pages/home.js` |
| **Workspace upload landing** | Upload in the workspace (`scripts/pages/workspace.js`) — the backend resolves the session user's default project; the frontend doesn't pick |
| **Chart save default** | `routes::charts::create` derives the project from the chart's `source_file_id` (the source File's project) |
| **Dashboard create default** | The workspace designer (`scripts/designer.js`) passes the open project's `project_redpash_id` to `POST /api/dashboards` |

---

## Notes

- **No multi-project UI yet.** Everything routes through the default
  project. A user with multiple projects today would only see one in
  the frontend.
- **`is_public` exists on reports + dashboards, not on projects.**
  Sharing happens per-resource, not per-workspace.
- **No soft-delete.** The default lives on `users.default_project_id`
  (one column = one default per user), so flipping the default just
  repoints that column — no per-project flag to toggle off.
- **The default project can't be deleted.** `DELETE /api/projects/:rid`
  rejects the owner's default with `400 is_default`; promote another
  project to default first. This keeps the "exactly one default per
  owner" invariant intact — deletion can't strand a user with none.
- The bootstrap's `bs.project` value used to be cached on `AppState`
  as `default_project`. Phase 4b removed it — every request resolves
  the session user's default via `ensure_default_project`.
