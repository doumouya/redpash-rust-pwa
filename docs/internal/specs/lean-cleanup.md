---
title: Spec — Lean cleanup (dead CSS/partials + RBAC-neuter + dead-route removal)
section: Internal
order: 61
last modified date: 2026-06-13
case: CAS_C8A9A3EC0935498880A468625FE3F490
type: task
area: backend/crates/api + frontend/styles
status: awaiting-checkpoint-1
---

# Spec: Lean cleanup — dead CSS/partials + backend RBAC-neuter + dead-route removal
Case: CAS_C8A9A3EC0935498880A468625FE3F490  ·  type: task  ·  area: backend/crates/api/src/{rbac.rs,routes/} + frontend/styles/

> Branch: `lean`. Full-app snapshot preserved at tag `full-app-pre-slim` + branch
> `prerelease`. This cleanup DELETES real code — the **Risks / open questions**
> section is the most important part of this spec; nothing in the DEAD column gets
> cut until Em rules on the ambiguous rows at Checkpoint 1.

## Problem / intent
RedPash is being slimmed to a **personal, single-user data tool** on the `lean`
branch. Two prior commits cut the SaaS pages (`9fac5fc`) and swept 10 orphan JS
modules. Three classes of dead weight remain: (1) CSS sheets that no live page
uses, (2) a multi-tenant RBAC machinery (per-request membership/contract queries)
that has no purpose when there is exactly one user who is always the platform
admin, and (3) whole backend route nests that only the cut pages called. This spec
pins down exactly what is LIVE vs DEAD — cross-checked against what the 5 surviving
pages actually fetch — and the cleanest neuter for the RBAC gate.

The 5 LIVE pages (`frontend/scripts/main.js:28-34`): `login`, `workspace`,
`dashboard`, `sheetwise`, `monitoring`.

## Acceptance criteria (numbered — tests map 1:1 to these)

**Frontend — CSS + partials**
- **AC-1**: Every `.css` file under `frontend/styles/` (top level **and**
  `frontend/styles/framework/`) is reachable from the `frontend/styles/main.css`
  `@import` closure (transitively). Zero CSS files exist outside that closure.
  *(Verify: enumerate the `@import` graph rooted at `main.css`; set-difference
  against `find frontend/styles -name '*.css'`. Today this is ALREADY satisfied —
  all 12 top-level + 30 framework sheets are imported — so this AC is a regression
  guard, not new deletion work. See Risk R-1.)*
- **AC-2**: Every file in `frontend/partials/` is named as a `partial:` by one of
  the 5 routes in `frontend/scripts/main.js`. No orphan partials.
  *(Verify: `frontend/partials/` contains exactly `login.html`, `workspace.html`,
  `dashboard.html`, `sheetwise.html`, `monitoring.html` — ALREADY satisfied;
  regression guard.)*
- **AC-3**: `frontend/styles/admin.css` (the `/database` admin-SQL-console sheet,
  `main.css:91`) is removed from the `main.css` `@import` list AND the file is
  deleted — UNLESS Em keeps `/database` (Risk R-3). No live page renders any
  `.rp-dbc-*` selector (verified: only `admin.css` itself + `framework-sandbox.html`
  reference them).
- **AC-4**: Each framework CSS sheet whose only consumers are (a) its own
  orphaned JS twin under `frontend/scripts/framework/` and (b)
  `framework-sandbox.html` — i.e. `comments.css`, `profile-record.css`,
  `settings-config.css`, `avatar-upload.css`, `filter-panel.css`, `tools-panel.css`
  — is EITHER deleted (sheet + its `main.css` `@import`) OR explicitly retained per
  Em's ruling (Risk R-2). The chosen disposition is the same for the sheet and its
  `@import` line (no half-deletes leaving an `@import` to a missing file, which
  blanks the cascade).

