---
title: REST API — internal
section: Internal
last modified date: 2026-06-07
---

# REST API

The HTTP surface of the backend (`backend/crates/api`, axum). One area for
every `/api/*` resource: the **route table is generated** from the live code,
the **conventions and per-resource WHY are hand-written**.

> Migrating in from the public `docs/api/*` tier (CAS_701CF65E). Per-resource
> docs land here in Phase C; the generated route table lands in Phase B.

## Generated route table

The full method × path × handler × RBAC-gate inventory, generated from
`tools/lib/rust-routes.js` (the same extractor `crossing-audit` /
`list-endpoint-rbac-audit` / `api-doc-audit` consume — one source of truth).

<!-- doc-gen:api:index START -->
Generated 2026-06-07 from the axum route tree (`tools/lib/rust-routes.js`) — 153 routes. `gate` = the platform-admin nest-layer gate.

### `/api/admin` (26)

| method | path | handler | gate | source |
|--------|------|---------|------|--------|
| GET | `/api/admin/audit-catalog` | `audit_catalog` | platform_admin | `routes/admin.rs:71` |
| GET | `/api/admin/charts` | `list_charts` | platform_admin | `routes/admin.rs:66` |
| GET | `/api/admin/charts/stats` | `stats_charts` | platform_admin | `routes/admin.rs:67` |
| GET | `/api/admin/companies` | `list_companies` | platform_admin | `routes/admin.rs:52` |
| DELETE | `/api/admin/companies/:rid` | `delete_company` | platform_admin | `routes/admin.rs:54` |
| GET | `/api/admin/companies/stats` | `stats_companies` | platform_admin | `routes/admin.rs:53` |
| GET | `/api/admin/fields` | `list_fields` | platform_admin | `routes/admin.rs:72` |
| PUT | `/api/admin/fields` | `put_field` | platform_admin | `routes/admin.rs:72` |
| GET | `/api/admin/files` | `list_files` | platform_admin | `routes/admin.rs:64` |
| GET | `/api/admin/files/stats` | `stats_files` | platform_admin | `routes/admin.rs:65` |
| GET | `/api/admin/memberships` | `list_memberships` | platform_admin | `routes/admin.rs:57` |
| POST | `/api/admin/memberships` | `create_membership` | platform_admin | `routes/admin.rs:57` |
| DELETE | `/api/admin/memberships/:rid` | `delete_membership` | platform_admin | `routes/admin.rs:63` |
| GET | `/api/admin/memberships/stats` | `stats_memberships` | platform_admin | `routes/admin.rs:58` |
| GET | `/api/admin/rbac` | `rbac_resolve` | platform_admin | `routes/admin.rs:70` |
| GET | `/api/admin/steps` | `list_steps` | platform_admin | `routes/admin.rs:68` |
| GET | `/api/admin/steps/stats` | `stats_steps` | platform_admin | `routes/admin.rs:69` |
| GET | `/api/admin/teams` | `list_teams_admin` | platform_admin | `routes/admin.rs:55` |
| GET | `/api/admin/teams/stats` | `stats_teams` | platform_admin | `routes/admin.rs:56` |
| GET | `/api/admin/types` | `list_types` | platform_admin | `routes/admin.rs:73` |
| POST | `/api/admin/types` | `register_type` | platform_admin | `routes/admin.rs:73` |
| GET | `/api/admin/types/:type` | `get_type` | platform_admin | `routes/admin.rs:74` |
| GET | `/api/admin/users` | `list_users` | platform_admin | `routes/admin.rs:49` |
| DELETE | `/api/admin/users/:rid` | `delete_user` | platform_admin | `routes/admin.rs:51` |
| PATCH | `/api/admin/users/:rid` | `patch_user_role` | platform_admin | `routes/admin.rs:51` |
| GET | `/api/admin/users/stats` | `stats_users` | platform_admin | `routes/admin.rs:50` |

### `/api/auth` (4)

