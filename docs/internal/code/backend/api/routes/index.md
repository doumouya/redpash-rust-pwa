---
title: Internal · Code · Backend · api/routes — atomic docs
section: Internal · Code · Backend · api · routes
order: 2
last modified date: 2026-05-30
---

# api/routes — atomic docs

One route module per resource. Router assembly is in
[`mod.rs`](mod.md); each sibling file owns the handlers, DTOs, and SQL
calls for that resource. The files-resource is large enough that it
has its own subdir: [`files/`](files/).

**Coverage at baseline (2026-05-30):** 25 atomic units, 0 documented.

## Route modules

| File | Atomic doc | Resource | Auth posture |
|---|---|---|---|
| `mod.rs` | [mod.md](mod.md) | Router assembly + ServeDir + ensure_owner + middleware | n/a |
| `health.rs` | [health.md](health.md) | `GET /api/health` | public |
| `auth.rs` | [auth.md](auth.md) | Google OAuth — start / callback / logout / dev-login | public |
| `me.rs` | [me.md](me.md) | `GET/PATCH /api/me` + `resolve_user_rid` (shared) | session |
| `projects.rs` | [projects.md](projects.md) | `/api/projects` list + per-project file list + PATCH/DELETE | session + owner |
| `files/` | [files/](files/) | upload + reads + cleaner step ops (decomposed) | session + owner |
| `charts.rs` | [charts.md](charts.md) | Chart CRUD (file_type='chart' rows) | session + owner |
| `group.rs` | [group.md](group.md) | `/api/files/:rid/group` aggregation preview/run | session + owner |
| `dashboards.rs` | [dashboards.md](dashboards.md) | Dashboard CRUD (file_type='dashboard' rows) | session + owner |
| `users.rs` | [users.md](users.md) | dev-permissive directory CRUD | session |
| `companies.rs` | [companies.md](companies.md) | companies + memberships (owner/admin/member) | session + membership |
| `cases.rs` | [cases.md](cases.md) | cases + comments + activity feed | session |
| `monitoring.rs` | [monitoring.md](monitoring.md) | `/api/monitoring/*` — requests / events / runs / findings stats | session |
| `metrics.rs` | [metrics.md](metrics.md) | Prometheus-ish metrics endpoint | public |
| `events.rs` | [events.md](events.md) | runtime observability log — capture + read API | session |
| `search.rs` | [search.md](search.md) | `/api/search` — omnisearch endpoint | session |
| `admin.rs` | [admin.md](admin.md) | admin-only routes (users/companies/files/steps stats) | session + admin |
| `demo.rs` | [demo.md](demo.md) | ephemeral no-auth parse endpoint (landing CSV demo) | public |
| `docs.rs` | [docs.md](docs.md) | `/api/docs/*` markdown viewer | public |
| `pagination.rs` | [pagination.md](pagination.md) | shared pagination DTO + parsers | n/a |

## Related

- [Crate landing](../index.md)
- [Subsystem: api-routes](../../../../subsystems/api-routes.md) — every route, what it does, owner
- [Public REDMAP — routes table](../../../../../../REDMAP.md)
