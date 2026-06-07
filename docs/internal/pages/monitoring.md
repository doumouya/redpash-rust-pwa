---
title: Page — Monitoring
section: Internal
last modified date: 2026-06-07
---

# Page — Monitoring

## Purpose

**"What is the platform doing right now, and where is it hurting?"** Monitoring is
the system-telemetry surface for the platform admin — the runtime side of
RedPash's [[audit-everything]] discipline. Every meaningful action is captured
(request_log, events, db_query_log, audit runs/findings); this page is where that
capture becomes a readable view. It is reached at `/monitoring` (authed; see the
generated route table in [pages/index.md](index.md)).

The page hosts **two top-level surfaces** behind one rail shell, toggled by a
rail-view switcher (`#rpMonRailView`, `mountRailSeg`) — the same Data ↔ Dashboard
mechanism Workspace uses:

- **`surface: "monitoring"`** — live system observability (this doc).
- **`surface: "admin"`** — Admin Console: org management / config. Covered by
  [admin-console.md](admin-console.md).

Both surfaces are rendered by the **same** `pages/monitoring.js` module; the
switcher just stamps `data-rail-view` on the rail and CSS hides the off-surface
groups. The split is the Em-locked page-purpose decision of CAS_274EDF3B
(2026-05-31): the platform-admin's surfaces all live in one shell rather than a
standalone `/admin` page.

## Admin gate (`is_platform_admin`)

The whole Admin Console surface — and the Admin Console option on the switcher —
is **platform-admin-only**. The gate is resolved once at mount via `GET /api/me`;
`is_platform_admin` is cached so every `renderRail()` reads it without
re-fetching. Mechanics worth knowing:

- It **defaults to `false`** until `/me` resolves. The `renderRail()` /
  `firstVisibleTabKey` / `activate` chain runs synchronously at mount, then the
  `/me` promise flips the flag, re-renders the rail (so the ADMIN group appears),
  reveals the switcher button (CSS-gated on the `.rp-mon-admin` class on the
  nav), and re-applies the saved rail-view (a pref of `"admin"` coerced to
  `"monitoring"` at mount is restored for an actual admin). Worst case: the admin
  group/option appears a beat late.
- It is a **UX hide, not the security boundary.** The backend `/api/admin/*`
  endpoints enforce the real auth — a non-admin who somehow selected `"admin"` is
  coerced back to `"monitoring"` and the `/admin/*` fetches would 403 regardless.
  This mirrors RedPash's standing rule that the FE display gate is cosmetic and
  the server is the real gate.

## Rail — the `surface: "monitoring"` view

Static groups, partitioned by `MON_GROUPS` / `MON_TABS` in
`pages/monitoring/tabs.js`. Each group carries a two-letter mark + colour token
and a `surface` field; `renderGroup` stamps `data-surface` so the switcher can
hide the off-surface ones. The monitoring-surface groups:

- **REQUESTS** (`RQ`) — **Requests · Events · Queries.** The HTTP + telemetry +
  DB-query layers.
- **AUDITS** (`AD`) — **Runs · Findings.** The audit-tool history captured into
  `audit_runs` / `audit_findings`.
- **OPTIMIZATION** (`OP`) — **Map.** Known optimization opportunities × live
  measurements.
- **USERS** (`US`) — **Activity.** Per-user unified activity feed.
- **CATALOG** (`CT`) — **Categories.** Reference/taxonomy data surfaced read-only.

The **ADMIN** group (`AM`, `surface: "admin"`) lives in the same `MON_TABS`
inventory but belongs to the Admin Console surface — its tabs (Cleanings /
Fields / Audit catalog) are documented in [admin-console.md](admin-console.md).
The default landing tab is `requests`; the default time window is `24h`.

### Rail behaviour
- **Hide/restore** — each wired tab carries a hide × that declutters the rail
  (pref write to `monitoring_hidden_tabs` + re-render). Per [[hide-is-display]]
  this is a **display-only** concern: hiding a tab never cuts its data source
  (the endpoint still serves charts, the activity feed, etc.) — only its rail
  entry is dropped. Hidden tabs collect in a recovery `<details>` for restore.
- **Deep-link** — an explicit `?tab=` in the hash wins even over a user's
  declutter; a bare load lands on the first still-visible wired tab.
- Disabled "coming soon" tabs (any with `wired: false`) render greyed with a
  pending-endpoint tooltip and no hide ×. Today the whole monitoring-surface
  inventory is wired.

## Surface — how the body works

