---
title: backend/crates/data/src/parse/sniff.rs
source: ../../../../../../backend/crates/data/src/parse/sniff.rs
owner: Gus
section: Internal · Code · backend · data · parse
last modified date: 2026-05-30
---

# sniff.rs

## Purpose

Preamble / delimiter sniffing + wrapped-CSV rescue.

Splits off the heuristic head of `parse_text_with_diag` (the two-pass
line scan, quote-aware delimiter count, wrapped-shape detection) and
the diagnostic-return contract (`RescueDiag`). The result of the
sniff is fed into Polars' `CsvReadOptions` to do the actual parse;
all of that lives here so `parse/mod.rs` can stay focused on the
upload-decode + pagination concerns.

## Public surface

- `pub enum RescueDiag` — enum
- `pub fn parse_text_with_diag` — function

## Drift-prone areas

- Wire shapes in `shared::` change in lockstep with this file when it consumes them; backend ↔ frontend ↔ DB seam.
- See the `//!` module documentation at the top of the source for the load-bearing invariants.

## Related

- [Backend pillar landing](../../index.md)
