---
title: tools/lean-cleanup-check/lean-cleanup.test.js
source: ../../../../../tools/lean-cleanup-check/lean-cleanup.test.js
owner: Torv
section: Internal · Code · Tools · lean-cleanup-check
last modified date: 2026-06-13
---

# lean-cleanup-check

## Purpose

Tester-owned, gate-shaped verification for the **lean dead-weight cleanup**
(Case `CAS_C8A9A3EC0935498880A468625FE3F490`, branch `lean`). The cleanup
DELETES real code — dead CSS sheets, dead backend route modules, and the
multi-tenant RBAC machinery that has no purpose in a single-user tool — so the
checks here are *gate-shaped, not classic unit-TDD*: each maps 1:1 to a numbered
acceptance criterion and goes from **red** (artifact still present / gate still
denies) to **green** (artifact deleted / gate neutered) as the coder lands the
deletions. The coder cannot edit this directory — that boundary is what keeps
the assertions meaningful.

This is a one-Case tool (not a recurring `*-audit/`); it is NOT auto-discovered
by `tools/audit.sh` and emits no `audit.json`. It is run directly during the
red→green→reviewer handshake and retired when the Case closes.

## Public surface

- `lean-cleanup.test.js` — `node:test` harness (node:assert/strict only; repo
  no-frameworks rule). Run: `node tools/lean-cleanup-check/lean-cleanup.test.js`.
  Tests, by AC:
  - **AC-1** — reuses `tools/css-audit` reachability as the oracle; asserts the
    lean CSS deletions leave **no half-delete** (a dangling `@import` to a sheet
    this Case removed) and **no net-new orphan** vs the committed baseline.
  - **AC-2** — `frontend/partials/*.html` set-equals the `partial:` targets of
    the 5 routes in `frontend/scripts/main.js` (regression guard).
  - **AC-3 / AC-4** — `admin.css` + the 6 orphan framework sheets
    (comments / profile-record / settings-config / avatar-upload / filter-panel /
    tools-panel) are deleted AND de-`@import`-ed.
  - **AC-7 (machinery half)** — the dead multi-tenant RBAC machinery
    (`resolve_grant` / `GRANT_SQL` / `EDGES_SQL` / `principals` / `Contract` /
    `load_contract` / `company_of` / `evaluate`) is gone from `rbac.rs`.
  - **AC-8** — every DEAD route module (demo, docs, companies, teams, users,
    members) is fully removed: `routes/<name>.rs` + its `mod` decl + its `.nest`.
  - **AC-9** — anti-over-deletion guard: the KEEP routes monitoring depends on
    (admin, cases, monitoring, metrics, …) stay nested + declared, and
    `/cases/categories` still serves.
  - **AC-10** — each deleted module's atomic doc is deleted in the same change.
- `baseline.json` — the **AC-11 audit baseline** captured on the committed
  `lean` branch BEFORE the cleanup (crossing-audit dangling/unused, js-audit
  unreachable, css-audit orphans/dangling, doc-coverage finding kinds). The
  AC-11 contract is "no NEW findings vs this baseline"; the reviewer/ops re-run
  `sh tools/audit.sh` and diff against it.

## Boundaries

- **AC-5 / AC-6** (RBAC gate behaviour) live as `#[cfg(test)] mod neuter_tests`
  in `backend/crates/api/src/rbac.rs` — the gate can only be exercised in Rust.
  They build an `AppState` over a lazy pool pointed at an unreachable DB; a gate
  that returns `Ok` for a non-dev caller without erroring is the proof of "zero
  per-request RBAC SQL". A test-only `TypeDefCache::empty()` (in
  `type_cache.rs`, `#[cfg(test)]`) lets the state be built without a live DB.
- **AC-7 (build/test green)**, **AC-11 (audit)**, **AC-12 (page-verify)** are
  existing gates the reviewer/ops run (`cargo build/test -p api`,
  `sh tools/audit.sh`, `tools/page-verify --pages workspace,dashboard,sheetwise,
  monitoring` with `REDPASH_DEV_LOGIN=1`) — named, not reimplemented here.

## Drift-prone areas

- `baseline.json` reflects the **committed** `lean` HEAD, not the shared working
  tree. A concurrent Torv's unstaged WIP (e.g. a `styles/*.css` deleted but not
  yet de-imported) can make css-audit show a foreign dangling import that is NOT
  this Case's doing — AC-1 deliberately scopes its half-delete check to the
  sheets THIS Case deletes so foreign WIP isn't mis-attributed.
- The AC-7 machinery grep strips `rbac.rs`'s `#[cfg(test)]` tail + comments
  before matching, so the neuter tests' own references to the gate fns don't
  register as live definitions. `Role` / `Grant` / `Action` are intentionally
  NOT in the hard delete-set (signatures stay, so the compiler's dead_code gate
  under AC-7 governs their depth).
