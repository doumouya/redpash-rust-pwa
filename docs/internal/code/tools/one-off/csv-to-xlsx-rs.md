---
title: tools/csv-to-xlsx-rs/
source: ../../../../../tools/csv-to-xlsx-rs/
owner: Gus
section: Internal · Code · Tools · one-off
last modified date: 2026-05-30
---

# csv-to-xlsx-rs

## Purpose

Rust-native CSV → XLSX converter. The proof-of-concept for the
export-to-xlsx workstream — written as its own small crate
(`Cargo.toml`, `src/`) so the dep-tree and perf could be evaluated in
isolation before deciding whether to fold the functionality into
`data::export`. Replaces the older `csv-to-xlsx.py` script (which is
retired but still in the tree as historical reference).

## Public surface

- `cargo run --manifest-path tools/csv-to-xlsx-rs/Cargo.toml -- <in.csv> <out.xlsx>`.
- Standalone (does not share deps with the main workspace) — picks its own xlsx-writing crate.

## Drift-prone areas

- **Standalone Cargo** means it doesn't share `polars` / `xlsx` versions with the main workspace; version drift can land here unnoticed by the main `stack-version.sh`.
- The eventual fold into `data::export` will retire this dir; until then, both paths exist.

## Related

- `backend/crates/data/src/export.rs` — the production export path
- Sibling Python: `tools/csv-to-xlsx.py` (historical, kept for reference)
