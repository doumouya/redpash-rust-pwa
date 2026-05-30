---
title: Search
section: API
order: 14
last modified date: 2026-05-30
---

# `/api/search`

Omnisearch backing the topbar input. One flat, `kind`-discriminated
result list spanning projects, files/charts/dashboards, users,
companies, and memberships. The frontend groups results by `kind` for
display and navigates via each result's `hash` — the backend names the
destination so adding a new kind doesn't need a frontend switch update.

**Route file:** [`crates/api/src/routes/search.rs`](../../backend/crates/api/src/routes/search.rs)
**Wire DTO:** [`crates/shared/src/search.rs`](../../backend/crates/shared/src/search.rs) (`SearchResponse`, `SearchResult`)
**Auth:** same resolver as `/api/me` (`resolve_user_rid`). Project/file results are scoped to the caller's `memberships`; users / companies / memberships surface org-wide today (matches the Home tabs), with RBAC scoping planned for Phase 4.

---

## `GET /api/search`

### Query params

| Param   | Type   | Default | Notes |
|---------|--------|---------|-------|
| `q`     | string | `""`    | Search text. Trimmed server-side; an empty query (after trim) returns an empty `results` list. Single-character queries are allowed. Matched per-kind via `ILIKE %q%`, with a prefix-match (`q%`) boost in the ordering. |
| `limit` | int    | `20`    | Overall result cap. Clamped to `1..=100`. There is also a fixed per-kind cap of 5; when the total exceeds `limit`, kinds are filled round-robin so no single kind monopolises the response. |

### Response — `200 OK`

```jsonc
{
  "q":       "ali",          // echoed back (trimmed) so the FE can drop stale responses
  "results": [
    {
      "kind":  "project",    // project | file | chart | dashboard | user | company | membership
      "rid":   "PRJ_…",      // membership uses a synthetic rid: "{scope}:{scope_rid}:{user_rid}"
      "label": "Alice's data",
      "sub":   "…",          // context line (see below); may be ""
      "hash":  "#/workspace?project=PRJ_…"  // navigation target the FE assigns to location.hash
    }
  ],
  "ms":      3                // server-side time spent, milliseconds
}
```

### `kind` values and their `hash` / `sub`

| `kind`       | Source             | `sub`                  | `hash` |
|--------------|--------------------|------------------------|--------|
| `project`    | `projects`         | description (or `""`)  | `#/workspace?project=<rid>` |
| `file`       | `project_files` (csv / other) | `in <project_name>` | `#/workspace?file=<rid>` |
| `chart`      | `project_files` (`file_type=chart`) | `in <project_name>` | `#/workspace?file=<rid>` |
| `dashboard`  | `project_files` (`file_type=dashboard`) | `in <project_name>` | `#/workspace?file=<rid>` |
| `user`       | `users`            | `@<username>` (or `""`) | `#/home?tab=users` |
| `company`    | `companies`        | slug (or `""`)         | `#/home?tab=companies` |
| `membership` | `memberships` (project + company union) | `<role> in <scope_name>` | `#/home?tab=memberships` |

### Errors

No search-specific error kinds. The only failure paths are the shared
ones: `unauthenticated` (401) when OAuth is enabled and the session is
missing, and `db` (500) on a Postgres error. See the
[error shape table](overview.md) for the full envelope.

---

Stateless — nothing is stored. The grouping/SQL strategy (per-kind
`ILIKE`, prefix boost, `ROW_NUMBER()` partitioning for the
`project_files` kinds) lives in the route file.