**Backend — RBAC neuter**
- **AC-5**: With the neuter in place, a request from the single dev user that hits
  any gated handler performs **zero** per-request RBAC/membership SQL — no
  `resolve_grant` / `GRANT_SQL`, no `principals`, no `load_contract`, no
  `company_of`. The gate returns `Ok(())` before touching the pool.
  *(Verify: unit test on the neutered gate asserts it returns `Ok` without a pool /
  with a pool whose query would panic; or assert no `memberships`/`company_rbac`
  query is emitted for a gated request in an integration probe.)*
- **AC-6**: `require_action`, `require_grant`, `require_view`, and the
  `require_platform_admin_mw` middleware (`routes/mod.rs:227`) all admit the request
  in single-user mode (no 404-on-deny path reachable for the dev user). The
  `/monitoring`, `/metrics`, and `/admin` nest gates pass.
- **AC-7**: After the neuter + any machinery deletion, `cargo build -p api`
  compiles green with **zero new `dead_code` warnings** attributable to this change
  (the deletion removes the now-unused fns rather than leaving them
  `#[allow(dead_code)]`). `cargo test -p api` is green.

**Backend — dead-route removal**
- **AC-8**: Every route nest in the DEAD column of the inventory table below
  (subject to Em's Checkpoint-1 ruling on the ambiguous rows) is removed: its
  `.nest(...)` line is deleted from `routes::router()` (`routes/mod.rs:252-288`),
  its `mod <name>;` is removed from `routes/mod.rs:44-67`, and its
  `routes/<name>.rs` file is deleted.
- **AC-9**: No LIVE surface regresses. Specifically, the cross-page dependencies
  survive: `/admin/users` (monitoring user-picker, `monitoring.js:967`),
  `/admin/steps/stats` (monitoring chart bank, `monitoring-bank.js:88,202`), and
  `/cases/categories` (monitoring CATALOG tab, `monitoring.js:1270` +
  `monitoring/tabs.js:62`) continue to resolve. (This is why `admin` and `cases`
  are NOT in the blanket-DEAD column — see Risk R-4/R-5.)
- **AC-10**: For every deleted route module, its atomic doc under
  `docs/internal/code/backend/api/routes/<name>.md` is deleted in the same commit
  (touch-policy), and any now-orphaned DB helper in `backend/crates/api/src/db.rs`
  (or `db_query.rs`) that no surviving handler calls is removed with its own doc
  update. No dangling `Doc:` breadcrumb is left.
- **AC-11**: `sh tools/audit.sh` reports **no NEW findings vs the lean baseline**
  captured before this work — specifically `crossing-audit` (the JS↔Rust `/api`
  seam: dangling crossings / unused endpoints) and `js-audit` (unreachable modules)
  show zero net-new dangling/unused entries introduced by the deletions, and
  `doc-coverage-audit` reports no new `missing_doc` / `wrong_breadcrumb` /
  `stale_doc`. *(Capture the baseline counts FIRST — they are the contract.)*
- **AC-12**: The 5 lean pages boot + auth + render as the dev user end-to-end:
  `/login` → `dev-login` succeeds; `/workspace` lists projects/files + opens a
  file; `/dashboard` lists + renders a chart; `/sheetwise` lists connectors;
  `/monitoring` renders all tabs INCLUDING the user-picker, the steps-stats chart,
  and the CATALOG (categories) tab. *(Verify via `tools/page-verify --pages
  workspace,dashboard,sheetwise,monitoring` per the render-proof recipe; login via
  `REDPASH_DEV_LOGIN=1`.)*

## LIVE vs DEAD backend inventory

Router source of truth: `backend/crates/api/src/routes/mod.rs:252-288` (the
`/api` nests) + `:44-67` (the `mod` decls). Classification cross-checked against
the `/api/...` calls in `frontend/scripts/pages/{workspace,dashboard,sheetwise,
monitoring,login}.js` and their imported helpers (`topbar.js`, `report.js`,
`designer.js`, `framework/rail.js`, `framework/editor-entity-picker.js`,
`charts/monitoring-bank.js`, `prefs.js`).

| Nest (mod) | Verdict | Why | File(s) |
|---|---|---|---|
| `/health` (health) | **KEEP** | liveness; harmless, used by ops | `routes/health.rs` |
| `/me` (me) | **KEEP** | boot `/me` (`main.js:45`), `/me/prefs` (`prefs.js:608`), avatar | `routes/me.rs` |
| `/auth` (auth) | **KEEP** | `dev-login` (`login.js:133`), `logout` (`topbar.js`/`framework/topbar.js`), google start/callback | `routes/auth.rs` |
| `/projects` (projects) | **KEEP** | workspace + dashboard list/create/rename + `/files` | `routes/projects.rs` |
| `/files` (files) | **KEEP** | upload/page/steps/undo-redo/sql/joins/export — the workspace core | `routes/files/*` |
| `/group` (group) | **KEEP** | `/group/preview` (`report.js:1033`, `designer.js:421`) | `routes/group.rs` |
| `/charts` (charts) | **KEEP** | dashboard charts CRUD (`dashboard.js`, `designer.js`) | `routes/charts.rs` |
| `/dashboards` (dashboards) | **KEEP** | dashboard CRUD (`dashboard.js`, `designer.js`) | `routes/dashboards.rs` |
| `/connectors` (connectors) | **KEEP** | SheetWise connectors (`sheetwise.js:285-563`) | `routes/connectors.rs` |
| `/monitoring` (monitoring) | **KEEP** | the monitoring page (every tab) | `routes/monitoring.rs` |
| `/metrics` (metrics) | **KEEP** | system observability feeding monitoring; admin-gated | `routes/metrics.rs` |
| `/events` (events) | **KEEP** | frontend error capture sink (`events.js` `installErrorCapture`) + monitoring events feed | `routes/events.rs` |
| `/search` (search) | **KEEP** | topbar omnisearch (`topbar.js:118`, `framework/omni.js:45`) | `routes/search.rs` |
| `/objects` (objects) | **KEEP** | entity picker (`framework/editor-entity-picker.js:32` → `/objects/company`) | `routes/objects.rs` |
| `/admin` (admin) | **KEEP (do NOT blanket-delete)** | monitoring depends on `/admin/users` + `/admin/steps/stats`; `cases.rs` reuses `admin::sort_clause`/`charts_page`/`group_count`. SURGICAL trim only — see R-4. | `routes/admin.rs` |
| `/cases` (cases) | **KEEP categories; trim CRUD** | monitoring depends on `/cases/categories`; the rest (case/comment CRUD, `/:rid/members` nest) is dead — see R-5. | `routes/cases.rs` |
| `/companies` (companies) | **DEAD?** | no live-page fetch found; but admin/cases SQL joins `companies` TABLE. The ROUTE looks dead; the table is not. See R-6. | `routes/companies.rs` |
| `/teams` (teams) | **DEAD?** | no live-page fetch; RBAC team-closure is being neutered → its consumers vanish. See R-6. | `routes/teams.rs` |
| `/users` (users) | **DEAD?** | no live-page fetch (monitoring uses `/admin/users`, not `/users`). See R-6. | `routes/users.rs` |
| `/demo` (demo) | **DEAD** | no live-page reference; demo-seed surface for the cut SaaS shell | `routes/demo.rs` |
| `/docs` (docs) | **DEAD** | the cut `docs` page's backend | `routes/docs.rs` |

Modules present but NOT nested in the `/api` tree (so not user-reachable as
routes), flagged for the coder to check for dead-by-removal: `charts` helpers,
`members` (only nested under `cases/:rid/members`), `list_registry`, `pagination`
(shared plumbing — KEEP), `objects`. `members` becomes dead iff the cases
`/:rid/members` nest is removed (R-5).

## RBAC-neuter approach (RECOMMENDED — Em decides at Checkpoint 1)

**Key fact** (`backend/crates/api/src/rbac.rs:226-235`): `is_platform_admin`
already fast-paths the bootstrap `dev_user` → `Ok(true)` with **no SQL**. Every
gate (`require_action` :421, `require_grant` :246, `require_view` :265) and the
`require_platform_admin_mw` middleware (`routes/mod.rs:227`) call
`is_platform_admin` FIRST and `return Ok(())` on true. In single-user mode the only
caller IS the dev user, so the multi-tenant query paths
(`resolve_grant`/`GRANT_SQL`, `principals`, `load_contract`, `company_of`,
`evaluate`) are already never the deciding path for real traffic.

**Recommended: no-op-neuter, then delete the dead machinery (two steps, one PR).**

1. **Neuter (least invasive — every handler keeps compiling).** Make the gate
   short-circuit unconditionally. Cleanest single point: change `is_platform_admin`
   to `Ok(true)` for all callers (it already does for dev_user), OR — more honest
   and self-documenting — make the four gate fns return `Ok(())` immediately:
   ```rust
   // rbac.rs — lean single-user mode: one user, always the platform admin.
   pub async fn require_action(_: &AppState, _: &str, _: &str, _: Action)
       -> Result<(), AppError> { Ok(()) }
   pub async fn require_grant(_: &AppState, _: &str, _: &str, _: &str,
       _: impl Fn(Grant) -> bool) -> Result<(), AppError> { Ok(()) }
   pub async fn require_view(_: &AppState, _: &str, _: &str, _: &str)
       -> Result<(), AppError> { Ok(()) }
   ```
   and make `require_platform_admin_mw` (`routes/mod.rs`) call `next.run(req)`
   unconditionally. Signatures are UNCHANGED so all call sites keep compiling —
   this is the safe floor (satisfies AC-5/AC-6/AC-7 alone).
2. **Delete the now-dead machinery** (the payoff). Once step 1 is green, remove the
   unreachable resolver + multi-tenant types: `resolve_grant`, `GRANT_SQL`,
   `EDGES_SQL`, `grant_edges`, `GrantEdge`, `principals`, `effective_role`, the
   `Contract` type + `load_contract` + `company_of` + `evaluate` + `Action`, and
   `Grant`/`Role` if no surviving caller remains. ALSO sweep their callers:
   `routes/mod.rs::list_viewer` (:97) and the per-handler `principals` /
   `is_platform_admin` list-scoping branches (e.g. `cases.rs:124-128`,
   `admin::charts_page` viewer arg) collapse to "no filter" in single-user mode.
   This is where the LOC actually drops. Drop is bounded by what the surviving
   handlers reference — the coder removes the closure first, then deletes whatever
   the compiler then reports unused (AC-7 guards it).

Rejected alternative: **surgically remove every gate call site.** More invasive
(touches dozens of handlers), higher regression surface, and leaves the gate fns
as no-op stubs anyway. The no-op-neuter is strictly cheaper and equally complete.

**This whole approach is a Checkpoint-1 decision for Em** (Risk R-7): the
recommendation is no-op-neuter + machinery deletion, but the depth of step 2
(delete `Role`/`Grant` too, or keep them as staged primitives per
`build-ready-dont-wire`) is Em's call.

## Scope boundaries
- **In**: dead CSS sheets (AC-1..4); RBAC gate neuter + dead-machinery deletion
  (AC-5..7); dead route-module deletion + their atomic docs + orphaned db helpers
  (AC-8..11); render-proof of the 5 pages (AC-12).
- **Out**: frontend dead-JS sweep beyond CSS/partials (the 10-module sweep is
  DONE; the orphaned `frontend/scripts/framework/{comments,profile-record,
  settings-config,avatar-upload}.js` twins are NOT in scope here — flag, don't cut,
  see R-2). Out: changing the surviving pages' behavior. Out: dropping any DB TABLE
  (admin/cases/monitoring SQL still joins `companies`/`memberships`/`users`/`cases`
  tables — table drops are a separate, riskier pass; R-6). Out: `framework-sandbox.html`
  itself (render-proof tool per memory).
- **Reuses**: the existing `is_platform_admin` dev-user fast-path as the neuter
  seam; `tools/audit.sh` (`crossing-audit` + `js-audit` + `doc-coverage-audit`) as
  the AC-11 oracle; `tools/page-verify` as the AC-12 oracle; the touch-policy
  (`docs/internal/processes/atomic-doc-plan.md`) for AC-10.

## Risks / open questions for Em
- **R-1 (CSS closure already green):** AC-1/AC-2 are already satisfied today — all
  sheets are imported, partials match the 5 routes. The real CSS dead weight is
  *imported-but-dead-by-page* (AC-3/AC-4), not *outside-the-closure*. Confirm we
  want the dead-by-page sweep (AC-3/AC-4), not just the orphan guard.
- **R-2 (framework sheets serve only orphan JS + the sandbox):** `comments.css`,
  `profile-record.css`, `settings-config.css`, `avatar-upload.css`,
  `filter-panel.css`, `tools-panel.css` are referenced only by their JS twins
  (which the 5 live pages don't import) and by `framework-sandbox.html`. Cutting
  them shrinks the cascade but may **break the framework-sandbox** (your render-proof
  surface). Keep them as staged framework primitives (`build-ready-dont-wire`), or
  cut both sheet + JS twin together? Your call — this is the largest CSS+JS chunk.
- **R-3 (`/database` page):** the prompt asks "is `database` truly unused?"
  `admin.css` is the `/database` admin-SQL-console sheet, and `/database` was in the
  cut-pages list (`9fac5fc`). No live page references `.rp-dbc-*`. Confirm `/database`
  stays cut so `admin.css` can go (AC-3). Note: the SQL CONSOLE on `/sheetwise` is a
  DIFFERENT surface (`/connectors/:rid/query`) and stays.
- **R-4 (`/admin` is NOT fully dead):** the LIVE monitoring page calls
  `/admin/users` (user-picker) and `/admin/steps/stats` (chart bank), and `cases.rs`
  imports `admin::{sort_clause, charts_page, group_count}`. Blanket-deleting `admin`
  breaks monitoring AND fails to compile cases. Options: (a) KEEP `admin.rs` whole
  (simplest, some dead handlers remain), or (b) SURGICALLY trim `admin.rs` to just
  the handlers monitoring needs + the shared plumbing cases/monitoring import. Which?
  Recommend (a) for this pass (lower risk), defer the surgical trim.
- **R-5 (`/cases` — categories LIVE, CRUD dead):** monitoring needs
  `/cases/categories`; the case/comment CRUD + `/:rid/members` nest are dead. Trim
  `cases.rs` to `list_categories` + its `db::list_categories` helper, deleting the
  rest? That also makes `members.rs` dead (only nested here). Or keep `cases.rs`
  whole for this pass? Recommend trim-to-categories only if confident; else KEEP
  whole and revisit.
- **R-6 (`/companies`, `/teams`, `/users` routes vs their TABLES):** these ROUTES
  have no live-page fetch (monitoring uses `/admin/*`, not these), so the route
  nests look DEAD. BUT the `companies`, `teams`, `memberships`, `users` TABLES are
  still joined by `admin.rs`/`cases.rs`/`monitoring.rs` SQL. Confirm we delete only
  the ROUTE modules (AC-8) and leave the tables + their `db.rs` helpers that other
  surfaces still call. A table-drop pass is explicitly OUT of scope.
- **R-7 (RBAC-neuter approach — THE decision):** approve no-op-neuter +
  machinery-deletion (recommended), and rule on how deep step 2 goes — delete
  `Role`/`Grant`/`Contract` entirely, or keep `Role`/`Grant` as staged framework
  primitives? The deeper the delete, the bigger the LOC win, but the harder to
  re-introduce multi-tenant later (the full-app snapshot at `prerelease` makes
  re-introduction cheap, which argues for the deep delete).
- **R-8 (events route + frontend error capture):** `/events` is classified KEEP
  because `events.js`'s `installErrorCapture` (armed in `main.js:23`) posts frontend
  errors there. Confirm the lean tool keeps frontend error capture (it feeds the
  monitoring Events tab). If error-capture is also being cut, `/events` POST may
  become trim-able — but the monitoring Events READ feed still needs the table.
