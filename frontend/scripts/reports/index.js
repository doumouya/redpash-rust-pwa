// Reports controller — Phase 3 MVP.
//
// Two modes share one page:
//   list mode   — saved reports + "+ New" (URL: #/reports)
//   builder mode — create or edit one report (URL: #/reports?id=RPT_… or ?new=1)
//
// The builder runs a live preview (POST /api/reports/preview) on every
// spec change (debounced). Save persists to /api/reports.

import { api } from "/scripts/api.js";
import { toast } from "/scripts/ui/toast.js";
import { mount as mountFilterPanel } from "/scripts/cleaner/filters/panel.js";
import { createHistory } from "/scripts/ui/history.js";
import { loadECharts, loadECStat } from "/scripts/dashboards/echarts.js";
import {
  chartOption,
  chartOptionHeatmap,
  chartOptionRadar,
  chartOptionBoxplot,
  chartOptionCalendar,
  subtotalsToSeries,
  subtotalsToScalar,
  subtotalsToHeatmap,
  subtotalsToRadar,
  subtotalsToBoxplot,
  subtotalsToCalendar,
  detailsToScatterSeries,
  chartPreviewBody,
  withRegression,
} from "/scripts/dashboards/chart-render.js";

const PREVIEW_DEBOUNCE_MS = 350;
const AGG_FNS = [
  ["count",          "count"],
  ["count_distinct", "count distinct"],
  ["sum",            "sum"],
  ["mean",           "mean"],
  ["min",            "min"],
  ["max",            "max"],
  ["first",          "first"],
  ["last",           "last"],
];

