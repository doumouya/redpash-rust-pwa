---
title: Internal · Code · Backend · data/parse — atomic docs
section: Internal · Code · Backend · data · parse
order: 7
last modified date: 2026-05-30
---

# data/parse — atomic docs

CSV → DataFrame. Decomposed 2026-05-27 from a single `parse.rs` into
entry points + predicate-tree evaluator + sniff. Excel files come in
via calamine → CSV string → the same Polars pipeline (`mod.rs`
delegates).

**Coverage at baseline (2026-05-30):** 3 atomic units, 0 documented.

## Files

| File | Atomic doc | Role |
|---|---|---|
| `mod.rs` | [mod.md](mod.md) | entry points: `page`, `apply_filter` dispatch, Excel→CSV via calamine |
| `filter.rs` | [filter.md](filter.md) | predicate-tree evaluator for `FilterNode` |
| `sniff.rs` | [sniff.md](sniff.md) | preamble + delimiter sniff + `RescueDiag` |

## Related

- [Crate landing](../index.md)
- [Subsystem: data-engine](../../../../subsystems/data-engine.md)
- [Spec: filter-dto](../../../../specs/filter-dto.md)
- [Flow: csv-upload-to-render](../../../../flows/csv-upload-to-render.md)