| method | path | handler | gate | source |
|--------|------|---------|------|--------|
| POST | `/api/auth/dev-login` | `dev_login` |  | `routes/auth.rs:42` |
| GET | `/api/auth/google/callback` | `callback` |  | `routes/auth.rs:40` |
| GET | `/api/auth/google/start` | `start` |  | `routes/auth.rs:39` |
| POST | `/api/auth/logout` | `logout` |  | `routes/auth.rs:41` |

### `/api/cases` (14)

| method | path | handler | gate | source |
|--------|------|---------|------|--------|
| GET | `/api/cases` | `list` |  | `routes/cases.rs:41` |
| POST | `/api/cases` | `create` |  | `routes/cases.rs:41` |
| DELETE | `/api/cases/:rid` | `delete_one` |  | `routes/cases.rs:45` |
| GET | `/api/cases/:rid` | `get_one` |  | `routes/cases.rs:45` |
| PATCH | `/api/cases/:rid` | `patch` |  | `routes/cases.rs:45` |
| GET | `/api/cases/:rid/comments` | `list_comments` |  | `routes/cases.rs:46` |
| POST | `/api/cases/:rid/comments` | `post_comment` |  | `routes/cases.rs:46` |
| DELETE | `/api/cases/:rid/comments/:cmt_rid` | `delete_comment` |  | `routes/cases.rs:47` |
| PATCH | `/api/cases/:rid/comments/:cmt_rid` | `patch_comment` |  | `routes/cases.rs:47` |
| GET | `/api/cases/:rid/members` | `list` |  | `routes/members.rs:45` |
| POST | `/api/cases/:rid/members` | `add` |  | `routes/members.rs:45` |
| DELETE | `/api/cases/:rid/members/:member_id` | `remove` |  | `routes/members.rs:46` |
| PATCH | `/api/cases/:rid/members/:member_id` | `patch_role` |  | `routes/members.rs:46` |
| GET | `/api/cases/categories` | `list_categories` |  | `routes/cases.rs:44` |

### `/api/charts` (5)

| method | path | handler | gate | source |
|--------|------|---------|------|--------|
| GET | `/api/charts` | `list` |  | `routes/charts.rs:31` |
| POST | `/api/charts` | `create` |  | `routes/charts.rs:31` |
| DELETE | `/api/charts/:rid` | `delete_one` |  | `routes/charts.rs:32` |
| GET | `/api/charts/:rid` | `get_one` |  | `routes/charts.rs:32` |
| PUT | `/api/charts/:rid` | `update_one` |  | `routes/charts.rs:32` |

### `/api/companies` (9)

| method | path | handler | gate | source |
|--------|------|---------|------|--------|
| GET | `/api/companies` | `list` |  | `routes/companies.rs:31` |
| POST | `/api/companies` | `create` |  | `routes/companies.rs:31` |
| DELETE | `/api/companies/:rid` | `delete_one` |  | `routes/companies.rs:32` |
| GET | `/api/companies/:rid` | `get_one` |  | `routes/companies.rs:32` |
| PATCH | `/api/companies/:rid` | `patch` |  | `routes/companies.rs:32` |
| GET | `/api/companies/:rid/members` | `list` |  | `routes/members.rs:45` |
| POST | `/api/companies/:rid/members` | `add` |  | `routes/members.rs:45` |
| DELETE | `/api/companies/:rid/members/:member_id` | `remove` |  | `routes/members.rs:46` |
| PATCH | `/api/companies/:rid/members/:member_id` | `patch_role` |  | `routes/members.rs:46` |

### `/api/connectors` (6)

| method | path | handler | gate | source |
|--------|------|---------|------|--------|
| GET | `/api/connectors` | `list` |  | `routes/connectors.rs:27` |
| POST | `/api/connectors` | `create` |  | `routes/connectors.rs:27` |
| DELETE | `/api/connectors/:rid` | `remove` |  | `routes/connectors.rs:28` |
| GET | `/api/connectors/:rid` | `get_one` |  | `routes/connectors.rs:28` |
| PATCH | `/api/connectors/:rid` | `rename` |  | `routes/connectors.rs:28` |
| POST | `/api/connectors/:rid/sync` | `sync` |  | `routes/connectors.rs:29` |

