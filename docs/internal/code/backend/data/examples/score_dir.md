---
title: backend/crates/data/examples/score_dir.rs
source: ../../../../../../backend/crates/data/examples/score_dir.rs
owner: Gus
section: Internal · Code · backend · data · examples
last modified date: 2026-05-30
---

# score_dir.rs

## Purpose

Dev eval harness — score every CSV in a directory through the exact
upload path (`from_csv_bytes` → `summarize` → `stats::cleanness_report`).

cargo run --example score_dir -- <dir>           # one summary line per file
cargo run --example score_dir -- <dir> -v        # also list per-column drift / mojibake / dirt

## Public surface

- Module-private helpers (no `pub` items at the top level).

## Drift-prone areas

- Wire shapes in `shared::` change in lockstep with this file when it consumes them; backend ↔ frontend ↔ DB seam.
- See the `//!` module documentation at the top of the source for the load-bearing invariants.

## Related

- [Backend pillar landing](../../index.md)
