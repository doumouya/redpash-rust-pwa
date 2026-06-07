---
title: Page — Home
section: Internal
last modified date: 2026-06-07
---

# Page — Home

## Purpose

Home answers one question for a signed-in user: **"What is in my world, and let me act on it directly."** It is the command center — a single railed surface that inventories every first-class entity (people, orgs, work, data) and lets the user create, edit, delete, hide, sort, search, and filter each one without leaving the page.

Every tab routes into the same six-section body — head · chip-row · KPI strip · charts · toolbar · table — so the user learns the surface once and it holds across all eight tabs. The page is the canonical home of RedPash's "framework, not product" thesis: one generic spec (`LIST_VIEWS`) drives every entity type, and a new entity becomes a Home tab by adding one declarative entry, not by writing a new page.

## Rail groups (reality, today)

Home's rail (`HOME_GROUPS` / `HOME_TABS` in `pages/home/tabs.js`) is split into **two static groups**:

- **ORG** — `Users` · `Companies` · `Teams` · `Memberships` · `Cases`
- **DATA** — `Projects` · `Files` · `Charts`

All eight tabs are `wired: true` and live today. `Projects` (the DATA group's first tab) is `HOME_DEFAULT_TAB` — the boot fallback when no `?tab=` hash and no `homeActiveTab` pref say otherwise.

> **Important — CAS_274 Phase B has NOT shipped.** The plan is to relocate the ORG group (Users / Companies / Teams / Memberships, the privileged org-CRUD surface) onto the admin SURFACE of Monitoring (`is_platform_admin`-gated). **That move has not happened.** As of today, Home STILL owns full org CRUD alongside its data inventory. Document and treat Home as the org command center; the admin-surface relocation is a forward reference, not the current state. When Phase B lands, those four tab entries move out of `HOME_TABS` and the rail collapses to the DATA group (plus Cases, which is a `perm: "user"` tab and stays). Until then: reality is Home owns it all.

The rail also carries collapsible groups (both expanded by default — the list is short), a per-active-tab rail-foot **create button** (repointed from the tab's `createSpec`), and a hide/restore recovery surface at the tail.

## What each tab actually does

Every tab is one `LIST_VIEWS[tabKey]` spec consumed by a single generic renderer (`renderListBody` → `fetchList`). The spec declares columns, a row template, an endpoint, optional charts/chip-rows, and which mutation modes are enabled. The differences that matter:

- **Users** (`/admin/users`) — the richest tab. Inline cell-editing on most columns (display name, names, handle, email, plan, job, profile org). Two privilege-escalating editors are **platform-admin-gated** (`requiresAdmin`): the **Platform** column (`users.role` admin↔user via the CAS_D78667D1 gated `PATCH /api/admin/users/:rid`, with a backend last-admin guard that 409s on demoting the only admin) and the **Org** / **Role** columns (entity-picker over companies + chip-enum role, both PATCH the user's primary company membership). Platform-admin status is resolved once at mount from `/me` and cached for every tab switch.
- **Companies** (`/admin/companies`), **Teams** (`/admin/teams`) — org-structure inventories with create modals. Teams' create modal requires a parent company (the schema's `teams.company_id` is NOT NULL) and a `kind` of `team` (default) or `department` — department carries the single-parent / one-direct-dept-per-user invariants enforced server-side.
- **Memberships** (`/admin/memberships`) — the polymorphic edge. One membership shape spans `project` / `company` / `case` / `team` scopes, flipped via the chip-row (which drives both the list `?scope=` and the stats payload). Its create modal is the showcase of the generic field engine: `dependsOn` cascades flip the scope-picker endpoint, the RBAC-role options, AND the open-ended `context_role` job-title list per scope. Rows use a **synthetic compound rid** (`{scope}:{scope_id}:{user_id}`) because the table PK is composite; the backend delete handler parses that triple.
- **Cases** (`/cases`) — a flat sortable inventory of the same cases the `/cases` page renders as a kanban. This is the one tab whose list endpoint has **real** pagination + `?q=` / `?status=` filtering (the `/cases` route). Rows are clickable into the Cases detail page. Type / Status / Priority are chip-enum editable against the cases.rs allowlists.
- **Projects** (`/projects`) — the default tab. Note: `/api/projects` still returns a bare `{ items: [...] }` (no `Page<T>` wrapper, no real pagination/sort/filter) — `fetchList` falls back to `items` and synthesises the pager fields, and the status chip-row is a **visual placeholder** until the backend Page-conversion lands. Project charts derive client-side from the list payload (no `/projects/stats` endpoint). The owner's default project can't be deleted (backend 400); bulk-delete uses `Promise.allSettled` so that partial failure doesn't block the rest.
- **Files** (`/admin/files`) **and Charts** (`/admin/charts`) — read-inventories that route mutation elsewhere: create is a **route** to Workspace (file = upload, chart = open a CSV in the Designer), and DELETE / PATCH decouple from the list endpoint (`deleteEndpoint` / `patchEndpoint` point at `/files` and `/charts`). Rows deep-link into Workspace with project + file rid. Files' `?stage=` chip is functionally wired; the charts `?window=` chip is a placeholder.

## Business logic that lives here (the WHY)

- **One renderer, N entities.** `renderListBody` + `fetchList` are entity-agnostic; the only per-tab variation is data (`LIST_VIEWS`). This is the disposability principle made concrete — a tab is cheap to add and cheap to delete. Cell-editing, select/delete modes, hide/restore, columns picker, drag-reorder, export, sort, search, paging, and charts are all generic and opt-in per spec flag.
- **Honest capability gating.** Modes/columns/buttons appear only when their backend support exists. Chips whose `?param=` isn't wired backend-side are commented as visual placeholders (they submit but no-op). Per "unify behaviour, not names": no disabled stubs that look like options.
- **Mutually-exclusive row-intent modes.** `select`, `delete`, and `edit` are exclusive — entering one exits the others — so the single tbody click delegate has unambiguous intent (navigate vs select vs delete vs let-the-cell-focus). The delete button is dual-shape: bulk-delete the selection when select-mode has picks, otherwise toggle click-row-to-delete.
- **Hide/restore is pure display.** The per-tab `home_hidden_<tabKey>` pref filters rows at **render-time, never fetch-time** — the server always returns the full page; the hidden set is applied before tbody render. Hiding is cosmetic declutter, not an access cut (RBAC stays server-side). Restore refetches so the row's data reappears.
- **Post-fetch hook order is load-bearing.** After each tbody rewrite: `_decorateSelectMode` → `_applyColumnOrder` → `_applyHiddenColumns` → `_decorateEditMode`. Reorder must precede positional hide-indexing and edit decoration, or hide/edit land on the wrong column once a user has drag-reordered. `decorateEditMode` resolves each editable column by its live `data-col-key`, not by spec index, for this reason.
- **Cell-editor is framework-owned.** `decorateEditMode` / `saveCellEdit` are thin wrappers over `cellEditor.decorate` / `cellEditor.save` (CAS_8A210C7A). The framework owns editor-registry dispatch, the PATCH, and `data-full` maintenance; Home keeps page-specific state (undo/redo `editHistory`/`editFuture`, the session `actionLog`, and `chipRenderFor`, which bridges chip rendering until `chip-registry` lands per CAS_BF208AA8).
- **User-built charts override curated ones.** When a `home-charts.<tab>` pref exists (built on Settings), it REPLACES the tab's curated KPI/chart strip via the unified `renderChart` pipeline; empty pref falls back to the curated path unchanged.
- **State persistence.** Active tab → `homeActiveTab`; rows-per-page → `home-rowsPerPage`; per-tab hidden rows → `home_hidden_<tab>`; per-tab hidden/reordered columns → list-page storage keyed on the tab. A deep link `#/home?tab=<key>` wins over the pref; an unknown/unwired key coerces to the default rather than blanking the body.

## Source files

The code/ survival layer — start here when changing behaviour:

- [home.js](../code/frontend/scripts/pages/home.md) — the page mount, `LIST_VIEWS` specs, generic renderer, create-modal field engine, modes, hide/restore, chips/charts.
- [home/tabs.js](../code/frontend/scripts/pages/home/tabs.md) — `HOME_TABS` / `HOME_GROUPS` / `HOME_DEFAULT_TAB`; the rail vocabulary and the ORG/DATA partition (the CAS_274 Phase B move edits this file).
- [list-page.js](../code/frontend/scripts/list-page.md) — the shared six-section paint path, composite strip, pager, columns/export, drag-reorder contract.
- [framework/cell-editor.js](../code/frontend/scripts/framework/cell-editor.md) — extracted inline cell-edit decorate + save (editor registry + PATCH + `data-full`).
- [charts/render.js](../code/frontend/scripts/charts/render.md) — the unified chart render pipeline used by both curated and user-built specs.
- [topbar.js](../code/frontend/scripts/topbar.md) · [rail-footer.js](../code/frontend/scripts/rail-footer.md) · [rail-controls.js](../code/frontend/scripts/rail-controls.md) — shared chrome (topbar nav, rail-foot nav, rail collapse).
- [prefs.js](../code/frontend/scripts/prefs.md) · [api.js](../code/frontend/scripts/api.md) — pref persistence and the HTTP client every fetch goes through.
