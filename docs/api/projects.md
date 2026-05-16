---
title: Projects
section: API
order: 4
---

# `/api/projects/*`

A project is a user's workspace: it owns files, reports, dashboards.
The API lists, lists a project's files, and supports a sparse metadata
`PATCH`; create / delete land with the multi-project UI (Phase 4c+).

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
      "owner_id":           "USR_9A2B…",   // FK → users.redpash_id
      "owner_display_name": "Jane Smith",  // from the users join
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
UI yet. A supplied `company_id` must be a company the editing user is a
member of — set/re-scope only, this path can't clear `company_id` back
to a personal project. `status` is validated against
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
owner-match (`ensure_owner`). `project_files` (→ `project_steps`),
`reports`, `dashboards` and `project_memberships` all cascade via FK.
The on-disk file blobs are unlinked best-effort after the row delete
(the cascade only clears DB rows) and the hot-frame cache entries are
evicted.

**The owner's default project can't be deleted** — every user must
keep exactly one default workspace. The delete is gated by
`DELETE FROM projects WHERE redpash_id = $1 AND NOT is_default`, so the
check is atomic; a request against the default project returns
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

## Planned

| Method | Path                       | Phase | Notes |
|--------|----------------------------|-------|-------|
| POST   | `/api/projects`            | 4c+   | Create — multi-project UI |

---

## Related

- [objects/project.md](../objects/project.md) — `ProjectSummary` DTO + table.
- [files.md](files.md) — file lifecycle within a project.
- [me.md](me.md) — owner resolution.
