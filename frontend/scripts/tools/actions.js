/* Purpose: see doc for details.
 * Doc: docs/internal/code/frontend/scripts/tools/actions.md */
// Tools-panel toolbar actions — slice 2 of the tools.js
// decomposition (god-object campaign, Em 2026-05-27 — broadcast.md
// 00:53). Two action lists used by the columns-view toolbar:
//
//   GLOBAL_ACTIONS — slice-B shape. No selection, no per-cell work.
//     `hasSheet` opens an in-panel modal sheet; otherwise the action
//     runs directly on Apply. `enabled(summary)` gates the button on
//     file-level state (e.g. unwrap_csv needs a single-column file).
//
//   SELECT_ACTIONS — slices C–E shape. Step(s) over the columns the
//     user picked via row checkboxes. `min` / `max` gate the button —
//     disabled when the selection size is wrong for the action.
//     `label` overrides the picker's name when it would read awkwardly
//     as a toolbar button.
//
// Apply shapes for SELECT_ACTIONS (the click handler picks one per entry):
//
//   default          — one step with `{ cols: string[] }`. Engine
//                      takes the list natively (steps.rs:
//                      arr_strings(params, "cols")). Examples:
//                      drop_columns, filter_columns, drop_nulls.
//   `colsParam: "columns"`
//                    — same one-step shape but renames the cols key
//                      for engines that already have a `cols` of
//                      their own (fix_invalid takes
//                      `columns: [string]`).
//   `hasSheet: true` — opens an in-panel sheet for extra params;
//                      selection pre-populates so column /
//                      multicolumn fields are dropped from the form
//                      (the chips ARE the column choice).
//   `perColumn: true`
//                    — fires one step per selected column with
//                      `{ ...sheetState, column: name }`. Engine
//                      takes singular `column` (fill_nulls,
//                      replace_text, …); the loop also gives one undo
//                      entry per column.
//   `mapCols(cols)`  — returns extra params derived from the picked
//                      column order — used by join_columns which
//                      needs `col1` + `col2` as distinct named
//                      params.
//
// Each entry references an existing TOOLS kind so tools.js stays the
// single source of truth for label/icon/blurb/fields/toParams. Both
// lists are module-private to the tools panel; promote the exports
// if a future surface composes the same action vocabulary.

export const GLOBAL_ACTIONS = [
  { kind: "snake_case_columns" },
  { kind: "replace_in_names",   hasSheet: true },
  { kind: "change_case",        hasSheet: true },
  { kind: "unwrap_csv",
    enabled: (summary) => (summary?.col_count ?? 0) === 1,
    disabledTitle: "Unwrap CSV needs a single-column file." },
];

export const SELECT_ACTIONS = [
  { kind: "drop_columns",   min: 1,         label: "Delete selected",          icon: "bi-trash3" },
  { kind: "filter_columns", min: 1,         label: "Keep only selected",       icon: "bi-check-square" },
  { kind: "drop_nulls",     min: 1,         label: "Drop nulls in selected",   icon: "bi-eraser" },
  { kind: "fill_nulls",     min: 1,         label: "Fill nulls in selected…",  icon: "bi-pencil-square",
    hasSheet: true, perColumn: true },
  { kind: "replace_text",   min: 1, max: 1, label: "Replace text in selected…", icon: "bi-arrow-repeat",
    hasSheet: true, perColumn: true },
  { kind: "fix_invalid",    min: 1,         label: "Fix invalid in selected…", icon: "bi-wrench-adjustable",
    hasSheet: true, colsParam: "columns" },
  { kind: "join_columns",   min: 2, max: 2, label: "Concatenate selected…",    icon: "bi-link-45deg",
    hasSheet: true, mapCols: (cols) => ({ col1: cols[0], col2: cols[1] }) },
  { kind: "split_column",   min: 1, max: 1, label: "Split selected…",          icon: "bi-scissors",
    hasSheet: true, perColumn: true },
  { kind: "format_dates",   min: 1, max: 1, label: "Format dates in selected…", icon: "bi-calendar3",
    hasSheet: true, perColumn: true },
];