export function mount(root) {
  const listView    = root.querySelector("#reports-list");
  const builderView = root.querySelector("#reports-builder");
  const listBody    = root.querySelector("#reports-list-body");

  // Builder DOM refs.
  const filtersHost = root.querySelector("#reports-filters");
  const titleInput  = root.querySelector("#report-title");
  const folderInput = root.querySelector("#report-folder");
  const folderList  = root.querySelector("#report-folders-list");
  const sourceSel   = root.querySelector("#report-source");
  const gbAdd      = root.querySelector("#gb-add");
  const gbChips    = root.querySelector("#gb-chips");
  const gbcAdd     = root.querySelector("#gbc-add");
  const gbcChips   = root.querySelector("#gbc-chips");
  const aggAdd     = root.querySelector("#agg-add");
  const aggList    = root.querySelector("#agg-list");
  const chartAddGrid = root.querySelector("#chart-add-sections");
  const chartList    = root.querySelector("#chart-list");
  const windowAdd    = root.querySelector("#window-add");
  const windowList   = root.querySelector("#window-list");
  const topNEnable   = root.querySelector("#topn-enable");
  const topNControls = root.querySelector("#topn-controls");
  const topNNInput   = root.querySelector("#topn-n");
  const topNOrderBy  = root.querySelector("#topn-order-by");
  const topNDir      = root.querySelector("#topn-direction");
  const chartModal   = root.querySelector("#chart-modal");
  const cmKind       = root.querySelector("#chart-modal-kind");
  const cmGroupBy    = root.querySelector("#chart-modal-group-by");
  const cmAggFn      = root.querySelector("#chart-modal-agg-fn");
  const cmAggCol     = root.querySelector("#chart-modal-agg-col");
  const cmTitleInput = root.querySelector("#chart-modal-title-input");
  const cmSmooth     = root.querySelector("#chart-modal-smooth");
  const cmDonut      = root.querySelector("#chart-modal-donut");
  const cmHalf       = root.querySelector("#chart-modal-half");
  const cmRose       = root.querySelector("#chart-modal-rose");
  const cmSmoothRow  = root.querySelector("[data-cond-smooth]");
  const cmDonutRow   = root.querySelector("[data-cond-donut]");
  const cmHalfRow    = root.querySelector("[data-cond-half]");
  const cmRoseRow    = root.querySelector("[data-cond-rose]");
  const cmRichRow    = root.querySelector("[data-cond-rich]");
  const cmRich       = root.querySelector("#chart-modal-rich");
  const cmAggFnRow   = root.querySelector("[data-cond-agg-fn]");
  const cmGroupByRow = root.querySelector("[data-cond-group-by]");
  const cmRegRow     = root.querySelector("[data-cond-regression]");
  const cmSymbolRow  = root.querySelector("[data-cond-symbol]");
  const cmSymRptRow  = root.querySelector("[data-cond-symbol-repeat]");
  const cmYGroupRow  = root.querySelector("[data-cond-y-group-by]");
  const cmYGroupBy   = root.querySelector("#chart-modal-y-group-by");
  const cmYGroupLbl  = root.querySelector("[data-label-y-group-by]");
  const cmRegression = root.querySelector("#chart-modal-regression");
  const cmSymbol     = root.querySelector("#chart-modal-symbol");
  const cmSymRpt     = root.querySelector("#chart-modal-symbol-repeat");
  const cmGroupByLbl = root.querySelector("[data-label-group-by]");
  const cmAggColLbl  = root.querySelector("[data-label-agg-col]");
  const cmSaveBtn    = root.querySelector("#chart-modal-save");
  const cmTitleEl    = root.querySelector("#chart-modal-title");
  const preview    = root.querySelector("#report-preview");
  const saveBtn    = builderView.querySelector("[data-save]");
  const saveAsBtn  = builderView.querySelector("[data-save-as]");
  const delBtn     = builderView.querySelector("[data-del]");
  const favBtn     = builderView.querySelector("#report-fav");
  const newBtn     = listView.querySelector("[data-new]");
  let isFavorite   = false;

  // Builder state — `spec.filter` is reserved for future panel integration.
  // show_* flags drive the three render sections (details / subtotals / total).
  // group_by_cols turns the subtotals view into a matrix (pivot).
  const spec = {
    group_by: [], group_by_cols: [], aggregations: [], filter: null,
    show_details: true, show_subtotals: true, show_total: false,
    sort: [],      // [{ col, dir: "asc"|"desc" }, ...] — order matters
    // [{ kind, group_by, agg_col, agg_fn, smooth, donut, title? }]
    // Each chart runs its own /reports/preview against the source file
    // — independent of the report's table-level group_by + aggs.
    charts: [],
    // Post-aggregation Top-N filter. `null` = disabled. Compiles to a
    // partitioned head() on the subtotals frame.
    //   { n, order_by, direction: "desc"|"asc", partition_by: [] }
    top_n:  null,
    // Aggregate window functions applied to the subtotals frame:
    // {alias, fn, col, partition_by[], as_percent} → new derived col.
    windows: [],
  };
  // Which chart is currently being edited in the modal (index into
  // spec.charts), or -1 when creating a new one.
  let editingChartIdx = -1;
  let rid       = null;        // RPT_… when editing an existing report
  let sourceFiles = [];        // available source files (column meta on demand)
  let currentColumns = [];     // columns of the selected source file
  let sourceRowCount = 0;      // total rows in selected source file (for unique counts)
  let knownFolders = [];       // folder labels already in use (for datalist)
  let previewTimer = null;
  // Client-side undo/redo. Snapshots happen in `previewSoon` (every
  // spec-mutating handler already calls it, so we get coverage for
  // free) and ignore consecutive no-op pushes via string-equality.
  const history       = createHistory(spec);
  let   lastSnapshot  = JSON.stringify(spec);
  const undoBtn       = builderView.querySelector("[data-undo]");
  const redoBtn       = builderView.querySelector("[data-redo]");
  // Snapshot of the latest preview response — needed so the chart
  // editor can offer x/y dropdowns over the subtotals' actual columns
  // (and so the chart renderer can plot rows without a second fetch).
  let lastSubtotals = null;

  // The cleaner filter panel talks to a `table` object. Reports
  // doesn't have a redtable instance — this adapter routes the panel's
  // reads/writes to `spec.filter` and kicks off a debounced preview
  // whenever the filter changes.
  const filterAdapter = {
    getFilter:          () => spec.filter,
    getAdvancedFilter:  () => spec.filter,
    isAdvanced:         () => !!spec.filter,
    getFilters() {
      const f = spec.filter;
      if (!f || f.op !== "and" || !Array.isArray(f.children)) return [];
      return f.children.filter((c) => !Array.isArray(c.children));
    },
    setFilters(value) {
      if (Array.isArray(value)) {
        spec.filter = value.length ? { op: "and", children: value } : null;
      } else if (value && value.op && Array.isArray(value.children)) {
        spec.filter = value.children.length ? value : null;
      } else {
        spec.filter = null;
      }
      previewSoon();
    },
  };
  const filtersPanel = mountFilterPanel(filtersHost, {
    table: filterAdapter,
    columns: [],
  });

  // Mode dispatch.
  const m = { id: queryArg("id"), neww: queryArg("new") };
  if (m.id) {
    openExisting(m.id);
  } else if (m.neww) {
    openNew();
  } else {
    showList();
  }

  newBtn.addEventListener("click", () => { location.hash = "#/reports?new=1"; });

  // ─── List mode ───────────────────────────────────────
  async function showList() {
    listView.hidden = false;
    builderView.hidden = true;
    listBody.innerHTML = `<p class="rp-muted">Loading…</p>`;
    try {
      const res = await api.get("/reports");
      if (!res.items?.length) {
        listBody.innerHTML = `<p class="rp-muted">No reports yet. Click <strong>New report</strong> to start.</p>`;
        return;
      }
      // Group rows by folder. Backend orders by folder then favourite
      // then updated_at, so a simple linear walk produces section
      // blocks without re-sorting.
      const groups = new Map();
      for (const r of res.items) {
        const key = r.folder?.trim() ? r.folder : "";   // "" = uncategorised
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(r);
      }
      const sections = Array.from(groups.entries()).map(([folder, items]) => `
        <section class="rp-reports__folder">
          <h2 class="rp-reports__folder-title">${folder ? "📁 " + esc(folder) : "Uncategorised"} <span class="rp-muted">· ${items.length}</span></h2>
          <table class="rp-project-files">
            <thead><tr><th></th><th>Title</th><th>Source file</th><th>Updated</th><th></th></tr></thead>
            <tbody>
              ${items.map((r) => `
                <tr>
                  <td>
                    <button class="rp-fav ${r.is_favorite ? "is-on" : ""}"
                            data-fav="${esc(r.redpash_id)}"
                            aria-label="${r.is_favorite ? "Unfavorite" : "Favorite"}">★</button>
                  </td>
                  <td><a href="#/reports?id=${encodeURIComponent(r.redpash_id)}">${esc(r.title)}</a></td>
                  <td class="rp-muted"><code>${esc(r.source_file_id)}</code></td>
                  <td>${esc(new Date(r.updated_at).toLocaleString())}</td>
                  <td>
                    <button class="rp-btn rp-btn--sm rp-btn--danger" data-del-row="${esc(r.redpash_id)}">Delete</button>
                  </td>
                </tr>`).join("")}
            </tbody>
          </table>
        </section>
      `).join("");
      listBody.innerHTML = sections;
      listBody.addEventListener("click", async (e) => {
        const favBtn = e.target.closest("[data-fav]");
        if (favBtn) {
          const id  = favBtn.dataset.fav;
          const on  = favBtn.classList.contains("is-on");
          // Optimistic toggle so the click feels instant.
          favBtn.classList.toggle("is-on");
          try {
            await api.post(`/reports/${encodeURIComponent(id)}/favorite`, { value: !on });
            // Re-fetch the list so favorites bubble up to the top.
            showList();
          } catch (err) {
            favBtn.classList.toggle("is-on"); // revert
            toast.error(err.message ?? String(err));
          }
          return;
        }
        const delBtn = e.target.closest("[data-del-row]");
        if (!delBtn) return;
        if (!confirm("Delete this report?")) return;
        try {
          await api.delete(`/reports/${encodeURIComponent(delBtn.dataset.delRow)}`);
          showList();
        } catch (err) { toast.error(err.message ?? String(err)); }
      }, { once: true });
    } catch (err) {
      listBody.innerHTML = `<p class="rp-muted">Couldn't load reports: ${esc(err.message ?? String(err))}</p>`;
    }
  }

  // ─── Builder mode ────────────────────────────────────
  async function openNew() {
    rid = null;
    isFavorite = false;
    favBtn.hidden = true;     // hide until the report is saved
    favBtn.classList.remove("is-on");
    folderInput.value = "";
    saveAsBtn.hidden = true;  // need a saved report before forking
    await refreshFolderList();
    spec.group_by = [];
    spec.group_by_cols = [];
    // Seed with a row-count so the preview is non-empty as soon as the
    // user adds a group-by column.
    spec.aggregations = [{ col: "*", fn: "count", alias: "" }];
    spec.show_details   = true;
    spec.show_subtotals = true;
    spec.show_total     = false;
    spec.sort           = [];
    spec.charts         = [];
    spec.top_n          = null;
    spec.windows        = [];
    syncToggles();
    delBtn.hidden = true;
    titleInput.value = "Untitled report";
    listView.hidden = true;
    builderView.hidden = false;
    await loadSourceFiles();
    // Pre-select the source file when the URL carries `?source=FIL_xxx`
    // (the Objects-page "New report from this file" row affordance
    // uses this). Falls back to the first source file when the param
    // isn't present or names a file the caller can't see.
    const seed = queryArg("source");
    const seedExists = seed && sourceFiles.some((f) => f.redpash_id === seed);
    if (seedExists)               await selectSource(seed);
    else if (sourceFiles.length)  await selectSource(sourceFiles[0].redpash_id);
    renderSpec();
    // Reset undo history to the freshly-seeded spec so the first
    // undo doesn't yank the user back to a stale previous report.
    history.reset(spec);
    lastSnapshot = JSON.stringify(spec);
    syncUndoButtons();
    previewSoon();
  }

  async function openExisting(id) {
    listView.hidden = true;
    builderView.hidden = false;
    preview.innerHTML = `<p class="rp-muted">Loading…</p>`;
    try {
      const r = await api.get(`/reports/${encodeURIComponent(id)}`);
      rid = r.redpash_id;
      isFavorite = !!r.is_favorite;
      favBtn.hidden = false;
      favBtn.classList.toggle("is-on", isFavorite);
      saveAsBtn.hidden = false;
      titleInput.value  = r.title;
      folderInput.value = r.folder ?? "";
      await refreshFolderList();
      spec.group_by       = r.spec?.group_by ?? [];
      spec.group_by_cols  = r.spec?.group_by_cols ?? [];
      spec.aggregations   = r.spec?.aggregations ?? [];
      spec.filter         = r.spec?.filter ?? null;
      spec.show_details   = r.spec?.show_details   ?? true;
      spec.show_subtotals = r.spec?.show_subtotals ?? true;
      spec.show_total     = r.spec?.show_total     ?? false;
      // Old reports may have `sort` as a single object — normalise to array.
      const rawSort = r.spec?.sort;
      spec.sort = Array.isArray(rawSort)
        ? rawSort
        : (rawSort && rawSort.col ? [rawSort] : []);
      spec.charts = Array.isArray(r.spec?.charts) ? r.spec.charts : [];
      spec.top_n  = r.spec?.top_n ?? null;
      spec.windows = Array.isArray(r.spec?.windows) ? r.spec.windows : [];
      syncToggles();
      delBtn.hidden = false;
      await loadSourceFiles();
      await selectSource(r.source_file_id);
      renderSpec();
      // Reset undo history on load — undo shouldn't reach back into
      // some previously-edited report's state.
      history.reset(spec);
      lastSnapshot = JSON.stringify(spec);
      syncUndoButtons();
      previewSoon();
    } catch (err) {
      preview.innerHTML = `<p class="rp-muted">Couldn't load report: ${esc(err.message ?? String(err))}</p>`;
    }
  }

  // Re-pull the reports list just to harvest existing folder labels.
  // Cheap (only metadata) and keeps the datalist accurate as the user
  // creates new folders during this session.
  async function refreshFolderList() {
    try {
      const res = await api.get("/reports");
      const set = new Set();
      (res.items ?? []).forEach((r) => { if (r.folder) set.add(r.folder); });
      knownFolders = Array.from(set).sort();
      folderList.innerHTML = knownFolders
        .map((f) => `<option value="${esc(f)}"></option>`).join("");
    } catch { /* fallback: leave datalist empty */ }
  }

  async function loadSourceFiles() {
    // Default-project files for now — multi-project lands later. Pulled
    // from the projects list so we don't hardcode any RID.
    try {
      const projects = await api.get("/projects");
      const def = projects.items?.find((p) => p.stage === "active") ?? projects.items?.[0];
      if (!def) { sourceFiles = []; return; }
      const files = await api.get(`/projects/${encodeURIComponent(def.redpash_id)}/files`);
      sourceFiles = files.items ?? [];
      sourceSel.innerHTML = sourceFiles
        .map((f) => `<option value="${esc(f.redpash_id)}">${esc(f.display_name ?? f.filename)}</option>`)
        .join("") || `<option value="">No files yet</option>`;
    } catch (err) {
      console.error("[reports] sources fetch failed", err);
      sourceFiles = [];
    }
  }

  async function selectSource(fileRid) {
    if (!fileRid) return;
    sourceSel.value = fileRid;
    // Pull the column list from /api/files/:rid (gives ColumnMeta).
    try {
      const env = await api.get(`/files/${encodeURIComponent(fileRid)}`);
      currentColumns  = env.columns ?? [];
      sourceRowCount  = env.summary?.row_count ?? 0;
      // Drop any spec entries referencing columns that no longer exist.
      const allowed = new Set(currentColumns.map((c) => c.name));
      spec.group_by      = spec.group_by.filter((c) => allowed.has(c));
      spec.group_by_cols = spec.group_by_cols.filter((c) => allowed.has(c));
      spec.aggregations  = spec.aggregations.filter((a) => a.col === "*" || allowed.has(a.col));
      renderColumnSelectors();
      renderSpec();
      filtersPanel.update({ table: filterAdapter, columns: currentColumns, rid: fileRid });
    } catch (err) {
      console.error("[reports] file fetch failed", err);
    }
  }

  // Approximate distinct-value count from ColumnMeta. unique_pct is a
  // percentage of total rows; we round to a whole count for display.
  // For the group-by pickers this is the most useful signal — low
  // cardinality columns make the best group keys.
  function uniqueCount(c) {
    if (c.unique_pct == null || sourceRowCount === 0) return null;
    return Math.max(1, Math.round((c.unique_pct / 100) * sourceRowCount));
  }
  function describeCol(c) {
    const n = uniqueCount(c);
    if (n == null) return c.dtype;
    return `${c.dtype} · ${n.toLocaleString()} uniques`;
  }
  function sortedColumns(cols) {
    // Low-cardinality first so the obvious grouping candidates surface
    // to the top of the dropdown. Stable for ties — keeps the source
    // column order.
    return cols.slice().sort((a, b) => {
      const an = uniqueCount(a); const bn = uniqueCount(b);
      if (an == null && bn == null) return 0;
      if (an == null) return 1;
      if (bn == null) return -1;
      return an - bn;
    });
  }

  function renderColumnSelectors() {
    const used = new Set([...spec.group_by, ...spec.group_by_cols]);
    const opts = sortedColumns(currentColumns)
      .filter((c) => !used.has(c.name))
      .map((c) => `<option value="${esc(c.name)}">${esc(c.name)} — ${esc(describeCol(c))}</option>`)
      .join("");
    gbAdd.innerHTML  = `<option value="">+ add column</option>` + opts;
    gbcAdd.innerHTML = `<option value="">+ add column</option>` + opts;
  }

  function renderSpec() {
    renderChartList();
    renderWindows();
    renderTopN();
    gbChips.innerHTML = spec.group_by.map((name) =>
      `<span class="rp-chip">${esc(name)}<button data-gb-rm="${esc(name)}" aria-label="Remove">×</button></span>`).join("");
    gbcChips.innerHTML = spec.group_by_cols.map((name) =>
      `<span class="rp-chip">${esc(name)}<button data-gbc-rm="${esc(name)}" aria-label="Remove">×</button></span>`).join("");
    aggList.innerHTML = spec.aggregations.map((a, i) => `
      <div class="rp-reports__agg" data-i="${i}">
        <select data-field="fn">
          ${AGG_FNS.map(([v, l]) => `<option value="${v}"${v === a.fn ? " selected" : ""}>${l}</option>`).join("")}
        </select>
        <select data-field="col">
          <option value="*"${a.col === "*" ? " selected" : ""}>* (rows)</option>
          ${currentColumns.map((c) =>
            `<option value="${esc(c.name)}"${c.name === a.col ? " selected" : ""}>${esc(c.name)} — ${esc(describeCol(c))}</option>`).join("")}
        </select>
        <input data-field="alias" class="rp-tools__input" placeholder="alias (optional)" value="${esc(a.alias ?? "")}" />
        <button data-agg-rm class="rp-filters__rm" aria-label="Remove">×</button>
      </div>
    `).join("");
    renderColumnSelectors();
  }

  // Wire up spec editors.
  gbAdd.addEventListener("change", () => {
    const v = gbAdd.value;
    if (!v) return;
    if (!spec.group_by.includes(v)) spec.group_by.push(v);
    gbAdd.value = "";
    renderSpec();
    previewSoon();
  });
  gbChips.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-gb-rm]");
    if (!btn) return;
    spec.group_by = spec.group_by.filter((n) => n !== btn.dataset.gbRm);
    renderSpec(); previewSoon();
  });

  gbcAdd.addEventListener("change", () => {
    const v = gbcAdd.value;
    if (!v) return;
    if (!spec.group_by_cols.includes(v)) spec.group_by_cols.push(v);
    gbcAdd.value = "";
    renderSpec();
    previewSoon();
  });
  gbcChips.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-gbc-rm]");
    if (!btn) return;
    spec.group_by_cols = spec.group_by_cols.filter((n) => n !== btn.dataset.gbcRm);
    renderSpec(); previewSoon();
  });

  aggAdd.addEventListener("click", () => {
    spec.aggregations.push({ col: "*", fn: "count", alias: "" });
    renderSpec(); previewSoon();
  });

  // ─── Window functions ──────────────────────────────────────
  // Adds derived columns to the subtotals frame via Polars `over()`.
  // Each window has alias + fn + col + partition_by[] + as_percent.
  // The col dropdown lists all subtotal columns (group_by + agg
  // aliases); partition_by lists group_by columns.
  function renderWindows() {
    if (!spec.windows.length) {
      windowList.innerHTML = `<p class="rp-muted">No windows. Useful for "% of partition" or "partition total" columns.</p>`;
      return;
    }
    const fnGroups = [
      ["Aggregate", ["sum","mean","count","min","max"]],
      ["Value",     ["lag","lead","first_value","last_value"]],
    ];
    const fnOpts = (sel) => fnGroups.map(([label, fns]) =>
      `<optgroup label="${label}">${
        fns.map((f) => `<option value="${f}"${f === sel ? " selected" : ""}>${f}</option>`).join("")
      }</optgroup>`).join("");
    const subCols = subtotalsColumnNames();
    const colOpts = (sel) => subCols
      .map((c) => `<option value="${esc(c)}"${c === sel ? " selected" : ""}>${esc(c)}</option>`).join("");
    windowList.innerHTML = spec.windows.map((w, i) => {
      const fn       = w.fn ?? "sum";
      const isValue  = ["lag","lead","first_value","last_value"].includes(fn);
      const needsOff = fn === "lag" || fn === "lead";
      const partSet  = new Set(w.partition_by ?? []);
      const partChips = spec.group_by.map((g) =>
        `<button type="button" class="rp-chip${partSet.has(g) ? " is-on" : ""}" data-toggle-part="${esc(g)}">${esc(g)}</button>`).join("");
      const orderOpts = subCols
        .map((c) => `<option value="${esc(c)}"${c === w.order_by ? " selected" : ""}>${esc(c)}</option>`).join("");
      return `
        <div class="rp-reports__window-row" data-i="${i}">
          <input data-wfield="alias" class="rp-tools__input" placeholder="alias" value="${esc(w.alias ?? "")}" />
          <select data-wfield="fn">${fnOpts(fn)}</select>
          <select data-wfield="col">${colOpts(w.col ?? "")}</select>
          ${isValue ? "" : `<label class="rp-reports__toggle"><input type="checkbox" data-wfield="as_percent"${w.as_percent ? " checked" : ""}/> %</label>`}
          <button data-window-rm class="rp-filters__rm" aria-label="Remove">×</button>
          ${isValue ? `
            <div class="rp-reports__window-value-row">
              <span class="rp-muted">order by</span>
              <select data-wfield="order_by"><option value="">— pick —</option>${orderOpts}</select>
              ${needsOff ? `<span class="rp-muted">offset</span>
                <input type="number" data-wfield="offset" min="1" step="1" value="${Number(w.offset ?? 1)}" />` : ""}
            </div>` : ""}
          <div class="rp-reports__window-partitions">
            <span class="rp-muted">partition by:</span>
            ${partChips || `<span class="rp-muted">(none — global)</span>`}
          </div>
        </div>`;
    }).join("");
  }

  // Subtotals columns = group_by + group_by_cols + aggregation aliases.
  // Computed client-side using the same alias rule as the backend so
  // window col-pickers stay in sync without an extra round-trip.
  function subtotalsColumnNames() {
    const cols = [];
    cols.push(...spec.group_by, ...spec.group_by_cols);
    for (const a of spec.aggregations) {
      cols.push(a.alias?.trim() || (a.col === "*" ? a.fn : `${a.col}_${a.fn}`));
    }
    return cols;
  }

  windowAdd.addEventListener("click", () => {
    const subCols = subtotalsColumnNames();
    const aliases = spec.aggregations.map((a) =>
      a.alias?.trim() || (a.col === "*" ? a.fn : `${a.col}_${a.fn}`));
    const defaultCol = aliases[0] ?? subCols[0] ?? "";
    spec.windows.push({
      alias:        defaultCol ? `${defaultCol}_pct` : "pct",
      fn:           "sum",
      col:          defaultCol,
      partition_by: spec.group_by[0] ? [spec.group_by[0]] : [],
      as_percent:   true,   // "% of partition" is the most common use case
    });
    renderWindows();
    previewSoon();
  });

  windowList.addEventListener("input",  onWindowEdit);
  windowList.addEventListener("change", onWindowEdit);
  windowList.addEventListener("click", (e) => {
    const rm = e.target.closest("[data-window-rm]");
    if (rm) {
      const i = Number(rm.closest("[data-i]").dataset.i);
      spec.windows.splice(i, 1);
      renderWindows();
      previewSoon();
      return;
    }
    const part = e.target.closest("[data-toggle-part]");
    if (part) {
      const i = Number(part.closest("[data-i]").dataset.i);
      const w = spec.windows[i]; if (!w) return;
      const c = part.dataset.togglePart;
      const set = new Set(w.partition_by ?? []);
      if (set.has(c)) set.delete(c); else set.add(c);
      // Preserve group_by order so the partition list is predictable.
      w.partition_by = spec.group_by.filter((g) => set.has(g));
      renderWindows();
      previewSoon();
    }
  });

  function onWindowEdit(e) {
    const row = e.target.closest("[data-i]");
    if (!row || !row.parentElement?.matches("#window-list")) return;
    const i = Number(row.dataset.i);
    const f = e.target.dataset.wfield;
    const w = spec.windows[i]; if (!w || !f) return;
    if (e.target.type === "checkbox") {
      w[f] = e.target.checked;
    } else if (f === "offset") {
      w[f] = Math.max(1, Number(e.target.value) || 1);
    } else {
      w[f] = e.target.value;
    }
    // Switching agg ↔ value kinds toggles which row fields render —
    // re-render the editor so order_by/offset appear or vanish.
    if (f === "fn") renderWindows();
    previewSoon();
  }

  // ─── Top-N per group ────────────────────────────────────────
  // Mirror the alias-naming rule the backend uses so the order-by
  // dropdown lists what subtotal columns will actually be present.
  function aggAliasFor(a) {
    if (a.alias?.trim()) return a.alias.trim();
    const fn = a.fn ?? "count";
    return a.col === "*" ? fn : `${a.col}_${fn}`;
  }

  function renderTopN() {
    const aliases = spec.aggregations.map(aggAliasFor);
    const current = spec.top_n;
    topNEnable.checked    = !!current;
    topNControls.hidden   = !current;
    topNNInput.value      = current?.n ?? 5;
    topNDir.value         = current?.direction ?? "desc";
    // Re-populate order_by from current aggregations.
    topNOrderBy.innerHTML = aliases.length
      ? aliases.map((a) => `<option value="${esc(a)}"${a === current?.order_by ? " selected" : ""}>${esc(a)}</option>`).join("")
      : `<option value="">(define an aggregation first)</option>`;
  }

  topNEnable.addEventListener("change", () => {
    if (topNEnable.checked) {
      const aliases = spec.aggregations.map(aggAliasFor);
      spec.top_n = {
        n:            Number(topNNInput.value) || 5,
        order_by:     aliases[0] ?? "",
        direction:    topNDir.value || "desc",
        partition_by: [],   // empty = backend defaults to group_by[..-1]
      };
    } else {
      spec.top_n = null;
    }
    renderTopN();
    previewSoon();
  });

  topNControls.addEventListener("input",  onTopNFieldEdit);
  topNControls.addEventListener("change", onTopNFieldEdit);

  function onTopNFieldEdit(e) {
    if (!spec.top_n) return;
    const id = e.target.id;
    if (id === "topn-n")        spec.top_n.n        = Math.max(1, Number(e.target.value) || 1);
    if (id === "topn-order-by") spec.top_n.order_by = e.target.value;
    if (id === "topn-direction")spec.top_n.direction = e.target.value;
    previewSoon();
  }

  // ─── Charts panel + modal ───────────────────────────────────
  // Each chart in the report has its own group_by + aggregation and
  // runs an independent /reports/preview. The Charts panel on the
  // left shows the icon picker (creates a new chart via modal) plus
  // a list of saved charts (clicking one re-opens the modal in edit
  // mode). Charts render below the table in the preview pane.

  // Saved-chart list (left panel).
  function renderChartList() {
    if (!spec.charts.length) {
      chartList.innerHTML = `<p class="rp-muted">No charts yet. Pick a type above to create one.</p>`;
      return;
    }
    chartList.innerHTML = spec.charts.map((c, i) => {
      const label = chartSummary(c);
      return `
        <div class="rp-reports__chart-list-item" data-i="${i}">
          <button class="rp-reports__chart-list-edit" data-edit-chart="${i}" type="button" title="Edit">${esc(label)}</button>
          <button class="rp-reports__chart-list-rm"  data-rm-chart="${i}"   type="button" aria-label="Remove">×</button>
        </div>`;
    }).join("");
  }

  function chartSummary(c) {
    const title = c.title?.trim();
    if (title) return title;
    if (c.kind === "scatter") {
      const reg = c.regression ? ` · ${c.regression}` : "";
      return `scatter · ${c.agg_col || "?"} vs ${c.group_by || "?"}${reg}`;
    }
    const fnPart = c.agg_fn === "count" && (c.agg_col === "*" || !c.agg_col)
      ? "count(*)" : `${c.agg_fn ?? "count"}(${c.agg_col || "*"})`;
    if (c.kind === "gauge") return `gauge · ${fnPart}`;
    if (c.kind === "heatmap") return `heatmap · ${fnPart} by ${c.group_by || "?"} × ${c.y_group_by || "?"}`;
    if (c.kind === "radar")   return `radar · ${fnPart} of ${c.y_group_by || "?"} per ${c.group_by || "?"}`;
    if (c.kind === "boxplot") return `boxplot · ${c.agg_col || "?"} by ${c.group_by || "?"}`;
    if (c.kind === "calendar") return `calendar · ${fnPart} by ${c.group_by || "?"}`;
    return `${c.kind ?? "bar"} · ${fnPart} by ${c.group_by || "?"}`;
  }

  // Modal — open in create or edit mode. `iconKind` for create flows
  // is one of the `data-add-chart` values (bar, donut, half_donut,
  // rose, …); ICON_PRESETS maps it to base kind + pie modifiers.
  function openChartModal(iconKind, editIdx) {
    editingChartIdx = editIdx ?? -1;
    const editing = editingChartIdx >= 0;
    const preset  = ICON_PRESETS[iconKind] ?? { kind: iconKind ?? "bar" };
    const cfg = editing
      ? spec.charts[editingChartIdx]
      : {
          kind:    preset.kind,
          group_by: "",
          agg_col: "*",
          agg_fn:  "count",
          smooth:  !!preset.smooth,
          donut:   !!preset.donut,
          half:    !!preset.half,
          rose:    !!preset.rose,
          title:   "",
        };

    cmTitleEl.textContent = editing ? "Edit chart" : "Add chart";
    cmKind.value          = cfg.kind ?? "bar";
    populateModalColumns(cfg.group_by, cfg.agg_col, cfg.agg_fn);
    cmAggFn.value         = cfg.agg_fn ?? "count";
    cmTitleInput.value    = cfg.title ?? "";
    cmSmooth.checked      = !!cfg.smooth;
    cmDonut.checked       = !!cfg.donut;
    cmHalf.checked        = !!cfg.half;
    cmRose.checked        = !!cfg.rose;
    cmRegression.value    = cfg.regression ?? "";
    cmSymbol.value        = cfg.symbol ?? "circle";
    cmSymRpt.checked      = !!cfg.symbol_repeat;
    cmRich.checked        = !!cfg.rich_labels;
    populateYGroupBy(cfg.y_group_by);
    syncModalConditionals();
    if (typeof chartModal.showModal === "function") {
      // Modal-only — gets native backdrop + focus trap + ESC-to-close.
      if (!chartModal.open) chartModal.showModal();
    } else {
      chartModal.setAttribute("open", "");
    }
    cmGroupBy.focus();
  }

  function closeChartModal() {
    if (typeof chartModal.close === "function") chartModal.close();
    else chartModal.removeAttribute("open");
    editingChartIdx = -1;
  }

  // Group-by + agg-col dropdowns are populated from the source file's
  // columns. agg-col includes a leading "* (rows)" option for count-of-rows.
  function populateModalColumns(selectedGroupBy, selectedAggCol, currentAggFn) {
    const opts = currentColumns
      .map((c) => `<option value="${esc(c.name)}"${c.name === selectedGroupBy ? " selected" : ""}>${esc(c.name)}</option>`)
      .join("");
    cmGroupBy.innerHTML = `<option value="">— pick a column —</option>${opts}`;
    if (selectedGroupBy && currentColumns.some((c) => c.name === selectedGroupBy)) {
      cmGroupBy.value = selectedGroupBy;
    }
    const colOpts = currentColumns
      .map((c) => `<option value="${esc(c.name)}"${c.name === selectedAggCol ? " selected" : ""}>${esc(c.name)}</option>`)
      .join("");
    cmAggCol.innerHTML = `<option value="*"${selectedAggCol === "*" || !selectedAggCol ? " selected" : ""}>* (rows)</option>${colOpts}`;
    // For count of all rows the agg column doesn't matter; disable it.
    cmAggCol.disabled = currentAggFn === "count" && (selectedAggCol === "*" || !selectedAggCol);
  }

  // Heatmap's Y dimension dropdown — same column list as the
  // primary group-by, picked from the source file's columns.
  function populateYGroupBy(selected) {
    const opts = currentColumns
      .map((c) => `<option value="${esc(c.name)}"${c.name === selected ? " selected" : ""}>${esc(c.name)}</option>`)
      .join("");
    cmYGroupBy.innerHTML = `<option value="">— pick a column —</option>${opts}`;
    if (selected && currentColumns.some((c) => c.name === selected)) {
      cmYGroupBy.value = selected;
    }
  }

  function syncModalConditionals() {
    const kind        = cmKind.value;
    const isScatter   = kind === "scatter";
    const isGauge     = kind === "gauge";
    const isPictorial = kind === "pictorial_bar";
    const isHeatmap   = kind === "heatmap";
    const isRadar     = kind === "radar";
    const isBoxplot   = kind === "boxplot";
    const isCalendar  = kind === "calendar";
    cmSmoothRow.hidden = !(kind === "line" || kind === "area");
    cmDonutRow.hidden  = kind !== "pie";
    cmHalfRow.hidden   = kind !== "pie";
    cmRoseRow.hidden   = kind !== "pie";
    // Scatter doesn't aggregate — hide the function row + relabel the
    // two column pickers as X / Y. Show the regression dropdown.
    // Gauge is a single scalar — no group_by needed.
    // PictorialBar gets symbol picker + repeat toggle.
    // Boxplot runs five canned aggregations (min/q1/median/q3/max) on
    // the chosen value column — there's no single function to pick.
    cmAggFnRow.hidden   = isScatter || isBoxplot;
    cmRegRow.hidden     = !isScatter;
    cmSymbolRow.hidden  = !isPictorial;
    cmSymRptRow.hidden  = !isPictorial;
    // Rich-text labels apply to data-label kinds: pie + bar.
    cmRichRow.hidden    = !(kind === "pie" || kind === "bar");
    cmGroupByRow.hidden = isGauge;
    cmYGroupRow.hidden  = !(isHeatmap || isRadar);
    cmGroupByLbl.textContent = isScatter ? "X column"
                              : isHeatmap ? "X group by"
                              : isRadar   ? "Series by"
                              : isCalendar ? "Date column"
                              : "Group by";
    cmYGroupLbl.textContent  = isRadar    ? "Indicators by" : "Y group by";
    cmAggColLbl.textContent  = isScatter ? "Y column"
                              : isBoxplot ? "Value column"
                              : "Column";
    // count + * means count rows → agg column irrelevant. Otherwise enable.
    cmAggCol.disabled = !isScatter
      && cmAggFn.value === "count"
      && (cmAggCol.value === "*" || !cmAggCol.value);
  }

  // Wire icon-grid clicks → open modal pre-filled with chosen kind.
  // Maps each icon-button's `data-add-chart` value to the kind +
  // pie-modifier seed the modal opens with. Keeps the spec's `kind`
  // enum tight (5 base kinds) while letting icons express variants.
  const ICON_PRESETS = {
    bar:                 { kind: "bar" },
    bar_horizontal:      { kind: "bar_horizontal" },
    line:                { kind: "line" },
    area:                { kind: "area" },
    pie:                 { kind: "pie" },
    donut:               { kind: "pie", donut: true },
    half_donut:          { kind: "pie", donut: true, half: true },
    rose:                { kind: "pie", rose: true },
    scatter:             { kind: "scatter" },
    scatter_linear:      { kind: "scatter", regression: "linear" },
    scatter_exponential: { kind: "scatter", regression: "exponential" },
    funnel:                 { kind: "funnel" },
    gauge:                  { kind: "gauge" },
    pictorial_bar_dotted:   { kind: "pictorial_bar", symbol: "circle",   symbol_repeat: true  },
    pictorial_bar_icon:     { kind: "pictorial_bar", symbol: "triangle", symbol_repeat: false },
    heatmap:                { kind: "heatmap" },
    radar:                  { kind: "radar" },
    boxplot:                { kind: "boxplot" },
    calendar:               { kind: "calendar" },
    pie_rich:               { kind: "pie", rich_labels: true },
    bar_rich:               { kind: "bar", rich_labels: true },
  };
  chartAddGrid.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-add-chart]");
    if (!btn) return;
    openChartModal(btn.dataset.addChart);
  });
  // Saved chart list — edit on label click, delete on × click.
  chartList.addEventListener("click", (e) => {
    const editBtn = e.target.closest("[data-edit-chart]");
    if (editBtn) {
      openChartModal(undefined, Number(editBtn.dataset.editChart));
      return;
    }
    const rmBtn = e.target.closest("[data-rm-chart]");
    if (rmBtn) {
      spec.charts.splice(Number(rmBtn.dataset.rmChart), 1);
      renderChartList();
      previewSoon();
      return;
    }
  });
  // Modal close — × button or Cancel. ESC also closes via the native
  // `cancel` event below.
  chartModal.addEventListener("click", (e) => {
    if (e.target.closest("[data-close]")) closeChartModal();
  });
  chartModal.addEventListener("close",  () => { editingChartIdx = -1; });
  chartModal.addEventListener("cancel", () => { editingChartIdx = -1; });
  // Modal kind change toggles smooth/donut visibility.
  cmKind.addEventListener("change", syncModalConditionals);
  cmAggFn.addEventListener("change", syncModalConditionals);
  cmAggCol.addEventListener("change", syncModalConditionals);
  // Modal save → commit the spec change and re-render.
  cmSaveBtn.addEventListener("click", () => {
    const kind = cmKind.value || "bar";
    const isPie       = kind === "pie";
    const isScatter   = kind === "scatter";
    const isPictorial = kind === "pictorial_bar";
    const isHeatmap   = kind === "heatmap";
    const isRadar     = kind === "radar";
    const isBoxplot   = kind === "boxplot";
    const next = {
      kind,
      group_by:      cmGroupBy.value || "",
      agg_col:       cmAggCol.value  || "*",
      agg_fn:        cmAggFn.value   || "count",
      smooth:        !!cmSmooth.checked && (kind === "line" || kind === "area"),
      donut:         !!cmDonut.checked  && isPie,
      half:          !!cmHalf.checked   && isPie,
      rose:          !!cmRose.checked   && isPie,
      regression:    isScatter && cmRegression.value ? cmRegression.value : null,
      symbol:        isPictorial ? (cmSymbol.value || "circle") : null,
      symbol_repeat: isPictorial && !!cmSymRpt.checked,
      rich_labels:   !!cmRich.checked && (kind === "pie" || kind === "bar"),
      y_group_by:    (isHeatmap || isRadar) ? (cmYGroupBy.value || "") : null,
      title:         cmTitleInput.value.trim() || null,
    };
    const isGauge = kind === "gauge";
    if (!next.group_by && !isGauge) {
      toast.error(isScatter   ? "Pick an X column."
                : isHeatmap   ? "Pick an X group-by column."
                : "Pick a column to group by.");
      return;
    }
    if (isScatter && (!next.agg_col || next.agg_col === "*")) {
      toast.error("Pick a Y column for scatter (not “* rows”).");
      return;
    }
    if (isHeatmap && !next.y_group_by) {
      toast.error("Pick a Y group-by column for the heatmap.");
      return;
    }
    if (isRadar && !next.y_group_by) {
      toast.error("Pick an Indicators column for the radar.");
      return;
    }
    if (isBoxplot && (!next.agg_col || next.agg_col === "*")) {
      toast.error("Pick a numeric value column for the boxplot.");
      return;
    }
    if (editingChartIdx >= 0) {
      spec.charts[editingChartIdx] = next;
    } else {
      spec.charts.push(next);
    }
    closeChartModal();
    renderChartList();
    // Re-run the table preview so the #report-charts host is rebuilt
    // (renderReportCharts mounts into cells produced by renderPreviewTable).
    // For chart-only edits the table fetch is cheap and gives us a
    // consistent rebuild path.
    previewSoon();
  });

  // Per-chart render — each chart fetches its own /reports/preview
  // against the report's source file with its own group_by + agg.
  // Charts are independent of the report's table grouping.
  async function renderReportCharts() {
    const host = preview.querySelector("#report-charts");
    if (!host) return;
    if (!sourceSel.value) {
      host.innerHTML = `<p class="rp-muted">Pick a source file first.</p>`;
      return;
    }
    // Each chart's cell may have a previous ECharts mount — dispose it
    // before we replace the innerHTML.
    host.querySelectorAll(".rp-reports__chart").forEach((cell) => cell._rpDispose?.());
    host.innerHTML = spec.charts.map((_, i) =>
      `<div class="rp-reports__chart" data-chart-i="${i}"><p class="rp-muted">Loading…</p></div>`
    ).join("");
    if (!spec.charts.length) return;

    const echarts = await loadECharts();
    spec.charts.forEach(async (cfg, i) => {
      const cell = host.querySelector(`[data-chart-i="${i}"]`);
      if (!cell) return;
      if (!cfg.group_by && cfg.kind !== "gauge") {
        cell.innerHTML = `<p class="rp-muted">Pick a group-by column.</p>`;
        return;
      }
      let res;
      try {
        res = await api.post("/reports/preview",
          chartPreviewBody(sourceSel.value, cfg, spec.filter));
      } catch (err) {
        cell.innerHTML = `<p class="rp-muted">${esc(err.message ?? String(err))}</p>`;
        return;
      }
      // Heatmap and radar use the same two-group-by data but render
      // wildly differently — each gets its own extractor + option
      // builder. Other kinds share `chartOption(cfg, labels, values)`.
      if (cfg.kind === "heatmap") {
        const hm = subtotalsToHeatmap(res.subtotals);
        if (!hm.data.length) {
          cell.innerHTML = `<p class="rp-muted">No data.</p>`;
          return;
        }
        cell.innerHTML = "";
        const inst = echarts.init(cell, "redpash", { renderer: "svg" });
        inst.setOption(chartOptionHeatmap(cfg, hm.xValues, hm.yValues, hm.data));
        const ro = new ResizeObserver(() => inst.resize());
        ro.observe(cell);
        cell._rpDispose = () => { ro.disconnect(); inst.dispose(); };
        return;
      }
      if (cfg.kind === "radar") {
        const rd = subtotalsToRadar(res.subtotals);
        if (!rd.series.length || !rd.indicators.length) {
          cell.innerHTML = `<p class="rp-muted">No data.</p>`;
          return;
        }
        cell.innerHTML = "";
        const inst = echarts.init(cell, "redpash", { renderer: "svg" });
        inst.setOption(chartOptionRadar(cfg, rd.indicators, rd.series));
        const ro = new ResizeObserver(() => inst.resize());
        ro.observe(cell);
        cell._rpDispose = () => { ro.disconnect(); inst.dispose(); };
        return;
      }
      if (cfg.kind === "boxplot") {
        const bp = subtotalsToBoxplot(res.subtotals);
        if (!bp.data.length) {
          cell.innerHTML = `<p class="rp-muted">No data.</p>`;
          return;
        }
        cell.innerHTML = "";
        const inst = echarts.init(cell, "redpash", { renderer: "svg" });
        inst.setOption(chartOptionBoxplot(cfg, bp.labels, bp.data));
        const ro = new ResizeObserver(() => inst.resize());
        ro.observe(cell);
        cell._rpDispose = () => { ro.disconnect(); inst.dispose(); };
        return;
      }
      if (cfg.kind === "calendar") {
        const cal = subtotalsToCalendar(res.subtotals);
        if (!cal.length) {
          cell.innerHTML = `<p class="rp-muted">No data.</p>`;
          return;
        }
        cell.innerHTML = "";
        const inst = echarts.init(cell, "redpash", { renderer: "svg" });
        inst.setOption(chartOptionCalendar(cfg, cal));
        const ro = new ResizeObserver(() => inst.resize());
        ro.observe(cell);
        cell._rpDispose = () => { ro.disconnect(); inst.dispose(); };
        return;
      }
      // Each kind family extracts differently from the preview payload:
      //   scatter → raw details rows → (x, y) pairs
      //   gauge   → one-row subtotals → single scalar
      //   others  → multi-row subtotals → (label, value) pairs
      const { labels, values } =
        cfg.kind === "scatter" ? detailsToScatterSeries(res.details, cfg.group_by, cfg.agg_col) :
        cfg.kind === "gauge"   ? subtotalsToScalar(res.subtotals, cfg.title?.trim() || cfg.agg_col || "") :
                                 subtotalsToSeries(res.subtotals);
      if (!labels.length) {
        cell.innerHTML = `<p class="rp-muted">No data.</p>`;
        return;
      }
      cell.innerHTML = "";
      const inst = echarts.init(cell, "redpash", { renderer: "svg" });
      const opt = chartOption(cfg, labels, values);
      // Async overlay — fit line for scatter+regression. The base
      // chart renders immediately; the line appears once ecStat loads.
      await withRegression(opt, cfg, labels, values, loadECStat);
      inst.setOption(opt);
      const ro = new ResizeObserver(() => inst.resize());
      ro.observe(cell);
      cell._rpDispose = () => { ro.disconnect(); inst.dispose(); };
    });
  }
  // Text inputs fire "input"; selects fire "change". Both update the
  // same spec slot; one handler is enough if we listen on both events.
  const onAggEdit = (e) => {
    const row = e.target.closest("[data-i]");
    if (!row) return;
    const i = Number(row.dataset.i);
    const f = e.target.dataset.field;
    const a = spec.aggregations[i]; if (!a) return;
    if (f === "fn")    a.fn    = e.target.value;
    if (f === "col")   a.col   = e.target.value;
    if (f === "alias") a.alias = e.target.value;
    previewSoon();
  };
  aggList.addEventListener("input",  onAggEdit);
  aggList.addEventListener("change", onAggEdit);
  aggList.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-agg-rm]");
    if (!btn) return;
    const i = Number(btn.closest("[data-i]").dataset.i);
    spec.aggregations.splice(i, 1);
    renderSpec(); previewSoon();
  });

  sourceSel.addEventListener("change", async () => {
    await selectSource(sourceSel.value);
    previewSoon();
  });

  // Display toggles (show_details / show_subtotals / show_total).
  builderView.querySelectorAll('input[data-toggle]').forEach((cb) => {
    cb.addEventListener("change", () => {
      spec[cb.dataset.toggle] = cb.checked;
      previewSoon();
    });
  });

  function syncToggles() {
    builderView.querySelectorAll('input[data-toggle]').forEach((cb) => {
      cb.checked = !!spec[cb.dataset.toggle];
    });
  }

  function currentBody(overrides = {}) {
    return {
      source_file_id: sourceSel.value,
      title:          (overrides.title ?? titleInput.value.trim()) || "Untitled report",
      folder:         (overrides.folder ?? folderInput.value.trim()) || null,
      spec: {
        group_by:       spec.group_by,
        group_by_cols:  spec.group_by_cols,
        aggregations:   spec.aggregations,
        filter:         spec.filter,
        show_details:   spec.show_details,
        show_subtotals: spec.show_subtotals,
        show_total:     spec.show_total,
        sort:           spec.sort.filter((s) => s && s.col),
        charts:         spec.charts,
        top_n:          spec.top_n,
        windows:        spec.windows,
      },
    };
  }

  saveBtn.addEventListener("click", async () => {
    const body = {
      source_file_id: sourceSel.value,
      title:          titleInput.value.trim() || "Untitled report",
      folder:         folderInput.value.trim() || null,
      spec: {
        group_by:       spec.group_by,
        group_by_cols:  spec.group_by_cols,
        aggregations:   spec.aggregations,
        filter:         spec.filter,
        show_details:   spec.show_details,
        show_subtotals: spec.show_subtotals,
        show_total:     spec.show_total,
        sort:           spec.sort.filter((s) => s && s.col),
        charts:         spec.charts,
        top_n:          spec.top_n,
        windows:        spec.windows,
      },
    };
    saveBtn.disabled = true;
    try {
      const r = rid
        ? await api.put(`/reports/${encodeURIComponent(rid)}`, body)
        : await api.post("/reports", body);
      rid = r.redpash_id;
      isFavorite = !!r.is_favorite;
      favBtn.hidden = false;
      favBtn.classList.toggle("is-on", isFavorite);
      delBtn.hidden = false;
      saveAsBtn.hidden = false;
      folderInput.value = r.folder ?? folderInput.value;
      await refreshFolderList();
      history.replaceState(null, "", `#/reports?id=${encodeURIComponent(rid)}`);
      toast.success(`Saved "${r.title}"`);
    } catch (err) { toast.error(err.message ?? String(err)); }
    finally { saveBtn.disabled = false; }
  });

  saveAsBtn.addEventListener("click", async () => {
    const suggested = `${titleInput.value.trim() || "Untitled report"} (copy)`;
    const newTitle  = (prompt("Save report as:", suggested) ?? "").trim();
    if (!newTitle) return;
    saveAsBtn.disabled = true;
    try {
      const body = currentBody({ title: newTitle });
      const r = await api.post("/reports", body);
      // Navigate to the new report. Reload so the builder resets and
      // re-fetches the freshly inserted spec.
      location.hash = `#/reports?id=${encodeURIComponent(r.redpash_id)}`;
      location.reload();
    } catch (err) {
      toast.error(err.message ?? String(err));
    } finally {
      saveAsBtn.disabled = false;
    }
  });

  delBtn.addEventListener("click", async () => {
    if (!rid) return;
    if (!confirm("Delete this report?")) return;
    try {
      await api.delete(`/reports/${encodeURIComponent(rid)}`);
      location.hash = "#/reports";
    } catch (err) { toast.error(err.message ?? String(err)); }
  });

  favBtn.addEventListener("click", async () => {
    if (!rid) return;
    const next = !isFavorite;
    favBtn.classList.toggle("is-on", next);    // optimistic
    try {
      const r = await api.post(`/reports/${encodeURIComponent(rid)}/favorite`, { value: next });
      isFavorite = !!r.is_favorite;
      favBtn.classList.toggle("is-on", isFavorite);
    } catch (err) {
      favBtn.classList.toggle("is-on", isFavorite); // revert
      toast.error(err.message ?? String(err));
    }
  });

  // ─── Live preview ────────────────────────────────────
  function previewSoon() {
    captureSnapshot();
    if (previewTimer) clearTimeout(previewTimer);
    previewTimer = setTimeout(runPreview, PREVIEW_DEBOUNCE_MS);
  }

  // Snapshot capture: every spec-mutating action already calls
  // previewSoon(), so hooking history here covers them all without
  // touching individual handlers. We push the *previous* state (held
  // in `lastSnapshot`) so undo rolls back the change the user just
  // made.
  function captureSnapshot() {
    const current = JSON.stringify(spec);
    if (current === lastSnapshot) return;
    history.push(JSON.parse(lastSnapshot));
    lastSnapshot = current;
    syncUndoButtons();
  }

  // Apply a state object back onto the live `spec` reference (other
  // closures hold a pointer to it). Skips re-recording via the
  // history hook by updating `lastSnapshot` to match.
  function applyState(s) {
    Object.keys(spec).forEach((k) => delete spec[k]);
    Object.assign(spec, s);
    lastSnapshot = JSON.stringify(spec);
    syncToggles();
    renderSpec();
    runPreview();
    syncUndoButtons();
  }

  function syncUndoButtons() {
    if (undoBtn) undoBtn.disabled = !history.canUndo();
    if (redoBtn) redoBtn.disabled = !history.canRedo();
  }

  function doUndo() {
    const s = history.undo();
    if (s) applyState(s);
  }
  function doRedo() {
    const s = history.redo();
    if (s) applyState(s);
  }

  undoBtn?.addEventListener("click", doUndo);
  redoBtn?.addEventListener("click", doRedo);

  // Ctrl+Z / Cmd+Z = undo; Ctrl+Y / Cmd+Y / Ctrl+Shift+Z = redo.
  // Skip when focus is in a text input/textarea — let the browser's
  // native undo handle the user's typing there.
  document.addEventListener("keydown", (e) => {
    if (builderView.hidden) return;
    const tag = e.target.tagName;
    const inText = tag === "INPUT" && /text|search|number|^$|^undefined$/.test(e.target.type)
                || tag === "TEXTAREA";
    if (inText) return;
    const meta = e.ctrlKey || e.metaKey;
    if (!meta) return;
    if (e.key === "z" && !e.shiftKey) { e.preventDefault(); doUndo(); }
    else if (e.key === "y" || (e.key === "z" && e.shiftKey)) { e.preventDefault(); doRedo(); }
  });
  async function runPreview() {
    if (!sourceSel.value) {
      preview.innerHTML = `<p class="rp-muted">Pick a source file to start.</p>`;
      return;
    }
    preview.innerHTML = `<p class="rp-muted">Running…</p>`;
    try {
      const res = await api.post("/reports/preview", {
        source_file_id: sourceSel.value,
        spec: {
          group_by:       spec.group_by,
          group_by_cols:  spec.group_by_cols,
          aggregations:   spec.aggregations,
          filter:         spec.filter,
          show_details:   spec.show_details,
          show_subtotals: spec.show_subtotals,
          show_total:     spec.show_total,
          sort:           spec.sort.filter((s) => s && s.col),
        charts:         spec.charts,
        top_n:          spec.top_n,
        windows:        spec.windows,
        },
      });
      renderPreviewTable(res);
    } catch (err) {
      preview.innerHTML = `<p class="rp-muted">Preview failed: ${esc(err.message ?? String(err))}</p>`;
    }
  }

  function renderPreviewTable(res) {
    // Stash subtotals for future use by inline-details / matrix code
    // that still wants the table-level shape. Charts now fetch their
    // own data independently (see renderReportCharts).
    lastSubtotals = res.subtotals ?? null;
    const hasGroupBy = spec.group_by.length > 0;
    const blocks = [];

    // Backend now always materializes subtotals + total when grouping
    // is defined (so dashboards can read the same shape without
    // re-running). The viewer respects the user's show_* toggles here
    // to keep the page UX unchanged.
    if (spec.show_details && res.details?.rows?.length) {
      blocks.push(`
        <h3 class="rp-reports__section-title">Row details${res.details.total >= 1000 ? ` <span class="rp-muted">(showing first 1000)</span>` : ""}</h3>
        ${renderIntegratedDetails(res.details)}`);
    }
    if (spec.show_subtotals && res.subtotals?.rows?.length) {
      const matrixMode = spec.group_by_cols.length > 0 && spec.group_by.length > 0;
      if (matrixMode) {
        blocks.push(`
          <h3 class="rp-reports__section-title">Matrix <span class="rp-muted">(${esc(spec.group_by.join(" / "))} × ${esc(spec.group_by_cols.join(" / "))})</span></h3>
          ${renderMatrix(res.subtotals)}`);
      } else {
        blocks.push(`
          <h3 class="rp-reports__section-title">${hasGroupBy ? "Subtotals" : "Summary"} <span class="rp-muted">(click header to sort · shift-click to add a key${hasGroupBy ? " · click a row to drill down" : ""})</span></h3>
          ${renderSection(res.subtotals, "subtotals", hasGroupBy, spec.show_total ? res.total : null)}`);
      }
    }
    // Charts always render when defined — even if subtotals are toggled
    // off — since the chart itself *is* the visual the user authored.
    if (spec.charts.length) {
      blocks.push(`
        <h3 class="rp-reports__section-title">Charts</h3>
        <div class="rp-reports__charts" id="report-charts">
          ${spec.charts.map((_, i) => `<div class="rp-reports__chart" data-chart-i="${i}"></div>`).join("")}
        </div>`);
    }
    if (!blocks.length) {
      preview.innerHTML = `<p class="rp-muted">Nothing to show — enable at least one of <em>row details</em>, <em>subtotals</em>, or <em>grand total</em>.</p>`;
      return;
    }
    preview.innerHTML = `
      <div class="rp-reports__preview-meta rp-muted">${res.ms} ms</div>
      ${blocks.join("")}`;

    renderReportCharts();

    // Wire drill-down on the subtotals section (group rows only).
    if (hasGroupBy && res.subtotals?.rows?.length) {
      const tbody = preview.querySelector('[data-section="subtotals"] tbody');
      tbody?.addEventListener("click", (e) => {
        const tr = e.target.closest("[data-row]");
        if (!tr) return;
        drilldown(res.subtotals.rows[Number(tr.dataset.row)]);
      });
    }
    // Clickable headers — click cycles a single-column sort; shift-click
    // adds/edits a column in the multi-key sort chain.
    //   click       → replace sort with [{col, asc}] (or cycle to desc / off)
    //   shift-click → append {col, asc}; subsequent shift-clicks on the
    //                 same column flip desc → remove
    const thead = preview.querySelector('[data-section="subtotals"] thead');
    thead?.addEventListener("click", (e) => {
      const th = e.target.closest("[data-sort]");
      if (!th) return;
      const col = th.dataset.sort;
      const list = spec.sort.slice();
      const idx  = list.findIndex((s) => s.col === col);

      if (e.shiftKey) {
        if (idx === -1)                       list.push({ col, dir: "asc" });
        else if (list[idx].dir === "asc")     list[idx] = { col, dir: "desc" };
        else                                  list.splice(idx, 1);
      } else if (idx === -1 || list.length > 1) {
        // Replace the whole chain with this one key.
        spec.sort.splice(0);
        spec.sort.push({ col, dir: "asc" });
        previewSoon();
        return;
      } else if (list[idx].dir === "asc") {
        list[idx] = { col, dir: "desc" };
      } else {
        list.splice(idx, 1);
      }
      spec.sort.splice(0, spec.sort.length, ...list);
      previewSoon();
    });
  }

  // Excel-style hierarchical details — each group-by level rowspans
  // across all its members. With group_by = [formule, ville], "F1"
  // spans every F1 row across all villes, "Aix-en-Provence" spans
  // every (F1, Aix-en-Provence) row, and so on. Counts shown on
  // every level.
  function renderIntegratedDetails(section) {
    const columns = section.columns ?? [];
    const rows    = section.rows ?? [];
    const groupByNames = spec.group_by ?? [];
    if (!groupByNames.length || !rows.length) {
      return renderSection(section, "details", false);
    }

    const groupColIdxs = groupByNames
      .map((n) => columns.indexOf(n))
      .filter((i) => i >= 0);
    const levels         = groupColIdxs.length;
    const showSubtotals  = !!spec.show_subtotals;
    const showGrandTotal = !!spec.show_total;
    const aggregations   = spec.aggregations ?? [];

    // For each level L (0 = outermost), compute groups as
    // {start, end, dataCount} (end inclusive). Subtotals get folded
    // into each group's rendered span via `augLen` below.
    const groupsByLevel = [];
    for (let L = 0; L < levels; L++) {
      const colsUpTo = groupColIdxs.slice(0, L + 1);
      const sameAtLevel = (a, b) =>
        colsUpTo.every((i) => (a[i] ?? null) === (b[i] ?? null));
      const arr = [];
      let start = 0;
      for (let i = 1; i <= rows.length; i++) {
        if (i === rows.length || !sameAtLevel(rows[start], rows[i])) {
          arr.push({ start, end: i - 1, dataCount: i - start });
          start = i;
        }
      }
      groupsByLevel.push(arr);
    }

    // Each level-L group's rowspan must cover its data rows *and*
    // every subtotal row that falls inside it (deeper-level subtotals)
    // plus its own subtotal at the end. Without this the group cell
    // wouldn't reach across the inserted subtotal rows.
    for (let L = levels - 1; L >= 0; L--) {
      for (const g of groupsByLevel[L]) {
        let inside = 0;
        if (showSubtotals) {
          for (let DL = L + 1; DL < levels; DL++) {
            for (const inner of groupsByLevel[DL]) {
              if (inner.start >= g.start && inner.end <= g.end) inside++;
            }
          }
        }
        g.augLen = g.dataCount + inside + (showSubtotals ? 1 : 0);
      }
    }

    const startMaps = groupsByLevel.map((arr) => {
      const m = new Map();
      for (const g of arr) m.set(g.start, g);
      return m;
    });
    const endMaps = groupsByLevel.map((arr) => {
      const m = new Map();
      for (const g of arr) m.set(g.end, g);
      return m;
    });

    const bodyHtml = [];
    for (let rowIdx = 0; rowIdx < rows.length; rowIdx++) {
      const row = rows[rowIdx];
      const cells = [];

      // Emit group cells for every level that starts on this row.
      // Other levels are covered by rowspans from previous rows.
      for (let level = 0; level < levels; level++) {
        const g = startMaps[level].get(rowIdx);
        if (!g) continue;
        const ci = groupColIdxs[level];
        const v = row[ci];
        const label = v === null ? "∅" : esc(v);
        cells.push(
          `<td rowspan="${g.augLen}" class="rp-reports__group-cell rp-reports__group-cell--l${level}">
            ${label} <span class="rp-reports__group-count">(${g.dataCount})</span>
          </td>`);
      }

      // Non-group columns — straight cells.
      columns.forEach((_col, ci) => {
        if (groupColIdxs.includes(ci)) return;
        const cell = row[ci];
        cells.push(cell === null
          ? `<td class="rp-muted">∅</td>`
          : `<td>${esc(cell)}</td>`);
      });
      bodyHtml.push(`<tr>${cells.join("")}</tr>`);

      // After this row, emit subtotal rows for any groups ending here
      // — deepest level first so a row that ends both a ville and a
      // formule renders [ville subtotal, formule subtotal] in order.
      if (showSubtotals) {
        for (let L = levels - 1; L >= 0; L--) {
          const g = endMaps[L].get(rowIdx);
          if (!g) continue;
          const groupRows = rows.slice(g.start, g.end + 1);
          bodyHtml.push(buildSubtotalRow(L, groupRows, columns, groupColIdxs, aggregations));
        }
      }
    }

    if (showGrandTotal) {
      bodyHtml.push(buildGrandTotalRow(rows, columns, aggregations));
    }

    return `
      <div class="rp-reports__preview-scroll" data-section="details">
        <table class="rp-reports__preview-table rp-reports__details-table">
          <thead><tr>${columns.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead>
          <tbody>${bodyHtml.join("")}</tbody>
        </table>
      </div>`;
  }

  // Render a Sub-Total row for a level-L group. Columns at group
  // levels ≤ L are skipped (covered by rowspan from the group cell
  // above). Aggregation values appear in their source columns; every
  // other slot is a blank colspan cell — distinct row styling alone
  // tells the user this is a subtotal, no explicit label needed.
  function buildSubtotalRow(level, groupRows, columns, groupColIdxs, aggregations) {
    return buildAggRow({
      label:    "",
      rowClass: `rp-reports__subtotal-row rp-reports__subtotal-row--l${level}`,
      skipCi:   (ci) => {
        const gi = groupColIdxs.indexOf(ci);
        return gi >= 0 && gi <= level;
      },
      sourceRows: groupRows,
      columns, aggregations,
    });
  }

  function buildGrandTotalRow(allRows, columns, aggregations) {
    return buildAggRow({
      label:    "Grand Total",
      rowClass: "rp-reports__subtotal-row rp-reports__grand-row",
      skipCi:   () => false,   // no rowspan coverage on grand total
      sourceRows: allRows,
      columns, aggregations,
    });
  }

  // Walks `columns` and emits one cell per non-skipped position:
  //   • agg value cell when the column matches an aggregation's source
  //   • blank colspan for runs of "filler" columns
  // The single `label`, when provided, is placed only on the first
  // filler run — keeps "Grand Total" visible once without repeating
  // it after the agg cell. Pass `label: ""` to suppress entirely.
  function buildAggRow({ label, rowClass, skipCi, sourceRows, columns, aggregations }) {
    const cells = [];
    let runStart  = -1;
    let labelDone = false;
    const flushRun = (endCi) => {
      if (runStart < 0) return;
      const span = endCi - runStart + 1;
      const showLabel = label && !labelDone;
      const text = showLabel ? esc(label) : "";
      const cls  = showLabel
        ? "rp-reports__subtotal-cell rp-reports__subtotal-label"
        : "rp-reports__subtotal-cell";
      cells.push(`<td class="${cls}" colspan="${span}">${text}</td>`);
      if (showLabel) labelDone = true;
      runStart = -1;
    };
    for (let ci = 0; ci < columns.length; ci++) {
      if (skipCi(ci)) { flushRun(ci - 1); continue; }
      const colName = columns[ci];
      const matchingAgg = aggregations.find((a) => a.col === colName);
      if (matchingAgg) {
        flushRun(ci - 1);
        const v = computeAgg(matchingAgg, sourceRows, columns);
        cells.push(`<td class="rp-reports__subtotal-cell rp-reports__subtotal-value">${esc(fmtAgg(v))}</td>`);
      } else {
        if (runStart < 0) runStart = ci;
      }
    }
    flushRun(columns.length - 1);
    return `<tr class="${rowClass}">${cells.join("")}</tr>`;
  }

  // Client-side reducer over the displayed rows. Mirrors the backend's
  // AggFn enum. Note: when details are capped (>1000 rows on the
  // server), this only reflects the visible slice — for exact totals
  // across the full dataset, the separate subtotals/total sections
  // run server-side and stay authoritative.
  function computeAgg(agg, rowList, columns) {
    if (!agg) return null;
    if (agg.col === "*") return rowList.length;
    const ci = columns.indexOf(agg.col);
    if (ci < 0) return null;
    const vals = [];
    for (const r of rowList) {
      const v = r[ci];
      if (v !== null && v !== undefined && v !== "") vals.push(v);
    }
    const nums = () => vals.map(Number).filter((n) => !Number.isNaN(n));
    switch (agg.fn) {
      case "count":          return vals.length;
      case "count_distinct": return new Set(vals).size;
      case "sum":            return nums().reduce((a, b) => a + b, 0);
      case "mean": {
        const ns = nums();
        return ns.length ? ns.reduce((a, b) => a + b, 0) / ns.length : null;
      }
      case "min": { const ns = nums(); return ns.length ? Math.min(...ns) : null; }
      case "max": { const ns = nums(); return ns.length ? Math.max(...ns) : null; }
      case "first": return vals[0] ?? null;
      case "last":  return vals[vals.length - 1] ?? null;
    }
    return null;
  }

  function fmtAgg(v) {
    if (v === null || v === undefined) return "";
    if (typeof v === "number") {
      if (Number.isInteger(v)) return v.toLocaleString();
      return v.toLocaleString(undefined, { maximumFractionDigits: 2 });
    }
    return String(v);
  }

  // Salesforce-style matrix view — rows × columns × first aggregation.
  // Row + column totals are summed client-side; non-numeric agg values
  // are skipped (so e.g. `first` on a string column won't sum).
  function renderMatrix(section) {
    const columns = section.columns ?? [];
    const rows    = section.rows ?? [];
    const rowDims = spec.group_by;
    const colDims = spec.group_by_cols;
    const rowDimIdxs = rowDims.map((n) => columns.indexOf(n));
    const colDimIdxs = colDims.map((n) => columns.indexOf(n));
    const aggStart   = rowDimIdxs.length + colDimIdxs.length;
    const metricIdx  = aggStart;            // first aggregation column
    const metricName = columns[metricIdx] ?? "value";

    const rowKeyOf = (row) => rowDimIdxs.map((i) => row[i] ?? "").join("");
    const colKeyOf = (row) => colDimIdxs.map((i) => row[i] ?? "").join("");

    const rowKeysSet = new Set();
    const colKeysSet = new Set();
    const rowKeyValues = new Map();
    const colKeyValues = new Map();
    const cellMap      = new Map();
    for (const row of rows) {
      const rk = rowKeyOf(row);
      const ck = colKeyOf(row);
      rowKeysSet.add(rk);
      colKeysSet.add(ck);
      if (!rowKeyValues.has(rk)) rowKeyValues.set(rk, rowDimIdxs.map((i) => row[i]));
      if (!colKeyValues.has(ck)) colKeyValues.set(ck, colDimIdxs.map((i) => row[i]));
      cellMap.set(`${rk}${ck}`, row[metricIdx]);
    }
    const rowKeys = Array.from(rowKeysSet).sort();
    const colKeys = Array.from(colKeysSet).sort();

    const wantTotals  = spec.show_total;
    const rowTotals   = {};
    const colTotals   = {};
    let   grandTotal  = 0;
    let   anyNumeric  = false;
    if (wantTotals) {
      for (const rk of rowKeys) {
        let s = 0;
        for (const ck of colKeys) {
          const v = cellMap.get(`${rk}${ck}`);
          const n = v == null ? NaN : Number(v);
          if (!isNaN(n)) { s += n; anyNumeric = true; }
        }
        rowTotals[rk] = s;
      }
      for (const ck of colKeys) {
        let s = 0;
        for (const rk of rowKeys) {
          const v = cellMap.get(`${rk}${ck}`);
          const n = v == null ? NaN : Number(v);
          if (!isNaN(n)) s += n;
        }
        colTotals[ck] = s;
      }
      grandTotal = Object.values(rowTotals).reduce((a, b) => a + b, 0);
    }

    const headerCells = [
      ...rowDims.map((d) => `<th>${esc(d)}</th>`),
      ...colKeys.map((ck) => `<th>${esc(colKeyValues.get(ck).join(" / "))}</th>`),
      ...(wantTotals && anyNumeric ? [`<th>Total</th>`] : []),
    ].join("");

    const body = rowKeys.map((rk) => {
      const rv = rowKeyValues.get(rk);
      const dimCells = rv.map((v) =>
        v == null ? `<td class="rp-muted">∅</td>` : `<td>${esc(v)}</td>`).join("");
      const valCells = colKeys.map((ck) => {
        const v = cellMap.get(`${rk}${ck}`);
        return v == null
          ? `<td class="rp-muted">∅</td>`
          : `<td class="rp-num">${esc(v)}</td>`;
      }).join("");
      const total = (wantTotals && anyNumeric)
        ? `<td class="rp-num rp-reports__matrix-rowtotal">${rowTotals[rk]}</td>` : "";
      return `<tr>${dimCells}${valCells}${total}</tr>`;
    }).join("");

    const foot = (wantTotals && anyNumeric) ? `
      <tfoot><tr class="rp-reports__total-row">
        <td colspan="${rowDims.length}">Grand total</td>
        ${colKeys.map((ck) => `<td class="rp-num">${colTotals[ck]}</td>`).join("")}
        <td class="rp-num">${grandTotal}</td>
      </tr></tfoot>` : "";

    return `
      <div class="rp-reports__preview-meta rp-muted">Metric: ${esc(metricName)}</div>
      <div class="rp-reports__preview-scroll" data-section="matrix">
        <table class="rp-reports__preview-table rp-reports__matrix-table">
          <thead><tr>${headerCells}</tr></thead>
          <tbody>${body}</tbody>
          ${foot}
        </table>
      </div>`;
  }

  function renderSection(section, kind, clickable, totalRow) {
    const headers  = section.columns ?? [];
    const sortable = kind === "subtotals";
    const sortList = spec.sort ?? [];
    const headHtml = headers.map((h) => {
      if (!sortable) return `<th>${esc(h)}</th>`;
      const idx = sortList.findIndex((s) => s.col === h);
      let badge = "";
      if (idx >= 0) {
        const arrow = sortList[idx].dir === "desc" ? "▾" : "▴";
        const order = sortList.length > 1 ? ` <small>${idx + 1}</small>` : "";
        badge = ` ${arrow}${order}`;
      }
      return `<th class="rp-reports__sort-th" data-sort="${esc(h)}">${esc(h)}${badge}</th>`;
    }).join("");
    const rowsHtml = section.rows.map((row, i) =>
      `<tr data-row="${i}"${clickable ? ' class="rp-reports__preview-row"' : ""}>${row.map((cell) => cell === null
        ? `<td class="rp-muted">∅</td>`
        : `<td>${esc(cell)}</td>`).join("")}</tr>`).join("");
    const totalFoot = totalRow
      ? `<tfoot><tr class="rp-reports__total-row">
           ${totalRow.map((cell, i) =>
             cell === null
               ? `<td>${i === 0 ? "Grand total" : ""}</td>`
               : `<td>${esc(cell)}</td>`).join("")}
         </tr></tfoot>` : "";
    return `
      <div class="rp-reports__preview-scroll" data-section="${esc(kind)}">
        <table class="rp-reports__preview-table">
          <thead><tr>${headHtml}</tr></thead>
          <tbody>${rowsHtml}</tbody>
          ${totalFoot}
        </table>
      </div>`;
  }

  // Build a filter from this row's group-by values and route the user
  // to the cleaner with that filter pre-applied via localStorage.
  // The cleaner's redtable reads its persisted view on mount, so
  // pre-seeding the filter there avoids any URL-level coupling.
  function drilldown(rowValues) {
    const fileRid = sourceSel.value;
    if (!fileRid || !spec.group_by.length) return;
    const children = spec.group_by.map((col, i) => {
      const v = rowValues[i];
      return v === null
        ? { col, op: "is_null" }
        : { col, op: "eq", value: String(v) };
    });
    const tree = { op: "and", children };
    try {
      const key = `redpash.view.${fileRid}`;
      let saved;
      try { saved = JSON.parse(localStorage.getItem(key) || "{}"); } catch { saved = {}; }
      saved.filter = tree;
      localStorage.setItem(key, JSON.stringify(saved));
    } catch { /* localStorage may be disabled — cleaner will just open unfiltered */ }
    location.hash = `#/cleaner?file=${encodeURIComponent(fileRid)}`;
  }

  function defaultAlias(a) {
    if (a.col === "*") return a.fn;
    return `${a.col}_${a.fn}`;
  }

  function queryArg(name) {
    const m = location.hash.match(new RegExp(`[?&]${name}=([^&]+)`));
    return m ? decodeURIComponent(m[1]) : null;
  }

  function esc(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) =>
      ({ "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;" }[c]));
  }
}
