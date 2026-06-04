/* Purpose: Tools-panel framework component — the COLUMN MANAGER (show/hide + drag-reorder + rename/cast/select cleaning) mounted inside the rp-panel tools shell.
   Doc: docs/internal/code/frontend/scripts/framework/tools-panel.md */
// ── Tools panel / column manager (framework component, CAS_37B2E1BF / B3.3) ──
// The right-side COLUMN MANAGER surface of the RedTable. mountToolsPanel(host,
// config) COMPOSES the rp-panel shell (mountPanel, variant "tools") for the
// frame, then mounts the column-manager body INTO the returned panel body: a
// meta strip (col/row counts + a fully-null pill), a wrapping action toolbar
// (composing the rp-toolbar atom), the optional cast-confirm / step-preview
// sheets, and the scrollable column table (a rp-redtable variant).
//
// This is FORK C — the tools-panel column MANAGER table — which mountRedTable
// (redtable.js) deliberately does NOT fold in (it is the per-column metadata
// editor, not a data grid). It lives here as its own builder, composing the same
// foundation atoms.
//
// Composes, does NOT duplicate:
//   - mountPanel (panel.js) — the SHELL (pill tabs Clean/Joins + close + body).
//     The has-columns 35vw widen + the designer-mode hide live in panel.css.
//   - rp-redtable / rp-redtable-chk (redtable.js / redtable.css) — the column
//     table carries .rp-redtable for the base grid + the checkbox atom; the
//     column drag-reorder CSS (.is-dragging / .is-drop-before / .is-drop-after)
//     is ALREADY in redtable.css — REUSED on the displayed table, and the
//     manager's own row drag (if wired) uses the same class contract.
//   - the rp-toolbar atom (toolbar.css) — the in-panel action toolbar is a wrap
//     variant; the manager streams enabled/disabled action buttons so it builds
//     the markup directly (composing the CSS atom), not via mountToolbar.
//   - rp-search / rp-btn-icon / --accent / --sq / rp-empty (atoms.css).
//
// UNIFIED column identity — the two legacy column-state models (the Workspace
// show/hide picker keyed by nth-child INDEX vs the list-page reorder keyed by
// data-col-key) converge on data-col-key here. Every column the manager renders
// carries data-col-key (the logical id); onToggleColumn / onReorder / onResize
// all speak that key, matching the rp-redtable reorder contract. The brittle
// nth-child index model is retired.
//
// State is NOT owned here beyond the transient selection + edit-target + filter.
// The column list, the row data, the step pipeline, and the displayed-table DOM
// live in the page controller; the manager reaches OUT via the config callbacks
// (onToggleColumn / onReorder / onResize / onRename / onCast / onAction / …).
"use strict";

import { register } from "/scripts/framework/component-registry.js";
import { mountPanel } from "/scripts/framework/panel.js";
import { esc } from "/scripts/dom.js";

const ICON_SELCHIP = "bi-check2-square";
const ICON_SELCHIP_CLEAR = "bi-x";
const ICON_FULLYNULL = "bi-trash3";
const ICON_SHEET_CLOSE = "bi-x-lg";
const ICON_PREVIEW = "bi-eye";
const ICON_APPLY = "bi-play-fill";

