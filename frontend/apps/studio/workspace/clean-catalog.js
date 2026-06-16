/* clean-catalog — THE data-cleaner's operation palette as DATA. Reading THIS
   ONE file reveals the whole product: every cleaning operation, what it does,
   what it needs, and where it applies. Each `id` is the exact step `kind` the
   backend data crate dispatches (backend/crates/data/src/steps/*), and each
   field `key` is the exact param that step reads — so the UI builds a step body
   straight from this catalog with no per-op glue. The Clean panel + the toolbar
   quick-actions both render from here; a new op is one entry (+ its Rust step).

   entry = {
     id,                 // = step kind (POST /files/:rid/steps { kind, params })
     label, icon,        // UI
     scope,              // "global" (no selection) | "column" (acts on selected columns)
     min?, max?,         // selection-count gate for scope:"column" (default min 1)
     fields?,            // params-schema rendered by the action-sheet (field.js):
                         //   { key, type:"text"|"number"|"enum"|"bool"|"sentinels",
                         //     label, options?:[[value,label]], default?, placeholder? }
     build(sel, vals),   // (selectedColumnNames, fieldValues) -> params object for the step
   }
   The `value`-less global ops have no fields; column ops thread the selection
   into the param the engine expects (cols / column / from / col1+col2 …).      */

const one = (sel) => sel[0];

export const CLEAN_OPS = [
  // ── global (whole-file; no selection) ──────────────────────────────────────
  {
    id: "snake_case_columns", label: "snake_case headers", icon: "bi-fonts",
    scope: "global", fields: [], build: () => ({}),
  },
  {
    id: "replace_in_names", label: "Replace in column names…", icon: "bi-input-cursor-text",
    scope: "global",
    fields: [
      { key: "find", type: "text", label: "Find", placeholder: "text in names" },
      { key: "replace", type: "text", label: "Replace with", placeholder: "(blank to remove)" },
    ],
    build: (_sel, v) => ({ find: v.find ?? "", replace: v.replace ?? "" }),
  },
  {
    id: "change_case", label: "Change case (values)…", icon: "bi-type",
    scope: "global",
    fields: [{ key: "mode", type: "enum", label: "Case", options: [["lower", "lowercase"], ["upper", "UPPERCASE"]], default: "lower" }],
    build: (_sel, v) => ({ mode: v.mode ?? "lower" }),
  },
  {
    id: "unwrap_csv", label: "Unwrap embedded CSV", icon: "bi-box-arrow-up",
    scope: "global", fields: [], build: () => ({}),
  },

  // ── column-scoped (act on the selected columns) ─────────────────────────────
  {
    id: "drop_columns", label: "Delete selected", icon: "bi-trash3",
    scope: "column", min: 1, fields: [], build: (sel) => ({ cols: sel }),
  },
  {
    id: "filter_columns", label: "Keep only selected", icon: "bi-check-square",
    scope: "column", min: 1, fields: [], build: (sel) => ({ cols: sel }),
  },
  {
    id: "drop_nulls", label: "Drop rows with empty in selected", icon: "bi-eraser",
    scope: "column", min: 1, fields: [], build: (sel) => ({ cols: sel }),
  },
  {
    id: "fill_nulls", label: "Fill empties in selected…", icon: "bi-pencil-square",
    scope: "column", min: 1,
    fields: [
      { key: "strategy", type: "enum", label: "With", options: [["fixed", "a value"], ["forward", "previous value"], ["zero", "zero"]], default: "fixed" },
      { key: "value", type: "text", label: "Value", placeholder: "when “a value”" },
    ],
    // single-column param shape; the orchestrator issues one step per selected col.
    build: (sel, v) => ({ column: one(sel), strategy: v.strategy ?? "fixed", value: v.value ?? "" }),
  },
  {
    id: "replace_text", label: "Find & replace in selected…", icon: "bi-arrow-repeat",
    scope: "column", min: 1, max: 1,
    fields: [
      { key: "find", type: "text", label: "Find" },
      { key: "replace", type: "text", label: "Replace with", placeholder: "(blank to remove)" },
      { key: "is_regex", type: "bool", label: "Regular expression", default: false },
    ],
    build: (sel, v) => ({ column: one(sel), find: v.find ?? "", replace: v.replace ?? "", is_regex: !!v.is_regex }),
  },
  {
    id: "cast", label: "Change type…", icon: "bi-shuffle",
    scope: "column", min: 1, max: 1,
    fields: [{ key: "dtype", type: "enum", label: "To type", options: [["str", "Text"], ["int", "Integer"], ["float", "Decimal"], ["bool", "Boolean"], ["date", "Date"]], default: "str" }],
    build: (sel, v) => ({ column: one(sel), dtype: v.dtype ?? "str" }),
  },
  {
    id: "rename_column", label: "Rename…", icon: "bi-pencil",
    scope: "column", min: 1, max: 1,
    fields: [{ key: "to", type: "text", label: "New name" }],
    build: (sel, v) => ({ from: one(sel), to: v.to ?? "" }),
  },
  {
    id: "split_column", label: "Split…", icon: "bi-distribute-horizontal",
    scope: "column", min: 1, max: 1,
    fields: [
      { key: "sep", type: "text", label: "Separator", default: "," },
      { key: "keep_original", type: "bool", label: "Keep original column", default: false },
    ],
    build: (sel, v) => ({ column: one(sel), sep: v.sep ?? ",", keep_original: !!v.keep_original }),
  },
  {
    id: "join_columns", label: "Combine…", icon: "bi-distribute-vertical",
    scope: "column", min: 2, max: 2,
    fields: [
      { key: "sep", type: "text", label: "Separator", default: " " },
      { key: "new_name", type: "text", label: "New column name" },
    ],
    build: (sel, v) => ({ col1: sel[0], col2: sel[1], sep: v.sep ?? " ", new_name: v.new_name || `${sel[0]}_${sel[1]}` }),
  },
  {
    id: "format_dates", label: "Format dates…", icon: "bi-calendar-date",
    scope: "column", min: 1, max: 1,
    fields: [
      { key: "fmt", type: "text", label: "Format", placeholder: "%Y-%m-%d", default: "%Y-%m-%d" },
      { key: "on_incomplete", type: "enum", label: "If unparseable", options: [["null", "blank it"], ["drop", "drop the row"], ["keep", "keep as-is"]], default: "null" },
    ],
    build: (sel, v) => ({ column: one(sel), fmt: v.fmt || "%Y-%m-%d", on_incomplete: v.on_incomplete ?? "null" }),
  },
  {
    id: "fix_invalid", label: "Fix invalid values…", icon: "bi-bandaid",
    scope: "column", min: 1,
    fields: [{ key: "sentinels", type: "sentinels", label: "Treat as invalid", placeholder: "N/A, -, ??? …" }],
    build: (sel, v) => ({ columns: sel, sentinels: v.sentinels ?? [] }),
  },
];

/** Lookup by step kind. */
export const cleanOp = (id) => CLEAN_OPS.find((o) => o.id === id) ?? null;

/** Whether an op is currently runnable for a given selection count. */
export function opEnabled(op, selectionCount) {
  if (op.scope === "global") return true;
  const min = op.min ?? 1;
  const max = op.max ?? Infinity;
  return selectionCount >= min && selectionCount <= max;
}