### `/api/dashboards` (7)

| method | path | handler | gate | source |
|--------|------|---------|------|--------|
| GET | `/api/dashboards` | `list` |  | `routes/dashboards.rs:25` |
| POST | `/api/dashboards` | `create` |  | `routes/dashboards.rs:25` |
| DELETE | `/api/dashboards/:rid` | `delete_one` |  | `routes/dashboards.rs:26` |
| GET | `/api/dashboards/:rid` | `get_one` |  | `routes/dashboards.rs:26` |
| PATCH | `/api/dashboards/:rid` | `patch_one` |  | `routes/dashboards.rs:26` |
| PUT | `/api/dashboards/:rid` | `update` |  | `routes/dashboards.rs:26` |
| POST | `/api/dashboards/:rid/favorite` | `set_favorite` |  | `routes/dashboards.rs:27` |

### `/api/demo` (3)

| method | path | handler | gate | source |
|--------|------|---------|------|--------|
| POST | `/api/demo/avro-decode` | `avro_decode` |  | `routes/demo.rs:45` |
| POST | `/api/demo/parse` | `parse` |  | `routes/demo.rs:44` |
| POST | `/api/demo/validate` | `validate_demo` |  | `routes/demo.rs:46` |

### `/api/docs` (2)

| method | path | handler | gate | source |
|--------|------|---------|------|--------|
| GET | `/api/docs` | `index` |  | `routes/docs.rs:33` |
| GET | `/api/docs/*slug` | `render` |  | `routes/docs.rs:34` |

### `/api/events` (3)

| method | path | handler | gate | source |
|--------|------|---------|------|--------|
| GET | `/api/events` | `list` |  | `routes/events.rs:33` |
| POST | `/api/events` | `report` |  | `routes/events.rs:33` |
| GET | `/api/events/:rid` | `get_one` |  | `routes/events.rs:34` |

### `/api/files` (24)

| method | path | handler | gate | source |
|--------|------|---------|------|--------|
| GET | `/api/files` | `list_all` |  | `routes/files/mod.rs:108` |
| DELETE | `/api/files/:rid` | `delete_file` |  | `routes/files/mod.rs:110` |
| GET | `/api/files/:rid` | `get_summary` |  | `routes/files/mod.rs:110` |
| PATCH | `/api/files/:rid` | `patch_file` |  | `routes/files/mod.rs:110` |
| POST | `/api/files/:rid/cast-preview` | `state_ops::cast_preview` |  | `routes/files/mod.rs:114` |
| DELETE | `/api/files/:rid/cleanness` | `meta::clear_cleanness` |  | `routes/files/mod.rs:127` |
| POST | `/api/files/:rid/cleanness` | `meta::compute_cleanness` |  | `routes/files/mod.rs:127` |
| POST | `/api/files/:rid/clear-filters` | `state_ops::clear_filters` |  | `routes/files/mod.rs:117` |
| GET | `/api/files/:rid/dedup` | `stats::dedup` |  | `routes/files/mod.rs:119` |
| POST | `/api/files/:rid/encoding` | `meta::set_encoding` |  | `routes/files/mod.rs:118` |
| GET | `/api/files/:rid/export` | `output::export` |  | `routes/files/mod.rs:126` |
| GET | `/api/files/:rid/joins` | `joins::joins` |  | `routes/files/mod.rs:120` |
| POST | `/api/files/:rid/joins` | `joins::create_join` |  | `routes/files/mod.rs:120` |
| GET | `/api/files/:rid/page` | `get_page` |  | `routes/files/mod.rs:111` |
| POST | `/api/files/:rid/redo` | `state_ops::redo` |  | `routes/files/mod.rs:116` |
| GET | `/api/files/:rid/sentinels` | `stats::sentinels` |  | `routes/files/mod.rs:125` |
| POST | `/api/files/:rid/snapshot` | `output::snapshot` |  | `routes/files/mod.rs:123` |
| POST | `/api/files/:rid/sql` | `sql::execute` |  | `routes/files/mod.rs:121` |
| POST | `/api/files/:rid/sql/materialize` | `sql::materialize` |  | `routes/files/mod.rs:122` |
| POST | `/api/files/:rid/steps` | `add_step` |  | `routes/files/mod.rs:112` |
| POST | `/api/files/:rid/steps/preview` | `state_ops::step_preview` |  | `routes/files/mod.rs:113` |
| POST | `/api/files/:rid/undo` | `state_ops::undo` |  | `routes/files/mod.rs:115` |
| GET | `/api/files/:rid/uniques` | `stats::uniques` |  | `routes/files/mod.rs:124` |
| POST | `/api/files/upload` | `upload` |  | `routes/files/mod.rs:109` |