// ── config shape (every field optional) ─────────────────────────────────────
//   tabs       : [{ id, label, icon, active }]  → the panel head pill strip
//                                                 (default Clean | Joins);
//                                                 mountPanel renders it.
//   columns    : [{ key, name, dtype, semantic_dtype, null_pct, unique_pct,
//                   sample }]  → the column rows. key = data-col-key (the unified
//                   identity); falls back to name when key is absent (legacy data).
//   summary    : { row_count, fully_null_rows }  → the meta strip counts + pill.
//   dtypeOptions : [[value, label], …]           → the inline cast <select> list
//                                                  (data-driven from the tool
//                                                  catalog; never enumerated here).
//   globalActions / selectActions : [{ kind, icon, label, title, enabled,
//                   disabled, min, max }]  → the toolbar action buttons.
//   filter     : string                          → the current "Filter columns…"
//                                                  query (the manager re-renders
//                                                  filtered; the page owns it).
//   sheet      : { variant:"action"|"cast"|"step", title, icon, blurb,
//                   chips:[name…], bodyHTML, confirmLabel }  → the open sheet.
//   onClose      : () => void                     → panel close.
//   onTab        : (id) => void                   → tab switch.
//   onFilter     : (q) => void                    → filter-box input.
//   onToggleColumn : (key, checked) => void       → row checkbox (selection).
//   onSelectAll  : (checked) => void              → header select-all.
//   onClearSel   : () => void                     → selection-chip clear.
//   onReorder    : (orderedKeys) => void          → column drag-reorder (keys).
//   onResize     : (key, width) => void           → column resize (no legacy
//                                                  provenance — wired only if a
//                                                  consumer supplies it; build-
//                                                  ready seam, not invented chrome).
//   onRename     : (fromKey, toName) => void       → inline rename commit.
//   onCast       : (key, toDtype) => void          → inline dtype-cast pick.
//   onAction     : (kind, scope) => void           → toolbar action button
//                                                  (scope = "global" | "select").
//   onFullyNull  : () => void                      → the fully-null pill.
//   onSheetClose / onSheetConfirm / onSheetPreview : () => void  → sheet foot.

/** Build + wire the tools panel into `host`. `host` becomes the `.rp-panel`
 *  aside (variant tools). Returns the controller
 *  { el, panel, body, columnsEl, render(config), setSelection(names),
 *    setOpen(bool), setTab(id) }. Self-registers as "tools-panel". */
