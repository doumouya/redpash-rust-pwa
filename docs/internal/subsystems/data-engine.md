---
title: Data engine
section: Internal
order: 23
last modified date: 2026-05-24
owner: Gus
status: stub
---

# Data engine

> **TODO (Gus).** Fill from `backend/crates/data/`.

To cover:

- The `data` crate's role — pure compute, zero IO, wasm-portable by accident of good design
- File layout: `parse.rs`, `steps.rs`, `clean.rs`, `dtype.rs`, `stats.rs`, `joins.rs`, `group_by.rs`, `dedup.rs`, `export.rs`, `encoding.rs`, `render.rs` (server-only)
- Polars feature matrix — server (default) vs wasm32 (default-features = false + the 6 features pinned)
- Dtype sniff: heuristics + when each kind wins
- Sentinel handling — global + per-file
- Why `render.rs` is `#[cfg(not(target_arch = "wasm32"))]`-gated
