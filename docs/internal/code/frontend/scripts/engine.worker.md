---
title: frontend/scripts/engine.worker.js
source: ../../../../frontend/scripts/engine.worker.js
owner: Torv
section: Internal · Code · Frontend · scripts
last modified date: 2026-06-01
---

# engine.worker.js

## Purpose

Dedicated module worker hosting the `data`-crate wasm engine OFF the main thread. Runs the same engine as `wasm-engine.js`'s `getEngine()`, so a heavy op (parse/sort over a full buffer) shows a spinner instead of freezing the tab — the edge-bench "fix #1" (the old 50k client cap was that main-thread freeze). The synchronous Polars calls AND the JSON marshaling run here, so only the minimal result (e.g. the sort permutation) crosses back, not the re-serialized rows.

## Public surface

- No exports — it's a worker entry point. Protocol: main thread posts `{ id, op, payload }`, worker replies `{ id, ok:true, result }` or `{ id, ok:false, error }`. The id correlation + proxy API live in `wasm-engine.js` (`warmWorkerEngine` / `workerSort` / `workerCall`).
- Ops: `__warm` (compile the wasm), `sort({rows, specs})` (stable multi-key, least-significant key first; returns each row's `__p` marker), `call({method, args})` (generic string-in/string-out passthrough).

## Drift-prone areas

- Imports `getEngine()` from `wasm-engine.js`; must stay a MODULE worker (`{ type: "module" }`) for the dynamic `import('/wasm/data.js')` to work.
- `sort`'s least-significant-key-first loop mirrors the workspace's old main-thread sort — keep the two in step (the workspace fallback path re-implements it).
- A thrown op rejects only its own call; a worker-level crash rejects all in-flight calls (see `wasm-engine.js` `onerror`) so callers can fall back.

## Related

- [Frontend pillar landing](../../index.md)
- [wasm-engine.js](wasm-engine.md)
