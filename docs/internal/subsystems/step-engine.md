---
title: Step engine
section: Internal
order: 27
last modified date: 2026-05-24
owner: Gus
status: stub
---

# Step engine

> **TODO (Gus).** Fill from `data::steps`, `routes/files.rs` (apply / undo / redo / snapshot endpoints).

To cover:

- Step model: each `project_steps` row carries `kind` + `params` JSON + `applied` flag + ordinal
- Apply / replay lifecycle: persisted steps replay against the base frame on every read
- Undo / redo: walk the `applied` flag from the topmost step
- The 17-step catalog (`drop_columns`, `filter_columns`, `drop_rows`, `filter_rows`, `unwrap_csv`, `drop_nulls`, `set_cell`, `fill_nulls`, `cast`, `rename_column`, `snake_case_columns`, `replace_in_names`, `change_case`, `replace_text`, `fix_invalid`, `join_columns`, `split_column`, `format_dates`) — what each accepts
- Snapshots — when the engine materialises a copy
- See also: [flows/step-apply-and-replay.md](../flows/step-apply-and-replay.md)
