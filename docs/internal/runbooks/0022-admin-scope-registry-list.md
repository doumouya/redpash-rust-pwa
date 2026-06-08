---
title: 0022 — User surfaces read admin endpoints; object lists move to the registry, shaped by the data engine ("one engine, two surfaces")
date: 2026-06-08
area: tools/admin-scope-audit + backend/crates/api/src/routes/{list_registry,objects,admin}.rs + frontend (S3, pending)
---

# 0022 — De-admin-scope user surfaces via the object registry + data engine

## Symptom / discovery

Building the dashboard Overview surfaced that Home (`#rpHomeView`, a non-admin app) lists 6 of 8
tabs from `/admin/*` endpoints — gated by `require_platform_admin_mw`, returning **all rows**. It
only "worked" because the operator is a platform admin; a real non-admin user gets **403/empty** on
Users/Companies/Teams/Memberships/Files/Charts, and an admin over-sees the whole platform where they
should see only their RBAC reach. Cases + shared cell-editor pickers borrow `/admin/users` /
`/admin/companies` the same way. A pre-RBAC holdover — RBAC is now in.

## The detector (Phase 0)

`tools/admin-scope-audit/audit.js` (+ atomic doc) — builds the import graph from `main.js` ROUTES
(`admin:true` ⇒ admin app) and flags any `/admin/*` string literal reachable from a **user** page.
Authoritative worklist: **40 leaks** — home.js 16, home/tabs.js 6, charts/home-bank.js 12 (settings
chart-customizer), cases.js 3, monitoring-bank.js 2, framework/editor-entity-picker.js 1. It is the
worklist AND the regression gate (auto-discovered by `tools/audit.sh`); it will report the 40 until
the S3 frontend repoint lands.

## Architecture (Em's calls, 2026-06-08 — "plan this properly, it's a big deal")

1. **Use the object registry** (skill `rust-object-registry-design`): route user lists through the
   generic `GET /api/objects/:type` + the type-agnostic `rbac` reach. New: a **`ListProviderRegistry`**
   (`routes/list_registry.rs`) mirroring `codec_registry` (Providers pattern, `OnceLock<HashMap>` +
   `register`/`get`). One reach-scoped delivery provider per builtin; custom types → the `entity_data`
   default. O(1) per new type, no central `match`.
2. **Use the data engine** (skill `rust-data-engine`): the server does reach **delivery** only;
   **shaping** (filter/search/sort/page) runs in the Polars **wasm** engine on the **client** — same
   engine as the Workspace table (`clientMode`/`CLIENT_ENGINE_ROW_CAP`). "One engine, two surfaces"
   ([[wasm-replaces-js]]). Server `page/size/q/sort` is the over-cap fallback only.

## Staged (plan: ~/.claude/plans/hi-need-a-plan-golden-treasure.md)

- **S1 — backend (DONE this runbook).** `ListProviderRegistry` + 6 reach providers
  (chart/file/company/team/user/membership); `GET /api/objects/:type` upgraded to dispatch
  builtin→provider / custom→`entity_data` (now paginated + reach-cascade), returns `Page<Value>`;
  `routes::list_viewer` (admin→None else principals). `db::list_charts` (owner-only) removed; `/api/charts`
  delegates to the reach core; `profile.js` reads `.rows`. **Verified** by a 2nd-instance live smoke:
  all 5 reachable providers return correct `Page<Value>` with the proven `*Summary` column keys
  (chart/file/user/company/team), no SQL/decode errors. `membership` 404s until S3 registers the type.
- **S2 — data engine.** Wire client filter/search/group wrappers (`apply_filter`/`get_distinct_values`/
  `run_sql`) into `wasm-engine.js` + `engine.worker.js` (sort/page already client-side).
- **S3 — frontend repoint (the leak closes; audit → green).** Shared client-engine list component;
  Home tabs + pickers + profile → `/api/objects/:type`; gauges client-derive (kills the `/admin/*/stats`
  leaks); register the `membership` type.
- **S4 — converge Workspace + build the dashboard Overview** (the original task) on the shared component.

## Lessons / risks

- **`all_count` must be reach-scoped, never `db::count_total`** — else a tab KPI leaks the platform
  total even when rows are scoped. Every provider scopes `all_count` like `charts_page`.
- **`Page<Value>` row keys are the frontend contract** — providers serialize the proven `*Summary`
  structs so the keys match the existing tab column specs; a renamed key blanks a cell silently.
- **No sqlx integration-test harness exists** — S1 verified by a live 2nd-instance smoke
  (`REDPASH_BIND=127.0.0.1:8799 REDPASH_DEV_LOGIN=1`, then `kill` the specific PID — never broad
  `pkill`, the shared binary runs the operator's app). A cross-tenant (non-admin) RBAC matrix needs a
  harness or a 2-user manual test — pending.

Runbook: docs/internal/runbooks/0022-admin-scope-registry-list.md