### `/api/group` (1)

| method | path | handler | gate | source |
|--------|------|---------|------|--------|
| POST | `/api/group/preview` | `preview` |  | `routes/group.rs:27` |

### `/api/health` (1)

| method | path | handler | gate | source |
|--------|------|---------|------|--------|
| GET | `/api/health` | `get_health` |  | `routes/health.rs:27` |

### `/api/me` (4)

| method | path | handler | gate | source |
|--------|------|---------|------|--------|
| GET | `/api/me` | `get_me` |  | `routes/me.rs:49` |
| PATCH | `/api/me` | `patch_me` |  | `routes/me.rs:49` |
| GET | `/api/me/avatar` | `get_avatar` |  | `routes/me.rs:51` |
| PATCH | `/api/me/prefs` | `patch_me_prefs` |  | `routes/me.rs:50` |

### `/api/metrics` (1)

| method | path | handler | gate | source |
|--------|------|---------|------|--------|
| GET | `/api/metrics` | `metrics` | platform_admin | `routes/metrics.rs:38` |

### `/api/monitoring` (13)

| method | path | handler | gate | source |
|--------|------|---------|------|--------|
| GET | `/api/monitoring/audit-findings` | `list_audit_findings` | platform_admin | `routes/monitoring.rs:55` |
| GET | `/api/monitoring/audit-findings/stats` | `stats_audit_findings` | platform_admin | `routes/monitoring.rs:56` |
| GET | `/api/monitoring/audit-runs` | `list_audit_runs` | platform_admin | `routes/monitoring.rs:53` |
| GET | `/api/monitoring/audit-runs/stats` | `stats_audit_runs` | platform_admin | `routes/monitoring.rs:54` |
| GET | `/api/monitoring/events` | `list_events` | platform_admin | `routes/monitoring.rs:51` |
| GET | `/api/monitoring/events/stats` | `stats_events` | platform_admin | `routes/monitoring.rs:52` |
| GET | `/api/monitoring/optimization-points` | `list_optimization_points` | platform_admin | `routes/monitoring.rs:67` |
| PATCH | `/api/monitoring/optimization-points/:rid` | `patch_optimization_point` | platform_admin | `routes/monitoring.rs:68` |
| GET | `/api/monitoring/queries` | `list_queries` | platform_admin | `routes/monitoring.rs:60` |
| GET | `/api/monitoring/request/:request_id` | `request_detail` | platform_admin | `routes/monitoring.rs:64` |
| GET | `/api/monitoring/requests` | `list_requests` | platform_admin | `routes/monitoring.rs:57` |
| GET | `/api/monitoring/requests/stats` | `stats_requests` | platform_admin | `routes/monitoring.rs:58` |
| GET | `/api/monitoring/users/:user_rid/activity` | `user_activity` | platform_admin | `routes/monitoring.rs:66` |

### `/api/objects` (5)

