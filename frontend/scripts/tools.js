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
    // Diagnostic: rank the columns by null density so the user picks
    // the one that's actually dirty. null_pct comes from the file
    // envelope (ColumnMeta.null_pct); null_count derives from
    // null_pct × summary.row_count. The cross-column fully_null_rows
    // count comes from Gus's `0768cc3` — populated on hydrate / upload
    // / join / snapshot. `null` means "DB-only read, hydrate hasn't
    // run yet" — the slot still renders, just dashed.
    context: (ctx) => {
      const cols    = ctx.columns() || [];
      const summary = ctx.summary ? ctx.summary() : null;
      const total   = summary?.row_count;
      const fullyNull = summary?.fully_null_rows;
      const ranked  = cols
        .map((c) => ({
          name:  c.name,
          pct:   c.null_pct == null ? null : Math.max(0, Math.min(100, c.null_pct)),
        }))
        .map((c) => ({
          ...c,
          count: c.pct != null && total != null ? Math.round(c.pct * total / 100) : null,
        }))
        .sort((a, b) => (b.pct ?? -1) - (a.pct ?? -1));
      if (!ranked.length) return "";
      const rows = ranked.slice(0, 8).map((c) => {
        const band = c.pct == null ? "" : c.pct >= 50 ? "is-warn-high" : c.pct >= 10 ? "is-warn-mid" : "";
        return '<tr>'
          + '<td>' + esc(c.name) + '</td>'
          + '<td class="is-num ' + band + '">' + (c.count != null ? c.count : "—") + '</td>'
          + '<td class="is-num ' + band + '">' + (c.pct != null ? c.pct.toFixed(1) + "%" : "—") + '</td>'
          + '</tr>';
      }).join("");
      const more = ranked.length > 8
        ? '<p class="rt-tool-context-note">' + (ranked.length - 8) + ' more columns…</p>'
        : "";
      // CTA conditional on the known count: visibly disabled when zero
      // (no rows to drop); enabled and counted when > 0; enabled with
      // the original generic label when the count is unknown.
      const ctaDisabled = fullyNull === 0;
      const ctaLabel    = fullyNull == null
                            ? "Drop fully-null rows"
                            : fullyNull === 0
                              ? "No fully-null rows"
                              : "Drop " + fullyNull + " fully-null rows";
      const ctaBand     = fullyNull != null && fullyNull > 0 ? "is-warn-high" : "";
      return ''
        + '<div class="rt-tool-context-summary">'
        +   '<span><b>' + (total != null ? total : "—") + '</b> rows</span>'
        +   '<span><b class="' + ctaBand + '">' + (fullyNull != null ? fullyNull : "—") + '</b> fully-null rows</span>'
        +   '<button class="rt-btn rt-btn--ghost rt-tool-context-cta" type="button"'
        +     ' data-action="drop-fully-null"'
        +     (ctaDisabled ? ' disabled' : '')
        +     ' title="Drop every row where every column is null (uses filter_rows)">'
        +     '<i class="bi bi-trash3"></i> ' + esc(ctaLabel)
        +   '</button>'
        + '</div>'
        + '<table class="rt-tool-context-table">'
        +   '<thead><tr><th>Column</th><th class="is-num">Nulls</th><th class="is-num">%</th></tr></thead>'
        +   '<tbody>' + rows + '</tbody>'
        + '</table>'
        + more;
    },
    // CTA in the context block fires a filter_rows step that KEEPS any
    // row where at least one column is not_null — i.e. drops rows where
    // every column is null. No new step kind needed; the engine already
    // accepts filter_rows with a flat OR of `{col, op: "not_null"}`
    // predicates (see steps.rs's filter_rows arm).
    handleAction: async (action, { ctx, runStep, btn }) => {
      if (action !== "drop-fully-null") return;
      const cols = ctx.columns() || [];
      if (!cols.length) return;
      const predicates = cols.map((c) => ({ column: c.name, op: "not_null" }));
      await runStep("filter_rows",
                    { combinator: "or", predicates },
                    "Drop fully-null rows",
                    { busyBtn: btn });
    },
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

