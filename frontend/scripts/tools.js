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

export function mountTools(panelBody, ctx) {
  let activeTool = null;          // the TOOLS[i] currently showing the form
  let renderedFields = [];        // [{ field, read }] for the open form — read() returns value

  // Two stable containers — list view + form view; we swap visibility.
  const listEl = document.createElement("div");
  listEl.className = "rt-tool-list";
  const formEl = document.createElement("div");
  formEl.className = "rt-tool-form";
  formEl.hidden = true;
  const statusEl = document.createElement("div");
  statusEl.className = "rt-tool-status";
  statusEl.hidden = true;

  panelBody.innerHTML = "";
  panelBody.append(statusEl, listEl, formEl);

  // ── list view ──────────────────────────────────────────────────────
  function renderList() {
    listEl.innerHTML = TOOLS.map((t, i) =>
      '<button class="rt-tool-item" type="button" data-i="' + i + '">'
      +   '<i class="bi ' + esc(t.icon) + '"></i>'
      +   '<span class="rt-tool-item-body">'
      +     '<span class="rt-tool-item-name">' + esc(t.label) + '</span>'
      +     '<span class="rt-tool-item-blurb">' + esc(t.blurb) + '</span>'
      +   '</span>'
      + '</button>').join("");
  }
  listEl.addEventListener("click", (e) => {
    const btn = e.target.closest(".rt-tool-item");
    if (!btn) return;
    openForm(TOOLS[+btn.dataset.i]);
  });

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

    listEl.hidden = true;
    formEl.hidden = false;
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
    listEl.hidden = false;
  }

  async function applyActive() {
    if (!activeTool) return;
    const applyBtn = formEl.querySelector(".rt-tool-apply");
    applyBtn.disabled = true;
    applyBtn.classList.add("is-busy");

    const state = {};
    renderedFields.forEach((r) => { state[r.field.key] = r.read(formEl); });
    const params = activeTool.toParams(state);

    const rid = ctx.fileRid();
    try {
      const res = await api.post("/files/" + encodeURIComponent(rid) + "/steps",
                                 { kind: activeTool.kind, params });
      const label = activeTool.label;
      closeForm();
      setStatus("Applied: " + label, "ok");
      ctx.onApplied?.(res);
    } catch (err) {
      const msg = (err && (err.body?.message || err.body?.error)) || err?.message || "Apply failed";
      setStatus(msg + (err?.status ? " (" + err.status + ")" : ""), "err");
      applyBtn.disabled = false;
      applyBtn.classList.remove("is-busy");
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

  renderList();
  return {
    refresh() { /* if columns change underneath us, rebuild the form */
      if (activeTool) openForm(activeTool);
    },
    reset() { closeForm(); statusEl.hidden = true; },
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
