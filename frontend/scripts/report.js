/* Purpose: see doc for details.
 * Doc: docs/internal/code/frontend/scripts/report.md */
// Report builder — the second tab in the filter panel. Edits a
// ReportSpec (shared::report::ReportSpec) against the open file and
// runs it through POST /api/group/preview (group.rs:25, renamed from
// the old /api/reports/preview after the object-model hard refresh).
//
// Targets the full pipeline (group_by + aggregations + windows +
// top-N) per docs/internal/architecture columns-redtable.md's sibling
// docs/features/reports.md. This module ships group_by + aggregations
// first (C1); windows + top-N land in follow-up commits with the
// builder shape unchanged — they're extra sections, not rewires.
//
// ctx: { fileRid, columns, onPreview(GroupPage), onError(err), setStatus(text, kind) }
//   - fileRid:   () => string | null
//   - columns:   () => ColumnMeta[]
//   - onPreview: called with the /preview response so the workspace
//                can render the sample table where it wants (panel,
//                main area, etc.) — keeps render decisions outside
//                this module.
//   - setStatus: surface inline messages (apply errors / "no fields
//                yet" warnings).

import { api } from "/scripts/api.js";
import { esc } from "/scripts/dom.js";

// Report builder vocabulary (AGG_FNS / WINDOW_FN_GROUPS /
// WINDOW_VALUE_FNS / WINDOW_OFFSET_FNS / PREVIEW_DEBOUNCE_MS)
// extracted into `report/vocab.js` as slice 7 of the god-object
// decomposition (broadcast.md 00:53). Module-private; promote if
// a future surface composes the aggregation vocabulary.
import {
  AGG_FNS,
  WINDOW_FN_GROUPS,
  WINDOW_VALUE_FNS,
  WINDOW_OFFSET_FNS,
  PREVIEW_DEBOUNCE_MS,
} from "/scripts/report/vocab.js";