Most tabs are **read-only paginated lists** sharing one generic runtime
(`renderListBody` / `fetchList`). Monitoring is read-only by design — the
entities are *tracked*, not mutated — so `modes: false` suppresses the
edit/select/delete button group entirely. The shared list shape (declared in
`LIST_VIEWS`) matches Home exactly: header → window chips (windowed tabs only) →
composite strip (charts + 2×2 KPI tiles) → toolbar (search · refresh · rows ·
columns · export) → the canonical `rp-table` with sortable headers → pager. All
list tabs consume the standard `Page<T>` shape (`{rows, page, pages, total}`);
the per-tab `itemsKey` hint lets a non-`Page<T>` response unwrap (e.g. audit
catalog returns `{tools:[…]}`).

**The lists (monitoring surface):**

- **Requests** (`/monitoring/requests`, windowed) — recent HTTP requests with a
  status-mix donut from `/monitoring/requests/stats?window=…`. Rows with a
  `request_id` are **click-to-replay**: opening a modal that fetches
  `/monitoring/request/:id` → the request line + a time-ordered event timeline
  (each event expands to its `context` JSONB). Legacy rows with NULL request_id
  stay unclickable (nothing to drill into).
- **Events** (`/monitoring/events`, windowed) — the events stream. 5xx-from-
  AppError rows carry a sanitized `context.error_chain` (redacted, capped) and
  render an expandable `<pre>` sibling row.
- **Queries** (`/monitoring/queries`) — per-query DB perf from `db_query_log`
  (duration / rows / ok|error / query template / route).
- **Runs** (`/monitoring/audit-runs`) — audit-tool run history with git sha /
  branch + a headline summarized from the run's heterogeneous `stats` JSON.
- **Findings** (`/monitoring/audit-findings`) — individual findings (run / tool /
  kind / finding key / severity).

**Known no-ops to expect (reality, not bugs):** sort chevrons flip but don't
reorder until backend `?sort=` lands; the Requests search input is structurally
present but the `?q=` backend support there is still pending (Events / Runs /
Findings / Steps already honour `?q=`).

**Dedicated renderers** (off the generic list runtime, because their shape
doesn't fit `Page<T>`):

- **Optimization → Map** (`/monitoring/optimization-points`) — known
  optimization points paired with live measurements; the KPI strip
  (Total · Open · Tipped · Done) is derived from the rows and the filter axis is
  **status** (chips: all/open/planned/done/wontfix), not a time window. Each row's
  status is an editable `<select>` that `PATCH`es the point then refetches (so the
  row re-sorts into its new bucket) — the **one mutable affordance** on the
  monitoring surface, optimistic-disable with on-error rollback. `tipped === true`
  rows tone red. Fraction units render as percentages.
- **Activity** (`/monitoring/users/:rid/activity`) — the "what is this user doing
  right now?" lens, distinct from the admin `/admin/users` org inventory. A
  debounced user picker (`/admin/users?q=…`) → a unified, server-merged timeline
  (`UNION ALL` over events + request_log, last 24h, newest first). Request rows
  click-to-replay via the same modal; event rows expand their context. Known
  event kinds map to a friendly category + icon + label; unmapped kinds degrade
  gracefully from their snake_case prefix and keep the raw kind as a tooltip.
- **Categories** (`/cases/categories`) — the case-category taxonomy, dormant but
  surfaced read-only (epic CAS_9A0C — make remaining DB objects visible). Returns
  a flat `{items}`; the renderer resolves the two-level parent_id hierarchy and
  company-vs-global scope client-side and orders parents-then-children so the flat
  table reads as a tree.

### Cross-cutting wiring
- **Charts** — the curated `kpiX` strip mounts via `createListCharts`. Slice D
  lets a user save chart specs per tab (`monitoring-charts.<tab>` pref, set in
  Settings) that **replace** the curated strip, rendered through the unified
  `renderChart` pipeline; both controllers are disposed together on tab-switch /
  window-flip.
- **Prefs** — page size from `monitoring-rowsPerPage` (own per-surface key,
  default 25, re-read each fetch); rail-view from `monitoring-railView`; column
  hide/reorder + export via the shared `wireListColumnsExport` helper.

## Source files

The per-file survival layer under `docs/internal/code/` (relative links from this
file):

- [../code/frontend/scripts/pages/monitoring.md](../code/frontend/scripts/pages/monitoring.md)
  — `monitoring.js`: the page module — rail render, admin gate, tab activation,
  the generic list runtime, the dedicated renderers, request-replay modal, and
  the render utilities.
- [../code/frontend/scripts/pages/monitoring/tabs.md](../code/frontend/scripts/pages/monitoring/tabs.md)
  — `monitoring/tabs.js`: the tab inventory (`MON_TABS`), group partition
  (`MON_GROUPS`, including the `surface` split), window options, and boot
  defaults.

See also [admin-console.md](admin-console.md) for the `surface: "admin"` view
that shares this same module and rail shell.
