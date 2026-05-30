---
title: backend/crates/data/src/export.rs
source: ../../../../../backend/crates/data/src/export.rs
owner: Gus
section: Internal · Code · backend · data
last modified date: 2026-05-30
---

# export.rs

## Purpose

Export — render a cleaned `DataFrame` to downloadable bytes.

Three formats, one signature each (`&DataFrame -> Vec<u8>`), so the
`api` export handler can pick a renderer by `?format=`:
- `to_csv`  — comma-separated, header row, UTF-8.
- `to_xlsx` — a single-sheet Excel 2007 workbook (rust_xlsxwriter).
- `to_json` — a pretty-printed array of row objects.

## Public surface

- `pub fn to_csv` — function
- `pub fn to_xlsx` — function
- `pub fn to_json` — function

## Drift-prone areas

- Wire shapes in `shared::` change in lockstep with this file when it consumes them; backend ↔ frontend ↔ DB seam.
- See the `//!` module documentation at the top of the source for the load-bearing invariants.

## Related

- [Backend pillar landing](../index.md)