| method | path | handler | gate | source |
|--------|------|---------|------|--------|
| GET | `/api/objects/:type` | `list` |  | `routes/objects.rs:26` |
| POST | `/api/objects/:type` | `create` |  | `routes/objects.rs:26` |
| DELETE | `/api/objects/:type/:rid` | `delete_one` |  | `routes/objects.rs:27` |
| GET | `/api/objects/:type/:rid` | `get_one` |  | `routes/objects.rs:27` |
| PATCH | `/api/objects/:type/:rid` | `patch` |  | `routes/objects.rs:27` |

### `/api/projects` (10)

| method | path | handler | gate | source |
|--------|------|---------|------|--------|
| GET | `/api/projects` | `list` |  | `routes/projects.rs:26` |
| POST | `/api/projects` | `create_project` |  | `routes/projects.rs:26` |
| DELETE | `/api/projects/:rid` | `delete_project` |  | `routes/projects.rs:27` |
| GET | `/api/projects/:rid` | `get_one` |  | `routes/projects.rs:27` |
| PATCH | `/api/projects/:rid` | `patch_project` |  | `routes/projects.rs:27` |
| GET | `/api/projects/:rid/files` | `list_files` |  | `routes/projects.rs:28` |
| GET | `/api/projects/:rid/members` | `list` |  | `routes/members.rs:45` |
| POST | `/api/projects/:rid/members` | `add` |  | `routes/members.rs:45` |
| DELETE | `/api/projects/:rid/members/:member_id` | `remove` |  | `routes/members.rs:46` |
| PATCH | `/api/projects/:rid/members/:member_id` | `patch_role` |  | `routes/members.rs:46` |

### `/api/search` (1)

| method | path | handler | gate | source |
|--------|------|---------|------|--------|
| GET | `/api/search` | `search` |  | `routes/search.rs:35` |

### `/api/teams` (9)

| method | path | handler | gate | source |
|--------|------|---------|------|--------|
| GET | `/api/teams` | `list` |  | `routes/teams.rs:30` |
| POST | `/api/teams` | `create` |  | `routes/teams.rs:30` |
| DELETE | `/api/teams/:rid` | `delete_one` |  | `routes/teams.rs:31` |
| GET | `/api/teams/:rid` | `get_one` |  | `routes/teams.rs:31` |
| PATCH | `/api/teams/:rid` | `patch` |  | `routes/teams.rs:31` |
| GET | `/api/teams/:rid/members` | `list` |  | `routes/members.rs:45` |
| POST | `/api/teams/:rid/members` | `add` |  | `routes/members.rs:45` |
| DELETE | `/api/teams/:rid/members/:member_id` | `remove` |  | `routes/members.rs:46` |
| PATCH | `/api/teams/:rid/members/:member_id` | `patch_role` |  | `routes/members.rs:46` |

### `/api/users` (5)

| method | path | handler | gate | source |
|--------|------|---------|------|--------|
| GET | `/api/users` | `list` |  | `routes/users.rs:33` |
| POST | `/api/users` | `create` |  | `routes/users.rs:33` |
| DELETE | `/api/users/:rid` | `delete_one` |  | `routes/users.rs:34` |
| GET | `/api/users/:rid` | `get_one` |  | `routes/users.rs:34` |
| PATCH | `/api/users/:rid` | `patch` |  | `routes/users.rs:34` |

<!-- doc-gen:api:index END -->

## Conventions (hand-written)

- **Auth** — session cookie; `is_platform_admin` gate on admin routes; the
  RBAC gate per route is shown in the generated table.
- **Pagination** — `{ items, total, page, size }` envelope.
- **Errors** — `AppError` → wire shape; see [`code/backend/api/error.md`](../code/backend/api/error.md).
- **IDs** — RedPash-ID prefixes (`USR_`, `PRJ_`, `CAS_`, …); see [`stack/db`](../stack/index.md).

## Per-resource

_(one `<resource>.md` per API resource — ported from `docs/api/*` in Phase C.)_

## Source files

- [`code/backend/api/`](../code/index.md) — the route handlers (the survival-layer deep dives).
