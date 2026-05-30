---
title: Internal · Code · Backend · api/db — atomic docs
section: Internal · Code · Backend · api · db
order: 4
last modified date: 2026-05-30
---

# api/db — atomic docs

Per-resource SQL helpers. Decomposed 2026-05-27 from a single `db.rs`
into per-resource files; `mod.rs` re-exports at `db::*` so call sites
in routes don't change. Decomposition is in flight per the source-tree
map in [REDMAP](../../../../../../REDMAP.md) — charts/dashboards/steps/
companies/events/cases land in future commits.

**Coverage at baseline (2026-05-30):** 6 atomic units, 0 documented.

## Files

| File | Atomic doc | Role |
|---|---|---|
| `mod.rs` | [mod.md](mod.md) | shared imports + count_total + remaining (charts/dashboards/steps/companies/events/cases) |
| `entities.rs` | [entities.md](entities.md) | entity-registry shared queries |
| `sessions.rs` | [sessions.md](sessions.md) | auth-cookie → user-rid lookups |
| `users.rs` | [users.md](users.md) | users table + Google-OAuth upsert + memberships join |
| `projects.rs` | [projects.md](projects.md) | projects CRUD + shared `PROJECT_SELECT` |
| `sentinels.rs` | [sentinels.md](sentinels.md) | cleanness-vocabulary promotion plumbing |

## Related

- [Crate landing](../index.md)
- [Subsystem: api-routes](../../../../subsystems/api-routes.md)
