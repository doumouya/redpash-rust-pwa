---
title: frontend/scripts/wasm-engine.js
source: ../../../../frontend/scripts/wasm-engine.js
owner: Torv
section: Internal · Code · Frontend · scripts
last modified date: 2026-05-30
---

# wasm-engine.js

## Purpose

Lazy loader for the data crate wasm build. The wasm bundle (~3.46 MB gzipped) lazy-loads only when getEngine() is first awaited — page-cold visitors pay 0 bytes. Browser stream-compiles the .wasm; engine ops are callable before download finishes.

## Public surface

- getEngine() — memoised promise to the wasm-bindgen module.
- Wraps the 6 wasm.rs exports: parse_csv, parse_csv_compare, apply_filter, apply_sort, auto_clean, step_preview.

## Drift-prone areas

- Wasm bundle path is /wasm/data.js; built by tools/build-wasm.sh. Drift between Rust and JS wrapper shapes = silent failure.

## Related

- [Frontend pillar landing](../../index.md)
