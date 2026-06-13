# Current feature — orchestrator run-ledger

> **Ephemeral run-state only.** The orchestrator (`/feature`) writes here after every step so a
> bloated/dead session can be resumed. This is NOT the spec — the spec + acceptance criteria
> live in the **Case** (and `docs/internal/specs/<id>.md`). Do not duplicate the spec here.
> When a feature lands or is abandoned, reset this file to the template below.

---

## Last landed (most recent first)
- **CAS_26EC04CAF5934A0996B7A04C8FA55534** — `auth-audit` Cat-4 detector for unchecked
  `scope_parent_id` binds (AC-5/6, sibling of CAS_DD6F) → **done**, pushed `8699679..f5cda92`
  on `prerelease` (2026-06-08). Ran **autonomously while Em slept** — Em delegated checkpoint
  approval ("approve work during my absence"); Torv approved CP1 + CP2 under guardrails (clean
  gates, `in_review`, scoped to `tools/`+`docs/`). Chain: architect → CP1 → tester (red 10/0) →
  coder (green 10/10) → reviewer (clean) → CP2 → ops. **5 role-hops, 0 retries.** `tools/` +
  `docs/` only, no backend Rust. Remaining sibling: the **Cat-1 false-positive widening**
  (so `require_grant` is recognized by the old ownership detector too) — a **3rd sibling Case,
  unfiled.**
- **CAS_DD6F55FB1B1446138936DBF66A74DBDB** — `objects.rs` `scope_parent_id` IDOR regression
  test (AC-1–4) → **done**, pushed `e0a21cc..8699679` (2026-06-08). First full `/feature` run;
  1 reviewer→tester loop-back (teardown orphans) caught + fixed.

---

## Active feature
- **Request:** Lean dead-weight cleanup on the `lean` branch — single-user personal tool.
  REMAINING after the page cut (9fac5fc) + frontend dead-JS sweep: (1) FE — orphaned CSS not in
  the styles/main.css @import closure + partials not in scripts/main.js ROUTES; (2) BE — neuter
  RBAC to single-user always-allow + remove dead route modules/machinery for the cut surfaces
  (cases/admin/database/docs/profile/settings-prefs/memberships). Keep: workspace/dashboard/
  sheetwise/monitoring/login + their live APIs (files, projects, data ops, connectors, monitoring,
  auth+dev-login+/me, search, rail).
- **Case:** CAS_C8A9A3EC0935498880A468625FE3F490   ·   **Spec doc:** docs/internal/specs/lean-cleanup.md
- **Started:** 2026-06-13   ·   **Phase reached:** CHECKPOINT 1 (awaiting Em)
- **Status:** in_progress · branch `lean`
- **Architect finding:** admin + cases NOT fully dead (monitoring/cases.rs depend on parts) →
  surgical, not blanket. Clear-dead: demo, docs. RBAC: no-op-neuter the 4 gates + mw, then
  delete dead grant/membership machinery. 8 open questions (R-1..R-8) for Em.

## Checklist (test-first order)
- [x] architect: spec + Case written (CAS_C8A9A3EC… · specs/lean-cleanup.md)
- [x] CHECKPOINT 1: Em approved the spec ("go" — all recs; resolutions in CAS_C8A9 comment)
- [x] tester: verification gates written (1:1 with ACs) · failing (1d93558; node 21 red, rbac 3 red)
- [x] coder: bulk implemented GREEN (caa40e9) — RBAC neutered, demo/docs/companies/teams/users/members routes + cases-CRUD gone, admin.css + 6 framework CSS gone, dead grant machinery removed. cargo check 0, cargo test 102/0, node 24/25.
- [x] **AC-7 deep-delete tail RESOLVED (uncommitted, Em-directed direct cut 2026-06-14)** — the 2 TEST-DRIFT items are gone, not deferred: deleted `Contract`+impl+`load_contract`+`company_of`+`evaluate`+`contract_tests` (rbac.rs −193 LOC), the dead `internal_company_id` AppState field (state.rs) + its bootstrap internal-company seeding block + `INTERNAL_COMPANY_DEFAULT` (bootstrap.rs), and the cascade-orphaned `create_company`+`COMPANY_COLS` (db/mod.rs). `neuter_tests` literal trimmed (mechanical — field gone, no assertion change). cargo check **0 warnings**, cargo test **98/0** (the 4 obsolete contract_tests removed). Atomic docs updated (rbac/state/bootstrap/db.mod/main). `contract_tests` was the OLD CAS_0DE2DDEF test, NOT a lean AC test → tester-owned neuter_tests untouched.
- [ ] reviewer: `audit.sh` + `ci-audit` clean · coverage ok
- [ ] CHECKPOINT 2: Em approved the push
- [ ] ops: built + pushed + Case closed

## Gate results (latest attempt)
| Gate | Command | Result | Notes |
|---|---|---|---|
| tests | `cargo test --jobs 4` | – | |
| fe tests | `sh tools/test-fe.sh` | – | |
| audit | `sh tools/audit.sh` | – | |
| ci-audit | `sh tools/ci-audit/check.sh` | – | |
| build | `sh tools/build-wasm.sh` / `sh tools/health-check.sh` | – | |

## Circuit-breaker counters
- coder/gate retry budget (max 3): **0/3**
- global role-hops (max 8): **0/8**
- TEST-DRIFT round-trips (max 2): **0/2**
- **Escalation reason (if any):** none

## Handoff notes
- **Uncommitted on `lean`:** the AC-7-tail backend cut (rbac/state/bootstrap/db.mod/main + 5 atomic docs). Verified green (check 0 / test 98). Ready for reviewer → CP2 → ops, or fold into Em's next commit.
- **Pre-existing audit noise (NOT from this cut):** doc-coverage `orphan_doc ×3` + `missing_doc ×2` + `wrong_breadcrumb ×1` are an in-flight `tools/audit-suite/` reorg (uniformity-audit / tokens-audit breadcrumbs point at a new dir the docs haven't moved to) — needs the tooling-lane owner's call, not part of this Case. admin-scope audit's "1 user-surface /admin/* leak" = monitoring's `/admin/users`+`/admin/steps/stats` calls, by-design in single-user (auth-audit confirms /admin /monitoring /metrics still gated).
