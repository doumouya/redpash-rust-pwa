/* Purpose: see doc for details.
 * Doc: docs/internal/code/frontend/scripts/tools/catalog.md */
// Tools-panel 12-tool catalog — slice 3 of the tools.js decomposition
// (god-object campaign, Em 2026-05-27 — broadcast.md 00:53).
//
// Each entry is a tool definition consumed by the form-renderer +
// click handler in tools.js. Shape:
//
//   {
//     kind:    string        // matches the server step kind verbatim
//     label:   string        // picker text
//     icon:    string        // Bootstrap-icon class
//     blurb:   string        // one-line description shown under the
//                            //   label + on hover
//     fields:  Field[]       // form fields (typed via tools/fields.js
//                            //   FIELDS keys: column / enum / text /
//                            //   boolean / multicolumn)
//     toParams(state): obj   // composes the form state into the JSON
//                            //   body POSTed to /api/files/:rid/steps
//   }
//
// Same `kind` lands on the wire as the step kind, so the JS↔Rust
// crossing names line up (per js-rust-boundary.md). Order matters —
// it's the order shown in the picker.
//
// `defineTool` is a pass-through identity function (returns its
// argument). Today it earns its keep as documentation (the call
// site names "this is a tool definition, not a random object") +
// it gives future shape-validation a single insertion point.
//
// Module-private to the tools panel: consumed at `tools.js`'s
// `getTool(kind)` + form-rendering dispatch. Promote the exports if
// a future surface composes the same tool vocabulary (e.g. a
// command-palette that lists every cleaning operation).

function defineTool(t) { return t; }

