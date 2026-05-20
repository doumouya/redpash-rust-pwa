---
title: Cleaner workspace
section: Features
order: 0
last modified date: 2026-05-16
---

# Cleaner workspace

The cleaner is the centerpiece. Open a project file, see it as a
redtable (paginated), and reach for the cleaning tools sidebar to:

- **Detect encoding** — the upload pipeline calls `data::encoding::detect`
  (chardetng + BOM-first). The sidebar exposes a manual override.
- **Dedup** — full-row OR per-PK duplicates with a previewable mini-table
  + select/delete modes so the user controls what gets removed.
- **Prepare joins** — detect_join_keys port, set-overlap scoring across
  files in the same project to surface candidate keys (e.g. `matricule`).
- **Edit / Delete / Select modes** — header buttons toggle row-level
  operations. Mode state is per-tab; switching tabs resets selection.
- **Save / Undo / Redo** — every mutation appends a `project_steps` row;
  undo decrements the cursor, redo increments. Save commits the current
  cursor to the file's canonical state.
- **Cleanness score** — header pill summarising completeness, dtype
  coverage, dedup status. Recomputed after each step.

## Why Rust

The fleury project crashed the all-JS demo at ~921k rows. Moving the
table engine behind `data::parse` + `data::dtype` + `data::group_by`
means the browser only ever receives the current page (25 rows by
default) — sort, filter, search and aggregation all happen against a
Polars `LazyFrame` cached in the api crate.