export function mountReport(panelBody, ctx) {
  // ── spec state ────────────────────────────────────────────────────
  // groupBy:      ordered group-by column names (subtotals rows).
  // aggregations: [{col, fn, alias}] — col is "*" for count(*).
  // windows:      [{alias, fn, col, partition_by[], as_percent,
  //                 order_by, offset}] — derived cols on subtotals.
  // show*:        which sections the engine should materialise.
  let groupBy      = [];
  let pivotBy      = [];           // group_by_cols — second-axis grouping for matrix preview
  let aggregations = [];
  let windows      = [];
  let showDetails   = false;
  let showSubtotals = true;
  let showTotal     = true;
  // topN: null | { n, order_by, direction, partition_by }. Compiles
  // to a ranking window on the subtotals frame (shared::report::TopNFilter).
  let topN         = null;
  // sortList: [{col, dir}] — multi-key sort over the subtotals frame.
  // Built by clicking preview headers (click cycles asc→desc→off,
  // shift-click appends to the chain).
  let sortList     = [];

  // ── live preview ──────────────────────────────────────────────────
  // previewSoon() debounces; runPreview() POSTs and updates the
  // inline sample table. Both used by every spec-mutating action so
  // the UX feels live without an explicit Apply.
  let previewTimer = null;
  let lastPage     = null;     // last successful GroupPage, for refresh-without-refetch

  // ── undo / redo (C4) ──────────────────────────────────────────────
  // JSON-snapshot history; every previewSoon() call captures via
  // captureSnapshot() so any spec-mutating action is in the chain
  // without per-handler hooks. Ctrl/Cmd+Z is undo, Ctrl/Cmd+Y or
  // Ctrl/Cmd+Shift+Z is redo — only when the Report tab is active.
  const undoStack = [];      // snapshots BEFORE the user's latest change
  const redoStack = [];      // snapshots forward of the current state
  let lastSnap    = "";      // JSON of the current spec — dedupe + capture source
  let suspendCapture = false; // applyState sets this so the redo step doesn't re-snapshot

  // ── containers ────────────────────────────────────────────────────
  const statusEl = document.createElement("div");
  statusEl.className = "rt-report-status";
  statusEl.hidden = true;
  const builderEl = document.createElement("div");
  builderEl.className = "rt-report-builder";
  const previewEl = document.createElement("div");
  previewEl.className = "rt-report-preview";
  previewEl.hidden = true;

  panelBody.innerHTML = "";
  panelBody.append(statusEl, builderEl, previewEl);

  // ── render ────────────────────────────────────────────────────────
  // Layout reframed (Em 2026-05-25) for non-tech users:
  //   • renderQuestionSection — "Show me X for each Y" sentence;
  //     consolidates the old Group by + Aggregations forms
  //   • renderAdvancedSection — pivot / windows / top-N / show
  //     toggles, hidden behind a <details> so the 80% case stays
  //     uncluttered (only ~20% of reports use these power features)
  function renderBuilder() {
    const cols = ctx.columns() || [];
    if (!cols.length) {
      builderEl.innerHTML = '<p class="rt-report-empty">Open a file to build a report.</p>';
      return;
    }
    builderEl.innerHTML =
        renderUndoStrip()
      + renderQuestionSection(cols)
      + renderAdvancedSection(cols);
    renderUndoButtons();
  }

  // The "Show me X for each Y" question-builder. Measures + breakdowns
  // share one mental model: the user is composing a sentence about
  // what they want to see. Underneath, measures = aggregations,
  // breakdowns = group_by — same state machine the old forms wrote.
  function renderQuestionSection(cols) {
    // ── measures (aggregations) ────────────────────────────────────
    const measureRows = aggregations.map((a, i) => {
      // Reorder: [fn ▾] of [col ▾] [alias?] [×] — reads as English
      // "Sum of price" / "Mean of age" instead of "price sum".
      const fnSelect = '<select class="rt-pred-op" data-key="fn">'
        + AGG_FNS.map(([v, l]) =>
            '<option value="' + esc(v) + '"'
            + (v === a.fn ? ' selected' : '') + '>' + esc(l) + '</option>').join('')
        + '</select>';
      const colSelect = '<select class="rt-pred-col" data-key="col">'
        + cols.map((c) =>
            '<option value="' + esc(c.name) + '"'
            + (c.name === a.col ? ' selected' : '') + '>' + esc(c.name) + '</option>').join('')
        + '<option value="*"' + (a.col === "*" ? ' selected' : '') + '>rows</option>'
        + '</select>';
      // Keeping the `rt-report-agg` class alongside the new visual
      // class so the existing change/input event handlers (which
      // target `.rt-report-agg`) keep working without rewires.
      // Two-row grid layout. Row 1: [fn ▾] of [col ▾] [×] — the two
      // selects fill the row width via grid `1fr` tracks. Row 2: the
      // alias input spans the full width via `grid-column: 1 / -1`.
      // DOM order matches the visual order — alias comes last (after
      // the delete button) so screen readers + keyboard nav move
      // through the row before stepping down to the rename.
      // Carries `.rt-pred` so the canonical row chrome (border /
      // padding / radius / sub-field bordered form treatment) flows in
      // from the filter panel's shared atom set. `.rt-report-measure`
      // stays on the element as the layout-modifier (4-track row 1 +
      // full-width alias row 2) and as the JS selector handlers
      // target. `.rt-report-agg` is the legacy alias for change-event
      // delegation. See docs/internal/processes/replicable-feature-
      // pattern.md — same UI concept = one canonical class set.
      return '<div class="rt-pred rt-report-measure rt-report-agg" data-i="' + i + '">'
        + fnSelect
        + '<span class="rt-report-measure-of">of</span>'
        + colSelect
        + '<button class="rt-pred-del" type="button" data-agg-del="' + i + '"'
        + '  title="Remove measure"><i class="bi bi-x-lg"></i></button>'
        + '<input class="rt-pred-val" data-key="alias" type="text"'
        + '  placeholder="rename (optional)" value="' + esc(a.alias || "") + '" />'
        + '</div>';
    }).join('');
    const measuresEmpty = !aggregations.length
      ? '<p class="rt-report-default-hint">By default, this counts rows in each group.</p>'
      : '';

    // ── breakdowns (group_by) ──────────────────────────────────────
    const breakdownChips = groupBy.map((name) =>
      '<span class="rt-report-chip">'
      +   esc(name)
      +   '<button class="rt-report-chip-del" type="button" data-group-del="'
      +     esc(name) + '" title="Remove"><i class="bi bi-x"></i></button>'
      + '</span>').join('');
    const breakdownAvail = cols.filter((c) => !groupBy.includes(c.name));
    const breakdownAdd = breakdownAvail.length
      ? '<div class="rt-dd-wrap rt-report-add">'
        + '<button class="rt-btn rt-btn--glass rt-btn--sm" type="button" data-dd="rtReportGroupDd">'
        +   '<i class="bi bi-plus-lg"></i> breakdown'
        + '</button>'
        + '<div class="rt-dd" id="rtReportGroupDd">'
        +   breakdownAvail.map((c) =>
              '<div class="rt-dd-item" data-group-add="' + esc(c.name) + '">'
              + esc(c.name) + '</div>').join('')
        + '</div>'
        + '</div>'
      : '';

    // Order: breakdowns first ("For each X"), then measures
    // ("show me Y") — defines the grouping axis before naming what
    // to compute over it, which mirrors how the user thinks about
    // the question. The measures-empty hint stays under the
    // measures line where it's contextual.
    return '<section class="rt-report-question">'
      +    '<div class="rt-report-q-line">'
      +      '<span class="rt-report-q-label">For each</span>'
      +      '<div class="rt-report-q-breakdowns">'
      +        (breakdownChips || '<span class="rt-report-q-hint">no breakdown — one grand row</span>')
      +        breakdownAdd
      +      '</div>'
      +    '</div>'
      +    '<div class="rt-report-q-line">'
      +      '<span class="rt-report-q-label">Show me</span>'
      +      '<div class="rt-report-q-measures">'
      +        measureRows
      +        '<button class="rt-btn rt-btn--glass rt-btn--sm rt-report-add-agg" type="button">'
      +          '<i class="bi bi-plus-lg"></i> measure'
      +        '</button>'
      +      '</div>'
      +    '</div>'
      +    measuresEmpty
      +    '</section>';
  }

  // Power-user sections, collapsed by default. Pivot turns the
  // report into a matrix; windows add derived columns; top-N caps
  // the group count; Show toggles which result frames materialise.
  // All four wired exactly as before — just folded behind disclosure.
  function renderAdvancedSection(cols) {
    return '<details class="rt-report-advanced">'
      +    '<summary class="rt-report-advanced-summary">'
      +      '<i class="bi bi-chevron-right rt-report-advanced-caret"></i>'
      +      'Advanced'
      +      '<span class="rt-report-advanced-hint">pivot · windows · top-N · show</span>'
      +    '</summary>'
      +    '<div class="rt-report-advanced-body">'
      +      renderPivotSection(cols)
      +      renderWindowsSection()
      +      renderTopNSection()
      +      renderShowSection()
      +    '</div>'
      +    '</details>';
  }

  // Compact undo/redo strip at the top of the builder. Keyboard
  // shortcuts (Ctrl/Cmd+Z, Ctrl/Cmd+Y) are the primary access; the
  // buttons make the affordance discoverable.
  function renderUndoStrip() {
    return '<div class="rt-report-undo-strip">'
      + '<button class="rt-btn rt-btn--glass rt-report-undo-btn" type="button"'
      +   ' title="Undo (Ctrl/Cmd+Z)" disabled>'
      +   '<i class="bi bi-arrow-return-left"></i></button>'
      + '<button class="rt-btn rt-btn--glass rt-report-redo-btn" type="button"'
      +   ' title="Redo (Ctrl/Cmd+Y)" disabled>'
      +   '<i class="bi bi-arrow-return-right"></i></button>'
      + '</div>';
  }

  // Subtotals columns = group_by + agg aliases. Computed client-side
  // (same alias rule as the backend's default_alias) so the window
  // col / order_by pickers stay in sync without an extra round-trip.
  function subtotalsColumnNames() {
    const out = [...groupBy];
    aggregations.forEach((a) => out.push(aggAlias(a)));
    return out;
  }
  function aggAlias(a) {
    if (a.alias && a.alias.trim()) return a.alias.trim();
    const fn = a.fn || "count";
    return a.col === "*" ? fn : (a.col + "_" + fn);
  }

  // Pivot columns — second-axis grouping (shared::report::group_by_cols).
  // When non-empty alongside group_by, the preview switches to matrix
  // mode: rows = group_by values, columns = pivot values × aggregations.
  // Same chip-picker shape as group_by; only available columns (not
  // already in group_by or pivot) appear in the dropdown.
  function renderPivotSection(cols) {
    const chips = pivotBy.map((name) =>
      '<span class="rt-report-chip rt-report-chip--pivot">'
      +   esc(name)
      +   '<button class="rt-report-chip-del" type="button" data-pivot-del="'
      +     esc(name) + '" title="Remove"><i class="bi bi-x"></i></button>'
      + '</span>').join('');
    const available = cols.filter((c) => !groupBy.includes(c.name) && !pivotBy.includes(c.name));
    const addDd = available.length
      ? '<div class="rt-dd-wrap rt-report-add">'
        + '<button class="rt-btn rt-btn--glass" type="button" data-dd="rtReportPivotDd">'
        +   '<i class="bi bi-plus-lg"></i> Add column'
        + '</button>'
        + '<div class="rt-dd" id="rtReportPivotDd">'
        +   available.map((c) =>
              '<div class="rt-dd-item" data-pivot-add="' + esc(c.name) + '">'
              + esc(c.name) + '</div>').join('')
        + '</div>'
        + '</div>'
      : '<p class="rt-report-empty">Every remaining column is either grouped or pivoted.</p>';
    return '<section class="rt-report-sect">'
      +    '<span class="rt-field-lbl">Pivot columns <span class="rt-report-muted">— matrix mode</span></span>'
      +    (pivotBy.length
            ? '<div class="rt-report-chips">' + chips + '</div>'
            : '<p class="rt-report-empty">No pivot — preview shows a flat subtotals table.</p>')
      +    addDd
      +    '</section>';
  }

  // Windows — derived columns added to the subtotals frame. Each
  // window compiles to a Polars `over()` expression. UI shape mirrors
  // shared::report::WindowSpec; conditional fields render only for
  // their fn family (as_percent on aggregate; order_by/offset on
  // value). Partition-by chips toggle from the group_by set.
  function renderWindowsSection() {
    const subCols = subtotalsColumnNames();
    const fnOpts = (sel) => WINDOW_FN_GROUPS.map(([label, fns]) =>
      '<optgroup label="' + esc(label) + '">'
      + fns.map(([v, l]) =>
          '<option value="' + esc(v) + '"'
          + (v === sel ? ' selected' : '') + '>' + esc(l) + '</option>').join('')
      + '</optgroup>').join('');
    const colOpts = (sel) => subCols.length
      ? subCols.map((c) =>
          '<option value="' + esc(c) + '"'
          + (c === sel ? ' selected' : '') + '>' + esc(c) + '</option>').join('')
      : '<option value="">(no columns yet — pick a group-by or agg)</option>';
    const rows = windows.map((w, i) => {
      const fn      = w.fn || "sum";
      const isVal   = WINDOW_VALUE_FNS.has(fn);
      const needOff = WINDOW_OFFSET_FNS.has(fn);
      const partSet = new Set(w.partition_by || []);
      const partChips = groupBy.length
        ? groupBy.map((g) =>
            '<button type="button" class="rt-report-part-chip'
            + (partSet.has(g) ? ' is-on' : '')
            + '" data-window-part="' + esc(g) + '" data-i="' + i + '">'
            + esc(g) + '</button>').join('')
        : '<span class="rt-report-muted">(none — global window)</span>';
      return '<div class="rt-report-window" data-i="' + i + '">'
        + '<div class="rt-report-window-row">'
        +   '<input class="rt-pred-val" data-wkey="alias" type="text"'
        +     ' placeholder="alias" value="' + esc(w.alias || "") + '" />'
        +   '<select class="rt-pred-op" data-wkey="fn">' + fnOpts(fn) + '</select>'
        +   '<select class="rt-pred-col" data-wkey="col">' + colOpts(w.col || "") + '</select>'
        +   (isVal
              ? ''
              : '<label class="rt-report-window-pct" title="Divide by partition total ×100">'
                + '<input type="checkbox" data-wkey="as_percent"'
                + (w.as_percent ? ' checked' : '') + ' /> %</label>')
        +   '<button class="rt-pred-del" type="button" data-window-del="' + i + '"'
        +     ' title="Remove window"><i class="bi bi-x-lg"></i></button>'
        + '</div>'
        + (isVal
            ? '<div class="rt-report-window-value">'
              + '<span class="rt-report-muted">order by</span>'
              + '<select class="rt-pred-col" data-wkey="order_by">'
              +   '<option value="">— pick —</option>'
              +   subCols.map((c) =>
                    '<option value="' + esc(c) + '"'
                    + (c === w.order_by ? ' selected' : '') + '>' + esc(c) + '</option>').join('')
              + '</select>'
              + (needOff
                  ? '<span class="rt-report-muted">offset</span>'
                    + '<input type="number" min="1" step="1" data-wkey="offset"'
                    + ' value="' + Number(w.offset || 1) + '" />'
                  : '')
              + '</div>'
            : '')
        + '<div class="rt-report-window-parts">'
        +   '<span class="rt-report-muted">partition by:</span> ' + partChips
        + '</div>'
        + '</div>';
    }).join('');
    return '<section class="rt-report-sect">'
      +    '<span class="rt-field-lbl">Windows</span>'
      +    (windows.length
            ? '<div class="rt-report-windows">' + rows + '</div>'
            : '<p class="rt-report-empty">No windows — useful for "% of partition" or running totals.</p>')
      +    '<button class="rt-btn rt-btn--glass rt-report-add-window" type="button">'
      +      '<i class="bi bi-plus-lg"></i> Add window'
      +    '</button>'
      +    '</section>';
  }

  // Top-N filter — keeps the top/bottom N rows per partition on the
  // subtotals frame. Compiles to a ranking window on order_by then a
  // filter to rank ≤ n (engine: shared::report::TopNFilter).
  function renderTopNSection() {
    const subCols = subtotalsColumnNames();
    const partSet = new Set(topN?.partition_by || []);
    const partChips = groupBy.length
      ? groupBy.map((g) =>
          '<button type="button" class="rt-report-part-chip'
          + (partSet.has(g) ? ' is-on' : '')
          + '" data-topn-part="' + esc(g) + '">'
          + esc(g) + '</button>').join('')
      : '<span class="rt-report-muted">(none — global top N)</span>';
    const enableRow =
      '<label class="rt-report-show-toggle">'
      + '<input type="checkbox" data-topn-enable'
      + (topN ? ' checked' : '') + ' /> Enable</label>';
    if (!topN) {
      return '<section class="rt-report-sect">'
        + '<span class="rt-field-lbl">Top N</span>'
        + '<div class="rt-report-show-row">' + enableRow + '</div>'
        + '<p class="rt-report-empty">Keep the top (or bottom) N rows per partition — useful for "top 5 per group" reports.</p>'
        + '</section>';
    }
    const colOpts = subCols.length
      ? subCols.map((c) =>
          '<option value="' + esc(c) + '"'
          + (c === topN.order_by ? ' selected' : '') + '>' + esc(c) + '</option>').join('')
      : '<option value="">(define a group-by or aggregation first)</option>';
    return '<section class="rt-report-sect">'
      + '<span class="rt-field-lbl">Top N</span>'
      + '<div class="rt-report-show-row">' + enableRow + '</div>'
      + '<div class="rt-report-topn">'
      +   '<div class="rt-report-topn-row">'
      +     '<span class="rt-report-muted">keep</span>'
      +     '<input type="number" min="1" step="1" data-topn-key="n"'
      +       ' value="' + Number(topN.n || 5) + '" />'
      +     '<select data-topn-key="direction">'
      +       '<option value="desc"' + (topN.direction === "desc" ? ' selected' : '') + '>top</option>'
      +       '<option value="asc"'  + (topN.direction === "asc"  ? ' selected' : '') + '>bottom</option>'
      +     '</select>'
      +     '<span class="rt-report-muted">by</span>'
      +     '<select data-topn-key="order_by">' + colOpts + '</select>'
      +   '</div>'
      +   '<div class="rt-report-window-parts">'
      +     '<span class="rt-report-muted">partition by:</span> ' + partChips
      +   '</div>'
      + '</div>'
      + '</section>';
  }

  // Show toggles — which sections the engine materialises. Hidden
  // sections still compute on the backend (always-materialise rule
  // for dashboards), but the preview omits them.
  function renderShowSection() {
    const toggle = (key, on, label, title) =>
      '<label class="rt-report-show-toggle" title="' + esc(title) + '">'
      + '<input type="checkbox" data-show-key="' + key + '"'
      + (on ? ' checked' : '') + ' /> ' + esc(label)
      + '</label>';
    return '<section class="rt-report-sect rt-report-show">'
      +    '<span class="rt-field-lbl">Show</span>'
      +    '<div class="rt-report-show-row">'
      +      toggle("show_subtotals", showSubtotals, "Subtotals",
                    "One row per group with the aggregations")
      +      toggle("show_total",     showTotal,     "Grand total",
                    "Single row aggregating all groups")
      +      toggle("show_details",   showDetails,   "Details",
                    "Source rows (capped at 1000 server-side)")
      +    '</div>'
      +    '</section>';
  }

  // Sample preview — render the subtotals + grand total inline. Cap
  // rows so a many-group preview doesn't dominate the panel; the user
  // gets a "showing N of M" footer when truncated. Details + matrix
  // sections aren't shown here; they're noise inside a builder panel.
  function renderPreview(page) {
    if (!page) { previewEl.hidden = true; previewEl.innerHTML = ""; return; }
    const sub = page.subtotals;
    if (!sub || !sub.rows?.length) {
      previewEl.hidden = false;
      previewEl.innerHTML = '<p class="rt-report-empty">No rows in this preview.</p>';
      return;
    }
    // Matrix mode — group_by × pivotBy. The backend returns long-
    // format rows; the frontend pivots into rows × columns for display.
    if (groupBy.length && pivotBy.length) {
      previewEl.hidden = false;
      previewEl.innerHTML = renderMatrix(page);
      return;
    }
    const MAX = 50;
    const shown = sub.rows.slice(0, MAX);
    const more  = Math.max(0, sub.rows.length - MAX);
    // Header cells carry data-sort + an active-state arrow so the
    // user sees which keys drive the current order. Click cycles
    // asc → desc → off; shift-click appends to the chain.
    const sortIdx = (col) => sortList.findIndex((s) => s.col === col);
    const head  = '<thead><tr>'
      + sub.columns.map((c) => {
          const i = sortIdx(c);
          const arrow = i === -1 ? ''
            : sortList[i].dir === "desc" ? ' <span class="rt-report-sort-arrow">▼</span>'
            : ' <span class="rt-report-sort-arrow">▲</span>';
          const chip = sortList.length > 1 && i >= 0
            ? ' <span class="rt-report-sort-chain">' + (i + 1) + '</span>' : '';
          return '<th data-sort="' + esc(c) + '" title="Click to sort; shift-click to chain">'
            + esc(c) + arrow + chip + '</th>';
        }).join('')
      + '</tr></thead>';
    const body  = '<tbody>'
      + shown.map((r) => '<tr>'
          + r.map((v, i) =>
              '<td class="' + (typeof v === "number" ? "is-num" : "") + '">'
              + (v == null ? '<span class="is-muted">—</span>' : esc(String(v)))
              + '</td>').join('')
          + '</tr>').join('')
      + (page.total
          ? '<tr class="is-total">'
            + page.total.map((v, i) =>
                '<td class="' + (typeof v === "number" ? "is-num" : "") + '">'
                + (v == null ? '' : esc(String(v)))
                + '</td>').join('')
            + '</tr>'
          : '')
      + '</tbody>';
    previewEl.hidden = false;
    previewEl.innerHTML =
        '<div class="rt-report-preview-head">'
      +   '<span class="rt-report-preview-meta">'
      +     '<b>' + sub.total + '</b> group' + (sub.total === 1 ? '' : 's')
      +     ' · ' + page.ms + ' ms'
      +   '</span>'
      + '</div>'
      + '<div class="rt-report-preview-wrap">'
      +   '<table class="rt-table rt-report-preview-table">'
      +     head + body
      +   '</table>'
      + '</div>'
      + (more
          ? '<p class="rt-report-empty">' + more + ' more group'
            + (more === 1 ? '' : 's') + ' not shown.</p>'
          : '');
    // Click-to-sort on preview headers — bound once per render since
    // the innerHTML wipes the previous listener. Cycle rules mirror
    // the historic Phase-3 behaviour:
    //   click       → replace chain with [{col, asc}], cycle asc→desc→off
    //   shift-click → append/cycle in chain
    const thead = previewEl.querySelector("thead");
    thead?.addEventListener("click", (e) => {
      const th = e.target.closest("[data-sort]");
      if (!th) return;
      const col = th.dataset.sort;
      const list = sortList.slice();
      const idx  = list.findIndex((s) => s.col === col);
      if (e.shiftKey) {
        if (idx === -1)                  list.push({ col, dir: "asc" });
        else if (list[idx].dir === "asc") list[idx] = { col, dir: "desc" };
        else                              list.splice(idx, 1);
      } else if (idx === -1 || list.length > 1) {
        sortList = [{ col, dir: "asc" }];
        previewSoon();
        return;
      } else if (list[idx].dir === "asc") {
        list[idx] = { col, dir: "desc" };
      } else {
        list.splice(idx, 1);
      }
      sortList = list;
      previewSoon();
    });
  }

  // Matrix renderer — pivots the long-format subtotals into a wide
  // cross-tab: rows = groupBy values, columns = pivotBy values, cells
  // = aggregation values. First aggregation drives the cell metric
  // (multi-agg matrices repeat the pivot block per metric — defer for
  // now; the historic Phase-3 also shipped single-metric first).
  // Numeric row/column totals + grand total rendered when show_total
  // is on AND at least one cell is numeric.
  function renderMatrix(page) {
    const sub = page.subtotals;
    const columns = sub.columns;
    const rows    = sub.rows;
    const rowDimIdxs = groupBy.map((n) => columns.indexOf(n)).filter((i) => i >= 0);
    const colDimIdxs = pivotBy.map((n) => columns.indexOf(n)).filter((i) => i >= 0);
    const metricIdx  = rowDimIdxs.length + colDimIdxs.length;
    const metricName = columns[metricIdx] || "value";

    const rowKeyOf = (r) => rowDimIdxs.map((i) => r[i] ?? "∅").join("␟");
    const colKeyOf = (r) => colDimIdxs.map((i) => r[i] ?? "∅").join("␟");

    const rowKeyValues = new Map();   // rowKey → original cell array
    const colKeyValues = new Map();
    const cellMap      = new Map();   // rowKey + "␞" + colKey → value
    for (const row of rows) {
      const rk = rowKeyOf(row);
      const ck = colKeyOf(row);
      if (!rowKeyValues.has(rk)) rowKeyValues.set(rk, rowDimIdxs.map((i) => row[i]));
      if (!colKeyValues.has(ck)) colKeyValues.set(ck, colDimIdxs.map((i) => row[i]));
      cellMap.set(rk + "␞" + ck, row[metricIdx]);
    }
    const rowKeys = Array.from(rowKeyValues.keys()).sort();
    const colKeys = Array.from(colKeyValues.keys()).sort();

    const wantTotals = showTotal;
    let anyNumeric = false;
    const rowTotals = {};
    const colTotals = {};
    let grand = 0;
    if (wantTotals) {
      for (const rk of rowKeys) {
        let s = 0;
        for (const ck of colKeys) {
          const v = cellMap.get(rk + "␞" + ck);
          const n = v == null ? NaN : Number(v);
          if (!Number.isNaN(n)) { s += n; anyNumeric = true; }
        }
        rowTotals[rk] = s;
      }
      for (const ck of colKeys) {
        let s = 0;
        for (const rk of rowKeys) {
          const v = cellMap.get(rk + "␞" + ck);
          const n = v == null ? NaN : Number(v);
          if (!Number.isNaN(n)) s += n;
        }
        colTotals[ck] = s;
      }
      grand = Object.values(rowTotals).reduce((a, b) => a + b, 0);
    }

    const totalsOn = wantTotals && anyNumeric;
    const headerCells = [
      ...groupBy.map((d) => '<th>' + esc(d) + '</th>'),
      ...colKeys.map((ck) =>
        '<th>' + esc(colKeyValues.get(ck).map((v) => v == null ? "∅" : String(v)).join(" / ")) + '</th>'),
      ...(totalsOn ? ['<th>Total</th>'] : []),
    ].join('');

    const body = rowKeys.map((rk) => {
      const rv = rowKeyValues.get(rk);
      const dimCells = rv.map((v) =>
        v == null ? '<td class="is-muted">∅</td>' : '<td>' + esc(String(v)) + '</td>').join('');
      const valCells = colKeys.map((ck) => {
        const v = cellMap.get(rk + "␞" + ck);
        return v == null
          ? '<td class="is-muted">∅</td>'
          : '<td class="is-num">' + esc(String(v)) + '</td>';
      }).join('');
      const total = totalsOn
        ? '<td class="is-num rt-report-matrix-rowtotal">' + esc(String(rowTotals[rk])) + '</td>'
        : '';
      return '<tr>' + dimCells + valCells + total + '</tr>';
    }).join('');

    const foot = totalsOn
      ? '<tfoot><tr class="is-total">'
        + '<td colspan="' + groupBy.length + '">Grand total</td>'
        + colKeys.map((ck) => '<td class="is-num">' + esc(String(colTotals[ck])) + '</td>').join('')
        + '<td class="is-num">' + esc(String(grand)) + '</td>'
        + '</tr></tfoot>'
      : '';

    return ''
      + '<div class="rt-report-preview-head">'
      +   '<span class="rt-report-preview-meta">'
      +     '<b>' + rowKeys.length + '</b> row' + (rowKeys.length === 1 ? '' : 's')
      +     ' × <b>' + colKeys.length + '</b> col' + (colKeys.length === 1 ? '' : 's')
      +     ' · metric: <b>' + esc(metricName) + '</b>'
      +     ' · ' + page.ms + ' ms'
      +   '</span>'
      + '</div>'
      + '<div class="rt-report-preview-wrap">'
      +   '<table class="rt-table rt-report-preview-table rt-report-matrix-table">'
      +     '<thead><tr>' + headerCells + '</tr></thead>'
      +     '<tbody>' + body + '</tbody>'
      +     foot
      +   '</table>'
      + '</div>';
  }

  // ── click delegation ──────────────────────────────────────────────
  // Every spec-mutating handler calls previewSoon() at the end so
  // the inline sample table re-renders without an explicit Apply.
  // The [data-dd] dropdown toggle is handled globally by
  // /scripts/dropdown.js (bindDropdown() at app boot) — no per-
  // builder wiring needed for the "Add column" / "Add pivot"
  // dropdowns, even though they're rendered dynamically.
  builderEl.addEventListener("click", (e) => {
    const addBtn = e.target.closest("[data-group-add]");
    if (addBtn) {
      const name = addBtn.dataset.groupAdd;
      if (name && !groupBy.includes(name)) {
        groupBy.push(name);
        renderBuilder();
        previewSoon();
      }
      // Dropdown auto-closes via the global click handler in
      // dropdown.js — the item click bubbles to document which
      // closes every open .rt-dd. No manual close needed here.
      return;
    }
    const delBtn = e.target.closest("[data-group-del]");
    if (delBtn) {
      groupBy = groupBy.filter((n) => n !== delBtn.dataset.groupDel);
      renderBuilder(); previewSoon();
      return;
    }
    // ── pivot columns (matrix mode) ─────────────────────────────
    const pivAdd = e.target.closest("[data-pivot-add]");
    if (pivAdd) {
      const name = pivAdd.dataset.pivotAdd;
      if (name && !pivotBy.includes(name) && !groupBy.includes(name)) {
        pivotBy.push(name);
        renderBuilder(); previewSoon();
      }
      // Auto-closed by dropdown.js's global click handler.
      return;
    }
    const pivDel = e.target.closest("[data-pivot-del]");
    if (pivDel) {
      pivotBy = pivotBy.filter((n) => n !== pivDel.dataset.pivotDel);
      renderBuilder(); previewSoon();
      return;
    }
    const aggDelBtn = e.target.closest("[data-agg-del]");
    if (aggDelBtn) {
      aggregations.splice(+aggDelBtn.dataset.aggDel, 1);
      renderBuilder(); previewSoon();
      return;
    }
    if (e.target.closest(".rt-report-add-agg")) {
      aggregations.push({ col: "*", fn: "count", alias: "" });
      renderBuilder(); previewSoon();
      return;
    }
    // ── windows ────────────────────────────────────────────────────
    if (e.target.closest(".rt-report-add-window")) {
      windows.push({
        alias:        "win" + (windows.length + 1),
        fn:           "sum",
        col:          subtotalsColumnNames()[0] || "",
        partition_by: [],
        as_percent:   false,
        order_by:     null,
        offset:       1,
      });
      renderBuilder(); previewSoon();
      return;
    }
    const winDelBtn = e.target.closest("[data-window-del]");
    if (winDelBtn) {
      windows.splice(+winDelBtn.dataset.windowDel, 1);
      renderBuilder(); previewSoon();
      return;
    }
    const partBtn = e.target.closest("[data-window-part]");
    if (partBtn) {
      const i = +partBtn.dataset.i;
      const name = partBtn.dataset.windowPart;
      const w = windows[i];
      if (!w) return;
      const set = new Set(w.partition_by || []);
      if (set.has(name)) set.delete(name); else set.add(name);
      // Preserve group_by order so the param is deterministic.
      w.partition_by = groupBy.filter((g) => set.has(g));
      renderBuilder(); previewSoon();
      return;
    }
    // ── undo / redo ──────────────────────────────────────────────
    if (e.target.closest(".rt-report-undo-btn")) { doUndo(); return; }
    if (e.target.closest(".rt-report-redo-btn")) { doRedo(); return; }
    // ── top-N ────────────────────────────────────────────────────
    const topnPart = e.target.closest("[data-topn-part]");
    if (topnPart && topN) {
      const name = topnPart.dataset.topnPart;
      const set = new Set(topN.partition_by || []);
      if (set.has(name)) set.delete(name); else set.add(name);
      topN.partition_by = groupBy.filter((g) => set.has(g));
      renderBuilder(); previewSoon();
      return;
    }
  });

  // Field changes propagate to the spec live; the live-preview fires
  // on every commit (change events; input events for free-text only).
  builderEl.addEventListener("change", (e) => {
    const aggRow = e.target.closest(".rt-report-agg");
    if (aggRow) {
      const i = +aggRow.dataset.i;
      if (!aggregations[i]) return;
      const key = e.target.dataset.key;
      if (key === "col" || key === "fn") {
        aggregations[i][key] = e.target.value;
        // fn change can move the col vs col change is harmless — both
        // trigger a re-render so subtotal-cols / window-cols pickers
        // pick up the new alias options.
        renderBuilder();
        previewSoon();
      }
      return;
    }
    const winRow = e.target.closest(".rt-report-window");
    if (winRow) {
      const i = +winRow.dataset.i;
      const w = windows[i];
      if (!w) return;
      const key = e.target.dataset.wkey;
      if (!key) return;
      if (key === "as_percent") w.as_percent = e.target.checked;
      else if (key === "offset") w.offset = Math.max(1, Number(e.target.value) || 1);
      else if (key === "fn") {
        w.fn = e.target.value;
        // Value fns require order_by; aggregate fns own as_percent.
        // Reset the now-irrelevant slot so the spec stays clean.
        if (WINDOW_VALUE_FNS.has(w.fn)) w.as_percent = false;
        else                            w.order_by   = null;
        renderBuilder();
      }
      else if (key === "col" || key === "order_by") w[key] = e.target.value;
      previewSoon();
      return;
    }
    // Show toggles — show_details / show_subtotals / show_total.
    const showCb = e.target.closest("[data-show-key]");
    if (showCb) {
      if (showCb.dataset.showKey === "show_details")   showDetails   = showCb.checked;
      if (showCb.dataset.showKey === "show_subtotals") showSubtotals = showCb.checked;
      if (showCb.dataset.showKey === "show_total")     showTotal     = showCb.checked;
      previewSoon();
      return;
    }
    // Top-N enable / fields.
    if (e.target.matches("[data-topn-enable]")) {
      if (e.target.checked) {
        const subCols = subtotalsColumnNames();
        topN = {
          n:            5,
          order_by:     subCols[subCols.length - 1] || "",
          direction:    "desc",
          partition_by: [],
        };
      } else {
        topN = null;
      }
      renderBuilder(); previewSoon();
      return;
    }
    const topnField = e.target.closest("[data-topn-key]");
    if (topnField && topN) {
      const key = topnField.dataset.topnKey;
      if (key === "n")        topN.n        = Math.max(1, Number(topnField.value) || 1);
      if (key === "order_by") topN.order_by = topnField.value;
      if (key === "direction")topN.direction = topnField.value;
      previewSoon();
    }
  });
  builderEl.addEventListener("input", (e) => {
    const aggRow = e.target.closest(".rt-report-agg");
    if (aggRow && e.target.dataset.key === "alias") {
      aggregations[+aggRow.dataset.i].alias = e.target.value;
      previewSoon();
      return;
    }
    const winRow = e.target.closest(".rt-report-window");
    if (winRow && e.target.dataset.wkey === "alias") {
      windows[+winRow.dataset.i].alias = e.target.value;
      previewSoon();
    }
  });

  // Keyboard shortcuts — undo / redo. Active only when the Report
  // tab is the visible one (panel has .has-report). Skipped when the
  // user is typing into a text/number input — let the browser's
  // native undo handle the field text.
  document.addEventListener("keydown", (e) => {
    if (!panelBody.closest(".rt-panel--filter.has-report")) return;
    const tag = e.target.tagName;
    const inText = (tag === "INPUT" && /^(text|search|number|)$/i.test(e.target.type || ""))
                || tag === "TEXTAREA";
    if (inText) return;
    const meta = e.ctrlKey || e.metaKey;
    if (!meta) return;
    if (e.key === "z" && !e.shiftKey) { e.preventDefault(); doUndo(); }
    else if (e.key === "y" || (e.key === "z" && e.shiftKey)) {
      e.preventDefault(); doRedo();
    }
  });

  // ── spec build + apply ────────────────────────────────────────────
  function buildSpec() {
    // Aggregations: drop empty alias keys so the backend infers a
    // default. Map shape matches shared::report::Aggregation:
    // { col, fn, alias? }. fn comes through as the snake_case enum.
    const aggs = aggregations.map((a) => {
      const out = { col: a.col, fn: a.fn };
      if (a.alias) out.alias = a.alias;
      return out;
    });
    // Engine auto-add workaround. When group_by is non-empty and the
    // user gave no aggregations, the engine auto-pushes
    // `{col:"*", fn:count}` (group_by.rs:44) which compiles to
    // `lit(1i64).count()` — Polars rejects literal aggregations with
    // "cannot aggregate a literal". Sending an explicit count over a
    // real column dodges the auto-add. Pinged Gus to fix in the
    // engine (the shortcut should use `len()` or a column reference,
    // not a literal); this workaround can be dropped once the engine
    // change lands.
    if (groupBy.length && !aggs.length) {
      aggs.push({ col: groupBy[0], fn: "count", alias: "count" });
    }
    // Windows: drop empty-alias slots and the irrelevant slot for
    // each fn family so the backend sees a clean shape.
    const wins = windows.map((w) => {
      const isVal = WINDOW_VALUE_FNS.has(w.fn);
      const out = {
        alias:        w.alias || ("win" + Math.random().toString(36).slice(2, 6)),
        fn:           w.fn,
        col:          w.col,
        partition_by: w.partition_by || [],
      };
      if (isVal) {
        out.order_by = w.order_by || null;
        if (WINDOW_OFFSET_FNS.has(w.fn)) out.offset = Math.max(1, Number(w.offset) || 1);
      } else {
        out.as_percent = !!w.as_percent;
      }
      return out;
    });
    return {
      group_by:       [...groupBy],
      group_by_cols:  [...pivotBy],
      aggregations:   aggs,
      filter:         null,
      show_details:   showDetails,
      show_subtotals: showSubtotals,
      show_total:     showTotal,
      // sort: drop empty cols so a stale entry from a renamed alias
      // doesn't 400 the request.
      sort:           sortList.filter((s) => s && s.col).map((s) => ({ col: s.col, dir: s.dir })),
      charts:         [],
      top_n:          topN ? {
        n:            Math.max(1, Number(topN.n) || 1),
        order_by:     topN.order_by || "",
        direction:    topN.direction || "desc",
        partition_by: topN.partition_by || [],
      } : null,
      windows:        wins,
    };
  }

  // Debounced preview — collapses bursts of spec edits into one
  // /group/preview round-trip. Skipped when there's no file open
  // (no surface to preview against). Every call also captures a
  // snapshot for undo/redo so any spec-mutating path gets history
  // for free.
  function previewSoon() {
    captureSnapshot();
    if (!ctx.fileRid()) return;
    if (previewTimer) clearTimeout(previewTimer);
    previewTimer = setTimeout(runPreview, PREVIEW_DEBOUNCE_MS);
  }

  // Snapshot capture: push the *previous* spec snapshot when the
  // current one differs. That means undo rolls back the change the
  // user just made (the stack tail is the pre-change state). Any
  // forward redoStack gets blown away on a fresh mutation — standard
  // undo-tree semantics.
  function captureSnapshot() {
    if (suspendCapture) return;
    const current = JSON.stringify(snapshotShape());
    if (current === lastSnap) return;
    if (lastSnap) {
      undoStack.push(lastSnap);
      if (undoStack.length > 200) undoStack.shift();
      redoStack.length = 0;
    }
    lastSnap = current;
    renderUndoButtons();
  }
  function snapshotShape() {
    return {
      groupBy:      [...groupBy],
      pivotBy:      [...pivotBy],
      aggregations: aggregations.map((a) => ({ ...a })),
      windows:      windows.map((w) => ({ ...w, partition_by: [...(w.partition_by || [])] })),
      showDetails, showSubtotals, showTotal,
      topN:         topN ? { ...topN, partition_by: [...(topN.partition_by || [])] } : null,
      sortList:     sortList.map((s) => ({ ...s })),
    };
  }
  function applySnap(json) {
    if (!json) return;
    const s = JSON.parse(json);
    suspendCapture = true;
    groupBy       = s.groupBy || [];
    pivotBy       = s.pivotBy || [];
    aggregations  = s.aggregations || [];
    windows       = s.windows || [];
    showDetails   = !!s.showDetails;
    showSubtotals = !!s.showSubtotals;
    showTotal     = !!s.showTotal;
    topN          = s.topN || null;
    sortList      = s.sortList || [];
    lastSnap      = json;
    renderBuilder();
    renderUndoButtons();
    suspendCapture = false;
    // Fire the preview against the restored state so the sample
    // table matches what the user just undid/redid into.
    if (ctx.fileRid()) {
      if (previewTimer) clearTimeout(previewTimer);
      previewTimer = setTimeout(runPreview, PREVIEW_DEBOUNCE_MS);
    }
  }
  function doUndo() {
    if (!undoStack.length) return;
    redoStack.push(lastSnap);
    applySnap(undoStack.pop());
  }
  function doRedo() {
    if (!redoStack.length) return;
    undoStack.push(lastSnap);
    applySnap(redoStack.pop());
  }
  function renderUndoButtons() {
    const undoBtn = builderEl.querySelector(".rt-report-undo-btn");
    const redoBtn = builderEl.querySelector(".rt-report-redo-btn");
    if (undoBtn) undoBtn.disabled = !undoStack.length;
    if (redoBtn) redoBtn.disabled = !redoStack.length;
  }
  async function runPreview(busyBtn) {
    const rid = ctx.fileRid();
    if (!rid) { ctx.setStatus?.("Open a file before running a report.", "warn"); return; }
    if (busyBtn) { busyBtn.disabled = true; busyBtn.classList.add("is-busy"); }
    try {
      const page = await api.post("/group/preview",
                                  { source_file_id: rid, spec: buildSpec() });
      lastPage = page;
      renderPreview(page);
      ctx.onPreview?.(page);
    } catch (err) {
      const msg = (err && (err.body?.message || err.body?.error)) || err?.message || "Preview failed";
      ctx.setStatus?.(msg + (err?.status ? " (" + err.status + ")" : ""), "err");
    } finally {
      if (busyBtn) { busyBtn.disabled = false; busyBtn.classList.remove("is-busy"); }
    }
  }
  // Apply button preserved as a "refresh now" affordance — bypasses
  // the debounce so the user can force a re-run after fixing an
  // error or when they want to commit a half-typed alias.
  const apply = runPreview;

  function clear() {
    groupBy = [];
    pivotBy = [];
    aggregations = [];
    windows = [];
    showDetails = false;
    showSubtotals = true;
    showTotal = true;
    topN = null;
    sortList = [];
    lastPage = null;
    if (previewTimer) { clearTimeout(previewTimer); previewTimer = null; }
    // Treat Clear as a fresh start — wipe history so undo doesn't
    // resurrect the cleared spec. The user can re-run preview to
    // start a fresh chain.
    undoStack.length = 0;
    redoStack.length = 0;
    lastSnap = JSON.stringify(snapshotShape());
    renderBuilder();
    renderPreview(null);
  }

  renderBuilder();
  return {
    refresh()  {
      renderBuilder();
      // Auto-preview on file switch / tab open so the inline sample
      // table reflects the current spec against the (possibly new)
      // file's data without an explicit Apply.
      previewSoon();
    },
    apply,
    clear,
    getSpec()  { return buildSpec(); },
  };
}

