---
title: Internal · Code · Backend · data/steps — atomic docs
section: Internal · Code · Backend · data · steps
order: 8
last modified date: 2026-05-30
---

# data/steps — atomic docs

Cleaning-step replay. Decomposed 2026-05-27 from a 646-line
`steps::apply` match block into per-kind-family files. `mod.rs` is the
17-arm dispatcher (`apply()`); each sibling owns its family's
implementations.

**Coverage at baseline (2026-05-30):** 6 atomic units, 0 documented.

## Files

| File | Atomic doc | Step kinds |
|---|---|---|
| `mod.rs` | [mod.md](mod.md) | `apply()` dispatcher — 17 one-line arms over the per-kind families |
| `util.rs` | [util.md](util.md) | shared helpers (column-index lookup, type coercion) |
| `rows.rs` | [rows.md](rows.md) | `drop_rows`, `drop_nulls`, `filter_rows` |
| `columns.rs` | [columns.md](columns.md) | `drop_columns`, `filter_columns`, `rename_column`, `snake_case_columns`, `replace_in_names`, `join_columns`, `split_column` |
| `cells.rs` | [cells.md](cells.md) | `set_cell`, `fill_nulls`, `cast`, `change_case`, `replace_text`, `fix_invalid`, `format_dates` |
| `structure.rs` | [structure.md](structure.md) | `unwrap_csv` (wrapped-CSV rescue path) |

## Related

- [Crate landing](../index.md)
- [Subsystem: step-engine](../../../../subsystems/step-engine.md)
- [Flow: step-apply-and-replay](../../../../flows/step-apply-and-replay.md)
- [Object model: step kinds](../../../../architecture/object-model.md)
