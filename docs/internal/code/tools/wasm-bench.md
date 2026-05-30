---
title: tools/wasm-bench/
source: ../../../../tools/wasm-bench/
owner: Woz
section: Internal · Code · Tools
last modified date: 2026-05-30
---

# wasm-bench

## Purpose

WASM Phase C bench harness. Measures parse-on-wasm vs server
round-trip on a representative CSV corpus. Deliverable contract:
[`architecture/roadmap-webassembly.md` §5 Phase C](../../architecture/roadmap-webassembly.md)
("an honest perf + size delta"). The data this harness produced is
what cleared the gate that unlocked Phase D of the WASM workstream.

Em (2026-05-29) also flagged this tool as the source for the richer
per-file profile data the login-page CSV demo will eventually surface
(see [`project_landing_csv_demo`](../../) workstream).

## Public surface

- `corpus/` — representative CSV fixtures (13–21 MB clean-dense).
- `fixtures/` — corner-case fixtures (sparse-wide, legacy-encoded, malformed-wrap).
- `generate-*.py` — fixture generators (stress, tricky, type-truth).
- HTML harness (the runner page) — surfaces per-file profile data: encoding/dialect sniff, dtypes, null counts, cleanness score, throughput.

## Drift-prone areas

- **Bundle-size + first-parse gate** values are in [roadmap-webassembly §5];
  this tool's numbers must keep being measured against those thresholds.
- **Corpus** must stay representative — adding a tiny fixture doesn't
  reflect production loads.

## Related

- [Architecture: roadmap-webassembly](../../architecture/roadmap-webassembly.md)
- [Subsystem: wasm-engine](../../subsystems/wasm-engine.md)
- [Spec: wasm-phase-c-spike](../../specs/wasm-phase-c-spike.md)
- Memory: [[project-landing-csv-demo]] — the wasm-bench data lands on the login modal
