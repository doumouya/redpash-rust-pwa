---
title: Admin
section: API
order: 13
last modified date: 2026-05-30
---

# `/api/admin/*`

Org-wide read surface for the `/home` rail's admin tabs. Every list
endpoint returns `Page<T>` — same envelope as
[`GET /api/files/:rid/page`](files.md#get-apifilesridpage) and
[`/api/monitoring/*`](monitoring.md) — so the redtable on each tab
reuses the existing reader and a new tab is one `LIST_VIEWS` entry on
the frontend.

> **Access.** Open today (solo / localhost) — same posture as
> [events.md](events.md) / [monitoring.md](monitoring.md). Gate behind
> the company-admin role when RBAC lands. The list endpoints surface
> every row in their table — they bypass the per-resource owner gate
> by design, so they're admin-only.

**Route file:** [`crates/api/src/routes/admin.rs`](../../backend/crates/api/src/routes/admin.rs)
**DTOs:** [`shared::admin`](../../backend/crates/shared/src/admin.rs) — `UserSummary`, `CompanySummary`, `MembershipSummary`, `AdminFileSummary`, `ChartSummary`, `StepSummary`, plus matching `*Stats` aggregates
**Wire contract:** [`docs/internal/admin-monitoring-surfaces.md §6`](../internal/admin-monitoring-surfaces.md)

---

## Endpoint map

| Route | Returns | Notes |
|---|---|---|
| `GET /api/admin/users` | `Page<UserSummary>` | Every `users` row. |
| `GET /api/admin/users/stats` | `UserStats` | Totals + recent-window counts. |
| `DELETE /api/admin/users/:rid` | — | Hard-delete a user (cascades per the **Scrub-Retain-Notify** policy — see [users.md#delete](users.md#delete-apiusersrid)). |
| `GET /api/admin/companies` | `Page<CompanySummary>` | Every `companies` row. |
| `GET /api/admin/companies/stats` | `CompanyStats` | — |
| `DELETE /api/admin/companies/:rid` | — | Hard-delete a company (cascades via `delete_entity`; company projects survive — `projects.company_id` is `ON DELETE SET NULL`). |
| `GET /api/admin/memberships` | `Page<MembershipSummary>` | Every `memberships` row (unified table). `?scope=project|company` narrows to project-typed or company-typed object rows. |
| `POST /api/admin/memberships` | `MembershipSummary` | Create one membership (admin write — body shape mirrors the row). |
| `GET /api/admin/memberships/stats` | `MembershipStats` | — |
| `DELETE /api/admin/memberships/:rid` | — | Synthetic compound rid in the path — `{scope}:{object_redpash_id}:{user_redpash_id}` — since the table's PK is composite (`object_redpash_id`, `user_redpash_id`). The handler parses the segments and dispatches the DELETE. |
| `GET /api/admin/files` | `Page<AdminFileSummary>` | Every csv-typed `project_files` row, org-wide (not per-project). |
| `GET /api/admin/files/stats` | `FileStats` | — |
| `GET /api/admin/charts` | `Page<ChartSummary>` | Every chart-typed `project_files` row (`file_type='chart'`). |
| `GET /api/admin/charts/stats` | `ChartStats` | — |
| `GET /api/admin/steps` | `Page<StepSummary>` | Every `project_steps` row across all files. |
| `GET /api/admin/steps/stats` | `StepStats` | — |

---

## Shared query plumbing

Every list endpoint accepts the same `AdminQuery` shape:

| Param  | Type   | Default | Notes |
|--------|--------|---------|-------|
| `page` | u32    | 1       | 1-indexed |
| `size` | u32    | 25      | Clamped per-endpoint (typically `[1, 500]`) |
| `q`    | string | —       | Free-text ILIKE-substring search, applied to the columns the handler declares — see the route docstring for the exact column list per endpoint. |
| `sort` | string | varies  | Click-to-sort column. **Validated against a per-endpoint `SORTABLE_*` allowlist** at the handler boundary — bad value silently falls back to the endpoint's default column. Never passed to the SQL builder unvalidated; the `format!`-built `ORDER BY` is safe because the column key comes from the allowlist, not the request. |
| `dir`  | string | `desc`  | `asc` or `desc`. |

Sortable column allowlists (key → SQL column):

| Endpoint | `SORTABLE_*` keys |
|---|---|
| `users` | `display_name` · `username` · `email` · `plan` · `job_title` · `organisation` · `org_name` · `org_role` · `created_at` (default) |
| `companies` | `name` · `slug` · `created_at` (default) · `updated_at` |
| `memberships` | `user_display_name` · `user_username` · `scope` · `scope_name` · `role` · `joined_at` (default) |
| `files` | `filename` · `display_name` · `file_type` · `stage` · `row_count` · `col_count` · `file_size_bytes` · `cleanness_pct` · `updated_at` · `created_at` (default) |
| `charts` | `display_name` · `filename` · `project_name` · `stage` · `created_at` (default) · `updated_at` |
| `steps` | `kind` · `applied` · `created_at` (default) |

For the authoritative per-endpoint list, see the `SORTABLE_*` constants
in [`crates/api/src/routes/admin.rs`](../../backend/crates/api/src/routes/admin.rs).

---

## Page envelope

```jsonc
{
  "rows":        [ /* T[] */ ],
  "total":       1287,
  "all_count":   1287,
  "page":        1,
  "size":        25,
  "pages":       52,
  "ms":          18,
  "row_indices": [0, 1, 2, …]
}
```

Stats endpoints return a single object (no pagination) — shape per DTO
in `shared::admin`.

---

## Memberships — synthetic compound rid

The `memberships` table is keyed on `(object_redpash_id,
user_redpash_id)`. To DELETE a single row through a URL path, the
handler accepts a synthetic compound rid:

```
DELETE /api/admin/memberships/project:PRJ_5F3C…:USR_9A2B…
DELETE /api/admin/memberships/company:CMP_…:USR_…
```

The `{scope}` segment narrows to project-typed or company-typed
object rows; the handler parses the three segments and runs a single
`DELETE FROM memberships WHERE object_redpash_id = … AND
user_redpash_id = …` (the scope segment is asserted against the row's
class via the entity registry to guard against cross-scope deletes).

---

## Cross-resource consistency

- Deleting a user via `DELETE /api/admin/users/:rid` runs the same
  cascade as the per-user endpoint — the **Scrub-Retain-Notify** policy
  applies (see [users.md#delete](users.md#delete-apiusersrid)). Owned
  objects (projects, charts, dashboards) are NOT cascade-deleted; the
  owner-membership is removed and the object goes ownerless for admin
  reassignment.
- Deleting a company cascades via `delete_entity` — company-typed
  `memberships` go away; `projects.company_id` is `ON DELETE SET NULL`
  so the company's projects survive as personal projects.
- The list endpoints surface every row their table holds, bypassing
  the per-resource owner gate — that's the admin posture; do not
  re-use these handlers in non-admin code paths.

---

## Related

- [users.md](users.md) — per-user CRUD + the Scrub-Retain-Notify cascade
  spec.
- [companies.md](companies.md) — the membership role model (`owner` >
  `admin` > `member`) the admin tab surfaces.
- [monitoring.md](monitoring.md) — adjacent admin-facing read surface
  (events / requests / queries / audit runs).
- [db/schema.md](../db/schema.md) — `users`, `companies`,
  `memberships`, `project_files`, `project_steps` definitions.
- [`docs/internal/admin-monitoring-surfaces.md`](../internal/admin-monitoring-surfaces.md)
  — wire contract.
