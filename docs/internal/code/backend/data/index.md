---
title: Internal · Code · Backend · data — atomic docs for backend/crates/data/src/
section: Internal · Code · Backend · data
order: 6
last modified date: 2026-05-30
---

# data crate — atomic docs

Polars-backed compute layer. **No HTTP** — pure compute. Same crate
also targets WASM via `wasm-bindgen` (the `wasm.rs` wrapper) so the
landing demo can run `parse_csv` + `auto_clean` client-side without
hitting the server. CSV parsing in [`parse/`](parse/); cleaning-step
replay in [`steps/`](steps/); aggregations + stats + joins + dedup as
sibling modules.

**Coverage at baseline (2026-05-30):** 22 atomic units (13 root + 3 parse + 6 steps), 0 documented.

## Root modules

| File | Atomic doc | Role |
|---|---|---|
| `lib.rs` | [lib.md](lib.md) | crate root: re-exports, DataError, public API |
| `dtype.rs` | [dtype.md](dtype.md) | column summaries — null %, unique %, sample |
| `group_by.rs` | [group_by.md](group_by.md) | report engine — group/agg/sort/top_n/windows |
| `stats.rs` | [stats.md](stats.md) | cleanness scorer + sentinel scan + unique-value extractor + cell-diff |
| `joins.rs` | [joins.md](joins.md) | overlap-coefficient detector |
| `dedup.rs` | [dedup.md](dedup.md) | full-row + per-PK dedup |
| `clean.rs` | [clean.md](clean.md) | auto-clean pipeline (trim, sentinel replace, type drift) |
| `distinct.rs` | [distinct.md](distinct.md) | distinct-value extraction per column |
| `encoding.rs` | [encoding.md](encoding.md) | chardetng wrapper + BOM-first |
| `export.rs` | [export.md](export.md) | snapshot/export to CSV / XLSX |
| `render.rs` | [render.md](render.md) | markdown → HTML (pulldown-cmark + syntect) for `/api/docs` |
| `wasm.rs` | [wasm.md](wasm.md) | `wasm-bindgen` wrappers — `parse_csv`, `parse_csv_compare`, `apply_filter`, `apply_sort`, `auto_clean`, `step_preview` |

## Subdirs

- [`parse/`](parse/) — 3 modules: entry points, predicate-tree evaluator, sniff
- [`steps/`](steps/) — 6 modules: per-kind cleaning-step replay

## Related

- [Backend pillar landing](../index.md)
- [Subsystem: data-engine](../../../subsystems/data-engine.md)
- [Subsystem: step-engine](../../../subsystems/step-engine.md)
- [Subsystem: wasm-engine](../../../subsystems/wasm-engine.md)
