// Report builder vocabulary — slice 7 of the god-object decomposition
// (Em 2026-05-27 — broadcast.md 00:53). Mirror of slices 4-6's
// label/tab extracts; pure data, module-private, structural-only.
//
// Five exports cover the aggregation + window-function + tuning
// vocabulary the report builder UI surfaces:
//
//   AGG_FNS — 11-entry [value, label] pair list for aggregation
//     dropdowns. Values match `shared::report::AggFn` verbatim
//     (snake_case enum the backend expects).
//
//   WINDOW_FN_GROUPS — two-group split of window functions:
//     - Aggregate: sum / mean / count / min / max — operate on a
//       column within a partition; can express "% of partition" via
//       `as_percent`.
//     - Value:     lag / lead / first_value / last_value — positional
//       window kinds; require `order_by`. Both shapes come from
//       `shared::report::WindowSpec`.
//
//   WINDOW_VALUE_FNS — Set membership test for the four value-kind
//     names. Used to gate `order_by` field visibility in the UI.
//
//   WINDOW_OFFSET_FNS — Set membership test for the two offset-
//     accepting kinds (lag / lead). Gates the `offset` field.
//
//   PREVIEW_DEBOUNCE_MS — 300 ms. Every spec mutation calls
//     previewSoon(), which collapses bursts into one
//     /group/preview round-trip. Historic Phase-3 default; fast
//     enough to feel live, slow enough that typing an alias doesn't
//     fire per-keystroke.
//
// Module-private to report.js today; promote if a future surface
// composes the same vocabulary (e.g. a dashboard widget builder
// that re-uses the aggregation dropdown).

export const AGG_FNS = [
  ["count",          "Count"],
  ["count_distinct", "Count distinct"],
  ["sum",            "Sum"],
  ["mean",           "Mean"],
  ["min",            "Min"],
  ["max",            "Max"],
  ["first",          "First"],
  ["last",           "Last"],
  ["median",         "Median"],
  ["q1",             "Q1 (25%)"],
  ["q3",             "Q3 (75%)"],
];

export const WINDOW_FN_GROUPS = [
  ["Aggregate", [["sum","Sum"], ["mean","Mean"], ["count","Count"],
                 ["min","Min"], ["max","Max"]]],
  ["Value",     [["lag","Lag"], ["lead","Lead"],
                 ["first_value","First value"], ["last_value","Last value"]]],
];

export const WINDOW_VALUE_FNS = new Set(["lag","lead","first_value","last_value"]);
export const WINDOW_OFFSET_FNS = new Set(["lag","lead"]);

export const PREVIEW_DEBOUNCE_MS = 300;
