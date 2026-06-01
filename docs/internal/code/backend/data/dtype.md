---
title: backend/crates/data/src/dtype.rs
source: ../../../../../backend/crates/data/src/dtype.rs
owner: Gus
section: Internal · Code · backend · data
last modified date: 2026-06-01
---

# dtype.rs

## Purpose

Per-column type inference + light stats.

Polars already infers a *storage* type when it parses the CSV — this
module coerces that into the frontend vocabulary (`int`, `float`,
`bool`, `date`, `string`, `empty`) **and** runs a `semantic_dtype`
sniff: for a column Polars had to store as `string` because its
cells are messy (`€995,83`, `Oui`/`non`, `12/03/2024`), we sample
~50 non-null values and guess the *intended* dtype. The cleanness
scorer then docks columns where storage and semantic disagree,
proportional to how many cells fail a strict native parse.

## Public surface

- `pub fn summarize` — per-column `ColumnMeta` (storage dtype + `semantic_dtype`
  sniff + null/unique stats + sample value).
- `pub(crate) fn classify_cell(raw) -> CellKind` — coarse per-cell kind
  (`Empty`/`Numeric`/`Bool`/`Date`/`Text`) reusing the same shape checks the
  semantic sniff uses, applied at cell granularity. A bare `1`/`0` is `Numeric`,
  not `Bool` (mirrors the sniff's int-over-bool guard).
- `pub(crate) fn worst_type_drift(df) -> Option<(String, f32)>` — **hook #6**.
  Scans String columns for the *worst* one that's mostly (≥50%) one structured
  kind but not pure (<95%) — the 50–95% band `sniff_semantic_type` waves through
  as a clean string column (it only commits a semantic type at ≥80%). Returns the
  column name + its off-type fraction (∈ (0.05, 0.5]) so `structure::detect` can
  scale the penalty by severity. Consumed only by [structure.rs](structure.md).

## Drift-prone areas

- **The ≥80% sniff threshold and the 50–95% drift band are coupled.** `worst_type_drift`
  exists *because* the sniff's threshold leaves a silent gap; if you move the sniff
  threshold, re-check the drift band so they still tile the space without overlap
  or hole. Re-run `tools/wasm-bench/score-calibration.py` after either change.
- Wire shapes in `shared::` change in lockstep with this file when it consumes them; backend ↔ frontend ↔ DB seam.
- See the `//!` module documentation at the top of the source for the load-bearing invariants.

## Related

- [Backend pillar landing](../index.md)
