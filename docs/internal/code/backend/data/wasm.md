---
title: backend/crates/data/src/wasm.rs
source: ../../../../../backend/crates/data/src/wasm.rs
owner: Gus
section: Internal · Code · backend · data
last modified date: 2026-05-30
---

# wasm.rs

## Purpose

`data::wasm` — wasm-bindgen wrappers for the cheap data-engine
entry points.

Compiled only for wasm32; the `api` crate depends on `data` as an
rlib and never sees this module. The wrappers are a thin marshaling
layer over JSON in / JSON out — they call the same engine functions
the server calls (`steps::apply`, `clean::auto_clean`), so the wasm
binary's content == the server engine's content. That's what makes
the Phase B size measurement honest.

## Public surface

- `pub fn start` — function
- `pub fn apply_filter` — function
- `pub fn apply_sort` — function
- `pub fn auto_clean` — function
- `pub fn parse_csv` — function
- `pub fn step_preview` — function
- `pub fn parse_csv_compare` — function

## Drift-prone areas

- Wire shapes in `shared::` change in lockstep with this file when it consumes them; backend ↔ frontend ↔ DB seam.
- See the `//!` module documentation at the top of the source for the load-bearing invariants.

## Related

- [Backend pillar landing](../index.md)
