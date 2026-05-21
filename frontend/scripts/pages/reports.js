// Reports page — sandbox port, Phase 1.5 (source-table wiring).
//
// Layout: stacked toolbar + redtable (top pane) + drag handle + chart dock
// (bottom pane). The whole page is sandbox; the old multi-file builder at
// /scripts/reports/index.js is kept on disk for revertability but never
// invoked here (its DOM hooks — #reports-list / #reports-builder — don't
// exist in the new shell).
//
// This pass wires the SOURCE TABLE only, mirroring the cleaner playbook in
// docs/frontend/sandbox-integration.md:
//   • Parse ?file=FIL_… from the URL.
//   • Fetch /api/files → populate the source-file picker dropdown.
//   • Pre-select the URL file (or fall back to the first owned file).
//   • Fetch /api/files/:rid + /:rid/page → paint headers, rows, pagination.
//   • Wire search (debounced), rows-per-page, header-click sort.
//   • Snapshot the chrome to sessionStorage so reload paints fast
//     (cache-then-correct).
//
// Chart-dock sample cards are left untouched on purpose — the +Chart flow
// + chart-render port land in Phase 2.
//
// Conventions enforced (see sandbox-integration.md):
//   • `mountSandbox` runs on every hash change → element bindings are
//     once-guarded; document-level listeners would need
//     _installReportsLiveHandlers._xxxInstalled (none in this pass).
//   • STATE mirror discipline — every value a window.report* handler
//     reads is in STATE before any clickable DOM exists.
//   • api.get / api.post already prefix /api — pass /files, not /api/files.
//   • Rendered cells DO NOT carry data-row-idx + data-col-name — those
//     trigger controls.js's cell-edit dispatcher, which would make
//     read-only source rows accidentally editable.

import { api }   from "/scripts/api.js";
import { toast } from "/scripts/ui/toast.js";
import { pagerMarkup } from "/scripts/ui/pager.js";
import { loadECharts, loadECStat } from "/scripts/dashboards/echarts.js";
import {
  chartOption, chartOptionHeatmap, chartOptionRadar,
  chartOptionBoxplot, chartOptionCalendar,
  subtotalsToSeries, subtotalsToScalar, subtotalsToHeatmap,
  subtotalsToRadar, subtotalsToBoxplot, subtotalsToCalendar,
  detailsToScatterSeries, chartPreviewBody, withRegression,
  subtotalsToMatrix, chartOptionMatrix,
} from "/scripts/dashboards/chart-render.js";

const SNAPSHOT_KEY = "rp_reports_mount_snapshot_v1";

// Saved charts persist here so they survive a reload and are available
// to the Dashboard page. Stopgap until backend FIL_ File persistence.
const SAVED_CHARTS_KEY = "rp_saved_charts_v1";

// Module-scope STATE — every window.report* handler reads from here.
// Reset shape (no `let STATE = …` reassignment) so other modules holding
// a stale reference don't drift.
const STATE = {
  files:    [],     // FileSummary[] — this project's CSV datasets
  projects: [],     // ProjectSummary[] — every project the user owns
  hiddenProjects: new Set(),  // project ids the user ×-hid from the strip
  hiddenFiles:    new Set(),  // file ids the user ×-hid from the strip
  projectId: null,  // project this Reports view is scoped to
  rid:      null,   // currently-selected file rid (null = none)
  summary:  null,   // FileSummary of the selected file
  columns:  [],     // ColumnMeta[] of the selected file
  page:     1,
  pageSize: 25,
  sorts:    [],     // [{ col, dir: "asc" | "desc" }] — single-key today
  search:   "",
  charts:   [],     // ChartSpec[] — each rendered as a chart-dock card
};

// Which chart the builder rail is editing — index into STATE.charts,
// or -1 when none is active.
let _activeChart = -1;

// Monotonic counter behind auto-generated chart-NNN titles — only
// advances on a real assignment, so generated names never collide.
let _chartSeq = 0;

// Builder-load closure, exposed by _installReportsLiveHandlers so the
// mount path can re-point the builder after the localStorage restore.
let _reportsBuilderLoad = null;

// Project STATE.charts currently reflects — when it changes, the dock is
// rebuilt from that project's saved charts.
let _chartsProject = null;

export default async function mount(root, ctx) {
  // 1) Sandbox subtree — router only loaded the thin partials/reports.html
  //    shell; include.js's recursive walker pulls in toolbar / table /
  //    chart-dock / modals from partials/reports/. Without this the page
  //    paints empty (mirrors cleaner.js / objects.js mount() pattern).
  if (typeof window.rpInclude === "function") {
    try { await window.rpInclude(root); }
    catch (err) { console.warn("[reports] rpInclude failed", err); }
  }

  // 2) Page-dots — wire the Data ↔ Charts scroll-snap navigation.
  _wireReportsDeck(root);

  // 3) Sandbox wiring — picker, fetch, table paint.
  await mountReportsSandbox(root, ctx);
}

// ─────────────────────────── mountReportsSandbox ──────────────────────

async function mountReportsSandbox(root, ctx) {
  const fileTabs  = root.querySelector("[data-reports-file-tabs]");
  const tableWrap = root.querySelector("[data-reports-table]");
  // Sandbox markup missing → bail. Mirrors the cleaner / objects guard so
  // a fall-through to the legacy layout (none today) wouldn't blow up.
  if (!fileTabs || !tableWrap) return;

  // Restore prefs FIRST so renderers see them when they paint.
  const prefs = ctx?.session?.prefs ?? {};
  const savedSize = Number(prefs.reports_page_size);
  if (Number.isFinite(savedSize) && [10, 25, 50, 100].includes(savedSize)) {
    STATE.pageSize = savedSize;
  }

  // Install handlers BEFORE any inline onclick (or post-paint binding)
  // can fire. Same ordering rule the cleaner / objects mount uses.
  _installReportsLiveHandlers(root);

  // Sync the rows-per-page pill label to the restored size so the toolbar
  // matches STATE on first paint (the static partial says "25").
  _syncRowsLabel(root);

  // URL → which project's report we're opening, + optionally an explicit
  // source file: #/reports?project=PRJ_…&file=FIL_…
  const q = new URLSearchParams(location.hash.split("?")[1] ?? "");
  let   projectId     = q.get("project");
  const initialFileId = q.get("file");

  // Every project the user owns — the proj-tabs strip lists them all,
  // and a bare #/reports resolves to the most-recently-updated one (the
  // same convenience the Objects topbar's Cleaner button uses).
  try {
    const pj   = api.getCached("/projects");
    const list = pj.cached ?? await pj.fresh;
    STATE.projects = [...(list?.items ?? [])];
  } catch (err) {
    console.error("[reports] fetch /projects failed", err);
    STATE.projects = [];
  }

  if (!projectId) {
    const rows = [...STATE.projects].sort((a, b) =>
      String(b.updated_at || "").localeCompare(String(a.updated_at || "")));
    projectId = rows[0]?.redpash_id ?? null;
  }
  if (!projectId) {
    _renderReportsEmptyState(root, "No projects yet — upload a file from Home to start one.");
    return;
  }
  STATE.projectId = projectId;
  _renderReportsProjectTabs(root);

  // Mount snapshot — paint the cached picker label fast, before the
  // fetch resolves.
  _restoreFromSnapshot(root);

  // Fetch the user's files, then scope to this project. /api/files
  // returns every file the user owns across all projects; the Reports
  // page works only with this project's CSV datasets.
  const _scopeToProject = (items) => (items ?? [])
    .filter((f) => f.project_redpash_id === projectId && f.file_type === "csv");
  const { cached, fresh } = api.getCached("/files");
  if (cached?.items) {
    STATE.files = _scopeToProject(cached.items);
    _renderReportsFileTabs(root);
    _renderReportsHeader(root);
  }
  try {
    const res = await fresh;
    STATE.files = _scopeToProject(res?.items);
  } catch (err) {
    console.error("[reports] fetch /files failed", err);
    if (!cached) {
      STATE.files = [];
      toast.error(`Couldn't load file list: ${err.body?.error ?? err.message ?? err}`);
    }
    // else: keep the cached paint; correction retries on next mount.
  }

  _renderReportsFileTabs(root);
  _renderReportsHeader(root);

  // No CSV datasets in this project → nothing to chart from yet.
  if (!STATE.files.length) {
    _renderReportsEmptyState(root, "No datasets in this project.");
    return;
  }

  // Active file: ?file= when it names a CSV in this project, else the
  // project's first dataset. A ?file= we can't see falls through.
  const urlFileValid = initialFileId && STATE.files.some((f) => f.redpash_id === initialFileId);
  const activeId     = urlFileValid ? initialFileId : STATE.files[0].redpash_id;

  // STATE mirror — every handler reads from here.
  STATE.rid     = activeId;
  STATE.summary = STATE.files.find((f) => f.redpash_id === activeId) ?? null;
  STATE.columns = [];   // forces _paintReportsTable to refetch /files/:rid

  // Re-render the file tabs now STATE.rid is set so the active dataset's
  // tab carries .active on first paint (the line-157 render ran before
  // the active file was chosen).
  _renderReportsFileTabs(root);
  _renderReportsHeader(root);
  await _paintReportsTable(root);

  // Restore this project's saved charts from localStorage into the dock —
  // on a fresh load or a project switch — so a saved report survives a
  // reload and is there for the Dashboard page. Drafts are in-memory only;
  // within the same project (SPA re-nav) the working set is left as-is.
  if (_chartsProject !== STATE.projectId) {
    const saved = _loadSavedCharts(STATE.projectId);
    for (const c of saved) {
      const m = /^chart-(\d+)$/.exec(c.title || "");
      if (m) _chartSeq = Math.max(_chartSeq, Number(m[1]));
    }
    STATE.charts.splice(0, STATE.charts.length, ...saved);
    if (!STATE.charts.length) {
      STATE.charts.push({ kind: "bar", group_by: "", agg_col: "*", agg_fn: "count" });
    }
    _activeChart = 0;
    _reportsBuilderLoad?.(0);
    _chartsProject = STATE.projectId;
  }

  _builderSyncPickers(root);
  _syncReportTools(root);
  _renderReportsCharts(root).catch(() => {});

  _snapshotForMount();

  // Canonicalise the URL — #/reports?project=…&file=… so a reload
  // reopens this project + file. replaceState fires no hashchange, so
  // the router doesn't re-mount.
  const _params = new URLSearchParams();
  _params.set("project", projectId);
  if (activeId) _params.set("file", activeId);
  const _canonical = `#/reports?${_params.toString()}`;
  if (_canonical !== location.hash) {
    history.replaceState(null, "", _canonical);
  }

  // Tier 2 E — warm the other lists for fast cross-navigation.
  api.prewarm(["/projects", "/reports", "/dashboards", "/users", "/companies"]);
}

