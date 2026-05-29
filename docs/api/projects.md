---
title: Projects
section: API
order: 4
last modified date: 2026-05-29
---

# `/api/projects/*`

A project is a user's workspace: it owns files (csv / chart-typed /
dashboard-typed `project_files` rows) and the step history on them.
Ownership is a `role='owner'` row in the unified [`memberships`](../db/schema.md#memberships)
table since mig 024 — there's no `projects.owner_id` column anymore.
The API lists, lists a project's files, creates, sparse-patches, and
deletes; ownership reassignment goes through the same `PATCH` (it's a
membership transfer under the hood).

**Route file:** [`crates/api/src/routes/projects.rs`](../../backend/crates/api/src/routes/projects.rs)
**DTO:** [`shared::project::ProjectSummary`](../objects/project.md)

---

## `GET /api/projects`

List the session user's projects, default first, then by `created_at`
ascending. Owner is resolved via [`resolve_user_rid`](me.md).

### Response

```jsonc
200 OK
{
  "items": [
    {
      "redpash_id":         "PRJ_5F3C7A21D8E94B6E92A1C0F4B3D7E0A2",
      "name":               "Workspace",
      "description":        null,
      "file_count":         7,             // COUNT(*) subquery on project_files
      "cleanness_pct":      null,          // placeholder — not populated yet
      "stage":              "clean",       // import | clean | report | publish
      "status":             "draft",       // draft | active | archived
      "is_default":         true,
      "owner_id":           "USR_9A2B…",   // derived via the owner-membership LATERAL (role='owner')
      "owner_display_name": "Jane Smith",  // from the users join on the owner-membership
      "owner_username":     "jane.9a2b3c4d",
      "company_id":         null,          // FK → companies; null = personal
      "created_at":         "2026-05-12T14:32:11Z",
      "updated_at":         "2026-05-12T14:32:11Z"
    }
  ]
}
```

No pagination — user-owned project counts are bounded.

### Errors

| Status | `kind`            | When |
|--------|-------------------|------|
| 401    | `unauthenticated` | OAuth enabled, no session cookie |
| 500    | `db`              | Postgres unreachable |

---

## `GET /api/projects/:rid/files`

Files in a project, as `FileSummary` records — same DTO shape as
[`GET /api/files/:rid`](files.md)'s `summary` field. Used by the home
page and the future project-detail view.

### Response

```jsonc
200 OK
{
  "items": [
    {
      "redpash_id":         "FIL_…",
      "project_redpash_id": "PRJ_…",
      "filename":           "dossiers_export.csv",
      "display_name":       "dossiers_export.csv",
      "file_type":          "csv",
      "stage":              "clean",       // computed — import | clean | report | publish
      "row_count":          101234,
      "col_count":          42,
      "file_size_bytes":    8421337,
      "cleanness_pct":      null,
      "encoding":           "latin-1",
      "delimiter":          ",",
      "created_at":         "2026-05-12T14:32:11Z",
      "updated_at":         "2026-05-12T14:32:11Z"
    }
  ]
}
```

### Errors

| Status | `kind`            | When |
|--------|-------------------|------|
| 401    | `unauthenticated` | OAuth enabled, no session |
| 404    | `not_found`       | Project RID missing or owned by another user |
| 500    | `db`              | Postgres unreachable |

---

## `PATCH /api/projects/:rid`

Sparse metadata update from the Objects overview's inline edit-mode.
Auth: session required + owner-match (`ensure_owner`). All body fields
optional — only the present ones change (`COALESCE`):

```jsonc
PATCH /api/projects/PRJ_…
{
  "name":        "Q4 Sales Cleanup",   // empty → dropped (can't blank a name)
  "description": "imported Q4 export",
  "is_default":  true,
  "owner_id":    "USR_…",              // reassign owner; empty → dropped
  "company_id":  "CMP_…",              // scope to a company; empty → dropped
  "status":      "active"              // draft | active | archived
}
```

Returns the updated `ProjectSummary` (re-fetched through the owner
join). The Objects page wires `name` + `description` as inline text
edits and `status` as an inline `enum` (badge) edit-cell; `is_default`
+ `owner_id` are accepted by the endpoint but have no inline edit-cell
UI yet. Under the hood: `is_default = true` writes to
`users.default_project_id` (one column = one default per user, no
flip-off of siblings needed); `owner_id` triggers a **membership
transfer** (DELETE the previous owner-membership + INSERT the new one,
in the same tx). A supplied `company_id` must be a company the editing
user is a member of — set/re-scope only, this path can't clear
`company_id` back to a personal project. `status` is validated against
`draft|active|archived` server-side — a bad value is a `400 invalid`,
not a CHECK-constraint `500`. **`stage` is not accepted** — it's a
computed value (the most advanced stage of any file in the project),
returned by `GET` but never written here.

### Errors

| Status | `kind`            | When |
|--------|-------------------|------|
| 400    | `invalid`         | `status` not in `draft|active|archived` |
| 401    | `unauthenticated` | OAuth enabled, no session |
| 404    | `not_found`       | Project RID missing or owned by another user; `owner_id` not a real user; `company_id` not a company the editor belongs to |
| 500    | `db`              | Postgres unreachable |

---

## `DELETE /api/projects/:rid`

Delete a project and everything it owns. Auth: session required +
owner-match (`ensure_owner`). The delete routes through `delete_entity`
(`DELETE FROM entities WHERE id = $1`); the project row + every edge
that FKs into the registry cascade out: `project_files` (incl. chart
and dashboard rows) → `project_steps`, plus the project's
`memberships`. The on-disk file blobs are unlinked best-effort after
the row delete (the cascade only clears DB rows) and the hot-frame
cache entries are evicted.

**The owner's default project can't be deleted** — every user must
keep exactly one default workspace. The delete is gated atomically by
`AND NOT EXISTS (SELECT 1 FROM users WHERE default_project_id = $1)`
(post-mig 024 the default flag lives on `users.default_project_id`, not
on the project); a request against the owner's default project returns
`400 is_default` telling the caller to promote another project to
default first. The Objects page mirrors this client-side by disabling
the trash button on the default project's row.

### Response

```
204 No Content
```

### Errors

| Status | `kind`            | When |
|--------|-------------------|------|
| 400    | `is_default`      | Project is the owner's default — reassign the default first |
| 401    | `unauthenticated` | OAuth enabled, no session |
| 404    | `not_found`       | Project RID missing or owned by another user |
| 500    | `db`              | Postgres unreachable |

---

## `POST /api/projects`

Create a project owned by the caller. The creator is seated as the
project's `role='owner'` membership in the same transaction as the
project insert (and the entity-registry insert that precedes it).
`is_default = true` writes the new project to `users.default_project_id`
in the same tx.

```jsonc
POST /api/projects
{
  "name":        "Q4 Sales",     // required, non-empty
  "description": "Q4 import",    // optional
  "company_id":  "CMP_…",        // optional — must be a company the caller belongs to
  "is_default":  false            // optional, default false
}
```

Returns the freshly-hydrated `ProjectSummary` (re-fetched through the
owner LATERAL).

---

## Related

- [objects/project.md](../objects/project.md) — `ProjectSummary` DTO + table.
- [files.md](files.md) — file lifecycle within a project.
- [charts.md](charts.md) / [dashboards.md](dashboards.md) — chart-typed
  and dashboard-typed `project_files` rows that share a project.
- [me.md](me.md) — owner / membership resolution.