// SELECT_ACTIONS (Slice C): one step over the columns the user picked
// via row checkboxes. All three take `cols: string[]`; the engine
// signature is identical for drop_columns, filter_columns, and
// drop_nulls (steps.rs: arr_strings(params, "cols")). `min` is the
// minimum selection size — buttons render disabled below the threshold.
// `label` overrides the picker's name when it would read awkwardly as
// a toolbar button (e.g. "Drop nulls in selected" vs. "Drop nulls").
const SELECT_ACTIONS = [
  { kind: "drop_columns",   min: 1, label: "Delete selected",        icon: "bi-trash3" },
  { kind: "filter_columns", min: 1, label: "Keep only selected",     icon: "bi-check-square" },
  { kind: "drop_nulls",     min: 1, label: "Drop nulls in selected", icon: "bi-eraser" },
];

function getTool(kind) { return TOOLS.find((t) => t.kind === kind); }

export function mountTools(panelBody, ctx) {
  let activeTool = null;          // the TOOLS[i] currently showing the form
  let renderedFields = [];        // [{ field, read }] for the open form — read() returns value
  let viewMode = "tools";         // "tools" (picker) | "columns" (columns-redtable)
  let activeSheet = null;         // the TOOLS entry whose modal sheet is open in columns view, or null
  let sheetFields = [];           // [{ field, read }] for the open sheet — read() returns value
  let selectedCols = new Set();   // column names selected via row checkboxes — drives SELECT_ACTIONS

  // Two stable containers — list view + form view; we swap visibility.
  const listEl = document.createElement("div");
  listEl.className = "rt-tool-list";
  const formEl = document.createElement("div");
  formEl.className = "rt-tool-form";
  formEl.hidden = true;
  const statusEl = document.createElement("div");
  statusEl.className = "rt-tool-status";
  statusEl.hidden = true;

  // colsEl wraps list + form so when the panel widens (.has-form), the
  // two become flex row siblings without dragging statusEl into the
  // row layout. statusEl stays above as a regular block.
  const colsEl = document.createElement("div");
  colsEl.className = "rt-tool-cols";
  colsEl.append(listEl, formEl);

  // View switcher — flips between the tools picker and the columns-as-
  // rows redtable (the WS#5 unification target spec'd in
  // architecture/columns-redtable.md). Slice A: the columns view is
  // read-only — no actions, no checkboxes, no cell-edit. It exists to
  // validate the layout + the data binding from activeColumns +
  // activeSummary before we port the 15 toolbar actions onto it.
  const switchEl = document.createElement("div");
  switchEl.className = "rt-tool-viewswitch rt-seg";
  switchEl.innerHTML =
      '<button class="is-active" type="button" data-view="tools" title="Tools picker">'
    +   '<i class="bi bi-tools"></i> Tools'
    + '</button>'
    + '<button type="button" data-view="columns" title="Columns table — preview, read-only">'
    +   '<i class="bi bi-grid-3x3"></i> Columns'
    + '</button>';
  const columnsEl = document.createElement("div");
  columnsEl.className = "rt-tool-columns";
  columnsEl.hidden = true;

  panelBody.innerHTML = "";
  panelBody.append(switchEl, statusEl, colsEl, columnsEl);

  // ── list view ──────────────────────────────────────────────────────
  // Picker rows show name + icon only — the per-tool blurb lives on the
  // form (rt-tool-form-blurb), no need to repeat it here. Keeps the
  // 15-tool catalog scrollable in a single screen.
  function renderList() {
    listEl.innerHTML = TOOLS.map((t, i) =>
      '<button class="rt-tool-item" type="button" data-i="' + i + '" title="' + esc(t.blurb || t.label) + '">'
      +   '<i class="bi ' + esc(t.icon) + '"></i>'
      +   '<span class="rt-tool-item-name">' + esc(t.label) + '</span>'
      + '</button>').join("");
  }
  listEl.addEventListener("click", (e) => {
    const btn = e.target.closest(".rt-tool-item");
    if (!btn) return;
    openForm(TOOLS[+btn.dataset.i]);
  });

  // ── view switcher ──────────────────────────────────────────────────
  switchEl.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-view]");
    if (!btn) return;
    setView(btn.dataset.view);
  });

  function setView(v) {
    if (v !== "tools" && v !== "columns") return;
    viewMode = v;
    switchEl.querySelectorAll("[data-view]").forEach((b) =>
      b.classList.toggle("is-active", b.dataset.view === v));
    const panel = panelBody.closest(".rt-panel");
    if (v === "columns") {
      // Close any open form before switching so the .has-form 500px
      // width doesn't fight with the columns view's .has-columns 50vw.
      if (activeTool) closeForm();
      colsEl.hidden = true;
      columnsEl.hidden = false;
      panel?.classList.add("has-columns");
      renderColumnsView();
    } else {
      colsEl.hidden = false;
      columnsEl.hidden = true;
      panel?.classList.remove("has-columns");
    }
  }

  // ── columns view ───────────────────────────────────────────────────
  // Rows = ColumnMeta[]; columns = #, Name, Datatype (+ sniff badge),
  // Nulls, % Null, Unique %, Sample. All fields come from the existing
  // /api/files/:rid envelope — no new endpoint. Sniff mismatch (storage
  // dtype ≠ semantic dtype) gets a small ⚠ badge so the dirty columns
  // surface visually without the user having to scan numbers.
  //
  // Slice B adds the global-actions toolbar above the table — the
  // first cut of the columns-redtable's toolbar (architecture/
  // columns-redtable.md). Dialog actions open an in-panel modal sheet
  // that reuses the existing FIELDS renderers.
  function renderColumnsView() {
    const cols    = ctx.columns() || [];
    const summary = ctx.summary ? ctx.summary() : null;
    const total   = summary?.row_count;
    if (!cols.length) {
      activeSheet = null;
      sheetFields = [];
      selectedCols.clear();
      columnsEl.innerHTML = '<p class="rt-step-state">Open a file to see its columns.</p>';
      return;
    }
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
      return '<tr' + (checked ? ' class="is-selected"' : '') + '>'
        + '<td class="is-check"><input type="checkbox" class="rt-chk rt-col-check"'
        +   ' data-col="' + esc(c.name) + '"' + (checked ? ' checked' : '') + ' /></td>'
        + '<td class="is-num is-muted">' + (i + 1) + '</td>'
        + '<td class="is-name">' + esc(c.name) + '</td>'
        + '<td>' + esc(c.dtype || "—") + sniff + '</td>'
        + '<td class="is-num ' + band + '">' + (nullCount != null ? nullCount : "—") + '</td>'
        + '<td class="is-num ' + band + '">' + (pct != null ? pct.toFixed(1) + "%" : "—") + '</td>'
        + '<td class="is-num">' + (uniqPct != null ? uniqPct.toFixed(1) + "%" : "—") + '</td>'
        + '<td class="is-sample" title="' + esc(sample) + '">' + esc(sample) + '</td>'
        + '</tr>';
    }).join("");
    columnsEl.innerHTML =
        '<div class="rt-tool-columns-head">'
      +   '<span class="rt-tool-columns-meta">'
      +     '<b>' + cols.length + '</b> column' + (cols.length === 1 ? '' : 's')
      +     (total != null ? ' · <b>' + total + '</b> row' + (total === 1 ? '' : 's') : '')
      +   '</span>'
      +   '<span class="rt-tool-columns-flag" title="Preview — edit mode lands in slices F–G.">preview</span>'
      + '</div>'
      + renderColumnsToolbar(summary)
      + (activeSheet ? renderColumnsSheet(cols) : '')
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
      const enabled = selCount >= a.min;
      const title   = enabled
        ? a.label + ' (' + selCount + ' column' + (selCount === 1 ? '' : 's') + ')'
        : 'Select ≥' + a.min + ' column' + (a.min === 1 ? '' : 's') + ' first.';
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
  // renderers (column/enum/text/boolean/multicolumn). Slice B uses
  // sheets for change_case (1 enum) + replace_in_names (2 text). The
  // sheet lives between the toolbar and the table.
  function renderColumnsSheet(cols) {
    if (!activeSheet) return '';
    sheetFields = activeSheet.fields.map((f) => {
      const renderer = FIELDS[f.type];
      if (!renderer) throw new Error("Unknown field type: " + f.type);
      const built = renderer({ ...f, columns: cols });
      return { field: f, html: built.html, read: built.read };
    });
    return '<div class="rt-tool-columns-sheet">'
      +    '<div class="rt-tool-columns-sheet-head">'
      +      '<span class="rt-tool-columns-sheet-title">'
      +        '<i class="bi ' + esc(activeSheet.icon) + '"></i> '
      +        esc(activeSheet.label)
      +      '</span>'
      +      '<button class="rt-btn rt-btn--ghost rt-tool-columns-sheet-close" type="button"'
      +        ' title="Cancel"><i class="bi bi-x-lg"></i></button>'
      +    '</div>'
      +    (activeSheet.blurb
            ? '<p class="rt-tool-columns-sheet-blurb">' + esc(activeSheet.blurb) + '</p>'
            : '')
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
        renderColumnsView();
      } else {
        await runStep(tool.kind, tool.toParams({}), tool.label, { busyBtn: actBtn });
      }
      return;
    }
    // Select action — fires one step over the picked columns.
    const selBtn = e.target.closest(".rt-tool-columns-action[data-select-kind]");
    if (selBtn && !selBtn.disabled) {
      const kind = selBtn.dataset.selectKind;
      const tool = getTool(kind);
      if (!tool) return;
      const cols = Array.from(selectedCols);
      if (!cols.length) return;
      // Engine signature for all three Slice C kinds is { cols: string[] }
      // (steps.rs: arr_strings(params, "cols")). drop_columns + the
      // affected columns vanish after apply → the intersect in
      // renderColumnsView clears the stale selection. filter_columns
      // keeps the picked set; drop_nulls keeps columns but removes rows.
      const label = (SELECT_ACTIONS.find((a) => a.kind === kind)?.label || tool.label)
                    + ' (' + cols.length + ')';
      await runStep(kind, { cols }, label, { busyBtn: selBtn });
      return;
    }
    // Selection chip — clear the lot.
    if (e.target.closest(".rt-tool-columns-selchip-clear")) {
      selectedCols.clear();
      renderColumnsView();
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
      const params = activeSheet.toParams(state);
      const tool = activeSheet;
      // Close optimistically — runStep → onApplied → loadFile → refresh
      // re-renders the view. On failure status shows the error inline
      // and the user re-opens the sheet (rare path; sheets are short).
      activeSheet = null;
      sheetFields = [];
      await runStep(tool.kind, params, tool.label, { busyBtn: applyBtn });
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

  function closeSheet() {
    activeSheet = null;
    sheetFields = [];
    renderColumnsView();
  }

  // ── form view ──────────────────────────────────────────────────────
  function openForm(tool) {
    if (!ctx.fileRid()) {
      setStatus("Open a file before running a tool.", "warn");
      return;
    }
    activeTool = tool;
    const columns = ctx.columns();
    renderedFields = tool.fields.map((f) => {
      const renderer = FIELDS[f.type];
      if (!renderer) throw new Error("Unknown field type: " + f.type);
      const built = renderer({ ...f, columns });
      return { field: f, html: built.html, read: built.read };
    });

    // Per-tool diagnostics surface — surfaces what the user needs to
    // pick *before* picking. Each tool can opt in by declaring a
    // `context(ctx)` function that returns HTML; null/empty skips.
    // Examples: drop_nulls ranks columns by null %; replace_text
    // could surface match counts; format_dates could surface
    // unparseable cell count. The slot is reserved on every tool form
    // so the pattern grows tool by tool without re-rendering anyone.
    const contextHTML = tool.context ? (tool.context(ctx) || "") : "";

    formEl.innerHTML =
      '<div class="rt-tool-form-head">'
      + '<button class="rt-btn rt-btn--ghost rt-tool-back" type="button" title="Back to tools">'
      +   '<i class="bi bi-chevron-left"></i>'
      + '</button>'
      + '<span class="rt-tool-form-title">'
      +   '<i class="bi ' + esc(tool.icon) + '"></i> ' + esc(tool.label)
      + '</span>'
      + '</div>'
      + (tool.blurb ? '<p class="rt-tool-form-blurb">' + esc(tool.blurb) + '</p>' : '')
      + (contextHTML ? '<div class="rt-tool-context">' + contextHTML + '</div>' : '')
      + '<div class="rt-tool-form-body">'
      +   (renderedFields.length
            ? renderedFields.map((r) => r.html).join("")
            : '<p class="rt-tool-form-blurb">No options — just apply.</p>')
      + '</div>'
      + '<div class="rt-tool-form-foot">'
      +   '<button class="rt-btn rt-tool-cancel" type="button">Cancel</button>'
      +   '<button class="rt-btn rt-btn--accent rt-tool-apply" type="button">'
      +     '<i class="bi bi-play-fill"></i> Apply'
      +   '</button>'
      + '</div>';

    // List stays visible — the panel widens, list keeps its 250px
    // column on the left, form takes the new 250px on the right. The
    // user can pick a different tool without going back first.
    formEl.hidden = false;
    panelBody.closest(".rt-panel")?.classList.add("has-form");
    // Mark the active tool in the list so the user sees which form
    // they're looking at.
    listEl.querySelectorAll(".rt-tool-item.is-active").forEach((b) => b.classList.remove("is-active"));
    const idx = TOOLS.indexOf(tool);
    if (idx >= 0) listEl.querySelector('.rt-tool-item[data-i="' + idx + '"]')?.classList.add("is-active");
  }

  formEl.addEventListener("click", async (e) => {
    if (e.target.closest(".rt-tool-back") || e.target.closest(".rt-tool-cancel")) {
      closeForm();
      return;
    }
    if (e.target.closest(".rt-tool-apply")) {
      await applyActive();
    }
  });

  function closeForm() {
    activeTool = null;
    renderedFields = [];
    formEl.innerHTML = "";
    formEl.hidden = true;
    listEl.querySelectorAll(".rt-tool-item.is-active").forEach((b) => b.classList.remove("is-active"));
    panelBody.closest(".rt-panel")?.classList.remove("has-form");
  }

  // POST a step + run the standard post-apply lifecycle (close the
  // form, set status, fire ctx.onApplied so the workspace refetches).
  // Shared between the form's Apply button and the context block's
  // action buttons (tool.handleAction can call runStep too).
  async function runStep(kind, params, label, opts = {}) {
    const rid = ctx.fileRid();
    if (!rid) { setStatus("Open a file before running a tool.", "warn"); return; }
    const busyBtn = opts.busyBtn;
    if (busyBtn) { busyBtn.disabled = true; busyBtn.classList.add("is-busy"); }
    try {
      const res = await api.post("/files/" + encodeURIComponent(rid) + "/steps",
                                 { kind, params });
      closeForm();
      setStatus("Applied: " + label, "ok");
      ctx.onApplied?.(res);
    } catch (err) {
      const msg = (err && (err.body?.message || err.body?.error)) || err?.message || "Apply failed";
      setStatus(msg + (err?.status ? " (" + err.status + ")" : ""), "err");
      if (busyBtn) { busyBtn.disabled = false; busyBtn.classList.remove("is-busy"); }
    }
  }

  async function applyActive() {
    if (!activeTool) return;
    const applyBtn = formEl.querySelector(".rt-tool-apply");
    const state = {};
    renderedFields.forEach((r) => { state[r.field.key] = r.read(formEl); });
    const params = activeTool.toParams(state);
    await runStep(activeTool.kind, params, activeTool.label, { busyBtn: applyBtn });
  }

  // Delegated click on the context block — tool.handleAction(action, helpers)
  // gets called when an element with data-action is clicked. Lets a tool's
  // context surface ship its own CTAs (e.g. drop_nulls' "Drop fully-null
  // rows" button) without each tool inventing its own wiring. `helpers`
  // gives the action handler ctx + runStep so it can fire any step.
  formEl.addEventListener("click", async (e) => {
    const actionBtn = e.target.closest(".rt-tool-context [data-action]");
    if (!actionBtn || !activeTool?.handleAction) return;
    const action = actionBtn.dataset.action;
    await activeTool.handleAction(action, { ctx, runStep, btn: actionBtn });
  });

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

  renderList();
  return {
    refresh() {
      // Columns / summary moved underneath us — re-render whatever view
      // is showing. The form rebuilds because its field renderers
      // capture the columns list at openForm time; the columns view
      // rebuilds because it's a pure projection of ctx.columns() +
      // ctx.summary().
      if (activeTool) openForm(activeTool);
      if (viewMode === "columns") renderColumnsView();
    },
    reset() { closeForm(); statusEl.hidden = true; },
    setView,
  };
}

// Local escape — tools.js is self-contained; workspace.js has its own.
// Per js-rust-boundary.md naming, `esc` (the shared noun) appears in both;
// keep them syntactically identical so future shared-primitive extraction
// (dom.js) can collapse them with a single move.
function esc(s) {
  return String(s ?? "").replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}
