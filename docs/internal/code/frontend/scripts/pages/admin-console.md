---
title: frontend/scripts/pages/admin-console.js
source: ../../../../../frontend/scripts/pages/admin-console.js
owner: Torv
section: Internal · Code · Frontend · scripts · pages
last modified date: 2026-06-07
---

# pages/admin-console.js

## Purpose

The **Admin Console** page — org management / configuration (Cleanings ·
Fields · Audit catalog), one of the **Admin app's** pages (alongside Monitoring +
Database). It was the **"admin" rail-seg surface of the old combined Monitoring
page**; **Slice B (2026-06-07)** split it out into its own route `#/admin-console`
so the Admin app's surfaces are distinct routes with a per-app topbar, not one page
with a hidden rail toggle. Platform-admin gated — `ROUTES["/admin-console"]` carries
`admin: true` (the FE route guard bounces a non-admin to `#/home`) and the backend
`require_platform_admin_mw` on the `/admin` nest is the real auth (a per-mount
`session.is_platform_admin` check also renders an honest denied surface if reached
without the claim).

**LEAN by design.** The three admin tabs are **read-only LIST_VIEWS** over
`/api/admin/{steps,fields,audit-catalog}`, so the page composes the framework rail
(`mountRail`) + the shared **list-page.js atoms** (`headHTML` / `kpiStripHTML` /
`listToolbarHTML` / `listPanel` / `setKpi` / `renderListPager` /
`wireListColumnsExport`) instead of the monitoring god-object's chart / window /
hide-restore machinery the admin tabs never used. (Note: the old monitoring "steps"
tab carried 2 charts; this lean version drops them — the table is the core, charts
are re-addable later.)

## Public surface

- `export default function adminConsole(app, { session })` — the router mount.
  Mounts the per-app topbar (`active: "admin-console"`), then the rail + body.
- **Rail (`mountRail` into `#acRail`):** one `ADMIN` group (mark `var(--rp-mauve)`)
  whose tabs are `ADMIN_TABS` — **Cleanings** (`bi-wrench`), **Fields**
  (`bi-grid-3x2-gap`), **Audit catalog** (`bi-card-checklist`). A tab click →
  `activate(id)`. Default tab = `steps` (Cleanings).
- **`ADMIN_VIEWS`** — the three list-view specs (moved verbatim from monitoring.js's
  old `LIST_VIEWS` admin entries), keyed `steps` / `fields` / `audit_catalog`. Each
  carries `{ title, icon, endpoint, columns, row }`:
  - `steps` → `/admin/steps` (File / # / Kind / Applied / When).
  - `fields` → `/admin/fields` (Object / Field / Editable / Sortable + per-RBAC-tier
    Owner / Admin / Member / Viewer access cells via `accessChip`).
  - `audit_catalog` → `/admin/audit-catalog`, which returns `{ tools: [...] }` (not
    the standard `Page<T>`), so it sets **`itemsKey: "tools"`** for `fetchList` to
    unwrap; columns are Tool / Last run / severity buckets (Total/High/Med/Low) +
    diff-vs-prev (Δ new / regressed / improved / fixed).
- **Body render path:** `activate` → `renderListBody(spec)` lays out the KPI strip
  (Total / On page / Page / Last fetch) + toolbar + `listPanel` + pager, then
  `fetchList(spec)` paginates `spec.endpoint?page=&size=&q=`.

## Drift-prone areas

- **Read-only, `modes: false`.** These are tracked entities, not mutated — the
  toolbar suppresses the edit/select/delete mode group. (The Fields tab's
  write/read/none access cells are RBAC-tier display only; a future chip-enum editor
  lands when the backend PUT slice does.)
- **Endpoint contracts with `/api/admin/*`** (gated server-side by
  `is_platform_admin` — leak-free for non-admins). The FE per-mount
  `session.is_platform_admin` check + route guard are UX gates, not the security
  boundary.
- **`spec.itemsKey` unwrap.** `audit_catalog` is the one tab whose payload isn't
  `{rows: [...]}`; `fetchList` reads `data[spec.itemsKey]` when set, else `data.rows`.
  A new admin endpoint with a non-`rows` envelope needs its own `itemsKey`.
- **Page-scoped prefs / IDs.** Rows-per-page persists under `admin-console-rowsPerPage`
  (its own key, not monitoring's); KPI / pager / tbody IDs are `ac-*`-prefixed so they
  don't collide with the monitoring page's `rp-mon-*` IDs.
- **Post-fetch hook order:** `colsCtrl.applyColumnOrder()` must fire before
  `colsCtrl.applyHiddenColumns()` so the drag-reorder lands before positional hide
  indexing — see [list-page.js](../list-page.md).
- **Local `fmtCount` / `fmtTime` / `accessChip` helpers** moved here with the admin
  tabs (module scope so `ADMIN_VIEWS` row functions can reference them); `accessChip`
  mirrors the backend `GET /api/admin/fields` cell shape (write → `rp-tone-high`,
  read → `rp-tone-mid`, none → `rp-meta` dash).

## Related

- [Frontend pillar landing](../../../index.md)
- [monitoring.js](monitoring.md) — the observability-only page this split out of (Slice B).
- [monitoring/tabs.js](monitoring/tabs.md) — the old `ADMIN` group/tabs that moved into `ADMIN_VIEWS` here.
- [rail.js](../framework/rail.md) · [list-page.js](../list-page.md) — the composed framework atoms.
- [main.js](../main.md) — the router that mounts this at `/admin-console`.
- [framework/apps.js](../framework/apps.md) — the Admin app registry that lists this page.