export const TOOLS = [
  defineTool({
    kind: "drop_nulls",
    label: "Drop nulls",
    icon: "bi-funnel",
    blurb: "Remove rows where the chosen column is empty.",
    fields: [{ type: "column", key: "column", label: "Column" }],
    toParams: (s) => ({ column: s.column }),
  }),

  defineTool({
    kind: "fill_nulls",
    label: "Fill nulls",
    icon: "bi-droplet-half",
    blurb: "Replace empty cells with a fixed value, zero, or carry forward.",
    fields: [
      { type: "column", key: "column", label: "Column" },
      { type: "enum", key: "strategy", label: "Strategy", options: [
        ["fixed", "Fixed value"], ["zero", "Zero (numeric)"], ["forward", "Forward fill"],
      ]},
      { type: "text", key: "value", label: "Value", placeholder: "(used when strategy = Fixed value)" },
    ],
    toParams: (s) => ({ column: s.column, strategy: s.strategy, value: s.value }),
  }),

  defineTool({
    kind: "cast",
    label: "Change type",
    icon: "bi-arrow-left-right",
    blurb: "Cast a column to a different data type.",
    fields: [
      { type: "column", key: "column", label: "Column" },
      { type: "enum", key: "dtype", label: "Target type", options: [
        ["int", "Integer"], ["float", "Float"], ["str", "String"], ["bool", "Boolean"],
        ["date", "Date"], ["datetime", "Datetime"], ["time", "Time"],
      ]},
    ],
    toParams: (s) => ({ column: s.column, dtype: s.dtype }),
  }),

  defineTool({
    kind: "rename_column",
    label: "Rename column",
    icon: "bi-pencil",
    blurb: "Rename one column.",
    fields: [
      { type: "column", key: "from", label: "Column" },
      { type: "text", key: "to", label: "New name", placeholder: "new_column_name" },
    ],
    toParams: (s) => ({ from: s.from, to: s.to }),
  }),

  defineTool({
    kind: "drop_columns",
    label: "Drop columns",
    icon: "bi-trash3",
    blurb: "Remove one or more columns from the file.",
    fields: [
      { type: "multicolumn", key: "cols", label: "Columns to drop" },
    ],
    toParams: (s) => ({ cols: s.cols || [] }),
  }),

  defineTool({
    kind: "filter_columns",
    label: "Keep columns",
    icon: "bi-check-square",
    blurb: "Keep only the selected columns, drop the rest.",
    fields: [
      { type: "multicolumn", key: "cols", label: "Columns to keep" },
    ],
    toParams: (s) => ({ cols: s.cols || [] }),
  }),

  defineTool({
    kind: "snake_case_columns",
    label: "Snake-case all columns",
    icon: "bi-fonts",
    blurb: "Convert every column name to snake_case. No options.",
    fields: [],
    toParams: () => ({}),
  }),

  defineTool({
    kind: "replace_in_names",
    label: "Replace in column names",
    icon: "bi-input-cursor-text",
    blurb: "Find and replace text across every column name.",
    fields: [
      { type: "text", key: "find", label: "Find", placeholder: "text or pattern" },
      { type: "text", key: "replace", label: "Replace with", placeholder: "(blank to remove)" },
    ],
    toParams: (s) => ({ find: s.find, replace: s.replace }),
  }),

  defineTool({
    kind: "change_case",
    label: "Change case (values)",
    icon: "bi-type",
    blurb: "Lowercase or uppercase every string column's values.",
    fields: [
      { type: "enum", key: "mode", label: "Mode", options: [
        ["lower", "lowercase"], ["upper", "UPPERCASE"],
      ]},
    ],
    toParams: (s) => ({ mode: s.mode }),
  }),

  defineTool({
    kind: "replace_text",
    label: "Replace text",
    icon: "bi-arrow-repeat",
    blurb: "Find-and-replace text within a column.",
    fields: [
      { type: "column", key: "column", label: "Column" },
      { type: "text", key: "find", label: "Find", placeholder: "text or regex" },
      { type: "text", key: "replace", label: "Replace with", placeholder: "(blank to remove)" },
      { type: "boolean", key: "is_regex", label: "Treat Find as a regular expression" },
    ],
    toParams: (s) => ({ column: s.column, find: s.find, replace: s.replace, is_regex: s.is_regex }),
  }),

  defineTool({
    kind: "fix_invalid",
    label: "Fix invalid values",
    icon: "bi-bandaid",
    blurb: "Replace sentinel values (N/A, NULL, ?, …) with a chosen value (blank = null).",
    fields: [
      { type: "multicolumn", key: "columns", label: "Columns (blank = every string column)" },
      { type: "text", key: "sentinels", label: "Sentinels (comma-separated)",
        placeholder: "N/A, NULL, ?, -" },
      { type: "text", key: "replacement", label: "Replace with", placeholder: "(blank → null)" },
    ],
    toParams: (s) => {
      const sentinels = (s.sentinels || "").split(",").map((t) => t.trim()).filter(Boolean);
      const p = { sentinels };
      if (s.columns && s.columns.length) p.columns = s.columns;
      if (s.replacement) p.replacement = s.replacement;
      return p;
    },
  }),

  defineTool({
    kind: "join_columns",
    label: "Concatenate columns",
    icon: "bi-link-45deg",
    blurb: "Join two columns into a new one with a separator.",
    fields: [
      { type: "column", key: "col1", label: "First column" },
      { type: "column", key: "col2", label: "Second column" },
      { type: "text", key: "sep", label: "Separator", placeholder: '" " (space)' },
      { type: "text", key: "new_name", label: "New column name", placeholder: "joined_name" },
    ],
    toParams: (s) => ({ col1: s.col1, col2: s.col2, sep: s.sep || " ", new_name: s.new_name }),
  }),

  defineTool({
    kind: "split_column",
    label: "Split column",
    icon: "bi-scissors",
    blurb: "Split a column by a separator into multiple new columns.",
    fields: [
      { type: "column", key: "column", label: "Column" },
      { type: "text", key: "sep", label: "Separator", placeholder: '","' },
      { type: "boolean", key: "keep_original", label: "Keep the original column" },
    ],
    toParams: (s) => ({ column: s.column, sep: s.sep || ",", keep_original: !!s.keep_original }),
  }),

  defineTool({
    kind: "format_dates",
    label: "Format dates",
    icon: "bi-calendar-date",
    blurb: "Parse messy dates and re-output them in one standard format.",
    // Output format is a PICKER, not free text — a raw strftime field let a
    // user type "yyyy-mm-dd" (the obvious human notation), which has no `%`
    // specifiers, so chrono's strftime echoed the literal string into every
    // row. The options below carry the real strptime spec as their value;
    // the user only sees a dated example. ISO is the default + the clean-
    // pipeline target.
    fields: [
      { type: "column", key: "column", label: "Column" },
      { type: "enum", key: "fmt", label: "Output as", options: [
        ["%Y-%m-%d", "2026-05-21  (ISO, YYYY-MM-DD)"],
        ["%d/%m/%Y", "21/05/2026  (DD/MM/YYYY)"],
        ["%m/%d/%Y", "05/21/2026  (MM/DD/YYYY)"],
        ["%d-%m-%Y", "21-05-2026  (DD-MM-YYYY)"],
        ["%d.%m.%Y", "21.05.2026  (DD.MM.YYYY)"],
        ["%Y/%m/%d", "2026/05/21  (YYYY/MM/DD)"],
      ]},
      { type: "enum", key: "on_incomplete", label: "If unparseable", options: [
        ["null", "Set to null"], ["keep", "Keep original"],
      ]},
    ],
    toParams: (s) => ({ column: s.column, fmt: s.fmt || "%Y-%m-%d", on_incomplete: s.on_incomplete }),
  }),

  defineTool({
    kind: "unwrap_csv",
    label: "Unwrap CSV",
    icon: "bi-box-arrow-up",
    // Special-case: the server step requires a single-column DataFrame
    // (a file whose rows look like quoted CSV records collapsed into
    // one column). Apply will fail-loud on a multi-column file — that's
    // the right behaviour, the blurb sets the expectation.
    blurb: "If this file is a single column of wrapped CSV records, parse and unwrap it. No options.",
    fields: [],
    toParams: () => ({}),
  }),
];
