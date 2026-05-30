---
title: backend/crates/data/src/parse/mod.rs
source: ../../../../../../backend/crates/data/src/parse/mod.rs
owner: Gus
section: Internal · Code · backend · data · parse
last modified date: 2026-05-30
---

# mod.rs

## Purpose

Byte buffer → Polars `DataFrame`.

Single entry point for the upload pipeline: `from_csv_bytes` decodes
the raw upload (encoding sniff via `super::encoding`) and feeds the
resulting text through `parse_text`. The returned tuple is
`(DataFrame, encoding_name)` — the caller persists the encoding so it
can be surfaced in the cleaner sidebar.

## Public surface

- `pub use filter` — re-export
- `pub use sniff` — re-export
- `pub fn is_excel_filename` — function
- `pub fn strip_upload_ext` — function
- `pub fn xlsx_to_csv` — function
- `pub fn from_csv_bytes` — function
- `pub fn from_csv_bytes_with_diag` — function
- `pub fn from_csv_bytes_with_encoding` — function

## Drift-prone areas

- Wire shapes in `shared::` change in lockstep with this file when it consumes them; backend ↔ frontend ↔ DB seam.
- See the `//!` module documentation at the top of the source for the load-bearing invariants.

## Related

- [Backend pillar landing](../../index.md)
