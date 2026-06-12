---
title: tools/test-fe.sh
source: ../../../../../tools/test-fe.sh
owner: Torv
section: Internal · Code · Tools · shell
last modified date: 2026-06-12
---

# test-fe.sh — the FE test gate

## Purpose

The single command for the frontend (vanilla JS) test gate, referenced by the
agent role chain (`tester.md` "Running tests" owns the gate-command list;
`coder.md` defers to it). Runs `node --test frontend/tests/`. While the
Phase-2 `node:test` harness doesn't exist yet, it prints an explicit
`FE gate n/a (0 tests)` notice and exits 0 instead of ENOENT-failing — before
this stub existed, the first FE feature routed through `/feature` would have
hit "No such file" on a documented gate command (review finding, see
[`specs/agent-system-review-2026-06-12.md`](../../../specs/agent-system-review-2026-06-12.md)).

## Public surface

- `sh tools/test-fe.sh [extra node --test args]` — exit 0 = green (or the
  explicit n/a notice), non-zero = red.
- Harness contract: `node:test` only (no JS test framework — repo rule);
  test files live under `frontend/tests/`.
- Runs from any cwd (cd's to the repo root itself).

## Drift-prone areas

- When `frontend/tests/` lands (Phase 2), decide whether 0 collected tests
  stays green or turns red — today's tolerant exit 0 is deliberate (matches
  the run ledger's "(n/a — backend feature)" convention).
- The gate-command list lives in `.claude/agents/tester.md` — keep this
  script referenced from there, not duplicated.