// ─────────────────────── _installReportsLiveHandlers ──────────────────

function _installReportsLiveHandlers(root) {

  // Shared closure — call after any STATE.rid / .search / .sorts / .page
  // mutation that needs a chrome + table repaint.
  async function _afterFileChange() {
    _renderReportsHeader(root);
    await _paintReportsTable(root);
    _builderSyncPickers(root);
    _syncReportTools(root);
    _renderReportsCharts(root).catch(() => {});   // re-fetch charts vs the new file
    _snapshotForMount();
  }

  // Picker → user clicked a file in the source-file dropdown. Closes the
  // menu, swaps STATE.rid, resets paging / sort / search, repaints, pushes
  // the URL so a reload reopens the new file.
  window.reportSelectFile = async (fileId) => {
    if (!fileId || fileId === STATE.rid) return;
    if (!STATE.files.some((f) => f.redpash_id === fileId)) {
      console.warn("[reports] unknown file id", fileId);
      return;
    }
    STATE.rid     = fileId;
    STATE.summary = STATE.files.find((f) => f.redpash_id === fileId) ?? null;
    STATE.columns = [];
    STATE.page    = 1;
    STATE.search  = "";
    STATE.sorts   = [];
    const searchInput = root.querySelector("[data-reports-search]");
    if (searchInput) searchInput.value = "";
    // Re-render the strip so .active moves and the × is suppressed on
    // the newly-selected tab (× placement depends on which tab is active).
    _renderReportsFileTabs(root);
    // Keep the project in the URL across a source-file swap so a reload
    // reopens the same Reports view.
    const _p = new URLSearchParams();
    if (STATE.projectId) _p.set("project", STATE.projectId);
    _p.set("file", fileId);
    history.replaceState(null, "", `#/reports?${_p.toString()}`);
    await _afterFileChange();
  };

  window.reportSetPage = async (page) => {
    if (!STATE.rid) return;
    const n = Number(page);
    if (!Number.isFinite(n) || n < 1 || n === STATE.page) return;
    STATE.page = n;
    await _paintReportsTable(root);
  };

  window.reportSetPageSize = async (size) => {
    const n = Number(size);
    if (!Number.isFinite(n) || n === STATE.pageSize) return;
    STATE.pageSize = n;
    STATE.page = 1;
    window.rpSavePref?.("reports_page_size", n);
    _syncRowsLabel(root);
    if (STATE.rid) await _paintReportsTable(root);
  };

  window.reportSortBy = async (col) => {
    if (!STATE.rid || !col) return;
    const cur = STATE.sorts[0];
    if (cur && cur.col === col) {
      // asc → desc → none cycle, mirrors the cleaner's column-sort UX.
      if (cur.dir === "asc")  { cur.dir = "desc"; }
      else                    { STATE.sorts = []; }
    } else {
      STATE.sorts = [{ col, dir: "asc" }];
    }
    STATE.page = 1;
    await _paintReportsTable(root);
  };

  window.reportRefresh = async () => {
    if (!STATE.rid) return;
    // Force a column re-fetch so a stale columns_meta from an underlying
    // step change repaints the headers too.
    STATE.columns = [];
    const start = performance.now();
    await _paintReportsTable(root);
    // 600ms minimum spin — same floor the cleaner uses so the icon
    // animation doesn't flash invisibly for cached fetches.
    const elapsed = performance.now() - start;
    if (elapsed < 600) await new Promise((r) => setTimeout(r, 600 - elapsed));
  };

  // Search — debounced 250ms. Bound once per element; the partial is
  // mounted by include.js into the same DOM node across re-mounts, so the
  // __rpReportsBound flag survives unless the partial is fully torn down.
  const searchInput = root.querySelector("[data-reports-search]");
  if (searchInput && !searchInput.__rpReportsBound) {
    searchInput.__rpReportsBound = true;
    let t = null;
    searchInput.addEventListener("input", () => {
      clearTimeout(t);
      t = setTimeout(async () => {
        const v = searchInput.value.trim();
        if (v === STATE.search) return;
        STATE.search = v;
        STATE.page = 1;
        if (STATE.rid) await _paintReportsTable(root);
      }, 250);
    });
  }

  // Rows-per-page menu items in the toolbar are hardcoded with
  // `onclick="spDdSelectRows(this, N)"` — that updates the pill label.
  // Hook the same item clicks (in capture phase so we run alongside the
  // sandbox handler, not after a class flip we'd have to read back) to
  // also push the new size into STATE via reportSetPageSize. Once-guarded.
  const rowsWrap = root.querySelector("[data-sp-rows-label]")?.closest(".rp-dd-wrap");
  if (rowsWrap && !rowsWrap.__rpReportsBound) {
    rowsWrap.__rpReportsBound = true;
    rowsWrap.addEventListener("click", (ev) => {
      const item = ev.target.closest(".rp-dd-item");
      if (!item) return;
      // The inline onclick already extracts N from the label number;
      // we re-read for safety in case the partial markup drifts.
      const n = parseInt(item.textContent, 10);
      if (Number.isFinite(n)) window.reportSetPageSize?.(n);
    });
  }

  // Project tabs — delegated click. Three targets inside the strip: the
  // × hides a project tab, an add-menu item shows a hidden one, a bare
  // tab click re-scopes the page. The listener sits on the stable strip
  // container so it survives every innerHTML rebuild; once-guarded.
  const projStrip = root.querySelector("[data-reports-proj-tabs]");
  if (projStrip && !projStrip.__rpReportsBound) {
    projStrip.__rpReportsBound = true;
    projStrip.addEventListener("click", (ev) => {
      const x = ev.target.closest(".rp-rt-proj-tab-x");
      if (x) {
        window.reportsHideProject?.(x.closest("[data-project-id]")?.dataset.projectId);
        return;
      }
      const addItem = ev.target.closest(".rp-tab-add-item");
      if (addItem) { window.reportsShowProject?.(addItem.dataset.projectId); return; }
      const tab = ev.target.closest("[data-project-id]");
      if (tab) window.reportsSelectProject?.(tab.dataset.projectId);
    });
  }
  // File tabs — same shape: × hides, add-menu item shows, tab click
  // selects the source dataset.
  const fileStrip = root.querySelector("[data-reports-file-tabs]");
  if (fileStrip && !fileStrip.__rpReportsBound) {
    fileStrip.__rpReportsBound = true;
    fileStrip.addEventListener("click", (ev) => {
      const x = ev.target.closest(".rp-rtp-tab-x");
      if (x) {
        window.reportsHideFile?.(x.closest("[data-file-id]")?.dataset.fileId);
        return;
      }
      const addItem = ev.target.closest(".rp-tab-add-item");
      if (addItem) { window.reportsShowFile?.(addItem.dataset.fileId); return; }
      const tab = ev.target.closest("[data-file-id]");
      if (tab) window.reportSelectFile?.(tab.dataset.fileId);
    });
  }

  // Switch the Reports view to another project — push the hash so the
  // router re-mounts mountReportsSandbox against the new ?project=.
  window.reportsSelectProject = (pid) => {
    if (!pid || pid === STATE.projectId) return;
    location.hash = `#/reports?project=${encodeURIComponent(pid)}`;
  };

  // Add a dataset — Reports doesn't ingest files, the Cleaner does.
  // Route there scoped to the active project so a fresh upload lands
  // in this project.
  window.reportsAddFile = () => {
    location.hash = STATE.projectId
      ? `#/cleaner?project=${encodeURIComponent(STATE.projectId)}`
      : "#/cleaner";
  };

  // ×/+ on the tab strips — hide a tab into a session-scoped set, or
  // show a hidden one back. The active project / dataset is never
  // hideable (its × isn't rendered), so a hidden tab is always non-active.
  window.reportsHideProject = (pid) => {
    if (!pid || pid === STATE.projectId) return;
    STATE.hiddenProjects.add(pid);
    _renderReportsProjectTabs(root);
  };
  window.reportsShowProject = (pid) => {
    if (!pid) return;
    STATE.hiddenProjects.delete(pid);
    window.reportsSelectProject?.(pid);   // unhide + jump to it
  };
  window.reportsHideFile = (fid) => {
    if (!fid || fid === STATE.rid) return;
    STATE.hiddenFiles.add(fid);
    _renderReportsFileTabs(root);
  };
  window.reportsShowFile = (fid) => {
    if (!fid) return;
    STATE.hiddenFiles.delete(fid);
    _renderReportsFileTabs(root);          // tab must exist before selecting
    window.reportSelectFile?.(fid);        // unhide + select
  };

  // ── Chart builder (Charts page rail) ──────────────────────────────
  // The builder edits STATE.charts[_activeChart]; the matching dock card
  // redraws live. Chart type = a family <select> + inline-SVG variant
  // tiles — there are no modifier checkboxes, every variant is a tile.

  // Paint the family's variant tiles into [data-nc-variants], the active
  // variant marked. Single-variant families render no tiles.
  const _renderVariantTiles = (familyKey, activeVariantId) => {
    const box = root.querySelector("[data-nc-variants]");
    if (!box) return;
    const fam = _CHART_FAMILIES.find((f) => f.key === familyKey);
    box.innerHTML = (fam?.variants ?? []).map((v) =>
      `<button class="rp-chart-variant${v.id === activeVariantId ? " is-active" : ""}" type="button" data-nc-variant="${v.id}" title="${_attrEsc(v.label)}">${v.g}<span class="rp-chart-variant-lbl">${_htmlEsc(v.label)}</span></button>`
    ).join("");
  };

  // Data-binding fields — kind + modifiers come from the variant tiles.
  const _builderFields = () => [...root.querySelectorAll(
    "#nc-x,#nc-ygroup,#nc-y,#nc-agg,#nc-regression,#nc-symbol")];

  // Load STATE.charts[idx] into the builder, mark it active, repaint.
  const _builderLoad = (idx) => {
    _activeChart = idx;
    const cfg = STATE.charts[idx] ?? {};
    // A card in is-active mode always carries a Title + Description —
    // seed basic defaults the user can keep or overwrite, so the foot
    // fields are never blank and Save never has to prompt.
    if (STATE.charts[idx]) {
      if (!cfg.title)       cfg.title       = _defaultChartTitle();
      if (!cfg.description) cfg.description = _autoChartDesc(cfg);
    }
    const $ = (s) => root.querySelector(s);
    const famKey = _familyOf(cfg);
    if ($("#nc-family")) $("#nc-family").value = famKey;
    _renderVariantTiles(famKey, _variantOf(cfg));
    _fillChartPicker($("[data-reports-x-picker]"),      false, cfg.group_by);
    _fillChartPicker($("[data-reports-ygroup-picker]"), false, cfg.y_group_by);
    _fillChartPicker($("[data-reports-y-picker]"),      true,  cfg.agg_col);
    if ($("#nc-agg"))        $("#nc-agg").value        = cfg.agg_fn ?? "count";
    if ($("#nc-regression")) $("#nc-regression").value = cfg.regression ?? "";
    if ($("#nc-symbol"))     $("#nc-symbol").value     = cfg.symbol ?? "circle";
    if ($("#nc-title"))      $("#nc-title").value      = cfg.title ?? "";
    if ($("#nc-desc"))       $("#nc-desc").value       = cfg.description ?? "";
    _syncChartConditionals(root);
    const ttl = root.querySelector("[data-builder-ttl]");
    if (ttl) ttl.textContent = cfg.title?.trim() || "New chart";
    _renderReportsCharts(root).catch(() => {});
  };

  // Apply a variant's kind + modifiers to the active chart. Every
  // modifier is reset first so switching variant leaves none stale.
  const _applyVariant = (variantId) => {
    if (_activeChart < 0) return;
    let spec = null;
    for (const f of _CHART_FAMILIES) {
      const v = f.variants.find((x) => x.id === variantId);
      if (v) { spec = v.spec; break; }
    }
    if (!spec) return;
    const reset = { smooth: false, donut: false, half: false, rose: false, symbol_repeat: false };
    STATE.charts[_activeChart] = { ...STATE.charts[_activeChart], ...reset, ...spec };
    _builderLoad(_activeChart);
  };

  // Family <select> → the family's first variant (or, for a single-
  // variant family, just its kind).
  const _pickFamily = (familyKey) => {
    if (_activeChart < 0) return;
    const fam = _CHART_FAMILIES.find((f) => f.key === familyKey);
    if (!fam) return;
    if (fam.variants.length) { _applyVariant(fam.variants[0].id); return; }
    const reset = { smooth: false, donut: false, half: false, rose: false, symbol_repeat: false };
    STATE.charts[_activeChart] = { ...STATE.charts[_activeChart], ...reset, kind: fam.key };
    _builderLoad(_activeChart);
  };

  // Form edit → merge the data fields into the active chart (kind +
  // modifiers stay — the variant owns them), debounce a re-preview.
  let _previewT = null;
  const _builderChanged = () => {
    if (_activeChart < 0 || _activeChart >= STATE.charts.length) return;
    STATE.charts[_activeChart] = { ...STATE.charts[_activeChart], ..._chartFormToSpec(root) };
    clearTimeout(_previewT);
    _previewT = setTimeout(() => _renderReportsCharts(root).catch(() => {}), 220);
  };
  _builderFields().forEach((el) => {
    if (el.__rpReportsBound) return;
    el.__rpReportsBound = true;
    el.addEventListener("change", _builderChanged);
  });
  const _ncFamily = root.querySelector("#nc-family");
  if (_ncFamily && !_ncFamily.__rpReportsBound) {
    _ncFamily.__rpReportsBound = true;
    _ncFamily.addEventListener("change", () => _pickFamily(_ncFamily.value));
  }
  const _ncVariants = root.querySelector("[data-nc-variants]");
  if (_ncVariants && !_ncVariants.__rpReportsBound) {
    _ncVariants.__rpReportsBound = true;
    _ncVariants.addEventListener("click", (ev) => {
      const t = ev.target.closest("[data-nc-variant]");
      if (t) _applyVariant(t.dataset.ncVariant);
    });
  }

  // Start a fresh draft chart + jump the deck to the Charts page.
  window.reportsNewChart = () => {
    STATE.charts.push({ kind: "bar", group_by: "", agg_col: "*", agg_fn: "count" });
    _builderLoad(STATE.charts.length - 1);
    root.querySelector('[data-reports-page="charts"]')
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
  };
  const _ncNew = root.querySelector("[data-nc-new]");
  if (_ncNew && !_ncNew.__rpReportsBound) {
    _ncNew.__rpReportsBound = true;
    _ncNew.addEventListener("click", () => window.reportsNewChart());
  }

  // ── Save / download / delete ──────────────────────────────────────
  // Each acts on a chart by index. The foot's master buttons pass the
  // active chart; the per-card header buttons pass that card's index.

  // Commit title + description onto a chart, flag it saved, and persist it
  // to localStorage (survives reload, available to the Dashboard page).
  // For the active card the foot fields are the live source of truth; an
  // inactive card uses its already-assigned values. Blank → auto-named.
  const _saveChart = (i) => {
    const c = STATE.charts[i];
    if (!c) { toast.error("No chart to save."); return; }
    let title = c.title, desc = c.description;
    if (i === _activeChart) {
      title = root.querySelector("#nc-title")?.value.trim() || title;
      desc  = root.querySelector("#nc-desc")?.value.trim()  || desc;
    }
    c.title       = title || _defaultChartTitle();
    c.description = desc  || _autoChartDesc(c);
    c._saved      = true;
    if (!c.id) c.id = _mkChartId();
    c.source_file_id = STATE.rid;
    c.saved_at = new Date().toISOString();
    const svg = root.querySelector(`[data-chart-host][data-chart-i="${i}"] svg`);
    if (svg) c.svg = svg.outerHTML;       // SVG snapshot for thumbnails
    _persistSavedCharts();
    if (i === _activeChart) _builderLoad(i);   // refresh fields + repaint
    else _renderReportsCharts(root).catch(() => {});
    toast.success(`Saved "${c.title}".`);
  };

  // Download a chart as a standalone HTML report — its rendered ECharts
  // SVG wrapped with the title + description, theme tokens inlined so the
  // file reads correctly on its own. Filename = slugged title.
  const _downloadChart = (i) => {
    const c = STATE.charts[i];
    if (!c) return;
    const host = root.querySelector(`[data-chart-host][data-chart-i="${i}"]`);
    const svg  = host?.querySelector("svg");
    if (!svg) { toast.error("Render the chart before downloading."); return; }
    const title = c.title || _defaultChartTitle();
    const html  = _chartReportHtml(title, c.description || "", svg.outerHTML);
    const url   = URL.createObjectURL(new Blob([html], { type: "text/html" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `${_slug(title)}.html`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    toast.success(`Downloaded ${_slug(title)}.html`);
  };

  // Drop a chart. A saved chart is also removed from localStorage. Keeps
  // _activeChart on a valid card; re-seeds a draft if the dock empties.
  const _deleteChart = (i) => {
    if (i < 0 || i >= STATE.charts.length) return;
    const wasSaved = !!STATE.charts[i]?._saved;
    STATE.charts.splice(i, 1);
    if (_activeChart === i) _activeChart = -1;
    else if (_activeChart > i) _activeChart -= 1;
    if (wasSaved) _persistSavedCharts();
    if (!STATE.charts.length) {
      STATE.charts.push({ kind: "bar", group_by: "", agg_col: "*", agg_fn: "count" });
    }
    const next = _activeChart >= 0
      ? _activeChart
      : Math.min(i, STATE.charts.length - 1);
    _builderLoad(next);
  };

  // Footer master buttons — Save / Download / Delete act on the active chart.
  const _ncSave = root.querySelector("[data-nc-save]");
  if (_ncSave && !_ncSave.__rpReportsBound) {
    _ncSave.__rpReportsBound = true;
    _ncSave.addEventListener("click", () => {
      if (_activeChart < 0) { toast.error("Build a chart first."); return; }
      _saveChart(_activeChart);
    });
  }
  const _ncDownload = root.querySelector("[data-nc-download]");
  if (_ncDownload && !_ncDownload.__rpReportsBound) {
    _ncDownload.__rpReportsBound = true;
    _ncDownload.addEventListener("click", () => {
      if (_activeChart < 0) { toast.error("Build a chart first."); return; }
      _downloadChart(_activeChart);
    });
  }
  const _ncDelete = root.querySelector("[data-nc-delete]");
  if (_ncDelete && !_ncDelete.__rpReportsBound) {
    _ncDelete.__rpReportsBound = true;
    _ncDelete.addEventListener("click", () => {
      if (_activeChart < 0) { toast.error("No chart to delete."); return; }
      _deleteChart(_activeChart);
    });
  }

  // Dock card → the header buttons save / download / remove that specific
  // chart; a bare card click loads it into the builder.
  const _chartGrid = root.querySelector("[data-reports-chart-grid]");
  if (_chartGrid && !_chartGrid.__rpReportsBound) {
    _chartGrid.__rpReportsBound = true;
    _chartGrid.addEventListener("click", (ev) => {
      const rm = ev.target.closest("[data-chart-remove]");
      if (rm) { _deleteChart(Number(rm.dataset.chartRemove)); return; }
      const sv = ev.target.closest("[data-chart-save]");
      if (sv) { _saveChart(Number(sv.dataset.chartSave)); return; }
      const dl = ev.target.closest("[data-chart-download]");
      if (dl) { _downloadChart(Number(dl.dataset.chartDownload)); return; }
      const card = ev.target.closest("[data-chart-card]");
      if (card) _builderLoad(Number(card.dataset.chartCard));
    });
  }

  // Report Tools panel — add / remove grouping + summarize rows.
  // Delegated so it survives the section innerHTML; once-guarded.
  const _toolsPanel = root.querySelector("#reports-tools-panel");
  if (_toolsPanel && !_toolsPanel.__rpReportsBound) {
    _toolsPanel.__rpReportsBound = true;
    _toolsPanel.addEventListener("click", (ev) => {
      const add = ev.target.closest("[data-reports-add]");
      if (add) {
        if (add.dataset.reportsAdd === "group")        _addGroupRow(root);
        else if (add.dataset.reportsAdd === "summary") _addAggRow(root);
        return;
      }
      const rm = ev.target.closest(".rp-rt-tool-rm");
      if (rm) {
        const row = rm.closest(".rp-rt-tool-row, .rp-rt-tool-agg");
        const box = row?.parentElement;
        if (row && box && box.children.length > 1) {
          row.remove();
          _paintReportsTable(root);
        }
      }
    });
    // Any grouping / summarize / display change → re-render the table.
    _toolsPanel.addEventListener("change", () => { _paintReportsTable(root); });
  }

  // Expose the builder loader so mountReportsSandbox can re-point it at a
  // chart after the project-scoped localStorage restore.
  _reportsBuilderLoad = _builderLoad;

  // Ensure the builder always has a chart to edit.
  if (!STATE.charts.length) {
    STATE.charts.push({ kind: "bar", group_by: "", agg_col: "*", agg_fn: "count" });
  }
  _builderLoad(_activeChart >= 0 && _activeChart < STATE.charts.length ? _activeChart : 0);
}

// ─────────────────────────── paint pipeline ───────────────────────────

async function _paintReportsTable(root) {
  if (!STATE.rid) {
    _renderReportsEmptyState(root, "Pick a source file from the toolbar.");
    return;
  }

  // Report Tools grouping configured → grouped report, not the raw page.
  if (_reportGroupingActive(root)) {
    await _paintGroupedReport(root);
    return;
  }

  const tableWrap = root.querySelector("[data-reports-table]");
  if (tableWrap) tableWrap.setAttribute("aria-busy", "true");

  // First paint per file → also fetch /files/:rid to harvest columns +
  // refreshed summary. Subsequent paints (sort / page / search) only need
  // /page. STATE.columns being empty is the cache-miss signal.
  const needColumns = STATE.columns.length === 0;
  const qs = new URLSearchParams();
  qs.set("page", String(STATE.page));
  qs.set("size", String(STATE.pageSize));
  if (STATE.search)        qs.set("q",     STATE.search);
  if (STATE.sorts.length)  qs.set("sorts", JSON.stringify(STATE.sorts));

  let envRes, pageRes;
  try {
    const pagePromise = api.get(`/files/${encodeURIComponent(STATE.rid)}/page?${qs}`);
    if (needColumns) {
      [envRes, pageRes] = await Promise.all([
        api.get(`/files/${encodeURIComponent(STATE.rid)}`),
        pagePromise,
      ]);
    } else {
      pageRes = await pagePromise;
    }
  } catch (err) {
    console.error("[reports] page fetch failed", err);
    _renderReportsEmptyState(root, `Couldn't load rows: ${err.body?.error ?? err.message ?? err}`);
    return;
  } finally {
    if (tableWrap) tableWrap.removeAttribute("aria-busy");
  }

  if (envRes) {
    STATE.columns = envRes.columns ?? [];
    // Mirror summary in BOTH STATE.summary AND the matching STATE.files[i]
    // — drift between the two has burnt the cleaner more than once (see
    // sandbox-integration.md "STATE.summary and STATE.files[idx] can
    // drift").
    if (envRes.summary) {
      STATE.summary = envRes.summary;
      const idx = STATE.files.findIndex((f) => f.redpash_id === STATE.rid);
      if (idx >= 0) STATE.files[idx] = envRes.summary;
    }
    _renderReportsHeader(root);
    _renderReportsColumnsPicker(root);
  }

  _renderReportsRows(root, pageRes);
  _renderReportsPaging(root, pageRes);
}

// ─────────────────────────── renderers ────────────────────────────────

// Project strip — one tab per visible project; the active project
// carries .active and has no × (you can't hide what you're viewing).
// × hides a tab into STATE.hiddenProjects; the trailing + opens a menu
// of hidden ones. Delegated click handling lives in _installReportsLiveHandlers.
function _renderReportsProjectTabs(root) {
  const strip = root.querySelector("[data-reports-proj-tabs]");
  if (!strip) return;
  const visible = STATE.projects.filter(
    (p) => p.redpash_id === STATE.projectId || !STATE.hiddenProjects.has(p.redpash_id));
  const hidden = STATE.projects.filter(
    (p) => p.redpash_id !== STATE.projectId && STATE.hiddenProjects.has(p.redpash_id));
  const tabs = visible.map((p) => {
    const id     = p.redpash_id;
    const name   = p.name || id;
    const active = id === STATE.projectId;
    const x = active ? ""
      : `<span class="rp-rt-proj-tab-x" title="Hide tab"><i class="bi bi-x"></i></span>`;
    return `<button class="rp-rt-proj-tab${active ? " active" : ""}" type="button" data-project-id="${_attrEsc(id)}" title="${_attrEsc(name)}">
      <i class="bi bi-folder2-open"></i>
      <span class="rp-rt-proj-tab-name">${_htmlEsc(name)}</span>
      ${x}
    </button>`;
  }).join("");
  strip.innerHTML = tabs + _renderTabAddWrap(hidden, "Hidden projects", "project");
}

// Source-file strip — one tab per visible CSV dataset; the selected
// dataset (STATE.rid) carries .active and has no ×. Same ×/+ model as
// the project strip. This strip IS the source-file selector.
function _renderReportsFileTabs(root) {
  const strip = root.querySelector("[data-reports-file-tabs]");
  if (!strip) return;
  const visible = STATE.files.filter(
    (f) => f.redpash_id === STATE.rid || !STATE.hiddenFiles.has(f.redpash_id));
  const hidden = STATE.files.filter(
    (f) => f.redpash_id !== STATE.rid && STATE.hiddenFiles.has(f.redpash_id));
  const tabs = visible.map((f) => {
    const id     = f.redpash_id;
    const name   = f.display_name || f.filename;
    const active = id === STATE.rid;
    const x = active ? ""
      : `<span class="rp-rtp-tab-x" title="Hide tab"><i class="bi bi-x"></i></span>`;
    return `<button class="rp-rtp-tab${active ? " active" : ""}" type="button" data-file-id="${_attrEsc(id)}" title="${_attrEsc(name)}">
      <i class="bi bi-file-earmark-text"></i>
      <span class="rp-rtp-tab-name">${_htmlEsc(name)}</span>
      ${x}
    </button>`;
  }).join("");
  strip.innerHTML = tabs + _renderTabAddWrap(hidden, "Hidden datasets", "file");
}

// The trailing + and its hidden-items dropdown — shared by both strips.
// `kind` ("project" | "file") picks the data-attr the click listener
// reads. Mirrors the objects type-tab add-menu (rp-tab-add-* classes,
// spToggleTabAddMenu for open/close). + is disabled when nothing's hidden.
function _renderTabAddWrap(hiddenItems, header, kind) {
  const attr = kind === "project" ? "data-project-id" : "data-file-id";
  const icon = kind === "project" ? "bi-folder2-open" : "bi-file-earmark-text";
  const items = hiddenItems.length
    ? hiddenItems.map((it) => {
        const name = it.name || it.display_name || it.filename || it.redpash_id;
        return `<div class="rp-tab-add-item" ${attr}="${_attrEsc(it.redpash_id)}"><i class="bi ${icon}"></i>${_htmlEsc(name)}</div>`;
      }).join("")
    : `<div class="rp-form-meta" style="padding:0.5rem;font-style:italic">Nothing hidden.</div>`;
  return `<span class="rp-tab-add-wrap">
    <button class="rp-tab-add" type="button" aria-label="Show a hidden tab" title="Show a hidden tab"${
      hiddenItems.length ? ` onclick="spToggleTabAddMenu(this)"` : " disabled"}>
      <i class="bi bi-plus-lg"></i>
    </button>
    <div class="rp-tab-add-menu" role="menu">
      <div class="rp-tab-add-hdr">${_htmlEsc(header)}</div>
      <div class="rp-tab-add-items">${items}</div>
    </div>
  </span>`;
}

// Header — project name, active source-file name, and the dataset-count
// meta line. Called after the project resolves, after files load, and
// after every source-file change.
function _renderReportsHeader(root) {
  const proj = STATE.projects.find((p) => p.redpash_id === STATE.projectId);
  const nm = root.querySelector("[data-reports-proj-name]");
  const fn = root.querySelector("[data-reports-file-name]");
  const mt = root.querySelector("[data-reports-proj-meta]");
  if (nm) nm.textContent = proj?.name || STATE.projectId || "—";
  if (fn) fn.textContent = STATE.summary?.display_name
                        || STATE.summary?.filename
                        || (STATE.rid ?? "No file");
  if (mt) {
    const n = STATE.files.length;
    mt.textContent = n ? `${n} dataset${n === 1 ? "" : "s"}` : "No datasets";
  }
}

function _renderReportsRows(root, page) {
  const tableWrap = root.querySelector("[data-reports-table]");
  if (!tableWrap) return;

  const colNames = STATE.columns.map((c) => c.name);
  if (!colNames.length) {
    tableWrap.innerHTML = `
      <table class="rp-rt-table">
        <thead><tr><th></th></tr></thead>
        <tbody><tr><td style="text-align:center;color:var(--muted);padding:1rem;font-style:italic">No columns to display.</td></tr></tbody>
      </table>`;
    return;
  }

  const sortBy = STATE.sorts[0];
  const thead = `<thead><tr>${colNames.map((c) => {
    const active = sortBy && sortBy.col === c;
    const ico = active
      ? (sortBy.dir === "desc"
          ? '<i class="bi bi-arrow-down rp-rt-sort-ico is-on"></i>'
          : '<i class="bi bi-arrow-up rp-rt-sort-ico is-on"></i>')
      : '<i class="bi bi-arrow-down-up rp-rt-sort-ico"></i>';
    // data-col carries the raw name; click handler attached below — keeps
    // headers with quotes / specials from breaking an inline onclick.
    return `<th class="rp-rt-th-sortable" data-col="${_attrEsc(c)}">${_htmlEsc(c)} ${ico}</th>`;
  }).join("")}</tr></thead>`;

  const rows = page?.rows ?? [];
  const tbody = rows.length === 0
    ? `<tbody><tr><td colspan="${colNames.length}" style="text-align:center;color:var(--muted);padding:1rem;font-style:italic">No rows match.</td></tr></tbody>`
    : `<tbody>${rows.map((r) => `<tr>${
        r.map((v) => v == null
          ? `<td><span class="rp-rt-null">—</span></td>`
          : `<td>${_htmlEsc(String(v))}</td>`
        ).join("")
      }</tr>`).join("")}</tbody>`;

  tableWrap.innerHTML = `<table class="rp-rt-table">${thead}${tbody}</table>`;

  // Wire header clicks for sort. Listeners die with the innerHTML on next
  // paint, so no once-guard needed.
  tableWrap.querySelectorAll("th[data-col]").forEach((th) => {
    th.addEventListener("click", () => window.reportSortBy?.(th.dataset.col));
  });
}

function _renderReportsPaging(root, page) {
  const rowsInfo = root.querySelector("[data-reports-rows-info]");
  const pages    = root.querySelector("[data-reports-pages]");

  if (!page) {
    if (rowsInfo) rowsInfo.textContent = "—";
    if (pages)    pages.innerHTML = "";
    return;
  }

  if (rowsInfo) {
    const start = page.total === 0 ? 0 : ((page.page - 1) * page.size) + 1;
    const end   = Math.min(page.page * page.size, page.total);
    const filt  = (page.all_count != null && page.total !== page.all_count)
      ? ` (filtered from ${page.all_count.toLocaleString()})`
      : "";
    rowsInfo.textContent = `${start.toLocaleString()}–${end.toLocaleString()} of ${page.total.toLocaleString()}${filt}`;
  }

  if (pages) {
    pages.innerHTML = pagerMarkup(page.page, page.pages || 1);
    pages.querySelectorAll("button[data-pg]").forEach((b) => {
      b.addEventListener("click", () => window.reportSetPage?.(Number(b.dataset.pg)));
    });
  }
}

function _renderReportsColumnsPicker(root) {
  const picker = root.querySelector("[data-reports-cols-picker]");
  if (!picker) return;
  const cols = STATE.columns;
  if (!cols.length) return;   // leave the static "No columns." placeholder

  picker.innerHTML = `
    <button type="button" class="rp-dd-reset" title="Restore all columns" onclick="spColsReset(this)">
      <i class="bi bi-arrow-counterclockwise"></i> Reset
    </button>
    ${cols.map((c) => `
      <label class="rp-dd-check">
        <input type="checkbox" checked data-col="${_attrEsc(c.name)}" />
        ${_htmlEsc(c.name)}
      </label>
    `).join("")}`;
  // Column-visibility wiring (route the checkbox state through
  // PageQuery.cols, repaint) is deferred — keeps this pass focused on
  // "source data lands in the table." The checkboxes paint and toggle
  // visually via the existing sandbox handlers.
}

function _renderReportsEmptyState(root, message) {
  const tableWrap = root.querySelector("[data-reports-table]");
  if (tableWrap) {
    tableWrap.innerHTML = `
      <table class="rp-rt-table">
        <thead><tr><th></th></tr></thead>
        <tbody><tr><td style="text-align:center;color:var(--muted);padding:1rem;font-style:italic">${_htmlEsc(message)}</td></tr></tbody>
      </table>`;
  }
  const rowsInfo = root.querySelector("[data-reports-rows-info]");
  if (rowsInfo) rowsInfo.textContent = "—";
  const pages = root.querySelector("[data-reports-pages]");
  if (pages) pages.innerHTML = "";
}

function _syncRowsLabel(root) {
  const lbl = root.querySelector("[data-sp-rows-label]");
  if (!lbl) return;
  lbl.textContent = String(STATE.pageSize);
  // Mark the matching menu item .is-selected so spDdSelectRows's
  // exclusive-selection paint stays in sync on first mount.
  const menu = lbl.closest(".rp-dd-wrap")?.querySelector(".rp-dd-menu");
  if (!menu) return;
  menu.querySelectorAll(".rp-dd-item").forEach((item) => {
    const n = parseInt(item.textContent, 10);
    item.classList.toggle("is-selected", n === STATE.pageSize);
  });
}

// ─────────────────────── mount-snapshot helpers ───────────────────────
// Same recipe as cleaner: snapshot the picker chrome to sessionStorage so
// reload paints the picker label instantly while fetches catch up. Table
// rows aren't snapshotted (too big to serialize, and they go stale fast —
// the partial's "Pick a source file…" placeholder shows until paint).

function _snapshotForMount() {
  try {
    const snap = {
      hashUrl: location.hash,
      rid:     STATE.rid,
      summary: STATE.summary
        ? {
            redpash_id:   STATE.summary.redpash_id,
            filename:     STATE.summary.filename,
            display_name: STATE.summary.display_name,
          }
        : null,
      pageSize: STATE.pageSize,
    };
    sessionStorage.setItem(SNAPSHOT_KEY, JSON.stringify(snap));
  } catch { /* sessionStorage full / disabled — non-fatal */ }
}

function _restoreFromSnapshot(root) {
  let snap;
  try { snap = JSON.parse(sessionStorage.getItem(SNAPSHOT_KEY) || "null"); }
  catch { return; }
  // URL guard — restore only when the user landed back on the same hash
  // (same file). Different URL = different file → don't paint stale.
  if (!snap || snap.hashUrl !== location.hash) return;

  const fn = root.querySelector("[data-reports-file-name]");
  if (fn && snap.summary) {
    fn.textContent = snap.summary.display_name || snap.summary.filename;
  }
  if (Number.isFinite(snap.pageSize)) {
    STATE.pageSize = snap.pageSize;
    _syncRowsLabel(root);
  }
}

// ─────────────────────────── page deck ────────────────────────────────
// Two full-bleed pages (Data / Charts) on a vertical scroll-snap deck.
// The page-dots jump between them; the active dot tracks scroll position.
function _wireReportsDeck(root) {
  const deck = root.querySelector("[data-reports-deck]");
  if (!deck || deck.__rpReportsBound) return;
  deck.__rpReportsBound = true;
  const dots  = [...root.querySelectorAll("[data-reports-dot]")];
  const pages = [...deck.querySelectorAll("[data-reports-page]")];

  // Dot click → snap-scroll the deck to that page.
  dots.forEach((dot) => {
    dot.addEventListener("click", () => {
      deck.querySelector(`[data-reports-page="${dot.dataset.reportsDot}"]`)
        ?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  });

  // Scroll position → active dot: whichever page is ≥50% in view wins.
  if ("IntersectionObserver" in window) {
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting || e.intersectionRatio < 0.5) continue;
        const key = e.target.dataset.reportsPage;
        dots.forEach((d) => d.classList.toggle("is-active", d.dataset.reportsDot === key));
      }
    }, { root: deck, threshold: [0.5] });
    pages.forEach((p) => io.observe(p));
  }
}

// ─────────────────────────── tiny helpers ─────────────────────────────

function _htmlEsc(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
function _attrEsc(s) {
  // Same as html, plus apostrophe (we use double-quoted attrs but data-
  // attrs occasionally land inside single-quoted innerHTML strings).
  return _htmlEsc(s).replace(/'/g, "&#39;");
}

// ─────────────────────────── chart dock ───────────────────────────────
// Reuses scripts/dashboards/chart-render.js — the same engine the
// dashboard chart-ref widgets use. Each ChartSpec runs its own
// /reports/preview against the active source file.

const _CHART_ICONS = {
  bar: "bi-bar-chart-fill", bar_horizontal: "bi-bar-chart-steps",
  line: "bi-graph-up", area: "bi-graph-up-arrow", pie: "bi-pie-chart-fill",
  funnel: "bi-funnel-fill", gauge: "bi-speedometer2", pictorial_bar: "bi-bar-chart",
  scatter: "bi-asterisk", heatmap: "bi-grid-3x3-gap-fill", radar: "bi-pentagon",
  boxplot: "bi-box", calendar: "bi-calendar3", matrix: "bi-grid-3x3",
};
function _chartIcon(kind) { return _CHART_ICONS[kind] || "bi-bar-chart-fill"; }

// Per-card state markup — icon + line. Used for empty / no-data / error
// states inside a chart canvas host.
function _chartMsg(icon, text) {
  return `<div class="rp-reports__chart-msg"><i class="bi ${icon}"></i><span>${_htmlEsc(text)}</span></div>`;
}

// Builder chart families. Multi-variant families expose a row of inline-SVG
// variant tiles; single-variant families are picked by the family <select>
// alone. Each variant commits a kind (+ modifiers) to the active chart —
// there are no modifier checkboxes. `g` is a glyph (viewBox 0 0 40 26,
// currentColor) drawn in the hero-steps style.
const _CHART_FAMILIES = [
  { key: "bar", label: "Bar", variants: [
    { id: "bar", label: "Bar", spec: { kind: "bar" },
      g: `<svg viewBox="0 0 40 26"><g fill="currentColor"><rect x="3" y="13" width="6" height="11" rx="1"/><rect x="12" y="6" width="6" height="18" rx="1"/><rect x="21" y="10" width="6" height="14" rx="1"/><rect x="30" y="3" width="6" height="21" rx="1"/></g></svg>` },
    { id: "bar_horizontal", label: "Horizontal", spec: { kind: "bar_horizontal" },
      g: `<svg viewBox="0 0 40 26"><g fill="currentColor"><rect x="3" y="3" width="22" height="5" rx="1"/><rect x="3" y="11" width="33" height="5" rx="1"/><rect x="3" y="19" width="14" height="5" rx="1"/></g></svg>` },
  ]},
  { key: "line", label: "Line", variants: [
    { id: "line", label: "Basic", spec: { kind: "line" },
      g: `<svg viewBox="0 0 40 26"><polyline points="3,21 13,9 22,15 31,5 37,11" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>` },
    { id: "line_smooth", label: "Smooth", spec: { kind: "line", smooth: true },
      g: `<svg viewBox="0 0 40 26"><path d="M3 20 Q 12 4 20 13 T 37 9" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>` },
  ]},
  { key: "area", label: "Area", variants: [
    { id: "area", label: "Basic", spec: { kind: "area" },
      g: `<svg viewBox="0 0 40 26"><path d="M3 21 L13 9 L22 15 L31 5 L37 11 L37 24 L3 24 Z" fill="currentColor" opacity="0.28"/><polyline points="3,21 13,9 22,15 31,5 37,11" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>` },
    { id: "area_smooth", label: "Smooth", spec: { kind: "area", smooth: true },
      g: `<svg viewBox="0 0 40 26"><path d="M3 20 Q 12 4 20 13 T 37 9 L37 24 L3 24 Z" fill="currentColor" opacity="0.28"/><path d="M3 20 Q 12 4 20 13 T 37 9" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>` },
  ]},
  { key: "pie", label: "Pie", variants: [
    { id: "pie", label: "Pie", spec: { kind: "pie" },
      g: `<svg viewBox="0 0 40 26"><circle cx="20" cy="13" r="11" fill="currentColor" opacity="0.28"/><path d="M20 13 L20 2 A11 11 0 0 1 31 13 Z" fill="currentColor"/></svg>` },
    { id: "donut", label: "Donut", spec: { kind: "pie", donut: true },
      g: `<svg viewBox="0 0 40 26"><circle cx="20" cy="13" r="9" fill="none" stroke="currentColor" stroke-width="5" opacity="0.28"/><path d="M20 4 A9 9 0 0 1 29 13" fill="none" stroke="currentColor" stroke-width="5"/></svg>` },
    { id: "half_donut", label: "Half-donut", spec: { kind: "pie", donut: true, half: true },
      g: `<svg viewBox="0 0 40 26"><path d="M5 20 A11 11 0 0 1 35 20" fill="none" stroke="currentColor" stroke-width="5" opacity="0.28"/><path d="M5 20 A11 11 0 0 1 20 9" fill="none" stroke="currentColor" stroke-width="5"/></svg>` },
    { id: "rose", label: "Rose", spec: { kind: "pie", rose: true },
      g: `<svg viewBox="0 0 40 26"><g fill="currentColor"><ellipse cx="20" cy="7" rx="3" ry="6"/><ellipse cx="20" cy="19" rx="3" ry="6" opacity="0.55"/><ellipse cx="13" cy="13" rx="6" ry="3" opacity="0.7"/><ellipse cx="27" cy="13" rx="6" ry="3" opacity="0.4"/></g></svg>` },
  ]},
  { key: "pictorial_bar", label: "Pictorial", variants: [
    { id: "pictorial", label: "Standard", spec: { kind: "pictorial_bar" },
      g: `<svg viewBox="0 0 40 26"><g fill="currentColor"><circle cx="9" cy="20" r="3"/><circle cx="9" cy="13" r="3"/><circle cx="20" cy="20" r="3"/><circle cx="20" cy="13" r="3"/><circle cx="20" cy="6" r="3"/><circle cx="31" cy="20" r="3"/></g></svg>` },
    { id: "pictorial_tiled", label: "Tiled", spec: { kind: "pictorial_bar", symbol_repeat: true },
      g: `<svg viewBox="0 0 40 26"><g fill="currentColor"><rect x="6" y="17" width="6" height="3" rx="1.5"/><rect x="6" y="12" width="6" height="3" rx="1.5"/><rect x="17" y="20" width="6" height="3" rx="1.5"/><rect x="17" y="15" width="6" height="3" rx="1.5"/><rect x="17" y="10" width="6" height="3" rx="1.5"/><rect x="17" y="5" width="6" height="3" rx="1.5"/><rect x="28" y="17" width="6" height="3" rx="1.5"/><rect x="28" y="12" width="6" height="3" rx="1.5"/></g></svg>` },
  ]},
  { key: "scatter",  label: "Scatter",  variants: [] },
  { key: "heatmap",  label: "Heatmap",  variants: [] },
  { key: "matrix",   label: "Matrix",   variants: [] },
  { key: "radar",    label: "Radar",    variants: [] },
  { key: "boxplot",  label: "Box plot", variants: [] },
  { key: "calendar", label: "Calendar", variants: [] },
  { key: "funnel",   label: "Funnel",   variants: [] },
  { key: "gauge",    label: "Gauge",    variants: [] },
];

// Which family <select> key a chart spec belongs to.
function _familyOf(spec) {
  return spec?.kind === "bar_horizontal" ? "bar" : (spec?.kind || "bar");
}
// Which variant id within its family a chart spec resolves to.
function _variantOf(s) {
  if (!s) return "bar";
  if (s.kind === "bar")  return "bar";
  if (s.kind === "bar_horizontal") return "bar_horizontal";
  if (s.kind === "line") return s.smooth ? "line_smooth" : "line";
  if (s.kind === "area") return s.smooth ? "area_smooth" : "area";
  if (s.kind === "pie")  return s.half ? "half_donut" : s.donut ? "donut" : s.rose ? "rose" : "pie";
  if (s.kind === "pictorial_bar") return s.symbol_repeat ? "pictorial_tiled" : "pictorial";
  return s.kind;
}

// Sequential fallback name for an untitled chart — chart-001, chart-002…
// The counter only advances on a real assignment, so numbers never repeat.
function _defaultChartTitle() {
  return `chart-${String(++_chartSeq).padStart(3, "0")}`;
}

// A plain-language description from the spec — seeds the Description field
// so a card in is-active mode is never blank.
function _autoChartDesc(cfg) {
  const fam  = _CHART_FAMILIES.find((f) => f.key === _familyOf(cfg));
  const kind = fam?.label || cfg.kind || "Chart";
  return cfg.group_by ? `${kind} by ${cfg.group_by}` : `${kind} chart`;
}

// Filesystem-safe slug for a download filename.
function _slug(s) {
  return String(s).toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "chart";
}

// Wrap a rendered ECharts SVG into a standalone HTML report — title +
// description + the chart. The live theme tokens are read off :root and
// inlined so the downloaded file reads correctly on its own, in whatever
// theme the chart was rendered under.
function _chartReportHtml(title, desc, svgMarkup) {
  const cs = getComputedStyle(document.documentElement);
  const v  = (n, fb) => (cs.getPropertyValue(n).trim() || fb);
  const t  = {
    text:    v("--rp-text", "#1a1a1f"),
    muted:   v("--rp-text-muted", "#5f5f6b"),
    surface: v("--rp-surface", "#ffffff"),
    border:  v("--rp-border", "#e3e3e8"),
    bg:      v("--rp-bg", v("--rp-surface", "#f4f4f6")),
  };
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${_htmlEsc(title)}</title>
<style>
  body { margin: 0; padding: 2.5rem 1.5rem; display: flex; justify-content: center;
    font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
    background: ${t.bg}; color: ${t.text}; }
  .rp-report { width: 100%; max-width: 52rem; }
  .rp-report h1 { font-size: 1.25rem; font-weight: 600; margin: 0 0 0.25rem; }
  .rp-report .desc { margin: 0 0 1.5rem; color: ${t.muted}; }
  .rp-report__chart { background: ${t.surface}; border: 1px solid ${t.border};
    border-radius: 0.625rem; padding: 1rem; display: flex; justify-content: center; }
  .rp-report__chart svg { max-width: 100%; height: auto; }
  .rp-report footer { margin-top: 1.25rem; font-size: 0.75rem; color: ${t.muted}; }
</style>
</head>
<body>
  <div class="rp-report">
    <h1>${_htmlEsc(title)}</h1>
    ${desc ? `<p class="desc">${_htmlEsc(desc)}</p>` : ""}
    <div class="rp-report__chart">${svgMarkup}</div>
    <footer>Generated by RedPash</footer>
  </div>
</body>
</html>`;
}

// ── Saved-chart persistence (localStorage stopgap) ─────────────────────
// A saved chart is written to localStorage so it survives a reload and
// can be read by the Dashboard page. Each entry carries its spec, title,
// description, an SVG snapshot, and project / source-file ids. Backend
// FIL_ File persistence is the eventual replacement.

function _mkChartId() {
  return "CHT_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function _readSavedStore() {
  try {
    const v = JSON.parse(localStorage.getItem(SAVED_CHARTS_KEY) || "[]");
    return Array.isArray(v) ? v : [];
  } catch { return []; }
}

// Saved charts for one project, flagged _saved so the dock paints them
// as committed.
function _loadSavedCharts(projectId) {
  return _readSavedStore()
    .filter((c) => c && c.project_id === projectId)
    .map((c) => ({ ...c, _saved: true }));
}

// Rewrite this project's saved charts from STATE.charts; other projects'
// entries in the store are left untouched.
function _persistSavedCharts() {
  const others = _readSavedStore().filter((c) => c && c.project_id !== STATE.projectId);
  const mine = STATE.charts
    .filter((c) => c && c._saved)
    .map((c) => ({ ...c, project_id: STATE.projectId }));
  try {
    localStorage.setItem(SAVED_CHARTS_KEY, JSON.stringify([...others, ...mine]));
  } catch (err) {
    console.warn("[reports] couldn't persist saved charts", err);
  }
}

// Paint one card per STATE.charts entry into the chart-dock grid, then
// fetch + mount each chart's ECharts instance.
async function _renderReportsCharts(root) {
  const grid  = root.querySelector("[data-reports-chart-grid]");
  const empty = root.querySelector("[data-reports-chart-empty]");
  if (!grid) return;

  // Dispose any live ECharts instances before the innerHTML rebuild.
  grid.querySelectorAll("[data-chart-host]").forEach((h) => h._rpDispose?.());

  if (empty) empty.hidden = STATE.charts.length > 0;
  if (!STATE.charts.length) { grid.innerHTML = ""; return; }

  grid.innerHTML = STATE.charts.map((cfg, i) => {
    const ttl  = cfg.title?.trim() || cfg.group_by || cfg.kind || "Chart";
    const meta = [cfg.kind, cfg.group_by,
                  cfg.agg_col && cfg.agg_col !== "*" ? cfg.agg_col : null]
      .filter(Boolean).map(_htmlEsc).join(" · ");
    const flag = cfg._saved
      ? `<i class="bi bi-floppy-fill" title="Saved" style="margin-left:auto;color:var(--green);font-size:0.6875rem"></i>`
      : `<span style="margin-left:auto;font-size:0.625rem;color:var(--muted)">draft</span>`;
    return `<article class="rp-reports__chart-card${i === _activeChart ? " is-active" : ""}" data-chart-card="${i}">
      <header class="rp-reports__chart-hdr">
        <i class="bi ${_chartIcon(cfg.kind)}"></i>
        <span class="rp-reports__chart-ttl">${_htmlEsc(ttl)}</span>
        <span class="rp-reports__chart-meta">${meta}</span>
        ${flag}
        <button class="rp-btn rp-btn-xs" title="Save report" data-chart-save="${i}"><i class="bi bi-floppy"></i></button>
        <button class="rp-btn rp-btn-xs" title="Download as HTML" data-chart-download="${i}"><i class="bi bi-download"></i></button>
        <button class="rp-btn rp-btn-xs" title="Remove chart" data-chart-remove="${i}"><i class="bi bi-x"></i></button>
      </header>
      <div class="rp-reports__chart-body">
        <div class="rp-reports__chart-canvas" data-chart-host data-chart-i="${i}">
          <div class="rp-reports__chart-loading">
            <div class="rp-reports__chart-spinner"></div><span>Loading</span>
          </div>
        </div>
      </div>
    </article>`;
  }).join("");

  if (!STATE.rid) {
    grid.querySelectorAll("[data-chart-host]").forEach((h) => {
      h.innerHTML = _chartMsg("bi-file-earmark-text", "Pick a source file to preview.");
    });
    return;
  }
  let echarts;
  try {
    echarts = await loadECharts();
  } catch {
    grid.querySelectorAll("[data-chart-host]").forEach((h) => {
      h.innerHTML = _chartMsg("bi-wifi-off", "Couldn't load the chart library.");
    });
    return;
  }
  STATE.charts.forEach(async (cfg, i) => {
    const host = grid.querySelector(`[data-chart-host][data-chart-i="${i}"]`);
    if (!host) return;
    if (!cfg.group_by && cfg.kind !== "gauge") {
      host.innerHTML = _chartMsg("bi-sliders", "Pick a group-by column to draw this chart.");
      return;
    }
    let res;
    try {
      res = await api.post("/reports/preview",
        chartPreviewBody(cfg.source_file_id || STATE.rid, cfg, null));
    } catch (err) {
      host.innerHTML = _chartMsg("bi-exclamation-triangle",
        err.body?.error ?? err.message ?? String(err));
      return;
    }
    await _mountChart(echarts, host, cfg, res);
  });
}

// Dispatch a /reports/preview payload to the right chart-render.js
// extractor + option builder, then init ECharts into `host`.
async function _mountChart(echarts, host, cfg, res) {
  let opt = null;
  if (cfg.kind === "heatmap") {
    const hm = subtotalsToHeatmap(res.subtotals);
    if (hm.data.length) opt = chartOptionHeatmap(cfg, hm.xValues, hm.yValues, hm.data);
  } else if (cfg.kind === "radar") {
    const rd = subtotalsToRadar(res.subtotals);
    if (rd.series.length && rd.indicators.length) opt = chartOptionRadar(cfg, rd.indicators, rd.series);
  } else if (cfg.kind === "boxplot") {
    const bp = subtotalsToBoxplot(res.subtotals);
    if (bp.data.length) opt = chartOptionBoxplot(cfg, bp.labels, bp.data);
  } else if (cfg.kind === "calendar") {
    const cal = subtotalsToCalendar(res.subtotals);
    if (cal.length) opt = chartOptionCalendar(cfg, cal);
  } else if (cfg.kind === "matrix") {
    const m = subtotalsToMatrix(res.subtotals);
    if (m.data.length) opt = chartOptionMatrix(cfg, m.xValues, m.yValues, m.data);
  } else {
    const { labels, values } =
      cfg.kind === "scatter" ? detailsToScatterSeries(res.details, cfg.group_by, cfg.agg_col) :
      cfg.kind === "gauge"   ? subtotalsToScalar(res.subtotals, cfg.title?.trim() || cfg.agg_col || "") :
                               subtotalsToSeries(res.subtotals);
    if (labels.length) {
      opt = chartOption(cfg, labels, values);
      if (cfg.kind === "scatter") await withRegression(opt, cfg, labels, values, loadECStat);
    }
  }
  if (!opt) {
    host.innerHTML = _chartMsg("bi-inbox", "No data for this selection.");
    return;
  }
  host.innerHTML = "";
  const inst = echarts.init(host, "redpash", { renderer: "svg" });
  inst.setOption(opt);
  const ro = new ResizeObserver(() => inst.resize());
  ro.observe(host);
  host._rpDispose = () => { ro.disconnect(); inst.dispose(); };
}

// Fill a column <select> from STATE.columns. `withRowCount` adds the
// "* (row count)" option for the metric picker; `selected` pre-selects.
function _fillChartPicker(sel, withRowCount, selected) {
  if (!sel) return;
  const cols = STATE.columns ?? [];
  const head = withRowCount
    ? `<option value="*">* (row count)</option>`
    : `<option value="">— pick a column —</option>`;
  sel.innerHTML = head + cols.map((c) =>
    `<option value="${_attrEsc(c.name)}">${_htmlEsc(c.name)}</option>`).join("");
  if (selected != null) sel.value = selected;
}

// Re-fill the builder's column pickers from STATE.columns, preserving the
// active chart's current selections. Called after the source file (and
// so its column set) changes.
function _builderSyncPickers(root) {
  const cfg = (_activeChart >= 0 ? STATE.charts[_activeChart] : null) ?? {};
  _fillChartPicker(root.querySelector("[data-reports-x-picker]"),      false, cfg.group_by);
  _fillChartPicker(root.querySelector("[data-reports-ygroup-picker]"), false, cfg.y_group_by);
  _fillChartPicker(root.querySelector("[data-reports-y-picker]"),      true,  cfg.agg_col);
}

// ── Report Tools panel — Slice 1: populate the grouping / summarize
// column pickers from STATE.columns, and add/remove rows. Spec
// collection + the /reports/preview wiring land in the next slice.

// Re-fill the Report Tools selects, keeping each select's first <option>
// (its placeholder) and the user's current pick where still valid.
function _syncReportTools(root) {
  const opts = (STATE.columns ?? []).map((c) =>
    `<option value="${_attrEsc(c.name)}">${_htmlEsc(c.name)}</option>`).join("");
  const fill = (sel) => {
    if (!sel) return;
    const head = sel.querySelector("option");
    const prev = sel.value;
    sel.innerHTML = (head ? head.outerHTML : "") + opts;
    sel.value = prev;
  };
  root.querySelectorAll("[data-reports-group-rows] select").forEach(fill);
  fill(root.querySelector("[data-reports-group-cols]"));
  root.querySelectorAll("[data-reports-aggs] .rp-rt-tool-agg > select").forEach(fill);
}

// Append a fresh group-row — clone the first row, reset its select,
// repopulate from STATE.columns.
function _addGroupRow(root) {
  const box = root.querySelector("[data-reports-group-rows]");
  const tpl = box?.querySelector(".rp-rt-tool-row");
  if (!box || !tpl) return;
  const row = tpl.cloneNode(true);
  row.querySelectorAll("select").forEach((s) => { s.selectedIndex = 0; });
  box.appendChild(row);
  _syncReportTools(root);
}
// Append a fresh aggregate block — clone the first block, reset its
// column + function selects.
function _addAggRow(root) {
  const box = root.querySelector("[data-reports-aggs]");
  const tpl = box?.querySelector(".rp-rt-tool-agg");
  if (!box || !tpl) return;
  const row = tpl.cloneNode(true);
  row.querySelectorAll("select").forEach((s) => { s.selectedIndex = 0; });
  box.appendChild(row);
  _syncReportTools(root);
}

// ── Report Tools — Slice 2: collect a ReportSpec from the panel, run
// /reports/preview, render the grouped result. Detail rows + grand
// total + matrix layout are the next render slice.

// True when grouping is configured — a group row OR a group column —
// the signal to render a grouped report instead of the raw source page.
function _reportGroupingActive(root) {
  const rows = [...root.querySelectorAll("[data-reports-group-rows] select")]
    .some((s) => s.value);
  return rows || !!root.querySelector("[data-reports-group-cols]")?.value;
}

// Read the Report Tools panel into a ReportSpec for /reports/preview.
function _collectReportSpec(root) {
  const groupBy = [...root.querySelectorAll("[data-reports-group-rows] select")]
    .map((s) => s.value).filter(Boolean);
  const groupCols = root.querySelector("[data-reports-group-cols]")?.value || "";
  // "Row count" blocks (col "*") are dropped — the engine can't aggregate
  // the "*" literal. With no explicit aggregations the engine adds an
  // implicit count(*), which is exactly the row count.
  const aggregations = [...root.querySelectorAll("[data-reports-aggs] .rp-rt-tool-agg")]
    .map((blk) => {
      const sels = blk.querySelectorAll("select");
      return { col: sels[0]?.value || "", fn: sels[1]?.value || "count", alias: "" };
    })
    .filter((a) => a.col && a.col !== "*");
  const show = (k) => !!root.querySelector(`[data-reports-show="${k}"]`)?.checked;
  return {
    group_by:       groupBy,
    group_by_cols:  groupCols ? [groupCols] : [],
    aggregations,
    filter:         null,
    sort:           [],
    show_details:   show("details"),
    show_subtotals: show("subtotals"),
    show_total:     show("total"),
  };
}

// Grouped-report path — POST the panel's ReportSpec to /reports/preview
// and render the subtotals.
async function _paintGroupedReport(root) {
  const tableWrap = root.querySelector("[data-reports-table]");
  if (tableWrap) tableWrap.setAttribute("aria-busy", "true");
  let res;
  try {
    res = await api.post("/reports/preview", {
      source_file_id: STATE.rid,
      spec: _collectReportSpec(root),
    });
  } catch (err) {
    _renderReportsEmptyState(root,
      `Report failed: ${err.body?.error ?? err.message ?? err}`);
    return;
  } finally {
    if (tableWrap) tableWrap.removeAttribute("aria-busy");
  }
  _renderGroupedRows(root, res);
}

// Render a /reports/preview subtotals payload ({columns, rows}) as the
// table — the grouped + aggregated view.
function _renderGroupedRows(root, res) {
  const tableWrap = root.querySelector("[data-reports-table]");
  if (!tableWrap) return;
  const cols = res?.subtotals?.columns ?? [];
  const rows = res?.subtotals?.rows ?? [];
  if (!cols.length) {
    _renderReportsEmptyState(root, "Pick a group column and a summary.");
    return;
  }
  const thead = `<thead><tr>${cols.map((c) =>
    `<th>${_htmlEsc(String(c))}</th>`).join("")}</tr></thead>`;
  const tbody = rows.length === 0
    ? `<tbody><tr><td colspan="${cols.length}" style="text-align:center;color:var(--muted);padding:1rem;font-style:italic">No rows.</td></tr></tbody>`
    : `<tbody>${rows.map((r) => `<tr>${
        r.map((v) => v == null
          ? `<td><span class="rp-rt-null">—</span></td>`
          : `<td>${_htmlEsc(String(v))}</td>`).join("")
      }</tr>`).join("")}</tbody>`;
  tableWrap.innerHTML = `<table class="rp-rt-table">${thead}${tbody}</table>`;
  const rowsInfo = root.querySelector("[data-reports-rows-info]");
  if (rowsInfo) {
    rowsInfo.textContent = `${rows.length} group${rows.length === 1 ? "" : "s"}`;
  }
  const pages = root.querySelector("[data-reports-pages]");
  if (pages) pages.innerHTML = "";
}

// Show/hide the builder's per-kind conditional rows + relabel the
// column pickers. Keyed off the active chart's kind (set by variants).
function _syncChartConditionals(root) {
  const kind = STATE.charts[_activeChart]?.kind || "bar";
  const isScatter = kind === "scatter";
  const isBoxplot = kind === "boxplot";
  const isGauge   = kind === "gauge";
  const is2D      = kind === "heatmap" || kind === "radar" || kind === "matrix";
  const show = (sel, on) => {
    const el = root.querySelector(sel);
    if (el) el.hidden = !on;
  };
  show("[data-cond-x]",          !isGauge);
  show("[data-cond-ygroup]",     is2D);
  show("[data-cond-agg]",        !(isScatter || isBoxplot));
  show("[data-cond-regression]", isScatter);
  show("[data-cond-symbol]",     kind === "pictorial_bar");
  const lblX = root.querySelector("[data-nc-lbl-x]");
  const lblY = root.querySelector("[data-nc-lbl-y]");
  if (lblX) lblX.textContent = isScatter ? "X column"
    : kind === "calendar" ? "Date column" : "Group by";
  if (lblY) lblY.textContent = isScatter ? "Y column"
    : isBoxplot ? "Value column" : "Metric column";
}

// Read the builder's *data-binding* fields into a partial ChartSpec.
// kind + modifiers (smooth/donut/half/rose/symbol_repeat) are NOT here —
// the variant tiles own those; title/description are committed on Save.
function _chartFormToSpec(root) {
  const $ = (sel) => root.querySelector(sel);
  const kind        = STATE.charts[_activeChart]?.kind || "bar";
  const isScatter   = kind === "scatter";
  const isPictorial = kind === "pictorial_bar";
  const is2D        = kind === "heatmap" || kind === "radar" || kind === "matrix";
  return {
    group_by:   $("#nc-x")?.value || "",
    agg_col:    $("#nc-y")?.value || "*",
    agg_fn:     $("#nc-agg")?.value || "count",
    regression: isScatter && $("#nc-regression")?.value ? $("#nc-regression").value : null,
    symbol:     isPictorial ? ($("#nc-symbol")?.value || "circle") : null,
    y_group_by: is2D ? ($("#nc-ygroup")?.value || "") : null,
  };
}
