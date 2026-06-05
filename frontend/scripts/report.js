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
  statusEl.className = "rp-report-status";
  statusEl.hidden = true;
  const builderEl = document.createElement("div");
  builderEl.className = "rp-report-builder";
  const previewEl = document.createElement("div");
  previewEl.className = "rp-report-preview";
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
      builderEl.innerHTML = '<p class="rp-report-empty">Open a file to build a report.</p>';
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
      // fn (.rp-pred-op) + col (.rp-pred-col) are the two row-1 selects
      // — same atoms as a filter predicate's col/op pair. Reads
      // "[Sum] [price]"; the fn label carries the aggregation verb.
      const fnSelect = '<select class="rp-pred-op" data-key="fn">'
        + AGG_FNS.map(([v, l]) =>
            '<option value="' + esc(v) + '"'
            + (v === a.fn ? ' selected' : '') + '>' + esc(l) + '</option>').join('')
        + '</select>';
      const colSelect = '<select class="rp-pred-col" data-key="col">'
        + cols.map((c) =>
            '<option value="' + esc(c.name) + '"'
            + (c.name === a.col ? ' selected' : '') + '>' + esc(c.name) + '</option>').join('')
        + '<option value="*"' + (a.col === "*" ? ' selected' : '') + '>rows</option>'
        + '</select>';
      // The measure row is now a structural twin of a filter
      // predicate row (Em 2026-06-01: "closer UI to Predicates"):
      //   Row 1 — [fn ▾]  [col ▾]   (two selects, 50/50, like col|op)
      //   Row 2 — [rename.................]  [×]   (alias 85% | del 15%,
      //            like the predicate's value | delete)
      // It reuses the canonical `.rp-pred` 20-track grid (no bespoke
      // grid-template-columns); panel.css `.rp-report-measure` only
      // SWAPS the fn(.rp-pred-op)/col(.rp-pred-col) placement so the
      // aggregation fn sits LEFT and the column RIGHT ("Sum" | "price").
      // The inline "of" connector was dropped for predicate fidelity —
      // the fn dropdown already labels the aggregation. DOM order =
      // visual/tab order: fn → col → alias → del. `.rp-report-measure`
      // stays as the layout hook + JS selector; `.rp-report-agg` is the
      // legacy alias the change/input handlers delegate on (kept so the
      // wiring works without rewires). See docs/internal/processes/
      // replicable-feature-pattern.md — same UI concept = one class set.
      return '<div class="rp-pred rp-report-measure rp-report-agg" data-i="' + i + '">'
        + fnSelect
        + colSelect
        + '<input class="rp-pred-val" data-key="alias" type="text"'
        + '  placeholder="rename (optional)" value="' + esc(a.alias || "") + '" />'
        + '<button class="rp-pred-del" type="button" data-agg-del="' + i + '"'
        + '  title="Remove measure"><i class="bi bi-x-lg"></i></button>'
        + '</div>';
    }).join('');
    const measuresEmpty = !aggregations.length
      ? '<p class="rp-report-default-hint">By default, this counts rows in each group.</p>'
      : '';

    // ── breakdowns (group_by) ──────────────────────────────────────
    const breakdownChips = groupBy.map((name) =>
      '<span class="rp-report-chip">'
      +   esc(name)
      +   '<button class="rp-report-chip-del" type="button" data-group-del="'
      +     esc(name) + '" title="Remove"><i class="bi bi-x"></i></button>'
      + '</span>').join('');
    const breakdownAvail = cols.filter((c) => !groupBy.includes(c.name));
    const breakdownAdd = breakdownAvail.length
      ? '<div class="rp-menu-wrap rp-report-add">'
        + '<button class="rp-btn-icon rp-btn-icon--glass rp-btn-icon--sm" type="button" data-dd="rtReportGroupDd">'
        +   '<i class="bi bi-plus-lg"></i> breakdown'
        + '</button>'
        + '<div class="rp-menu" id="rtReportGroupDd">'
        +   breakdownAvail.map((c) =>
              '<div class="rp-menu-item" data-group-add="' + esc(c.name) + '">'
              + esc(c.name) + '</div>').join('')
        + '</div>'
        + '</div>'
      : '';

    // Order: breakdowns first ("For each X"), then measures
    // ("show me Y") — defines the grouping axis before naming what
    // to compute over it, which mirrors how the user thinks about
    // the question. The measures-empty hint stays under the
    // measures line where it's contextual.
    return '<section class="rp-report-question">'
      +    '<div class="rp-report-q-line">'
      +      '<span class="rp-report-q-label">For each</span>'
      +      '<div class="rp-report-q-breakdowns">'
      +        (breakdownChips || '<span class="rp-report-q-hint">no breakdown — one grand row</span>')
      +        breakdownAdd
      +      '</div>'
      +    '</div>'
      +    '<div class="rp-report-q-line">'
      +      '<span class="rp-report-q-label">Show me</span>'
      +      '<div class="rp-report-q-measures">'
      +        measureRows
      +        '<button class="rp-btn-icon rp-btn-icon--glass rp-btn-icon--sm rp-report-add-agg" type="button">'
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
    return '<details class="rp-report-advanced">'
      +    '<summary class="rp-report-advanced-summary">'
      +      '<i class="bi bi-chevron-right rp-report-advanced-caret"></i>'
      +      'Advanced'
      +      '<span class="rp-report-advanced-hint">pivot · windows · top-N · show</span>'
      +    '</summary>'
      +    '<div class="rp-report-advanced-body">'
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
    return '<div class="rp-report-undo-strip">'
      + '<button class="rp-btn-icon rp-btn-icon--glass rp-report-undo-btn" type="button"'
      +   ' title="Undo (Ctrl/Cmd+Z)" disabled>'
      +   '<i class="bi bi-arrow-return-left"></i></button>'
      + '<button class="rp-btn-icon rp-btn-icon--glass rp-report-redo-btn" type="button"'
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
      '<span class="rp-report-chip rp-report-chip--pivot">'
      +   esc(name)
      +   '<button class="rp-report-chip-del" type="button" data-pivot-del="'
      +     esc(name) + '" title="Remove"><i class="bi bi-x"></i></button>'
      + '</span>').join('');
    const available = cols.filter((c) => !groupBy.includes(c.name) && !pivotBy.includes(c.name));
    const addDd = available.length
      ? '<div class="rp-menu-wrap rp-report-add">'
        + '<button class="rp-btn-icon rp-btn-icon--glass" type="button" data-dd="rtReportPivotDd">'
        +   '<i class="bi bi-plus-lg"></i> Add column'
        + '</button>'
        + '<div class="rp-menu" id="rtReportPivotDd">'
        +   available.map((c) =>
              '<div class="rp-menu-item" data-pivot-add="' + esc(c.name) + '">'
              + esc(c.name) + '</div>').join('')
        + '</div>'
        + '</div>'
      : '<p class="rp-report-empty">Every remaining column is either grouped or pivoted.</p>';
    return '<section class="rp-report-sect">'
      +    '<span class="rp-label">Pivot columns <span class="rp-report-muted">— matrix mode</span></span>'
      +    (pivotBy.length
            ? '<div class="rp-report-chips">' + chips + '</div>'
            : '<p class="rp-report-empty">No pivot — preview shows a flat subtotals table.</p>')
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
            '<button type="button" class="rp-report-part-chip'
            + (partSet.has(g) ? ' is-on' : '')
            + '" data-window-part="' + esc(g) + '" data-i="' + i + '">'
            + esc(g) + '</button>').join('')
        : '<span class="rp-report-muted">(none — global window)</span>';
      return '<div class="rp-report-window" data-i="' + i + '">'
        + '<div class="rp-report-window-row">'
        +   '<input class="rp-pred-val" data-wkey="alias" type="text"'
        +     ' placeholder="alias" value="' + esc(w.alias || "") + '" />'
        +   '<select class="rp-pred-op" data-wkey="fn">' + fnOpts(fn) + '</select>'
        +   '<select class="rp-pred-col" data-wkey="col">' + colOpts(w.col || "") + '</select>'
        +   (isVal
              ? ''
              : '<label class="rp-report-window-pct" title="Divide by partition total ×100">'
                + '<input type="checkbox" data-wkey="as_percent"'
                + (w.as_percent ? ' checked' : '') + ' /> %</label>')
        +   '<button class="rp-pred-del" type="button" data-window-del="' + i + '"'
        +     ' title="Remove window"><i class="bi bi-x-lg"></i></button>'
        + '</div>'
        + (isVal
            ? '<div class="rp-report-window-value">'
              + '<span class="rp-report-muted">order by</span>'
              + '<select class="rp-pred-col" data-wkey="order_by">'
              +   '<option value="">— pick —</option>'
              +   subCols.map((c) =>
                    '<option value="' + esc(c) + '"'
                    + (c === w.order_by ? ' selected' : '') + '>' + esc(c) + '</option>').join('')
              + '</select>'
              + (needOff
                  ? '<span class="rp-report-muted">offset</span>'
                    + '<input type="number" min="1" step="1" data-wkey="offset"'
                    + ' value="' + Number(w.offset || 1) + '" />'
                  : '')
              + '</div>'
            : '')
        + '<div class="rp-report-window-parts">'
        +   '<span class="rp-report-muted">partition by:</span> ' + partChips
        + '</div>'
        + '</div>';
    }).join('');
    return '<section class="rp-report-sect">'
      +    '<span class="rp-label">Windows</span>'
      +    (windows.length
            ? '<div class="rp-report-windows">' + rows + '</div>'
            : '<p class="rp-report-empty">No windows — useful for "% of partition" or running totals.</p>')
      +    '<button class="rp-btn-icon rp-btn-icon--glass rp-report-add-window" type="button">'
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
          '<button type="button" class="rp-report-part-chip'
          + (partSet.has(g) ? ' is-on' : '')
          + '" data-topn-part="' + esc(g) + '">'
          + esc(g) + '</button>').join('')
      : '<span class="rp-report-muted">(none — global top N)</span>';
    const enableRow =
      '<label class="rp-report-show-toggle">'
      + '<input type="checkbox" data-topn-enable'
      + (topN ? ' checked' : '') + ' /> Enable</label>';
    if (!topN) {
      return '<section class="rp-report-sect">'
        + '<span class="rp-label">Top N</span>'
        + '<div class="rp-report-show-row">' + enableRow + '</div>'
        + '<p class="rp-report-empty">Keep the top (or bottom) N rows per partition — useful for "top 5 per group" reports.</p>'
        + '</section>';
    }
    const colOpts = subCols.length
      ? subCols.map((c) =>
          '<option value="' + esc(c) + '"'
          + (c === topN.order_by ? ' selected' : '') + '>' + esc(c) + '</option>').join('')
      : '<option value="">(define a group-by or aggregation first)</option>';
    return '<section class="rp-report-sect">'
      + '<span class="rp-label">Top N</span>'
      + '<div class="rp-report-show-row">' + enableRow + '</div>'
      + '<div class="rp-report-topn">'
      +   '<div class="rp-report-topn-row">'
      +     '<span class="rp-report-muted">keep</span>'
      +     '<input type="number" min="1" step="1" data-topn-key="n"'
      +       ' value="' + Number(topN.n || 5) + '" />'
      +     '<select data-topn-key="direction">'
      +       '<option value="desc"' + (topN.direction === "desc" ? ' selected' : '') + '>top</option>'
      +       '<option value="asc"'  + (topN.direction === "asc"  ? ' selected' : '') + '>bottom</option>'
      +     '</select>'
      +     '<span class="rp-report-muted">by</span>'
      +     '<select data-topn-key="order_by">' + colOpts + '</select>'
      +   '</div>'
      +   '<div class="rp-report-window-parts">'
      +     '<span class="rp-report-muted">partition by:</span> ' + partChips
      +   '</div>'
      + '</div>'
      + '</section>';
  }

  // Show toggles — which sections the engine materialises. Hidden
  // sections still compute on the backend (always-materialise rule
  // for dashboards), but the preview omits them.
  function renderShowSection() {
    const toggle = (key, on, label, title) =>
      '<label class="rp-report-show-toggle" title="' + esc(title) + '">'
      + '<input type="checkbox" data-show-key="' + key + '"'
      + (on ? ' checked' : '') + ' /> ' + esc(label)
      + '</label>';
    return '<section class="rp-report-sect rp-report-show">'
      +    '<span class="rp-label">Show</span>'
      +    '<div class="rp-report-show-row">'
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
      previewEl.innerHTML = '<p class="rp-report-empty">No rows in this preview.</p>';
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
            : sortList[i].dir === "desc" ? ' <span class="rp-report-sort-arrow">▼</span>'
            : ' <span class="rp-report-sort-arrow">▲</span>';
          const chip = sortList.length > 1 && i >= 0
            ? ' <span class="rp-report-sort-chain">' + (i + 1) + '</span>' : '';
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
        '<div class="rp-report-preview-head">'
      +   '<span class="rp-report-preview-meta">'
      +     '<b>' + sub.total + '</b> group' + (sub.total === 1 ? '' : 's')
      +     ' · ' + page.ms + ' ms'
      +   '</span>'
      + '</div>'
      + '<div class="rp-report-preview-wrap">'
      +   '<table class="rt-table rp-report-preview-table">'
      +     head + body
      +   '</table>'
      + '</div>'
      + (more
          ? '<p class="rp-report-empty">' + more + ' more group'
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
  // cross-tab. rows = groupBy values, columns = pivotBy values. Each
  // row value gets ONE sub-row PER measure (Salesforce-style: the row
  // dim cell spans its measure sub-rows; the measure name sits in its
  // own "Measure" column), so a matrix carries N measures per cell
  // instead of one. CAS_AF836C82 #1.
  //
  // Totals (when show_total): per-row and per-column totals are rolled
  // up CLIENT-side, so they're only exact for ADDITIVE fns — sum/count
  // (summed) and min/max (min/max-ed). Non-additive fns (mean, median,
  // q1/q3, count_distinct, first/last) can't be re-derived from already-
  // aggregated cell values, so their row/col total cells render "—".
  // The per-measure GRAND total uses the engine's page.total (correct
  // for every fn). Metric columns = columns.slice(dimCount); each
  // metric's fn aligns to `aggregations` by index — the buildSpec
  // auto-count (used when the user added no measures) defaults to a
  // summable count.
  function renderMatrix(page) {
    const sub = page.subtotals;
    const columns = sub.columns;
    const rows    = sub.rows;
    const rowDimIdxs = groupBy.map((n) => columns.indexOf(n)).filter((i) => i >= 0);
    const colDimIdxs = pivotBy.map((n) => columns.indexOf(n)).filter((i) => i >= 0);
    const dimCount   = rowDimIdxs.length + colDimIdxs.length;
    const metricCols = columns.slice(dimCount);             // measure aliases
    const metricFns  = metricCols.map((_, j) => (aggregations[j] && aggregations[j].fn) || "count");
    const K = Math.max(1, metricCols.length);

    const rowKeyOf = (r) => rowDimIdxs.map((i) => r[i] ?? "∅").join("␟");
    const colKeyOf = (r) => colDimIdxs.map((i) => r[i] ?? "∅").join("␟");

    const rowKeyValues = new Map();   // rowKey → row-dim cell array
    const colKeyValues = new Map();   // colKey → col-dim cell array
    const cellMap      = new Map();   // rowKey ␞ colKey → [metric values]
    for (const row of rows) {
      const rk = rowKeyOf(row);
      const ck = colKeyOf(row);
      if (!rowKeyValues.has(rk)) rowKeyValues.set(rk, rowDimIdxs.map((i) => row[i]));
      if (!colKeyValues.has(ck)) colKeyValues.set(ck, colDimIdxs.map((i) => row[i]));
      cellMap.set(rk + "␞" + ck, row.slice(dimCount));
    }
    const rowKeys = Array.from(rowKeyValues.keys()).sort();
    const colKeys = Array.from(colKeyValues.keys()).sort();

    const totalsOn = showTotal;
    const SUMMABLE = new Set(["count", "sum"]);
    // Roll a measure's cell values up along one axis — exact only for
    // additive fns; everything else returns null → rendered "—".
    const rollup = (fn, vals) => {
      const nums = vals.filter((v) => v != null && v !== "" && !Number.isNaN(Number(v))).map(Number);
      if (!nums.length) return null;
      if (SUMMABLE.has(fn)) return nums.reduce((a, b) => a + b, 0);
      if (fn === "min") return Math.min(...nums);
      if (fn === "max") return Math.max(...nums);
      return null;
    };
    const fmt = (v) => v == null ? null
      : (typeof v === "number" && !Number.isInteger(v) ? String(Math.round(v * 1e4) / 1e4) : String(v));
    const numCell = (v) => {
      const f = fmt(v);
      return f == null ? '<td class="is-num is-muted">—</td>'
                       : '<td class="is-num">' + esc(f) + '</td>';
    };
    const colLabel = (ck) => esc(colKeyValues.get(ck).map((v) => v == null ? "∅" : String(v)).join(" / "));

    const headerCells = [
      ...groupBy.map((d) => '<th>' + esc(d) + '</th>'),
      '<th class="rp-report-matrix-measure-h">Measure</th>',
      ...colKeys.map((ck) => '<th class="is-num">' + colLabel(ck) + '</th>'),
      ...(totalsOn ? ['<th class="is-num">Total</th>'] : []),
    ].join('');

    // One <tr> per (rowKey, measure); the row-dim cells on the first
    // measure sub-row span all K via rowspan.
    const body = rowKeys.map((rk) => {
      const rv = rowKeyValues.get(rk);
      return metricCols.map((alias, j) => {
        const dimCells = j === 0
          ? rv.map((v) => '<td rowspan="' + K + '">'
              + (v == null ? '<span class="is-muted">∅</span>' : esc(String(v))) + '</td>').join('')
          : '';
        const valCells = colKeys.map((ck) =>
          numCell((cellMap.get(rk + "␞" + ck) || [])[j])).join('');
        const rowTot = totalsOn
          ? numCell(rollup(metricFns[j], colKeys.map((ck) => (cellMap.get(rk + "␞" + ck) || [])[j])))
          : '';
        return '<tr' + (j === 0 ? ' class="rp-report-matrix-rowstart"' : '') + '>'
          + dimCells
          + '<td class="rp-report-matrix-measure">' + esc(alias) + '</td>'
          + valCells + rowTot + '</tr>';
      }).join('');
    }).join('');

    const foot = totalsOn
      ? '<tfoot>' + metricCols.map((alias, j) => {
          const label = j === 0
            ? '<td rowspan="' + K + '" colspan="' + Math.max(1, groupBy.length) + '">Total</td>'
            : '';
          const colTots = colKeys.map((ck) =>
            numCell(rollup(metricFns[j], rowKeys.map((rk) => (cellMap.get(rk + "␞" + ck) || [])[j])))).join('');
          const grand = page.total ? page.total[dimCount + j] : null;
          return '<tr class="is-total' + (j === 0 ? ' rp-report-matrix-rowstart' : '') + '">'
            + label
            + '<td class="rp-report-matrix-measure">' + esc(alias) + '</td>'
            + colTots + numCell(grand) + '</tr>';
        }).join('') + '</tfoot>'
      : '';

    const metricsLabel = metricCols.length ? metricCols.map((m) => esc(m)).join(', ') : 'value';
    return ''
      + '<div class="rp-report-preview-head">'
      +   '<span class="rp-report-preview-meta">'
      +     '<b>' + rowKeys.length + '</b> row' + (rowKeys.length === 1 ? '' : 's')
      +     ' × <b>' + colKeys.length + '</b> col' + (colKeys.length === 1 ? '' : 's')
      +     ' · ' + metricCols.length + ' measure' + (metricCols.length === 1 ? '' : 's')
      +     ' (' + metricsLabel + ')'
      +     ' · ' + page.ms + ' ms'
      +   '</span>'
      + '</div>'
      + '<div class="rp-report-preview-wrap">'
      +   '<table class="rt-table rp-report-preview-table rp-report-matrix-table">'
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
      // closes every open .rp-menu. No manual close needed here.
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
    if (e.target.closest(".rp-report-add-agg")) {
      aggregations.push({ col: "*", fn: "count", alias: "" });
      renderBuilder(); previewSoon();
      return;
    }
    // ── windows ────────────────────────────────────────────────────
    if (e.target.closest(".rp-report-add-window")) {
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
    if (e.target.closest(".rp-report-undo-btn")) { doUndo(); return; }
    if (e.target.closest(".rp-report-redo-btn")) { doRedo(); return; }
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
    const aggRow = e.target.closest(".rp-report-agg");
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
    const winRow = e.target.closest(".rp-report-window");
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
    const aggRow = e.target.closest(".rp-report-agg");
    if (aggRow && e.target.dataset.key === "alias") {
      aggregations[+aggRow.dataset.i].alias = e.target.value;
      previewSoon();
      return;
    }
    const winRow = e.target.closest(".rp-report-window");
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
    if (!panelBody.closest(".rp-panel-filter.has-report")) return;
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
    // count(*) workaround. The engine compiles count over the "*"
    // sentinel (the "Count rows" measure) to `lit(1i64).count()`, which
    // Polars rejects with "cannot aggregate a literal" → HTTP 400.
    // Counting any REAL column dodges it (count is row-count regardless
    // of which non-null column it targets); a group/pivot key is always
    // present, so prefer one, else fall back to the first data column.
    // Applies to EVERY count(*) measure, not just the auto-added one —
    // an explicit "Count of rows" measure hit the same 400 before.
    // Pinged Gus to fix in the engine (the shortcut should use `len()`
    // / a column ref, not a literal); drop this once that lands.
    const countCol = groupBy[0] || pivotBy[0]
      || ((ctx.columns() || [])[0] && (ctx.columns() || [])[0].name) || "*";
    // Aggregations: drop empty alias keys so the backend infers a
    // default. Map shape matches shared::report::Aggregation:
    // { col, fn, alias? }. fn comes through as the snake_case enum.
    const aggs = aggregations.map((a) => {
      const isCountRows = a.fn === "count" && a.col === "*";
      const out = { col: isCountRows ? countCol : a.col, fn: a.fn };
      // Keep the column labelled "count" even though we count a real
      // column under the hood (else the engine names it after countCol).
      if (a.alias) out.alias = a.alias;
      else if (isCountRows) out.alias = "count";
      return out;
    });
    // Auto-add: when group_by is non-empty and the user gave no
    // aggregations, add a count over a real column (same workaround).
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
    const undoBtn = builderEl.querySelector(".rp-report-undo-btn");
    const redoBtn = builderEl.querySelector(".rp-report-redo-btn");
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

