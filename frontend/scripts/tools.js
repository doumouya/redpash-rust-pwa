// Cleaning tools — the workspace's tools panel, parameterised.
//
// One factory (defineTool), N tool configs, a single form renderer that
// covers them all by composing 5 field-type renderers (column, enum,
// text, boolean, multi-column). The panel runs a master/detail loop:
// list of tools → click → form → Apply → POST /api/files/:rid/steps →
// the response carries the new file envelope, which the caller renders
// into the table without a refetch.
//
// Conventions:
//   - Same noun (`tool`) appears on the wire as the step `kind` so the
//     JS↔Rust crossing names line up (js-rust-boundary.md).
//   - All field rows reuse the filter panel's `rt-pred` family — no new
//     UI components, just BEM modifiers (`rt-pred--lbl`) on existing.
//   - Apply hits POST /api/files/:rid/steps; the server returns
//     { summary, columns, steps, last_op } so the table re-renders
//     directly from the response — no extra round-trip.

import { api } from "/scripts/api.js";
import { esc } from "/scripts/dom.js";

// ─── field-type renderers ────────────────────────────────────────────
// Each renderer returns { html, read(rootEl) }. Read returns the typed
// value for that field; toParams composes them into the step params.

const FIELDS = {
  column: ({ key, label, columns }) => ({
    html:
      '<div class="rt-pred rt-pred--stack">'
      + '<label class="rt-pred-lbl">' + esc(label) + '</label>'
      + '<select class="rt-pred-col" data-key="' + esc(key) + '">'
      +   columns.map((c) =>
            '<option value="' + esc(c.name) + '">' + esc(c.name) + '</option>').join("")
      + '</select>'
      + '</div>',
    read: (root) => root.querySelector('[data-key="' + key + '"]').value,
  }),

  enum: ({ key, label, options }) => ({
    html:
      '<div class="rt-pred rt-pred--stack">'
      + '<label class="rt-pred-lbl">' + esc(label) + '</label>'
      + '<select class="rt-pred-op" data-key="' + esc(key) + '">'
      +   options.map(([v, l]) =>
            '<option value="' + esc(v) + '">' + esc(l) + '</option>').join("")
      + '</select>'
      + '</div>',
    read: (root) => root.querySelector('[data-key="' + key + '"]').value,
  }),

  text: ({ key, label, placeholder }) => ({
    html:
      '<div class="rt-pred rt-pred--stack">'
      + '<label class="rt-pred-lbl">' + esc(label) + '</label>'
      + '<input class="rt-pred-val" data-key="' + esc(key) + '"'
      + (placeholder ? ' placeholder="' + esc(placeholder) + '"' : '') + ' />'
      + '</div>',
    read: (root) => root.querySelector('[data-key="' + key + '"]').value.trim(),
  }),

  boolean: ({ key, label }) => ({
    html:
      '<div class="rt-pred rt-pred--inline">'
      + '<label class="rt-pred-lbl">'
      +   '<input type="checkbox" class="rt-chk" data-key="' + esc(key) + '" /> ' + esc(label)
      + '</label>'
      + '</div>',
    read: (root) => root.querySelector('[data-key="' + key + '"]').checked,
  }),

  // Multi-column: a vertical list of checkboxes, one per active column.
  // Returns the array of checked column names (or [] if none).
  multicolumn: ({ key, label, columns }) => ({
    html:
      '<div class="rt-pred rt-pred--stack">'
      + '<label class="rt-pred-lbl">' + esc(label) + '</label>'
      + '<div class="rt-pred-multi" data-key="' + esc(key) + '">'
      +   columns.map((c) =>
            '<label class="rt-dd-item"><input type="checkbox" class="rt-chk" value="'
              + esc(c.name) + '" /> ' + esc(c.name) + '</label>').join("")
      + '</div>'
      + '</div>',
    read: (root) => Array.from(
      root.querySelectorAll('[data-key="' + key + '"] input:checked')
    ).map((el) => el.value),
  }),
};

// ─── factory + the 12-tool catalog ───────────────────────────────────
// Order matters — it's the order shown in the picker.

function defineTool(t) { return t; }

