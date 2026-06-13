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

## Active feature  *(idle — reset; next `/feature` overwrites)*
- **Request:** —
- **Case:** —   ·   **Spec doc:** —
- **Started:** —   ·   **Phase reached:** —
- **Status:** idle

## Checklist (test-first order)
- [ ] architect: spec + Case written
- [ ] CHECKPOINT 1: Em approved the spec
- [ ] tester: red tests written (1:1 with ACs) · failing
- [ ] coder: acceptance criteria implemented (atomic docs updated, tests turned green)
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
- (empty — no active run)
