---
title: backend/crates/data/src/wasm.rs
source: ../../../../../backend/crates/data/src/wasm.rs
owner: Gus
section: Internal · Code · backend · data
last modified date: 2026-06-05
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
- `pub fn apply_group_by` — function (Reports/aggregation; `spec_json` = `shared::report::ReportSpec`)
- `pub fn dedup_detect` — function (duplicate groups over `by` keys, capped at `max_rows`)
- `pub fn get_distinct_values` — function (one column's distincts + substring filter `q`, capped at `limit`)
- `pub fn detect_join_candidates` — function (overlap-scored column-pair candidates between two row sets)
- `pub fn find_sentinels` — function (repeated placeholder/junk values + per-column counts)
- `pub fn detect_structure` — function (raw-CSV structure diagnostics; takes RAW bytes, not rows)

## Drift-prone areas

- Wire shapes in `shared::` change in lockstep with this file when it consumes them; backend ↔ frontend ↔ DB seam.
- See the `//!` module documentation at the top of the source for the load-bearing invariants.
- **Engine-completion exports (2026-06-05):** the six `apply_group_by` … `detect_structure` wrappers each call the IDENTICAL `crate::<module>` fn the `api` calls (group_by/dedup/distinct/joins/stats/structure), so server and edge stay one engine. Each added op pulls its code path into the .wasm — the +203 KB raw delta (12.32 → 12.53 MB; 3.54 MB gz) is the honest cost of "everything that could be wasm is wasm". A new wrapper is the same shape: `rows_to_df` → engine fn → `serde_json::to_string`/`df_to_rows`. `detect_structure` is the one that takes **raw bytes** (its byte-level line-ending/binary/delimiter checks need the original CSV, not parsed rows) — it re-parses internally.
- **Parse cliff (follow-up, not yet built):** browser `parse_csv` is fine to ~19 MB (<1 s warm) but freezes the main thread and OOMs the wasm32 heap (~0.5–1 GB) past a few hundred MB. The ranked lifts (from the scope analysis): (1) move parse to the existing `engine.worker.js` Web Worker (UX: spinner not frozen tab), (2) stateful `Arc<DataFrame>` handles returning only the visible page instead of all rows, (3) chunked/streaming parse for the memory ceiling. None implemented here — these wrappers are the op-coverage milestone.

## Related

- [Backend pillar landing](../index.md)
