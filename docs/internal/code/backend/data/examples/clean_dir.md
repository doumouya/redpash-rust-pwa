---
title: backend/crates/data/examples/clean_dir.rs
source: ../../../../../../backend/crates/data/examples/clean_dir.rs
owner: Torv
section: Internal · Code · backend · data · examples
last modified date: 2026-06-01
---

# clean_dir.rs

## Purpose

Cleaning-EFFICACY harness — the regression gate for "does the tool
actually clean?". Runs each raw CSV through the standard always-safe
recipe (`clean::auto_clean` + `snake_case_columns` + coerce drift
columns to their `semantic_dtype`) and RE-scores via
`stats::cleanness_report`, so the gap to clean is visible data.

cargo run --example clean_dir -- <raw_dir>                   # raw → cleaned Δ per file
cargo run --example clean_dir -- <raw_dir> --ref <clean_dir> # raw → ours → gold reference

`--ref` pairs `raw_NNN_*.csv` ↔ `clean_NNN_*.csv` by index; `ours < ref`
means cleaning we haven't built yet. Exercises the same `steps::apply`
entry the api crate uses, so an engine regression shows as a flat /
falling Δ.

## Public surface

- Module-private helpers (no `pub` items at the top level). Entry: `main`.

## Drift-prone areas

- The recipe's drift-column filter (`int|float|date|bool`) widens as new
  coercions harden; keep it in step with `cast`'s string-source handling
  in `steps/cells.rs`.
- Reads the clean-score corpus from disk (`fleury_data_project/.../clean-score`),
  not committed — a dev / eval tool only.

## Related

- [Backend pillar landing](../../index.md)
- `score_dir.md` — the scorer-only sibling.
