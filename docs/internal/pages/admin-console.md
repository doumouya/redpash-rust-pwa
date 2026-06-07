---
title: Page — Admin Console (Monitoring admin surface)
section: Internal
last modified date: 2026-06-07
---

# Page — Admin Console (Monitoring admin surface)

## Purpose

The ONE question this surface answers: **"As a platform admin, what is the
state of the framework's own configuration and self-audit?"** — the
cleanings that have run against uploaded files, the per-(object, field) RBAC
matrix, and the audit-tool catalog. It is the org-management / config lens,
distinct from Monitoring's system-observability lens ("what is happening
live").

## It is NOT a separate page

Admin Console has **no route of its own**. There is no `/admin-console`,
no `pages/admin-console.js` — grep `main.js` ROUTES and you will not find
one. It is the `surface:"admin"` rail-view **of `/monitoring`**, reached by
toggling the rail-view switcher (`#rpMonRailView`) from "Monitoring" to
"Admin Console". This is the exact same mechanism Workspace uses for its
Data ↔ Dashboards segmented control (`mountRailSeg` → `data-rail-view` on
the rail → CSS hides the off-surface groups). One page, two surfaces; the
admin surface is just the half of the rail tagged `surface:"admin"`.

The Em-locked page-purpose split that put it here (CAS_274EDF3B,
2026-05-31) was deliberate: rather than a standalone `/admin` page, all of
the platform-admin's surfaces live inside the Monitoring shell, so an admin
flips a switcher instead of navigating away.

## Admin gating — why the FE gate is only a hide

The whole ADMIN rail group is gated on `is_platform_admin`. On mount,
`monitoring.js` fires `GET /api/me` once, caches `isPlatformAdmin`, then
(a) reveals the Admin Console switcher button (CSS-gated on the
`.rp-mon-admin` class), (b) re-renders the rail so `renderRail()`'s
`MON_GROUPS.filter(g => g.name !== "ADMIN" || isPlatformAdmin)` lets the
group through, and (c) re-applies the saved rail-view (a pref of `"admin"`
is coerced back to `"monitoring"` until the admin flag resolves, then
restored). A non-admin never sees the switcher button and cannot select the
admin surface — selecting `"admin"` while `!isPlatformAdmin` snaps back to
`"monitoring"`.

Critically, **this FE behavior is a UX hide, not the security boundary.**
Every admin tab's data comes from an `/api/admin/*` endpoint that enforces
the real authorization server-side. If `/me` is slow the worst case is the
group appearing a beat late for a genuine admin — there is no privilege
leak, because a non-admin hitting `/api/admin/*` directly is rejected by
the backend regardless of what the rail shows. This is the same discipline
as the CSS hide/restore for decluttered tabs: display state never gates
access.

## What actually ships (three tabs)

The ADMIN group (`mark: "AM"`, mauve) ships **exactly three wired tabs**,
all read-only today. Each is a standard `LIST_VIEWS` entry routed through
the shared list renderer (`renderListBody` → `fetchList`), so they inherit
the same KPI strip, search box, rows-per-page pref
(`monitoring-rowsPerPage`), columns picker, export, and pager as every
other Monitoring list tab. None uses a window chip (`useWindow: false`).

- **Cleanings** (`steps`, `bi-wrench` → `GET /api/admin/steps`) — one row
  per applied/queued clean step against an uploaded file (file · ordinal ·
  kind · applied · when). Carries two charts: a top-10 by-kind horizontal
  bar and an "active last 24h" gauge. This is the tab that was *moved* onto
  the admin surface in Phase A (it previously lived elsewhere); "Cleanings"
  is its admin-facing label, `steps` its internal key.
- **Fields** (`fields`, `bi-grid-3x2-gap` → `GET /api/admin/fields`) — the
  RBAC field matrix: one row per (object, field) pair, with `is_editable` /
  `is_sortable` flags and a write|read|none access chip per tier (Owner /
  Admin / Member / Viewer). **Read-only by design today** — the edit path
  (PUT) is slice 2, not yet wired; the chip-enum framework and a
  `col.editEndpoint` override are staged to drop in when PUT lands. This is
  the FE consumer of the backend's `field_perms` contract.
- **Audit catalog** (`audit_catalog`, `bi-card-checklist` →
  `GET /api/admin/audit-catalog`) — one row per audit tool with severity
  buckets (total / high / med / low) and a diff-vs-previous-run delta block
  (new / regressed / improved / fixed). This endpoint returns
  `{ tools: [...] }`, not the standard `Page<T>`, so its view spec sets
  `itemsKey: "tools"` and `fetchList` unwraps that key instead of `rows`.

## What is NOT here yet (Phase B pending)

The CAS_274EDF3B design names more admin surfaces, but **they have not
shipped to this rail-view.** Do not document them as present. As of today:

- **Users / Companies / Teams / Memberships** still live on **Home's** ORG
  group — Phase B (moving org CRUD off Home onto the admin surface) has not
  landed. (See `pages/home.md`.)
- **TypeDefinitions, Field-Permissions editing, and RBAC introspection**
  are drafted but not on the admin surface. RBAC introspection is slated as
  a custom panel (not a redtable list) in its own commit; field-perm
  *editing* is the slice-2 PUT path above.

The shipped admin surface is the three read-only tabs and nothing more.

## Relationship to the rest of Monitoring

The admin surface shares the page's entire machinery with the
`surface:"monitoring"` groups (REQUESTS / AUDITS / OPTIMIZATION / USERS /
CATALOG): the same rail collapse, the same per-tab hide/restore declutter
(pure display state, never a data cut), the same `?tab=` deep-link
activation, and the same generic list runtime. Tab definitions for both
surfaces live in one inventory (`MON_TABS` / `MON_GROUPS`); the only thing
that separates "Admin Console" from "Monitoring" is the `surface` field on
each group and the rail-view switcher that toggles which surface is shown.
For the system-observability half of the same page, see
[monitoring.md](monitoring.md).

## Source files

- [../code/frontend/scripts/pages/monitoring.md](../code/frontend/scripts/pages/monitoring.md)
  — the page controller: `/me` admin gate, the rail-view switcher
  (`mountRailSeg`), `renderRail`/`renderGroup` group filtering, the
  `LIST_VIEWS` specs for `steps` / `fields` / `audit_catalog`, and the
  shared `renderListBody`/`fetchList` runtime (incl. the `itemsKey` unwrap).
- [../code/frontend/scripts/pages/monitoring/tabs.md](../code/frontend/scripts/pages/monitoring/tabs.md)
  — the data-only tab inventory: `MON_TABS` (the ADMIN group's three
  `/admin/*` entries) and `MON_GROUPS` (the `surface:"admin"` partition).
- [../code/frontend/scripts/rail-controls.md](../code/frontend/scripts/rail-controls.md)
  — `mountRailSeg`, the segmented control that drives the Monitoring ↔
  Admin Console surface toggle.