const TOOLS = [
  defineTool({
    kind: "drop_nulls",
    label: "Drop nulls",
    icon: "bi-eraser",
    blurb: "Remove rows where the chosen column is empty.",
    fields: [{ type: "column", key: "column", label: "Column" }],
    toParams: (s) => ({ column: s.column }),
  }),

  defineTool({
    kind: "fill_nulls",
    label: "Fill nulls",
    icon: "bi-pencil-square",
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
    icon: "bi-x-square",
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
    icon: "bi-type",
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
    icon: "bi-type-strikethrough",
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
    icon: "bi-wrench-adjustable",
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
    icon: "bi-calendar3",
    blurb: "Parse and format date strings with a strftime pattern.",
    fields: [
      { type: "column", key: "column", label: "Column" },
      { type: "text", key: "fmt", label: "Format", placeholder: "%Y-%m-%d" },
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

// ─── mount ───────────────────────────────────────────────────────────
// ctx: { fileRid, columns, onApplied(response), onError(err) }
//   - fileRid:   () => string | null
//   - columns:   () => ColumnMeta[]
//   - onApplied: callback(POST response) — the caller re-renders the table
//
// The panel owns three views inside its body:
//   1. list view — the picker (one card per tool)
//   2. form view — the active tool's fields + Apply
//   3. status   — a small inline message on the picker (last applied / errors)

// ── columns-view actions ──────────────────────────────────────────────
// Each entry references an existing TOOLS kind so tools.js stays the
// single source of truth for label/icon/blurb/fields/toParams.
//
// GLOBAL_ACTIONS (Slice B): no selection, no per-cell work. `hasSheet`
// opens an in-panel modal sheet, otherwise the action runs directly.
// `enabled(summary)` gates the button on file-level state (e.g.
// unwrap_csv needs a single-column file).
const GLOBAL_ACTIONS = [
  { kind: "snake_case_columns" },
  { kind: "replace_in_names",   hasSheet: true },
  { kind: "change_case",        hasSheet: true },
  { kind: "unwrap_csv",
    enabled: (summary) => (summary?.col_count ?? 0) === 1,
    disabledTitle: "Unwrap CSV needs a single-column file." },
];

// SELECT_ACTIONS (Slices C–E): step(s) over the columns the user picked
// via row checkboxes. `min` / `max` gate the button — disabled when the
// selection size is wrong for the action. `label` overrides the picker's
// name when it would read awkwardly as a toolbar button.
//
// Apply shapes (the click handler picks one per entry):
// - default: one step with `{ cols: string[] }`. Engine takes the list
//   natively (steps.rs: arr_strings(params, "cols")). Examples:
//   drop_columns, filter_columns, drop_nulls.
// - `colsParam: "columns"`: same one-step shape but renames the cols
//   key for engines that already have a `cols` of their own (fix_invalid
//   takes `columns: [string]`).
// - `hasSheet`: opens an in-panel sheet for extra params; selection
//   pre-populates so column / multicolumn fields are dropped from the
//   form (the chips ARE the column choice).
// - `perColumn`: fires one step per selected column with
//   `{ ...sheetState, column: name }`. Engine takes singular `column`
//   (fill_nulls, replace_text, …); the loop also gives one undo entry
//   per column.
// - `mapCols(cols)`: returns extra params derived from the picked
//   column order — used by join_columns which needs `col1` + `col2`
//   as distinct named params.
const SELECT_ACTIONS = [
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

function getTool(kind) { return TOOLS.find((t) => t.kind === kind); }

export function mountTools(panelBody, ctx) {
  let activeSheet = null;         // the TOOLS entry whose modal sheet is open, or null
  let sheetSource = null;         // "global" | "select" — context for sheet apply + chips header
  let sheetCfg    = null;         // the SELECT_ACTIONS entry when sheetSource === "select" (carries perColumn etc.)
  let sheetFields = [];           // [{ field, read }] for the open sheet — read() returns value
  let selectedCols = new Set();   // column names selected via row checkboxes — drives SELECT_ACTIONS
  let editingName  = null;        // column name whose Name cell is being edited, or null
  let editingDtype = null;        // column name whose Datatype cell is being edited, or null
  let castConfirm  = null;        // { column, dtype, total, would_null, samples } — open confirm sheet, or null

  // Target dtypes for cast — pulled from the cast tool's enum field so
  // the toolbar (Slice G cast-preview flow) and any future re-introduced
  // picker share one source of truth.
  const DTYPE_OPTIONS = (TOOLS.find((t) => t.kind === "cast")?.fields || [])
    .find((f) => f.key === "dtype")?.options || [];

  // Two stable children — the status line (last-applied / errors) and
  // the columns surface itself. The tools panel is now single-surface
  // (the picker + form retired in Slice H); .has-columns goes on the
  // panel root at mount so the natural #wsToolsToggle opens it at 50vw.
  const statusEl = document.createElement("div");
  statusEl.className = "rt-tool-status";
  statusEl.hidden = true;
  const columnsEl = document.createElement("div");
  columnsEl.className = "rt-tool-columns";

  panelBody.innerHTML = "";
  panelBody.append(statusEl, columnsEl);
  panelBody.closest(".rt-panel")?.classList.add("has-columns");

  // ── columns view ───────────────────────────────────────────────────
  // The full columns-redtable per architecture/columns-redtable.md.
  // Rows = ColumnMeta[]; columns = ☑, #, Name (click to rename),
  // Datatype (click to cast w/ preview), Nulls, % Null, Unique %,
  // Sample. All fields come from the existing /api/files/:rid envelope
  // — no new endpoint. Sniff mismatch (storage dtype ≠ semantic dtype)
  // gets a small ⚠ badge so the dirty columns surface visually.
  //
  // Toolbar groups the actions by mode:
  //   Global   — snake_case, replace_in_names, change_case, unwrap_csv
  //   Selected — drop, keep, drop_nulls, fill_nulls, replace_text,
  //              fix_invalid, join, split, format_dates
  //
  // Head meta strip surfaces a "Drop K fully-null rows" CTA when the
  // summary has any (fully-null is a row-level cleanup that uses
  // column-level info — the only cross-cutting action on this surface).
  function renderColumnsView() {
    const cols    = ctx.columns() || [];
    const summary = ctx.summary ? ctx.summary() : null;
    const total   = summary?.row_count;
    if (!cols.length) {
      activeSheet = null;
      sheetSource = null;
      sheetCfg    = null;
      sheetFields = [];
      selectedCols.clear();
      editingName  = null;
      editingDtype = null;
      castConfirm  = null;
      columnsEl.innerHTML = '<p class="rt-step-state">Open a file to see its columns.</p>';
      return;
    }
    // Drop stale edit targets if the column they point at no longer
    // exists (file change, rename via another path, drop_columns step).
    if (editingName  && !live.has(editingName))  editingName  = null;
    if (editingDtype && !live.has(editingDtype)) editingDtype = null;
    if (castConfirm  && !live.has(castConfirm.column)) castConfirm = null;
    // Intersect the current selection with the live column set — a
    // prior step (drop_columns, rename_column, etc.) may have removed
    // or renamed columns that the user had selected. Stale names get
    // silently dropped so the toolbar's count stays honest.
    const live = new Set(cols.map((c) => c.name));
    for (const n of selectedCols) if (!live.has(n)) selectedCols.delete(n);

    const allSelected  = cols.length > 0 && cols.every((c) => selectedCols.has(c.name));
    const someSelected = !allSelected && cols.some((c) => selectedCols.has(c.name));

    const rows = cols.map((c, i) => {
      const pct       = c.null_pct == null ? null : Math.max(0, Math.min(100, c.null_pct));
      const nullCount = pct != null && total != null ? Math.round(pct * total / 100) : null;
      const band      = pct == null ? "" : pct >= 50 ? "is-warn-high" : pct >= 10 ? "is-warn-mid" : "";
      const uniqPct   = c.unique_pct == null ? null : Math.max(0, Math.min(100, c.unique_pct));
      const sample    = c.sample == null ? "" : String(c.sample);
      const sniff     = c.semantic_dtype && c.dtype && c.semantic_dtype !== c.dtype
                          ? ' <span class="rt-col-sniff" title="Sniffed as ' + esc(c.semantic_dtype)
                            + ' — stored as ' + esc(c.dtype) + '">⚠</span>'
                          : '';
      const checked   = selectedCols.has(c.name);
      const isEditing = editingName === c.name;
      // Name cell swaps to an inline <input> when its column is being
      // edited (Slice F). data-col on the cell lets the click handler
      // resolve back to the column name without walking the row.
      const nameCell  = isEditing
        ? '<td class="is-name is-editing" data-col="' + esc(c.name) + '">'
          + '<input class="rt-col-name-input" type="text" value="' + esc(c.name) + '"'
          + ' data-orig="' + esc(c.name) + '" autocomplete="off" spellcheck="false" /></td>'
        : '<td class="is-name is-editable" data-col="' + esc(c.name) + '"'
          + ' title="Click to rename">' + esc(c.name) + '</td>';
      // Datatype cell — click swaps to a <select> of DTYPE_OPTIONS;
      // picking a new value triggers the cast-preview flow (Slice G).
      const isEditingDtype = editingDtype === c.name;
      const dtypeCell = isEditingDtype
        ? '<td class="is-dtype is-editing" data-col="' + esc(c.name) + '">'
          + '<select class="rt-col-dtype-select" data-orig="' + esc(c.dtype || "") + '">'
          +   DTYPE_OPTIONS.map(([v, l]) =>
                '<option value="' + esc(v) + '"'
                + (v === c.dtype ? ' selected' : '') + '>'
                + esc(l) + '</option>').join("")
          + '</select></td>'
        : '<td class="is-dtype is-editable" data-col="' + esc(c.name) + '"'
          + ' title="Click to change type">'
          + esc(c.dtype || "—") + sniff + '</td>';
      return '<tr' + (checked ? ' class="is-selected"' : '') + '>'
        + '<td class="is-check"><input type="checkbox" class="rt-chk rt-col-check"'
        +   ' data-col="' + esc(c.name) + '"' + (checked ? ' checked' : '') + ' /></td>'
        + '<td class="is-num is-muted">' + (i + 1) + '</td>'
        + nameCell
        + dtypeCell
        + '<td class="is-num ' + band + '">' + (nullCount != null ? nullCount : "—") + '</td>'
        + '<td class="is-num ' + band + '">' + (pct != null ? pct.toFixed(1) + "%" : "—") + '</td>'
        + '<td class="is-num">' + (uniqPct != null ? uniqPct.toFixed(1) + "%" : "—") + '</td>'
        + '<td class="is-sample" title="' + esc(sample) + '">' + esc(sample) + '</td>'
        + '</tr>';
    }).join("");
    // Fully-null-rows pill — row-level cleanup that uses cross-column
    // info. Surfaces only when there's something to drop; clicking
    // fires a filter_rows step that KEEPS rows where any column is
    // not_null (i.e. drops the all-null rows). No new step kind —
    // see steps.rs's filter_rows arm.
    const fullyNull = summary?.fully_null_rows;
    const fullyNullPill = fullyNull != null && fullyNull > 0
      ? ' · <button class="rt-tool-columns-fullynull" type="button"'
        + ' title="Drop every row where every column is null">'
        + '<i class="bi bi-trash3"></i> Drop <b>' + fullyNull + '</b> fully-null row'
        + (fullyNull === 1 ? '' : 's')
        + '</button>'
      : '';
    columnsEl.innerHTML =
        '<div class="rt-tool-columns-head">'
      +   '<span class="rt-tool-columns-meta">'
      +     '<b>' + cols.length + '</b> column' + (cols.length === 1 ? '' : 's')
      +     (total != null ? ' · <b>' + total + '</b> row' + (total === 1 ? '' : 's') : '')
      +     fullyNullPill
      +   '</span>'
      + '</div>'
      + renderColumnsToolbar(summary)
      + (activeSheet ? renderColumnsSheet(cols) : '')
      + (castConfirm ? renderCastConfirm() : '')
      + '<div class="rt-tool-columns-tablewrap">'
      +   '<table class="rp-table rt-tool-columns-table">'
      +     '<thead><tr>'
      +       '<th class="is-check"><input type="checkbox" class="rt-chk rt-col-check-all"'
      +         (allSelected ? ' checked' : '') + ' /></th>'
      +       '<th>#</th><th>Name</th><th>Type</th>'
      +       '<th class="is-num">Nulls</th><th class="is-num">% Null</th>'
      +       '<th class="is-num">Unique %</th><th>Sample</th>'
      +     '</tr></thead>'
      +     '<tbody>' + rows + '</tbody>'
      +   '</table>'
      + '</div>';
    // Header checkbox indeterminate state can't be set via HTML attr.
    const head = columnsEl.querySelector(".rt-col-check-all");
    if (head) head.indeterminate = someSelected;
    // Auto-focus + select the editing input so the user can immediately
    // type the new name. requestAnimationFrame avoids the focus being
    // stolen back by the originating click event.
    if (editingName) {
      const input = columnsEl.querySelector(".rt-col-name-input");
      if (input) {
        requestAnimationFrame(() => { input.focus(); input.select(); });
      }
    }
  }

  // Toolbar — global actions (Slice B) + select actions (Slice C).
  // Edit mode lands in slices F–G alongside cell-edit affordances.
  function renderColumnsToolbar(summary) {
    const selCount = selectedCols.size;
    const globalBtns = GLOBAL_ACTIONS.map((a) => {
      const tool = getTool(a.kind);
      if (!tool) return '';
      const enabled = a.enabled ? a.enabled(summary) : true;
      const title   = enabled ? (tool.blurb || tool.label)
                              : (a.disabledTitle || tool.blurb || tool.label);
      return '<button class="rt-btn rt-tool-columns-action" type="button"'
        +    ' data-action-kind="' + esc(a.kind) + '"'
        +    (enabled ? '' : ' disabled')
        +    ' title="' + esc(title) + '">'
        +    '<i class="bi ' + esc(tool.icon) + '"></i> '
        +    esc(tool.label) + (a.hasSheet ? '…' : '')
        +    '</button>';
    }).join('');
    const selBtns = SELECT_ACTIONS.map((a) => {
      const tool = getTool(a.kind);
      if (!tool) return '';
      const meetsMin = selCount >= a.min;
      const meetsMax = a.max == null || selCount <= a.max;
      const enabled  = meetsMin && meetsMax;
      // Title spells out the gating reason so the disabled state isn't
      // a mystery — "exactly 1" / "exactly 2" / "≥N" are the three shapes.
      let title;
      if (enabled) {
        title = a.label + ' (' + selCount + ' column' + (selCount === 1 ? '' : 's') + ')';
      } else if (a.min === a.max) {
        title = 'Select exactly ' + a.min + ' column' + (a.min === 1 ? '' : 's') + ' first.';
      } else if (!meetsMin) {
        title = 'Select ≥' + a.min + ' column' + (a.min === 1 ? '' : 's') + ' first.';
      } else {
        title = 'Select ≤' + a.max + ' column' + (a.max === 1 ? '' : 's') + ' (currently ' + selCount + ').';
      }
      return '<button class="rt-btn rt-tool-columns-action" type="button"'
        +    ' data-select-kind="' + esc(a.kind) + '"'
        +    (enabled ? '' : ' disabled')
        +    ' title="' + esc(title) + '">'
        +    '<i class="bi ' + esc(a.icon) + '"></i> '
        +    esc(a.label)
        +    '</button>';
    }).join('');
    // Selection chip — count + clear; click clears the selection.
    // Visually muted when nothing is picked so it doesn't shout
    // "0 selected" at the user constantly.
    const chip =
      '<span class="rt-tool-columns-selchip' + (selCount ? ' is-active' : '') + '"'
      + (selCount ? ' title="Click to clear selection"' : '') + '>'
      +   '<i class="bi bi-check2-square"></i>'
      +   '<b>' + selCount + '</b> selected'
      +   (selCount ? '<button class="rt-tool-columns-selchip-clear" type="button"'
                      + ' title="Clear selection"><i class="bi bi-x"></i></button>' : '')
      + '</span>';
    return '<div class="rt-tool-columns-toolbar">'
      +    '<span class="rt-tool-columns-toolbar-grp">Global</span>'
      +    globalBtns
      +    '<span class="rt-tool-columns-toolbar-sep"></span>'
      +    '<span class="rt-tool-columns-toolbar-grp">Selected</span>'
      +    selBtns
      +    chip
      +    '</div>';
  }

  // Modal sheet — small in-panel form that reuses the existing FIELDS
  // renderers (column/enum/text/boolean/multicolumn). Lives between the
  // toolbar and the table. Two open paths:
  //
  // - Global sheet (Slice B): every tool field renders; e.g. change_case
  //   shows its enum, replace_in_names shows its 2 text fields.
  // - Select sheet (Slice D): rendered with an "Acting on" chip strip
  //   showing the selection. Column-picker fields are dropped (the
  //   chips ARE the column choice); other fields render as normal.
  //   e.g. fill_nulls shows only strategy + value.
  function renderColumnsSheet(cols) {
    if (!activeSheet) return '';
    const isSelect = sheetSource === "select";
    const visibleFields = isSelect
      ? activeSheet.fields.filter((f) => f.type !== "column" && f.type !== "multicolumn")
      : activeSheet.fields;
    sheetFields = visibleFields.map((f) => {
      const renderer = FIELDS[f.type];
      if (!renderer) throw new Error("Unknown field type: " + f.type);
      const built = renderer({ ...f, columns: cols });
      return { field: f, html: built.html, read: built.read };
    });
    const chips = isSelect
      ? '<div class="rt-tool-columns-sheet-chips" title="Columns this action will run on, in file order">'
        + '<span class="rt-tool-columns-sheet-chips-lbl">Acting on</span>'
        + pickedInOrder().map((n) =>
            '<span class="rt-tool-columns-sheet-chip">' + esc(n) + '</span>').join('')
        + '</div>'
      : '';
    return '<div class="rt-tool-columns-sheet">'
      +    '<div class="rt-tool-columns-sheet-head">'
      +      '<span class="rt-tool-columns-sheet-title">'
      +        '<i class="bi ' + esc(activeSheet.icon) + '"></i> '
      +        esc((isSelect && sheetCfg) ? sheetCfg.label : activeSheet.label)
      +      '</span>'
      +      '<button class="rt-btn rt-btn--ghost rt-tool-columns-sheet-close" type="button"'
      +        ' title="Cancel"><i class="bi bi-x-lg"></i></button>'
      +    '</div>'
      +    (activeSheet.blurb
            ? '<p class="rt-tool-columns-sheet-blurb">' + esc(activeSheet.blurb) + '</p>'
            : '')
      +    chips
      +    '<div class="rt-tool-columns-sheet-body">'
      +      sheetFields.map((r) => r.html).join('')
      +    '</div>'
      +    '<div class="rt-tool-columns-sheet-foot">'
      +      '<button class="rt-btn rt-tool-columns-sheet-cancel" type="button">Cancel</button>'
      +      '<button class="rt-btn rt-btn--accent rt-tool-columns-sheet-apply" type="button">'
      +        '<i class="bi bi-play-fill"></i> Apply'
      +      '</button>'
      +    '</div>'
      +    '</div>';
  }

  // Click delegation for the columns view — toolbar buttons fire either
  // a direct apply (no-field tools) or open a sheet (dialog tools); the
  // sheet's Apply/Cancel buttons commit or close. Listening on columnsEl
  // means re-renders inside that subtree don't lose the handler.
  columnsEl.addEventListener("click", async (e) => {
    // Global action — opens sheet or runs directly.
    const actBtn = e.target.closest(".rt-tool-columns-action[data-action-kind]");
    if (actBtn && !actBtn.disabled) {
      const tool = getTool(actBtn.dataset.actionKind);
      if (!tool) return;
      if (tool.fields && tool.fields.length) {
        activeSheet = tool;
        sheetSource = "global";
        sheetCfg    = null;
        renderColumnsView();
      } else {
        await runStep(tool.kind, tool.toParams({}), tool.label, { busyBtn: actBtn });
      }
      return;
    }
    // Select action — branches by config:
    //   hasSheet → open a select sheet (column fields dropped, chips
    //              header shows the picked columns).
    //   else     → fire one step with `{ cols: string[] }` (Slice C
    //              shape: drop_columns / filter_columns / drop_nulls).
    const selBtn = e.target.closest(".rt-tool-columns-action[data-select-kind]");
    if (selBtn && !selBtn.disabled) {
      const kind = selBtn.dataset.selectKind;
      const tool = getTool(kind);
      const cfg  = SELECT_ACTIONS.find((a) => a.kind === kind);
      if (!tool || !cfg) return;
      const cols = pickedInOrder();
      if (!cols.length) return;
      if (cfg.hasSheet) {
        activeSheet = tool;
        sheetSource = "select";
        sheetCfg    = cfg;
        renderColumnsView();
      } else {
        const colsParam = cfg.colsParam || "cols";
        const label = (cfg.label || tool.label) + ' (' + cols.length + ')';
        await runStep(kind, { [colsParam]: cols }, label, { busyBtn: selBtn });
      }
      return;
    }
    // Selection chip — clear the lot.
    if (e.target.closest(".rt-tool-columns-selchip-clear")) {
      selectedCols.clear();
      renderColumnsView();
      return;
    }
    // Drop fully-null rows — head-strip CTA. KEEPS any row where at
    // least one column is not_null (i.e. drops rows where every column
    // is null). No new step kind; reuses filter_rows with a flat OR
    // of `{column, op: "not_null"}` predicates over every column.
    const fullyBtn = e.target.closest(".rt-tool-columns-fullynull");
    if (fullyBtn) {
      const cols = ctx.columns() || [];
      if (!cols.length) return;
      const predicates = cols.map((c) => ({ column: c.name, op: "not_null" }));
      await runStep("filter_rows",
                    { combinator: "or", predicates },
                    "Drop fully-null rows",
                    { busyBtn: fullyBtn });
      return;
    }
    // Sheet controls.
    if (e.target.closest(".rt-tool-columns-sheet-cancel")
        || e.target.closest(".rt-tool-columns-sheet-close")) {
      closeSheet();
      return;
    }
    const applyBtn = e.target.closest(".rt-tool-columns-sheet-apply");
    if (applyBtn) {
      if (!activeSheet) return;
      const state = {};
      sheetFields.forEach((r) => { state[r.field.key] = r.read(columnsEl); });
      const tool   = activeSheet;
      const source = sheetSource;
      const cfg    = sheetCfg;
      const cols   = pickedInOrder();
      // Close optimistically — runStep → onApplied → loadFile → refresh
      // re-renders the view. On failure status shows the error inline
      // and the user re-opens the sheet (rare path; sheets are short).
      activeSheet = null;
      sheetSource = null;
      sheetCfg    = null;
      sheetFields = [];
      if (source === "select" && cfg?.perColumn) {
        // One step per selected column. The engine for these kinds
        // (fill_nulls, replace_text, split_column, format_dates) takes
        // singular `column`; the per-column loop also gives each one
        // its own undo entry. Sequential awaits because each step's
        // response is the input to the next (envelope refetch via
        // onApplied).
        for (const c of cols) {
          const params = tool.toParams({ ...state, column: c });
          const label  = (cfg.label || tool.label) + ' — ' + c;
          await runStep(tool.kind, params, label, { busyBtn: applyBtn });
        }
      } else if (source === "select" && cfg?.mapCols) {
        // Custom selection-to-param mapping — join_columns needs
        // col1 + col2 from the picked column order.
        const params = { ...tool.toParams(state), ...cfg.mapCols(cols) };
        const label  = (cfg.label || tool.label) + ' (' + cols.join(' + ') + ')';
        await runStep(tool.kind, params, label, { busyBtn: applyBtn });
      } else if (source === "select") {
        // Sheet result + selection collapses into one step. Cols go
        // under `colsParam` (default "cols", overridden to "columns"
        // for engines that already have a `cols` of their own —
        // fix_invalid).
        const colsParam = cfg?.colsParam || "cols";
        const params = { ...tool.toParams(state), [colsParam]: cols };
        const label  = (cfg?.label || tool.label) + ' (' + cols.length + ')';
        await runStep(tool.kind, params, label, { busyBtn: applyBtn });
      } else {
        // Global sheet — one step from the form alone.
        const params = tool.toParams(state);
        await runStep(tool.kind, params, tool.label, { busyBtn: applyBtn });
      }
    }
  });

  // Row + header checkboxes — listen on `change` (not click) so keyboard
  // toggles work too. The header checkbox toggles every row; row clicks
  // mutate selectedCols by column name (stable across re-orders).
  columnsEl.addEventListener("change", (e) => {
    const head = e.target.closest(".rt-col-check-all");
    if (head) {
      const cols = ctx.columns() || [];
      if (head.checked) cols.forEach((c) => selectedCols.add(c.name));
      else              selectedCols.clear();
      renderColumnsView();
      return;
    }
    const row = e.target.closest(".rt-col-check");
    if (row) {
      const name = row.dataset.col;
      if (row.checked) selectedCols.add(name);
      else             selectedCols.delete(name);
      renderColumnsView();
    }
  });

  // ── Slice F — edit mode: Name cell ─────────────────────────────────
  // Click on the Name cell (when not already editing) swaps it to an
  // <input>. Enter commits a rename_column step; Esc cancels; blur
  // commits to match spreadsheet UX. Empty-or-unchanged exits cleanly
  // with no step. A duplicate name surfaces the server's 400 via the
  // existing status row.
  columnsEl.addEventListener("click", (e) => {
    const cell = e.target.closest(".rt-tool-columns-table td.is-name.is-editable");
    if (!cell || editingName) return;
    editingName = cell.dataset.col || null;
    if (editingName) renderColumnsView();
  });

  columnsEl.addEventListener("keydown", (e) => {
    const input = e.target.closest(".rt-col-name-input");
    if (!input) return;
    if (e.key === "Enter")      { e.preventDefault(); commitNameEdit(input); }
    else if (e.key === "Escape") { e.preventDefault(); cancelNameEdit(); }
  });

  // focusout commits — guarded by the editingName check so the
  // re-render from a commit doesn't double-fire.
  columnsEl.addEventListener("focusout", (e) => {
    const input = e.target.closest(".rt-col-name-input");
    if (input && editingName) commitNameEdit(input);
  });

  async function commitNameEdit(input) {
    const from = input.dataset.orig;
    const to   = (input.value || "").trim();
    editingName = null;
    if (!to || to === from) { renderColumnsView(); return; }
    await runStep("rename_column", { from, to },
                  "Rename " + from + " → " + to);
  }

  function cancelNameEdit() {
    editingName = null;
    renderColumnsView();
  }

  // ── Slice G — edit mode: Datatype cell (cast with preview) ─────────
  // Click on the Datatype cell swaps it for a <select> of DTYPE_OPTIONS.
  // Picking a value runs /cast-preview; if no rows would be nulled, the
  // cast fires immediately. Otherwise a confirm sheet shows the cost
  // (would_null + sample source values) before the destructive apply.
  columnsEl.addEventListener("click", (e) => {
    const cell = e.target.closest(".rt-tool-columns-table td.is-dtype.is-editable");
    if (!cell || editingDtype) return;
    editingDtype = cell.dataset.col || null;
    if (editingDtype) renderColumnsView();
  });

  columnsEl.addEventListener("change", async (e) => {
    const select = e.target.closest(".rt-col-dtype-select");
    if (!select || !editingDtype) return;
    const from = select.dataset.orig;
    const to   = select.value;
    const col  = editingDtype;
    editingDtype = null;
    if (!to || to === from) { renderColumnsView(); return; }
    await previewAndCast(col, to);
  });

  columnsEl.addEventListener("keydown", (e) => {
    const select = e.target.closest(".rt-col-dtype-select");
    if (!select) return;
    if (e.key === "Escape") {
      e.preventDefault();
      editingDtype = null;
      renderColumnsView();
    }
  });

  // Cast confirm sheet — close/cancel re-render; apply fires the cast.
  columnsEl.addEventListener("click", async (e) => {
    if (e.target.closest(".rt-cast-confirm-close")
        || e.target.closest(".rt-cast-confirm-cancel")) {
      castConfirm = null;
      renderColumnsView();
      return;
    }
    const applyBtn = e.target.closest(".rt-cast-confirm-apply");
    if (!applyBtn || !castConfirm) return;
    const { column, dtype } = castConfirm;
    castConfirm = null;
    await runStep("cast", { column, dtype },
                  "Cast " + column + " → " + dtype,
                  { busyBtn: applyBtn });
  });

  // Cast-preview gate — dry-run the cast against the cached frame and
  // surface the cost before applying. The endpoint returns
  // { total, would_null, samples }; would_null === 0 means a clean
  // cast that we apply immediately.
  async function previewAndCast(column, dtype) {
    const rid = ctx.fileRid();
    if (!rid) return;
    let resp;
    try {
      // DATA-ENDPOINT-ACK: caller-checks-file_type — tools.js mounts
      // inside the Workspace's Tools panel, which is CSV-gated by
      // loadFile's CSV branch (see 6f1b70c). ctx.fileRid() returns
      // the active CSV here.
      resp = await api.post("/files/" + encodeURIComponent(rid) + "/cast-preview",
                            { column, dtype });
    } catch (err) {
      const msg = (err && (err.body?.message || err.body?.error)) || err?.message || "Preview failed";
      setStatus(msg + (err?.status ? " (" + err.status + ")" : ""), "err");
      return;
    }
    if ((resp?.would_null ?? 0) === 0) {
      await runStep("cast", { column, dtype }, "Cast " + column + " → " + dtype);
      return;
    }
    castConfirm = {
      column,
      dtype,
      total:      resp.total      ?? 0,
      would_null: resp.would_null ?? 0,
      samples:    resp.samples    ?? [],
    };
    renderColumnsView();
  }

  function closeSheet() {
    activeSheet = null;
    sheetSource = null;
    sheetCfg    = null;
    sheetFields = [];
    renderColumnsView();
  }

  // Slice G — cast confirm sheet. Shown when /cast-preview reports
  // would_null > 0 so the user sees the cost (how many cells will
  // become null, and which source values caused it) before applying.
  // would_null === 0 skips this and fires the step directly.
  function renderCastConfirm() {
    if (!castConfirm) return '';
    const { column, dtype, total, would_null, samples } = castConfirm;
    const dtypeLbl = (DTYPE_OPTIONS.find((o) => o[0] === dtype) || [dtype, dtype])[1];
    return '<div class="rt-tool-columns-sheet rt-cast-confirm">'
      +    '<div class="rt-tool-columns-sheet-head">'
      +      '<span class="rt-tool-columns-sheet-title">'
      +        '<i class="bi bi-exclamation-triangle"></i> '
      +        'Cast ' + esc(column) + ' → ' + esc(dtypeLbl)
      +      '</span>'
      +      '<button class="rt-btn rt-btn--ghost rt-cast-confirm-close" type="button"'
      +        ' title="Cancel"><i class="bi bi-x-lg"></i></button>'
      +    '</div>'
      +    '<p class="rt-tool-columns-sheet-blurb">'
      +      '<b>' + would_null + '</b> of ' + total + ' cell'
      +      (total === 1 ? '' : 's') + ' won\'t parse and will become null. '
      +      'Use <i>Fix invalid</i> first if you\'d rather clean the source values.'
      +    '</p>'
      +    (samples.length
            ? '<div class="rt-tool-columns-sheet-chips" title="Sample source values that would be nulled">'
              + '<span class="rt-tool-columns-sheet-chips-lbl">Examples</span>'
              + samples.map((s) => '<span class="rt-tool-columns-sheet-chip">'
                  + esc(s) + '</span>').join('')
              + '</div>'
            : '')
      +    '<div class="rt-tool-columns-sheet-foot">'
      +      '<button class="rt-btn rt-cast-confirm-cancel" type="button">Cancel</button>'
      +      '<button class="rt-btn rt-btn--accent rt-cast-confirm-apply" type="button">'
      +        '<i class="bi bi-play-fill"></i> Apply cast'
      +      '</button>'
      +    '</div>'
      +    '</div>';
  }

  // Picked columns in file order — checking order is unpredictable
  // (Set insertion order = the order the user clicked), but for
  // multi-col actions the user expects "in order from top to bottom"
  // (join_columns explicitly relies on this; the others gain in
  // readability — the chip strip + step labels read in column order).
  function pickedInOrder() {
    const live = ctx.columns() || [];
    return live.filter((c) => selectedCols.has(c.name)).map((c) => c.name);
  }

  // POST a step + run the standard post-apply lifecycle (set status,
  // fire ctx.onApplied so the workspace refetches and the columns
  // view re-renders).
  async function runStep(kind, params, label, opts = {}) {
    const rid = ctx.fileRid();
    if (!rid) { setStatus("Open a file before running a tool.", "warn"); return; }
    const busyBtn = opts.busyBtn;
    if (busyBtn) { busyBtn.disabled = true; busyBtn.classList.add("is-busy"); }
    try {
      // DATA-ENDPOINT-ACK: caller-checks-file_type — same CSV-gating
      // path as cast-preview above; tools.js renders only inside the
      // Workspace Tools panel's CSV branch.
      const res = await api.post("/files/" + encodeURIComponent(rid) + "/steps",
                                 { kind, params });
      setStatus("Applied: " + label, "ok");
      ctx.onApplied?.(res);
    } catch (err) {
      const msg = (err && (err.body?.message || err.body?.error)) || err?.message || "Apply failed";
      setStatus(msg + (err?.status ? " (" + err.status + ")" : ""), "err");
      if (busyBtn) { busyBtn.disabled = false; busyBtn.classList.remove("is-busy"); }
    }
  }

  function setStatus(text, kind /* "ok" | "warn" | "err" */) {
    statusEl.textContent = text;
    statusEl.dataset.kind = kind || "";
    statusEl.hidden = false;
    if (kind === "ok") {
      // Auto-clear OK status after a few seconds.
      clearTimeout(setStatus._t);
      setStatus._t = setTimeout(() => { statusEl.hidden = true; }, 4000);
    }
  }

  renderColumnsView();
  return { refresh: renderColumnsView };
}