export function mountToolsPanel(host, config = {}) {
  if (!host) return null;
  let cfg = config;

  // ── shell — compose mountPanel (variant "tools"); the pill tabs default to
  //    Clean | Joins (the legacy strip). The column-manager mounts into body. ──
  const panel = mountPanel(host, {
    variant: "tools",
    pills: true,
    tabs: cfg.tabs || [
      { id: "clean", label: "Clean", icon: "bi-tools", active: true },
      { id: "joins", label: "Joins", icon: "bi-link-45deg" },
    ],
    onClose: () => cfg.onClose && cfg.onClose(),
    onTab: (id) => cfg.onTab && cfg.onTab(id),
  });

  // tools.js historically adds .has-columns at mount so the panel opens to 35vw
  // (vs the base 15.625rem) — the column-manager always wants the wide layout.
  host.classList.add("has-columns");

  // The column-manager mounts into a host inside the panel body — its own
  // flex-column surface (was columnsEl.rt-tool-columns).
  const columnsEl = document.createElement("div");
  columnsEl.className = "rp-tool-columns";
  panel.body.appendChild(columnsEl);

  // ── per-section HTML (a missing config key emits the empty / placeholder) ───

  // The meta strip: <b>N</b> columns · <b>M</b> rows · the fully-null pill.
  function metaHTML(cols) {
    const summary = cfg.summary || null;
    const total = summary && summary.row_count != null ? summary.row_count : null;
    const fullyNull = summary ? summary.fully_null_rows : null;
    const pill = fullyNull != null && fullyNull > 0
      ? ' · <button class="rp-tool-columns-fullynull" type="button"'
        + ' data-tp-action="fully-null"'
        + ' title="Drop every row where every column is null">'
        + '<i class="bi ' + ICON_FULLYNULL + '"></i> Drop <b>' + esc(fullyNull) + "</b> fully-null row"
        + (fullyNull === 1 ? "" : "s")
        + "</button>"
      : "";
    return '<div class="rp-tool-columns-head">'
      + '<span class="rp-tool-columns-meta">'
      + "<b>" + esc(cols.length) + "</b> column" + (cols.length === 1 ? "" : "s")
      + (total != null ? " · <b>" + esc(total) + "</b> row" + (total === 1 ? "" : "s") : "")
      + pill
      + "</span></div>";
  }

  // A single action button (rt-btn → rp-btn-icon). data-tp-action routes it; the
  // kind + scope ride along so the one delegated handler can dispatch.
  function actionBtn(a, scope) {
    const disabled = a.disabled ? " disabled" : "";
    return '<button type="button" class="rp-btn-icon" data-tp-action="action"'
      + ' data-tp-kind="' + esc(a.kind) + '"'
      + ' data-tp-scope="' + esc(scope) + '"'
      + (scope === "select" ? ' data-select-kind="' + esc(a.kind) + '"' : "")
      + disabled
      + ' title="' + esc(a.title || a.label || a.kind) + '">'
      + '<i class="bi ' + esc(a.icon) + '"></i></button>';
  }

  // The wrapping action toolbar — composes the rp-toolbar atom + the wrap
  // variant. Row 1: search + enabled actions. Row 2 (after the zero-height
  // -break): disabled (gated) actions + the selection chip at the far end.
  function toolbarHTML() {
    const sel = selectedNames;
    const selCount = sel.size;
    const globals = (cfg.globalActions || []).map((a) => ({
      enabled: a.enabled !== false && !a.disabled,
      html: actionBtn(a, "global"),
    }));
    const selects = (cfg.selectActions || []).map((a) => {
      const meetsMin = a.min == null || selCount >= a.min;
      const meetsMax = a.max == null || selCount <= a.max;
      const enabled = meetsMin && meetsMax;
      return { enabled, html: actionBtn({ ...a, disabled: !enabled }, "select") };
    });
    const all = globals.concat(selects);
    const enabledHTML = all.filter((b) => b.enabled).map((b) => b.html).join("");
    const disabledHTML = all.filter((b) => !b.enabled).map((b) => b.html).join("");
    const chip = '<span class="rp-tool-columns-selchip' + (selCount ? " is-active" : "") + '"'
      + (selCount ? ' title="Click to clear selection" data-tp-action="clear-sel"' : "") + ">"
      + '<i class="bi ' + ICON_SELCHIP + '"></i>'
      + "<b>" + esc(selCount) + "</b> selected"
      + (selCount
          ? '<button class="rp-btn-icon rp-btn-icon--sq rp-tool-columns-selchip-clear" type="button"'
            + ' data-tp-action="clear-sel" title="Clear selection">'
            + '<i class="bi ' + ICON_SELCHIP_CLEAR + '"></i></button>'
          : "")
      + "</span>";
    return '<div class="rp-toolbar rp-tool-columns-toolbar">'
      + '<div class="rp-search">'
      + '<i class="bi bi-search"></i>'
      + '<input type="search" data-tp-search placeholder="Filter columns…"'
      + ' autocomplete="off" spellcheck="false" value="' + esc(cfg.filter || "") + '" /></div>'
      + '<span class="rp-toolbar-sep"></span>'
      + enabledHTML
      + '<span class="rp-tool-columns-toolbar-break"></span>'
      + disabledHTML
      + chip
      + "</div>";
  }

  // The optional in-panel sheet (action form / cast-confirm / step-preview). The
  // variant maps to the legacy modifier class (rp-cast-confirm / rp-step-preview).
  function sheetHTML() {
    const s = cfg.sheet;
    if (!s) return "";
    const variantCls = s.variant === "cast" ? " rp-cast-confirm"
      : s.variant === "step" ? " rp-step-preview" : "";
    const chips = (s.chips && s.chips.length)
      ? '<div class="rp-tool-columns-sheet-chips" title="Columns this action will run on, in file order">'
        + '<span class="rp-tool-columns-sheet-chips-lbl">Acting on</span>'
        + s.chips.map((n) => '<span class="rp-tool-columns-sheet-chip">' + esc(n) + "</span>").join("")
        + "</div>"
      : "";
    const blurb = s.blurb
      ? '<p class="rp-tool-columns-sheet-blurb">' + esc(s.blurb) + "</p>"
      : "";
    // bodyHTML is the FIELDS-rendered form (sibling JS owns the field renderers,
    // which compose the rp-pred filter-panel family). The manager places it; the
    // page is responsible for any unescaped trust in its own renderers.
    const body = '<div class="rp-tool-columns-sheet-body">' + (s.bodyHTML || "") + "</div>";
    const foot = '<div class="rp-tool-columns-sheet-foot">'
      + '<button class="rp-btn-icon rp-tool-columns-sheet-cancel" type="button"'
      + ' data-tp-action="sheet-close">Cancel</button>'
      + (s.variant !== "step"
          ? '<button class="rp-btn-icon rp-tool-columns-sheet-preview" type="button"'
            + ' data-tp-action="sheet-preview" title="See what this will change before applying">'
            + '<i class="bi ' + ICON_PREVIEW + '"></i> Preview</button>'
          : "")
      + '<button class="rp-btn-icon rp-btn-icon--accent rp-tool-columns-sheet-apply" type="button"'
      + ' data-tp-action="sheet-confirm">'
      + '<i class="bi ' + ICON_APPLY + '"></i> ' + esc(s.confirmLabel || "Apply") + "</button>"
      + "</div>";
    return '<div class="rp-tool-columns-sheet' + variantCls + '">'
      + '<div class="rp-tool-columns-sheet-head">'
      + '<span class="rp-tool-columns-sheet-title">'
      + (s.icon ? '<i class="bi ' + esc(s.icon) + '"></i> ' : "")
      + esc(s.title || "") + "</span>"
      + '<button class="rp-btn-icon rp-btn-icon--sq rp-tool-columns-sheet-close" type="button"'
      + ' data-tp-action="sheet-close" title="Cancel">'
      + '<i class="bi ' + ICON_SHEET_CLOSE + '"></i></button>'
      + "</div>"
      + blurb
      + chips
      + body
      + foot
      + "</div>";
  }

  // One column row. data-col-key is the unified identity (falls back to name for
  // legacy data without an explicit key). The Name + Type cells swap to an inline
  // input/select when the column is the active edit target.
  function rowHTML(c, i) {
    const key = c.key != null ? c.key : c.name;
    const total = cfg.summary && cfg.summary.row_count != null ? cfg.summary.row_count : null;
    const pct = c.null_pct == null ? null : Math.max(0, Math.min(100, c.null_pct));
    const nullCount = pct != null && total != null ? Math.round((pct * total) / 100) : null;
    const band = pct == null ? "" : pct >= 50 ? "is-warn-high" : pct >= 10 ? "is-warn-mid" : "";
    const uniqPct = c.unique_pct == null ? null : Math.max(0, Math.min(100, c.unique_pct));
    const sample = c.sample == null ? "" : String(c.sample);
    const sniff = c.semantic_dtype && c.dtype && c.semantic_dtype !== c.dtype
      ? ' <span class="rp-col-sniff" title="Sniffed as ' + esc(c.semantic_dtype)
        + " — stored as " + esc(c.dtype) + '">⚠</span>'
      : "";
    const checked = selectedNames.has(key);
    const isEditingName = editingName === key;
    const nameCell = isEditingName
      ? '<td class="is-name is-editing" data-col-key="' + esc(key) + '">'
        + '<input class="rp-col-name-input" type="text" value="' + esc(c.name) + '"'
        + ' data-orig="' + esc(c.name) + '" autocomplete="off" spellcheck="false" /></td>'
      : '<td class="is-name is-editable" data-col-key="' + esc(key) + '"'
        + ' title="Click to rename">' + esc(c.name) + "</td>";
    const isEditingDtype = editingDtype === key;
    const dtypeCell = isEditingDtype
      ? '<td class="is-dtype is-editing" data-col-key="' + esc(key) + '">'
        + '<select class="rp-col-dtype-select" data-orig="' + esc(c.dtype || "") + '">'
        + (cfg.dtypeOptions || []).map(([v, l]) =>
            '<option value="' + esc(v) + '"' + (v === c.dtype ? " selected" : "") + ">"
            + esc(l) + "</option>").join("")
        + "</select></td>"
      : '<td class="is-dtype is-editable" data-col-key="' + esc(key) + '"'
        + ' title="Click to change type">' + esc(c.dtype || "—") + sniff + "</td>";
    return '<tr data-col-key="' + esc(key) + '"' + (cfg.onReorder ? ' draggable="true"' : "")
      + (checked ? ' class="is-selected"' : "") + ">"
      + '<td class="is-check"><input type="checkbox" class="rp-redtable-chk rp-col-check"'
      + ' data-col-key="' + esc(key) + '"' + (checked ? " checked" : "") + " /></td>"
      + '<td class="is-num is-muted">' + esc(i + 1) + "</td>"
      + nameCell
      + dtypeCell
      + '<td class="is-num ' + band + '">' + (nullCount != null ? esc(nullCount) : "—") + "</td>"
      + '<td class="is-num ' + band + '">' + (pct != null ? esc(pct.toFixed(1)) + "%" : "—") + "</td>"
      + '<td class="is-num">' + (uniqPct != null ? esc(uniqPct.toFixed(1)) + "%" : "—") + "</td>"
      + '<td class="is-sample" title="' + esc(sample) + '">' + esc(sample) + "</td>"
      + "</tr>";
  }

  // The column table — a rp-redtable variant (base grid) + the manager context.
  function tableHTML(cols) {
    const q = (cfg.filter || "").trim().toLowerCase();
    const visible = cols
      .map((c, i) => [c, i])
      .filter(([c]) => !q || String(c.name).toLowerCase().includes(q));
    const allSelected = cols.length > 0 && cols.every((c) => selectedNames.has(c.key != null ? c.key : c.name));
    const body = visible.length
      ? visible.map(([c, i]) => rowHTML(c, i)).join("")
      : '<tr><td colspan="8" class="rp-tool-columns-nomatch">No columns match “'
        + esc(cfg.filter || "") + "”.</td></tr>";
    return '<div class="rp-tool-columns-tablewrap">'
      + '<table class="rp-redtable rp-tool-columns-table">'
      + "<thead><tr>"
      + '<th class="is-check"><input type="checkbox" class="rp-redtable-chk rp-col-check-all"'
      + (allSelected ? " checked" : "") + " /></th>"
      + "<th>#</th><th>Name</th><th>Type</th>"
      + '<th class="is-num">Nulls</th><th class="is-num">% Null</th>'
      + '<th class="is-num">Unique %</th><th>Sample</th>'
      + "</tr></thead>"
      + "<tbody>" + body + "</tbody>"
      + "</table></div>";
  }

  // ── transient state (selection + edit target + drag) ───────────────────────
  let selectedNames = new Set();        // keys of selected columns
  let editingName = null;               // key being inline-renamed
  let editingDtype = null;              // key being inline-cast
  let dragKey = null;                   // active drag source key

  // ── render the manager body into columnsEl ─────────────────────────────────
  function render(next) {
    if (next) cfg = next;
    const cols = cfg.columns || [];
    if (!cols.length) {
      selectedNames.clear();
      editingName = null;
      editingDtype = null;
      columnsEl.innerHTML = '<p class="rp-empty">Open a file to see its columns.</p>';
      return;
    }
    // Drop stale selection / edit targets if their column no longer exists.
    const live = new Set(cols.map((c) => (c.key != null ? c.key : c.name)));
    if (editingName && !live.has(editingName)) editingName = null;
    if (editingDtype && !live.has(editingDtype)) editingDtype = null;
    for (const k of Array.from(selectedNames)) if (!live.has(k)) selectedNames.delete(k);

    columnsEl.innerHTML = metaHTML(cols) + toolbarHTML() + sheetHTML() + tableHTML(cols);

    // The select-all indeterminate state can't be set via an HTML attr.
    const head = columnsEl.querySelector(".rp-col-check-all");
    if (head) {
      const someSelected = !cols.every((c) => selectedNames.has(c.key != null ? c.key : c.name))
        && cols.some((c) => selectedNames.has(c.key != null ? c.key : c.name));
      head.indeterminate = someSelected;
    }
    // Auto-focus the active inline edit input (rAF avoids the focus being stolen
    // back by the originating click).
    if (editingName || editingDtype) {
      const inp = columnsEl.querySelector(".rp-col-name-input, .rp-col-dtype-select");
      if (inp) requestAnimationFrame(() => { inp.focus(); inp.select && inp.select(); });
    }
  }

  // ── one delegated click handler routes every action by data-* attribute ─────
  columnsEl.addEventListener("click", (e) => {
    // Inline rename — click an editable Name cell to start editing.
    const nameCell = e.target.closest("td.is-name.is-editable");
    if (nameCell) {
      editingDtype = null;
      editingName = nameCell.dataset.colKey;
      render();
      return;
    }
    // Inline dtype — click an editable Type cell to start editing.
    const dtypeCell = e.target.closest("td.is-dtype.is-editable");
    if (dtypeCell) {
      editingName = null;
      editingDtype = dtypeCell.dataset.colKey;
      render();
      return;
    }
    const el = e.target.closest("[data-tp-action]");
    if (!el || !columnsEl.contains(el)) return;
    if (el.disabled) return;
    switch (el.dataset.tpAction) {
      case "action":
        cfg.onAction && cfg.onAction(el.dataset.tpKind, el.dataset.tpScope);
        return;
      case "clear-sel":
        selectedNames.clear();
        cfg.onClearSel && cfg.onClearSel();
        render();
        return;
      case "fully-null":
        cfg.onFullyNull && cfg.onFullyNull();
        return;
      case "sheet-close":
        cfg.onSheetClose && cfg.onSheetClose();
        return;
      case "sheet-preview":
        cfg.onSheetPreview && cfg.onSheetPreview();
        return;
      case "sheet-confirm":
        cfg.onSheetConfirm && cfg.onSheetConfirm();
        return;
    }
  });

  // Filter-box input (the page owns the query; the manager re-renders filtered).
  columnsEl.addEventListener("input", (e) => {
    const input = e.target.closest("[data-tp-search]");
    if (!input || !columnsEl.contains(input)) return;
    cfg.filter = input.value;
    cfg.onFilter && cfg.onFilter(input.value.trim());
    render();
  });

  // Selection checkboxes (header select-all + per-row), keyed by data-col-key.
  columnsEl.addEventListener("change", (e) => {
    const all = e.target.closest(".rp-col-check-all");
    if (all) {
      const cols = cfg.columns || [];
      if (all.checked) cols.forEach((c) => selectedNames.add(c.key != null ? c.key : c.name));
      else selectedNames.clear();
      cfg.onSelectAll && cfg.onSelectAll(all.checked);
      render();
      return;
    }
    const chk = e.target.closest(".rp-col-check");
    if (chk) {
      const key = chk.dataset.colKey;
      if (chk.checked) selectedNames.add(key);
      else selectedNames.delete(key);
      cfg.onToggleColumn && cfg.onToggleColumn(key, chk.checked);
      render();
      return;
    }
    // Inline dtype-cast pick — change on the swapped <select>.
    const sel = e.target.closest(".rp-col-dtype-select");
    if (sel) {
      const cell = sel.closest("td.is-dtype");
      const key = cell ? cell.dataset.colKey : null;
      const from = sel.dataset.orig;
      const to = sel.value;
      editingDtype = null;
      if (key && to && to !== from) cfg.onCast && cfg.onCast(key, to);
      else render();
      return;
    }
  });

  // Inline rename — Enter commits, Esc cancels (delegated keydown on the input).
  columnsEl.addEventListener("keydown", (e) => {
    const input = e.target.closest(".rp-col-name-input");
    if (!input) return;
    if (e.key === "Enter") {
      e.preventDefault();
      commitRename(input);
    } else if (e.key === "Escape") {
      e.preventDefault();
      editingName = null;
      render();
    }
  });
  // Blur also commits (matches the legacy commitNameEdit on blur).
  columnsEl.addEventListener("focusout", (e) => {
    const input = e.target.closest(".rp-col-name-input");
    if (input) commitRename(input);
  });

  function commitRename(input) {
    const cell = input.closest("td.is-name");
    const key = cell ? cell.dataset.colKey : null;
    const from = input.dataset.orig;
    const to = input.value.trim();
    editingName = null;
    if (key && to && to !== from) cfg.onRename && cfg.onRename(key, to);
    else render();
  }

  // ── column drag-reorder — REUSES the redtable.css .is-dragging /
  //    .is-drop-before / .is-drop-after CSS contract (NOT re-ported). Keyed by
  //    data-col-key; emits the new visible-column key order via onReorder.
  //    Wired only when a consumer supplies onReorder (build-ready otherwise). ──
  if (cfg.onReorder) {
    // The manager lists each data column as a ROW (tr[data-col-key]); reorder is
    // a VERTICAL row drag (the displayed RedTable owns the actual th-DOM surgery,
    // keyed off the same data-col-key, via its own horizontal reorder). Rows are
    // the drag handles, so target tr[data-col-key] + use clientY (top/bottom half).
    function clearDropMarks() {
      columnsEl.querySelectorAll(".is-drop-before, .is-drop-after")
        .forEach((tr) => tr.classList.remove("is-drop-before", "is-drop-after"));
    }
    columnsEl.addEventListener("dragstart", (e) => {
      const tr = e.target.closest("tr[data-col-key]");
      if (!tr) return;
      dragKey = tr.dataset.colKey;
      tr.classList.add("is-dragging");
      if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
    });
    columnsEl.addEventListener("dragover", (e) => {
      const tr = e.target.closest("tr[data-col-key]");
      if (!tr || tr.dataset.colKey === dragKey || dragKey == null) return;
      e.preventDefault();
      clearDropMarks();
      const rect = tr.getBoundingClientRect();
      const after = e.clientY - rect.top > rect.height / 2;
      tr.classList.add(after ? "is-drop-after" : "is-drop-before");
    });
    columnsEl.addEventListener("drop", (e) => {
      const tr = e.target.closest("tr[data-col-key]");
      if (!tr || dragKey == null) return;
      e.preventDefault();
      const after = tr.classList.contains("is-drop-after");
      clearDropMarks();
      reorderTo(dragKey, tr.dataset.colKey, after);
      dragKey = null;
    });
    columnsEl.addEventListener("dragend", () => {
      clearDropMarks();
      columnsEl.querySelectorAll(".is-dragging").forEach((el) => el.classList.remove("is-dragging"));
      dragKey = null;
    });
  }

  // Compute the new visible-key order and emit it; the page persists + re-feeds
  // the reordered columns back through render (the displayed RedTable owns the
  // actual DOM surgery via its own reorder, keyed off the same data-col-key).
  function reorderTo(fromKey, toKey, after) {
    if (fromKey === toKey) return;
    const order = (cfg.columns || []).map((c) => (c.key != null ? c.key : c.name));
    const fromI = order.indexOf(fromKey);
    if (fromI === -1) return;
    order.splice(fromI, 1);
    let toI = order.indexOf(toKey);
    if (toI === -1) return;
    if (after) toI += 1;
    order.splice(toI, 0, fromKey);
    cfg.onReorder && cfg.onReorder(order.slice());
  }

  render(config);

  return {
    el: host,
    panel,
    body: panel.body,
    columnsEl,
    render,
    /** Replace the selection set (keys) without a full config swap. */
    setSelection(keys) {
      selectedNames = new Set(keys || []);
      render();
    },
    /** Open / close the panel (delegates to the shell). */
    setOpen(open) { panel.setOpen(open); },
    /** Switch the head tab (delegates to the shell). */
    setTab(id) { panel.setTab(id); },
  };
}

register("tools-panel", mountToolsPanel);
