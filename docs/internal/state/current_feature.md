# Current feature — orchestrator run-ledger

> **Ephemeral run-state only.** The orchestrator (`/feature`) writes here after every step so a
> bloated/dead session can be resumed. This is NOT the spec — the spec + acceptance criteria
> live in the **Case** (and `docs/internal/specs/<id>.md`). Do not duplicate the spec here.
> When a feature lands or is abandoned, reset this file to the template below.

---

## Active feature
- **Request:** <verbatim feature request>
- **Case:** <CAS_id or "pending">   ·   **Spec doc:** docs/internal/specs/<id>.md
- **Started:** <date>   ·   **Phase reached:** <architect | tester | coder | reviewer | ops>
- **Status:** <in_progress | awaiting-checkpoint-1 | awaiting-checkpoint-2 | escalated | landed | abandoned>

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
| tests | `cargo test --jobs 4` | <pass/fail/–> | |
| fe tests | `sh tools/test-fe.sh` | <pass/fail/–> | |
| audit | `sh tools/audit.sh` | <pass/fail/–> | |
| ci-audit | `sh tools/ci-audit/check.sh` | <pass/fail/–> | |
| build | `sh tools/build-wasm.sh` / `sh tools/health-check.sh` | <pass/fail/–> | |

## Circuit-breaker counters
- coder/gate retry budget (max 3): **0/3**
- global role-hops (max 8): **0/8**
- TEST-DRIFT round-trips (max 2): **0/2**
- **Escalation reason (if any):** <none>

## Handoff notes
<one or two lines per role hand-off: what was done, what the next role needs. Kept terse — the
detail lives in the Case `case_comment` trail.>
