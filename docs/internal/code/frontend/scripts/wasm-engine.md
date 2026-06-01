---
title: frontend/scripts/wasm-engine.js
source: ../../../../frontend/scripts/wasm-engine.js
owner: Torv
section: Internal · Code · Frontend · scripts
last modified date: 2026-05-30
---

# wasm-engine.js

## Purpose

Lazy loader for the data crate wasm build — main-thread AND worker-backed. The wasm bundle (~3.46 MB gzipped) lazy-loads only when first awaited — page-cold visitors pay 0 bytes. Browser stream-compiles the .wasm; engine ops are callable before download finishes. `getEngine()` binds the engine to the CURRENT thread (synchronous ops); the worker API runs the SAME engine in `engine.worker.js` so a heavy op (parse/sort over a full buffer) never freezes the tab — the edge-bench "fix #1" (the old 50k client cap was that main-thread freeze, not a compute ceiling).

## Public surface

- `getEngine()` — memoised promise to the wasm-bindgen module, bound to the current thread (sync ops). The 6 `wasm.rs` exports are listed once in `ENGINE_METHODS` (shared with the worker so they can't drift): parse_csv, parse_csv_compare, apply_filter, apply_sort, auto_clean, step_preview.
- `warmWorkerEngine()` — fire-and-forget; compile the wasm in the worker so the first real op is instant.
- `workerSort(rows, specs)` — stable multi-key sort off the main thread; resolves to the `__p` permutation only (JSON marshaling stays in the worker — minimal payload back).
- `workerCall(method, ...args)` — generic worker-backed call to a string-in/string-out engine method.
- `gateBySize(file)` / `DEMO_CAP_BYTES` — demo upload cap gate.

## Drift-prone areas

- Wasm bundle path is /wasm/data.js; built by tools/build-wasm.sh. Drift between Rust and JS wrapper shapes = silent failure.
- `ENGINE_METHODS` is the single source for both `getEngine()` and the worker proxy — add a `wasm.rs` export here once.
- The worker (`engine.worker.js`) imports THIS module's `getEngine()`; the worker-spawning code (`workerSort`/`workerCall`) must never run at import time or it would spawn a nested worker.

## Related

- [Frontend pillar landing](../../index.md)
