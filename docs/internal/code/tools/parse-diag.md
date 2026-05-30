---
title: tools/parse-diag/
source: ../../../../tools/parse-diag/
owner: Gus
section: Internal · Code · Tools
last modified date: 2026-05-30
---

# parse-diag

## Purpose

CSV parse diagnostic / rescue debugger. A standalone Rust crate
(its own `Cargo.toml`, `src/`) that loads a problematic CSV through
the same `data::parse` pipeline the app uses, but with extensive
diagnostic logging at every stage (sniff, dialect detection, dtype
inference, rescue paths). The debugging companion when a CSV won't
parse the way you expect.

`COMPARE.md` documents the comparison view — how this tool's output
maps to the production parse path for diagnosing divergences.

## Public surface

- `cargo run --manifest-path tools/parse-diag/Cargo.toml -- <file.csv>` — full diagnostic run.
- Shared deps with the `data` crate so it sees the same Polars / encoding behavior.
- Output: per-stage findings (preamble, delimiter, header, dtype-inference, rescue invocation).

## Drift-prone areas

- **Shared with `data` crate** — when the parse pipeline changes, this
  tool must be re-pointed at the new shape OR it drifts from production.
- **Diagnostic output format** is human-prose, not parseable; if a
  future "auto-diagnose" workflow needs it, the format needs structuring.

## Related

- [`backend/crates/data/src/parse/`](../backend/data/parse/) — the production pipeline
- [Subsystem: data-engine](../../subsystems/data-engine.md)
- Excel edge cases: [`../../excel-edge-cases/index.md`](../../excel-edge-cases/index.md)
