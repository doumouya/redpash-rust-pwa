---
title: tools/ci-audit/check.sh
source: ../../../../../tools/ci-audit/check.sh
owner: Gus
section: Internal · Code · Tools · audit-suite
last modified date: 2026-05-30
---

# ci-audit

## Purpose

The CI fidelity floor. Wraps the existing audit suite
([`tools/audit.sh`](../shell/audit.md)) + the `audit.run_diff(cur,
prev)` SQL function (mig 030) into a CI-friendly exit-code wrapper —
run on every PR, fails the build when any new high-severity finding
appears since the previous baseline.

Single-script tool: this dir has a `check.sh` instead of the usual
`audit.js`, so it's not auto-discovered by `tools/audit.sh`'s glob —
it's the *runner-of-runners*, invoked from CI workflow YAML.

## Public surface

- `check.sh [baseline_run_id]` — runs the full suite, ingests `audit.json` outputs, queries `audit.run_diff()`, exits non-zero on regression.
- Outputs structured Markdown to stdout for PR comment rendering.
- Reads from `audit.run` / `audit.finding` tables (Postgres).

## Drift-prone areas

- **Baseline-run-id resolution** picks the previous main-branch run; CI branch-strategy changes need this updated.
- **Regression threshold** — currently any new finding above the suppression list. Tunable per [[audit-cadence]].
- Not part of the `tools/audit.sh` discovery glob — must be invoked explicitly.

## Related

- [Master runner: audit.sh](../shell/audit.md)
- [Spec: audit-storage-design](../../../specs/audit-storage-design.md)
- [Spec: audit-ingest-explode](../../../specs/audit-ingest-explode.md)
- [Process: audit-cadence](../../../processes/audit-cadence.md)
