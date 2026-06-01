/* Purpose: see doc for details.
 * Doc: docs/internal/code/frontend/scripts/tools.md */
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
// First slice of the tools.js decomposition (god-object campaign,
// Em 2026-05-27 — Internal-Slack/broadcast.md 00:53). FIELDS is the
// 5-renderer dispatch object consumed at this file's sheet-renderer
// (~line 558 in the pre-slice file; ~line 498 post-slice). Module-
// private — no external surface change. Promote `tools/fields.js`
// to a re-export if a future page composes the same field family.
import { FIELDS } from "/scripts/tools/fields.js";
// Slice 2 — columns-view toolbar actions (GLOBAL + SELECT). Same
// pattern as slice 1: module-private to tools.js, single source of
// truth for the shape vocabulary (hasSheet / perColumn / mapCols /
// colsParam / enabled). See `tools/actions.js`'s header for the
// shape contract.
import { GLOBAL_ACTIONS, SELECT_ACTIONS } from "/scripts/tools/actions.js";
// Sentinel picker reads/writes the user's learned-sentinel list (a server
// pref) so "add your own" persists + (with Share on) promotes to global.
import { getPref, setPref } from "/scripts/prefs.js";
// Slice 3 — the 12-tool catalog. Each entry pairs a server step kind
// (matches Rust steps.rs verbatim) with its picker label / icon /
// blurb / fields / toParams. See `tools/catalog.js`'s header for the
// shape vocabulary. Order matters — picker rendering iterates the
// array directly.
import { TOOLS } from "/scripts/tools/catalog.js";

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
// GLOBAL_ACTIONS + SELECT_ACTIONS extracted into `tools/actions.js`
// as slice 2 of the decomposition (broadcast.md 00:53). See the
// sibling module's header for the full shape vocabulary (hasSheet /
// enabled / perColumn / colsParam / mapCols). Each entry still
// references an existing TOOLS kind — tools.js remains the single
// source of truth for label/icon/blurb/fields/toParams.

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
  let colFilter    = "";          // toolbar search text — filters the columns table by name
  let refocusColSearch = false;   // re-focus the search input after a filter-driven re-render

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
      columnsEl.innerHTML = '<p class="rt-empty rt-step-state">Open a file to see its columns.</p>';
      return;
    }
    // The live column set drives both the stale-edit-target guards and
    // the selection intersection below, so it must be built up front —
    // referencing it before this point throws a TDZ ReferenceError.
    const live = new Set(cols.map((c) => c.name));
    // Drop stale edit targets if the column they point at no longer
    // exists (file change, rename via another path, drop_columns step).
    if (editingName  && !live.has(editingName))  editingName  = null;
    if (editingDtype && !live.has(editingDtype)) editingDtype = null;
    if (castConfirm  && !live.has(castConfirm.column)) castConfirm = null;
    // Intersect the current selection with the live column set — a
    // prior step (drop_columns, rename_column, etc.) may have removed
    // or renamed columns that the user had selected. Stale names get
    // silently dropped so the toolbar's count stays honest.
    for (const n of selectedCols) if (!live.has(n)) selectedCols.delete(n);

    const allSelected  = cols.length > 0 && cols.every((c) => selectedCols.has(c.name));
    const someSelected = !allSelected && cols.some((c) => selectedCols.has(c.name));

    const q = colFilter.trim().toLowerCase();
    const visible = cols
      .map((c, i) => [c, i])
      .filter(([c]) => !q || String(c.name).toLowerCase().includes(q));
    const rows = visible.map(([c, i]) => {
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
      return '<tr data-name="' + esc(c.name) + '"' + (checked ? ' class="is-selected"' : '') + '>'
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
    }).join("")
      || '<tr><td colspan="8" class="rt-tool-columns-nomatch">No columns match “' + esc(colFilter) + '”.</td></tr>';
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
      +   '<table class="rt-table rt-tool-columns-table">'
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
    // Restore focus + caret to the search after a filter-driven re-render
    // (synchronous — no originating click to steal focus back).
    if (refocusColSearch) {
      refocusColSearch = false;
      const search = columnsEl.querySelector("[data-col-search]");
      if (search) {
        search.focus();
        const end = search.value.length;
        try { search.setSelectionRange(end, end); } catch (_) { /* type=search */ }
      }
    }
    // Sentinel picker — the sheet's `sentinels` field renders only a
    // placeholder; scan the file async and paint the junk chips into it
    // (FIELDS renderers are sync; the /sentinels scan isn't).
    if (activeSheet && activeSheet.fields?.some((f) => f.type === "sentinels")) {
      populateSentinels();
    }
  }

  // Scan the active file + render its junk values as pickable chips into
  // the open Fix-invalid sheet. Found-in-file (pre-checked, with counts)
  // first, then the rest of the known set. Reuses the existing
  // GET /files/:rid/sentinels scanner — the FE just stopped calling it.
  async function populateSentinels() {
    const host = columnsEl.querySelector("[data-sentinel-found]");
    const rid  = ctx.fileRid && ctx.fileRid();
    if (!host || !rid) return;
    let learned = [];
    try { const l = getPref("learned_sentinels"); if (Array.isArray(l)) learned = l; } catch (_e) { /* unregistered */ }
    const qs = learned.length ? "?extra=" + encodeURIComponent(learned.join(",")) : "";
    try {
      // DATA-ENDPOINT-ACK: caller-checks-file_type — populateSentinels runs
      // only from the Fix-invalid sheet in the Tools panel, which renders
      // for data files only (never a chart/dashboard rid).
      const res   = await api.get("/files/" + rid + "/sentinels" + qs);
      const items = res.items || [];
      const known = res.known || [];
      const seen  = new Set(items.map((i) => i.canonical || i.value));
      const chip  = (val, count, on) =>
        '<label class="rt-sentinel-chip' + (on ? " is-on" : "") + '">'
        + '<input type="checkbox" class="rt-chk" data-sentinel-val="' + esc(val) + '"'
        + (on ? " checked" : "") + " /> "
        + '<span class="rt-sentinel-chip-val">' + esc(val) + "</span>"
        + (count != null ? '<span class="rt-sentinel-chip-n">×' + count + "</span>" : "")
        + "</label>";
      let html = items.map((i) => chip(i.value, i.total, true)).join("");
      const others = known.filter((k) => !seen.has(k));
      if (others.length) {
        html += '<div class="rt-sentinel-known-lbl">also known</div>'
          + others.map((k) => chip(k, null, false)).join("");
      }
      host.innerHTML = html
        || '<span class="rt-sentinel-clean">No junk values found — this file looks clean.</span>';
    } catch (_e) {
      host.innerHTML = '<span class="rt-sentinel-err">Couldn’t scan — type values below.</span>';
    }
  }

  // Toolbar — global actions (Slice B) + select actions (Slice C).
  // Edit mode lands in slices F–G alongside cell-edit affordances.
  function renderColumnsToolbar(summary) {
    const selCount = selectedCols.size;
    // Each button carries its enabled flag so we can stream enabled
    // actions onto row 1 and drop the locked ones to row 2 below.
    const globalBtns = GLOBAL_ACTIONS.map((a) => {
      const tool = getTool(a.kind);
      if (!tool) return null;
      const enabled = a.enabled ? a.enabled(summary) : true;
      // Icon-only now, so the tooltip must carry the name: "Label — reason".
      const reason  = enabled ? tool.blurb : (a.disabledTitle || tool.blurb);
      const label   = tool.label + (a.hasSheet ? '…' : '');
      const tip     = reason && reason !== tool.label ? label + ' — ' + reason : label;
      return { enabled, html:
        '<button class="rt-btn" type="button"'
        + ' data-action-kind="' + esc(a.kind) + '"'
        + (enabled ? '' : ' disabled')
        + ' title="' + esc(tip) + '">'
        + '<i class="bi ' + esc(tool.icon) + '"></i></button>' };
    }).filter(Boolean);
    const selBtns = SELECT_ACTIONS.map((a) => {
      const tool = getTool(a.kind);
      if (!tool) return null;
      const meetsMin = selCount >= a.min;
      const meetsMax = a.max == null || selCount <= a.max;
      const enabled  = meetsMin && meetsMax;
      // Title spells out the gating reason so the disabled state isn't
      // a mystery — "exactly 1" / "exactly 2" / "≥N" are the three shapes.
      // Icon-only now: lead the tooltip with the action label, then the
      // count / gating reason.
      let title;
      if (enabled) {
        title = a.label + ' (' + selCount + ' column' + (selCount === 1 ? '' : 's') + ')';
      } else if (a.min === a.max) {
        title = a.label + ' — select exactly ' + a.min + ' column' + (a.min === 1 ? '' : 's') + ' first.';
      } else if (!meetsMin) {
        title = a.label + ' — select ≥' + a.min + ' column' + (a.min === 1 ? '' : 's') + ' first.';
      } else {
        title = a.label + ' — select ≤' + a.max + ' column' + (a.max === 1 ? '' : 's') + ' (currently ' + selCount + ').';
      }
      return { enabled, html:
        '<button class="rt-btn" type="button"'
        + ' data-select-kind="' + esc(a.kind) + '"'
        + (enabled ? '' : ' disabled')
        + ' title="' + esc(title) + '">'
        + '<i class="bi ' + esc(a.icon) + '"></i></button>' };
    }).filter(Boolean);
    const allBtns      = globalBtns.concat(selBtns);
    const enabledHtml  = allBtns.filter((b) => b.enabled).map((b) => b.html).join('');
    const disabledHtml = allBtns.filter((b) => !b.enabled).map((b) => b.html).join('');
    // Selection chip — count + clear; click clears the selection.
    // Visually muted when nothing is picked so it doesn't shout
    // "0 selected" at the user constantly.
    const chip =
      '<span class="rt-tool-columns-selchip' + (selCount ? ' is-active' : '') + '"'
      + (selCount ? ' title="Click to clear selection"' : '') + '>'
      +   '<i class="bi bi-check2-square"></i>'
      +   '<b>' + selCount + '</b> selected'
      +   (selCount ? '<button class="rt-icon-btn rt-icon-btn--sm rt-tool-columns-selchip-clear" type="button"'
                      + ' title="Clear selection"><i class="bi bi-x"></i></button>' : '')
      + '</span>';
    // Row 1: a full-width search + every enabled (actionable) button.
    // Row 2 (after a 100%-basis break): the locked buttons, with the
    // selection chip pinned to the far end — so "needs a selection" sits
    // visibly below what you can do now, and the chip anchors the corner.
    return '<div class="rt-toolbar rt-tool-columns-toolbar">'
      +    '<div class="rt-search">'
      +      '<i class="bi bi-search"></i>'
      +      '<input type="search" data-col-search placeholder="Filter columns…"'
      +        ' autocomplete="off" spellcheck="false" value="' + esc(colFilter) + '" />'
      +    '</div>'
      +    '<span class="rt-toolbar-sep"></span>'
      +    enabledHtml
      +    '<span class="rt-tool-columns-toolbar-break"></span>'
      +    disabledHtml
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
      +      '<button class="rt-icon-btn rt-tool-columns-sheet-close" type="button"'
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
    const actBtn = e.target.closest("button[data-action-kind]");
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
    const selBtn = e.target.closest("button[data-select-kind]");
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
      // Custom junk the user typed — captured BEFORE the optimistic
      // re-render clears the input; persisted to their Settings list
      // after the step applies (Share-on → server promotes it global).
      const typedSentinels = tool.kind === "fix_invalid"
        ? (columnsEl.querySelector("[data-sentinel-add]")?.value || "")
            .split(",").map((t) => t.trim()).filter(Boolean)
        : [];
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
      // Remember typed custom junk — lands in Settings → Personal
      // sentinels (setPref → PATCH /api/me/prefs); the server promotes it
      // to the global vocabulary once a 2nd user flags it, if Share is on.
      if (typedSentinels.length) {
        try {
          const cur  = getPref("learned_sentinels");
          const list = Array.isArray(cur) ? cur : [];
          const next = [...new Set([...list, ...typedSentinels])];
          if (next.length !== list.length) setPref("learned_sentinels", next);
        } catch (_e) { /* best-effort; the clean already applied */ }
      }
    }
  });

  // Toolbar search — filters the columns table by name. Re-renders so
  // the row set (and the "no match" fallback) stays consistent with any
  // action that fires meanwhile; refocusColSearch restores the caret.
  columnsEl.addEventListener("input", (e) => {
    const search = e.target.closest("[data-col-search]");
    if (!search) return;
    colFilter = search.value;
    refocusColSearch = true;
    renderColumnsView();
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

