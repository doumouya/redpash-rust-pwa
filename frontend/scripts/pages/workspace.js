// Workspace page — the redtable as a browser, wired to /api.
//
// On mount: load real projects + lazy-load files per group. A file
// click fetches /api/files/:rid (columns) + /api/files/:rid/page
// (?page=N&size=M) and renders. The toolbar (search, sort, select /
// edit / delete, columns dropdown, filter builder) operates on the
// loaded page; column-indexed state (sort keys, filter, cols vis)
// resets per file. Rows-per-page + pager buttons refetch the page
// server-side via PageQuery.
//
// What's still stubbed: server-side filter+sort (still page-local for
// now — that's WS#2), and saving cell-edits / row-deletes back to the
// server (cell / row modes are visual only). Tools panel + refresh
// are wired.

import { api } from "/scripts/api.js";
import { mountTopbar } from "/scripts/topbar.js";
import { mountTools } from "/scripts/tools.js";
import { mountReport } from "/scripts/report.js";
import { mountDesigner } from "/scripts/designer.js";
import { getEngine } from "/scripts/wasm-engine.js";
import { getPref, setPref } from "/scripts/prefs.js";
import { esc, cssEsc } from "/scripts/dom.js";

// Stage labels mirror backend's file_stages view (migration 022,
// 2026-06-05). Renamed from `import|report` to `new|design` — same
// vocabulary home.js uses; keep this in sync.
const STAGE_DOT     = { new: "is-dirty", clean: "is-warn", design: "is-clean", publish: "is-clean" };
const MARK_COLORS   = ["blue", "mauve", "teal", "peach"];
const DATE_DTYPES   = new Set(["date"]);
const ALL_ROWS_SIZE = 50000;       // "All rows" is a one-shot big page, not a separate code path.
const DEFAULT_PAGE_SIZE = 25;

export default function workspace(app, { session }) {
  const $  = (s) => app.querySelector(s);
  const $$ = (s) => Array.from(app.querySelectorAll(s));

  mountTopbar($("#rp-topbar"), { active: "workspace", session });

  // Warm the wasm engine cache — the user is on the workspace, they're
  // going to do data work, so trigger the lazy fetch now and await
  // later from whichever surface needs it. Fire-and-forget: any load
  // error stays silent until a real call happens (then surfaces there).
  getEngine().catch(() => { /* lazy-loader error path; ignored on warm-up */ });

  // ─── element refs ──────────────────────────────────────────────
  const nav        = $("#wsNav");
  const navBody    = $("#wsNavBody");
  const table      = $("#wsTable");
  const thead      = table.tHead;
  const tbody      = table.tBodies[0];
  const tableState = $("#wsTableState");
  const colsDd     = $("#wsColsDd");
  const rowsInfo   = $("#wsRowsInfo");
  const selChip    = $("#wsSelChip");
  const selCount   = $("#wsSelCount");
  const deleteBtn  = app.querySelector('.rt-mode[data-mode="delete"]');
  const groupList  = $("#wsGroupList");

  // ─── state ─────────────────────────────────────────────────────
  let activeFileRid = null;
  let activeColumns = [];   // ColumnMeta[] for the open file
  let activeSteps   = [];   // ProjectStep[] — drives undo/redo enable
  let activeSummary = null; // FileSummary — drives per-tool context renderers
  let groupColorIdx = 0;
  let sortKeys      = [];   // [{ col, dir, isDate }] — col is display-column-index (≥3)
  let searchQ       = "";
  let activeFilter  = null; // FilterNode tree (see shared::filter::FilterNode) — null = no filter
  let searchDebounce = null;
  let toolsCtrl     = null; // mountTools' control surface — refresh() rebuilds the open form / columns view
  let reportCtrl    = null; // mountReport's control surface — refresh() rebuilds the open builder
  let designerCtrl  = null; // mountDesigner — load(chart) when a chart-typed file opens
  let sourceCache   = { rid: null, columns: [] }; // last data file the user opened — drives "+ New chart" + designer source

  // UI filter ops → canonical FilterOp on the wire (shared::filter::FilterOp).
  // The op-list union landed in 3d29291; this is the frontend half.
  const OP_TO_WIRE = {
    contains: "contains",
    is:       "eq",
    not:      "neq",
    starts:   "starts_with",
    empty:    "is_null",
    filled:   "not_null",
  };
  // Ops that don't carry a value (server ignores .value for these).
  const NULL_OPS = new Set(["is_null", "not_null"]);
  let groupCombo    = "AND";
  let filterCols    = [];   // [[colIndex, name], ...] for the filter builder
  let currentPage   = 1;    // 1-indexed page (matches Page<T>.page on the wire)
  let pageSize      = pageSizeFromPref();
  let totalPages    = 1;    // last response's Page<T>.pages — drives the pager render
  let rowIndices    = [];   // absolute row idx in the underlying frame, per displayed row
  let stepInFlight  = false;

  // The wire-level pref ("10" / "25" / "50" / "100" / "all") into the
  // numeric pageSize the fetch uses. "all" maps to a large one-shot
  // page so the rest of the code stays in a single paginated path.
  function pageSizeFromPref() {
    const raw = getPref("rowsPerPage");
    if (raw === "all") return ALL_ROWS_SIZE;
    const n = parseInt(raw || "", 10);
    return Number.isFinite(n) && n > 0 ? n : DEFAULT_PAGE_SIZE;
  }

  // ─── rail — collapse to compact ────────────────────────────────
  $("#wsNavCollapse").addEventListener("click", (e) => {
    nav.classList.toggle("compact");
    e.currentTarget.querySelector("i").className = nav.classList.contains("compact")
      ? "bi bi-chevron-double-right" : "bi bi-chevron-double-left";
  });

  // ─── upload — POST /api/files/upload (multipart) ───────────────
  // File picked from #wsUploadInput → uploaded into the project of
  // the currently-active file (or default when nothing's open). After
  // the FileEnvelope returns, refresh the rail + auto-expand the
  // target project's group + auto-open the new file.
  const uploadInput = $("#wsUploadInput");
  const uploadBtn   = $("#wsUpload");
  uploadBtn.addEventListener("click", () => uploadInput.click());
  uploadInput.addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    await doUpload(file);
    uploadInput.value = "";  // reset so re-picking the same file fires change
  });

  async function doUpload(file) {
    const targetProject = activeProjectName();
    const fd = new FormData();
    fd.append("file", file);
    if (targetProject) fd.append("project_name", targetProject);

    uploadBtn.disabled = true;
    uploadBtn.classList.add("is-busy");
    const labelEl = uploadBtn.querySelector("span");
    const originalLabel = labelEl?.textContent;
    if (labelEl) labelEl.textContent = "Uploading…";

    try {
      // FormData → api.js skips JSON encoding (sees the instance type).
      const env = await api.post("/files/upload", fd);
      const newRid  = env?.summary?.redpash_id;
      const projRid = env?.summary?.project_redpash_id;
      if (!newRid) throw new Error("Upload succeeded but the server returned no file id.");
      await refreshAndOpen(newRid, projRid);
    } catch (err) {
      const msg = err?.body?.message || err?.body?.error || err?.message || "Upload failed";
      rowsInfo.textContent = msg + (err?.status ? " (" + err.status + ")" : "");
    } finally {
      uploadBtn.disabled = false;
      uploadBtn.classList.remove("is-busy");
      if (labelEl && originalLabel) labelEl.textContent = originalLabel;
    }
  }

  // The project name of the currently-active file (if any). Sent as
  // ?project_name= so a logged-in user uploading from inside Project
  // X gets the new file routed to X (find-or-create) instead of the
  // default. When no file is open, return null → server defaults to
  // the user's default project.
  function activeProjectName() {
    const activeTab = navBody.querySelector(".rt-tab.active");
    if (!activeTab) return null;
    const group = activeTab.closest(".rt-group");
    return group?.querySelector(".rt-group-name")?.textContent?.trim() || null;
  }

  async function refreshAndOpen(newRid, projRid) {
    // Claim activeFileRid up front so loadProjects' default-group
    // auto-open (gated on `!activeFileRid`) skips — otherwise it
    // would race against our target file and the table could flicker
    // through the wrong content first.
    activeFileRid = newRid;
    await loadProjects();
    const group = projRid && navBody.querySelector('.rt-group[data-rid="' + cssEsc(projRid) + '"]');
    if (!group) { activeFileRid = null; loadFile(newRid); return; }
    group.classList.add("expanded");
    await loadFilesForGroup(group);
    const newTab = group.querySelector('.rt-tab[data-rid="' + cssEsc(newRid) + '"]');
    if (newTab) {
      navBody.querySelectorAll(".rt-tab.active").forEach((t) => t.classList.remove("active"));
      newTab.classList.add("active");
    }
    activeFileRid = null;  // clear so loadFile's "same-rid" early-return doesn't fire
    loadFile(newRid);
  }

  // ─── rail — load projects + lazy files ─────────────────────────
  loadProjects();

  async function loadProjects() {
    try {
      const data = await api.get("/projects");
      renderRail(data?.items || []);
    } catch (err) {
      navBody.setAttribute("aria-busy", "false");
      navBody.innerHTML = '<div class="rt-nav-state">Couldn’t load projects'
        + (err.status ? " (" + err.status + ")" : "") + ".</div>";
    }
  }

  function renderRail(items) {
    navBody.setAttribute("aria-busy", "false");
    if (!items.length) {
      navBody.innerHTML = '<div class="rt-nav-state">No projects yet.</div>';
      return;
    }
    navBody.innerHTML = items.map(projectGroup).join("");
    // Deep-link via #/workspace?project=<rid>&file=<rid>. Project
    // auto-opens that project; file (optional) jumps straight to
    // that file instead of the project's first tab — used by Home
    // to land the user on a specific chart or csv. Falls back to
    // is_default, then first group.
    const params   = new URLSearchParams(location.hash.split("?")[1] || "");
    const wantRid  = params.get("project");
    const wantFile = params.get("file");
    const first = (wantRid && navBody.querySelector('.rt-group[data-rid="' + cssEsc(wantRid) + '"]'))
               || navBody.querySelector('.rt-group[data-default="1"]')
               || navBody.querySelector(".rt-group");
    if (first) {
      // Mark the target group so loadFilesForGroup auto-opens its first
      // file (the auto-open path is dataset.default === "1"). When a
      // file deep-link is set, stash it so loadFilesForGroup picks it
      // instead of the first tab.
      if (wantRid && first.dataset.rid === wantRid) first.dataset.default = "1";
      if (wantFile) first.dataset.wantFile = wantFile;
      first.classList.add("expanded");
      loadFilesForGroup(first);
    }
  }

  function projectGroup(p) {
    const c = MARK_COLORS[(groupColorIdx++) % MARK_COLORS.length];
    const initials = ((p.name || "?").trim().split(/\s+/)
      .map((w) => w[0]).join("") || "?").slice(0, 2).toUpperCase();
    return '<div class="rt-group" data-rid="' + esc(p.redpash_id) + '"'
      + (p.is_default ? ' data-default="1"' : '') + '>'
      +   '<button class="rt-group-head" type="button">'
      +     '<i class="bi bi-chevron-down rt-group-caret"></i>'
      +     '<span class="rt-group-mark" data-c="' + c + '">' + esc(initials) + '</span>'
      +     '<span class="rt-group-name">' + esc(p.name) + '</span>'
      +     '<span class="rt-group-count">' + (p.file_count || 0) + '</span>'
      +   '</button>'
      +   '<div class="rt-group-body" aria-busy="false"></div>'
      + '</div>';
  }

  async function loadFilesForGroup(group) {
    if (group.dataset.filesLoaded === "1") return;
    const body = group.querySelector(".rt-group-body");
    const rid  = group.dataset.rid;
    body.setAttribute("aria-busy", "true");
    body.innerHTML = '<div class="rt-nav-state">Loading files…</div>';
    try {
      const data = await api.get("/projects/" + encodeURIComponent(rid) + "/files");
      renderFiles(body, data?.items || []);
      group.dataset.filesLoaded = "1";
      // Default group — auto-open. If a deep-linked file rid is
      // stashed on the group (?file=<rid>), pick that tab; otherwise
      // pick the first.
      if (!activeFileRid && group.dataset.default === "1") {
        const wantFile = group.dataset.wantFile;
        const tab = (wantFile && body.querySelector('.rt-tab[data-rid="' + cssEsc(wantFile) + '"]'))
                 || body.querySelector(".rt-tab");
        if (tab) {
          navBody.querySelectorAll(".rt-tab.active").forEach((t) => t.classList.remove("active"));
          tab.classList.add("active");
          loadFile(tab.dataset.rid);
        }
      }
    } catch {
      body.innerHTML = '<div class="rt-nav-state">Couldn’t load files.</div>';
    } finally {
      body.setAttribute("aria-busy", "false");
    }
  }

  function renderFiles(body, items) {
    if (!items.length) {
      body.innerHTML = '<div class="rt-nav-state">No files yet.</div>';
      return;
    }
    body.innerHTML = items.map(fileTab).join("");
  }

  function fileTab(f) {
    const dot = STAGE_DOT[f.stage] || "is-dirty";
    const name = f.display_name || f.filename || "(unnamed)";
    // Icon per file_type — Designer-bound rows (chart, dashboard)
    // get distinct glyphs so the rail reads at a glance.
    const icon = f.file_type === "chart"     ? "bi-bar-chart-line"
              : f.file_type === "dashboard"  ? "bi-grid-1x2"
              :                                 "bi-filetype-csv";
    return '<button class="rt-tab" type="button" data-rid="' + esc(f.redpash_id) + '">'
      +   '<i class="bi ' + icon + ' rt-tab-icon"></i>'
      +   '<span class="rt-tab-name">' + esc(name) + '</span>'
      +   '<span class="rt-tab-dot ' + dot + '" title="' + esc(f.stage || "") + '"></span>'
      +   '<span class="rt-tab-close" title="Close"><i class="bi bi-x"></i></span>'
      + '</button>';
  }

  // ─── rail body — expand groups, switch / close tabs ────────────
  navBody.addEventListener("click", (e) => {
    const head = e.target.closest(".rt-group-head");
    if (head) {
      const group = head.closest(".rt-group");
      const wasExpanded = group.classList.contains("expanded");
      group.classList.toggle("expanded");
      if (!wasExpanded) loadFilesForGroup(group);
      return;
    }
    if (e.target.closest(".rt-tab-close")) {
      const tab = e.target.closest(".rt-tab");
      const closingActive = tab.dataset.rid === activeFileRid;
      tab.remove();
      if (closingActive) {
        // The file backing the table just disappeared — clear state so
        // loadFile(rid) can re-open the same rid later, and blank the
        // surface back to the "open a file" prompt.
        activeFileRid = null;
        activeColumns = [];
        activeSteps = [];
        rowIndices = [];
        totalPages = 1;
        renderPager();
        syncToolbar();
        setTableState("Open a file from the rail to see its data.");
        rowsInfo.textContent = "No file open.";
      }
      return;
    }
    const tab = e.target.closest(".rt-tab");
    if (tab) {
      navBody.querySelectorAll(".rt-tab.active").forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");
      loadFile(tab.dataset.rid);
    }
  });

  // ─── table — load a file's columns + page ──────────────────────
  // Three-helper split: loadFile resets per-file state and fetches
  // columns; refetchPage preserves column-indexed state and re-renders
  // the table body; fetchAndRender does the wire call + render shared
  // by both.
  async function loadFile(rid) {
    if (!rid || rid === activeFileRid) return;
    activeFileRid = rid;
    // Reset all per-file state — column-indexed knobs only make sense
    // against the columns we're about to fetch.
    sortKeys = []; activeFilter = null; searchQ = "";
    currentPage = 1;
    $("#wsRowSearch").value = "";
    $("#wsFilterToggle").classList.remove("has-filter");
    setTableState("Loading…");
    rowsInfo.textContent = "Loading…";
    try {
      // Charts and data files take different load paths. Rid prefix
      // disambiguates without a probe call — CHT_* is a chart row in
      // project_files; FIL_* is a data file. The /files/:rid endpoint
      // 500s on chart rids (no row/column metadata), so we MUST not
      // hit it for charts.
      if (rid.startsWith("CHT_")) {
        const chart = await api.get("/charts/" + encodeURIComponent(rid));
        await ensureSourceCache(chart?.source_file_id);
        enterDesignerMode(chart?.title || "Untitled chart");
        designerCtrl?.load({ type: "chart", chart });
        rowsInfo.textContent = "Chart · " + (chart?.title || "untitled");
        totalPages = 1;
        renderPager();
        syncNewChartButton();
        return;
      }

      const envelope = await api.get("/files/" + encodeURIComponent(rid));
      activeColumns = envelope?.columns || [];
      activeSteps   = envelope?.steps   || [];
      activeSummary = envelope?.summary || null;
      syncToolbar();
      // Tools panel binds columns + summary lazily via getters — when
      // the file changes, tell it to re-render whichever view is open
      // (picker form re-derives field options; columns view re-projects
      // the rows). Picker idle state is a no-op.
      toolsCtrl?.refresh();
      // Report builder is column-bound too — re-render so the group-by
      // dropdown + agg col options reflect the new file. Stale spec
      // (group-by names that don't exist) gets filtered visually on
      // re-render; Apply would surface a server error if user submits.
      reportCtrl?.refresh();
      // Defensive fallback for legacy CHT_-prefix mistakes or future
      // file_types that route through the same designer path.
      const fileType = envelope?.summary?.file_type;
      if (fileType === "chart") {
        // Defensive fallback — shouldn't normally hit since the
        // CHT_ branch returns above, but legacy/wrong-prefixed rids
        // could land here.
        const chart = await api.get("/charts/" + encodeURIComponent(rid));
        await ensureSourceCache(chart?.source_file_id);
        enterDesignerMode(chart?.title || envelope?.summary?.display_name || "Untitled chart");
        designerCtrl?.load({ type: "chart", chart });
        rowsInfo.textContent = "Chart · " + (chart?.title || envelope?.summary?.display_name || "untitled");
        totalPages = 1;
        renderPager();
        syncNewChartButton();
      } else if (fileType === "dashboard") {
        // Dashboards = FIL_-prefix project_files rows with
        // file_type='dashboard'. Spec carries widgets[] each
        // referencing a chart by id. Designer fetches each in
        // parallel and renders the multi-tile canvas.
        const dashboard = await api.get("/dashboards/" + encodeURIComponent(rid));
        enterDesignerMode(dashboard?.title || envelope?.summary?.display_name || "Untitled dashboard", "dashboard");
        designerCtrl?.load({ type: "dashboard", dashboard });
        rowsInfo.textContent = "Dashboard · " + (dashboard?.title || envelope?.summary?.display_name || "untitled");
        totalPages = 1;
        renderPager();
        syncNewChartButton();
      } else {
        rebuildColsDropdown(activeColumns);
        rebuildFilterCols(activeColumns);
        // Cache the open data file so + New chart + future designer
        // opens have an immediate source.
        sourceCache = { rid, columns: activeColumns };
        syncNewChartButton();
        // Tear down any open designer (user navigated from chart to data).
        designerCtrl?.load(null);
        exitDesignerMode();
        await fetchAndRender();
      }
    } catch (err) {
      setTableState("Couldn’t load file" + (err.status ? " (" + err.status + ")" : "") + ".");
      rowsInfo.textContent = "Error.";
    }
  }

  // Re-fetch the current file's current page without resetting state.
  // Triggered by pager clicks + rows-per-page changes.
  async function refetchPage() {
    if (!activeFileRid) return;
    rowsInfo.textContent = "Loading…";
    try { await fetchAndRender(); }
    catch (err) {
      setTableState("Couldn’t load page" + (err.status ? " (" + err.status + ")" : "") + ".");
      rowsInfo.textContent = "Error.";
    }
  }

  async function fetchAndRender() {
    const params = new URLSearchParams();
    params.set("page", String(currentPage));
    params.set("size", String(pageSize));
    if (searchQ) params.set("q", searchQ);
    const sorts = buildSortsParam();
    if (sorts && sorts.length) params.set("sorts", JSON.stringify(sorts));
    if (activeFilter) params.set("filters", JSON.stringify(activeFilter));
    const pageData = await api.get(
      "/files/" + encodeURIComponent(activeFileRid) + "/page?" + params.toString());
    // Server clamps page; trust its echo so the pager reflects reality.
    currentPage = pageData?.page || 1;
    totalPages  = pageData?.pages || 1;
    rowIndices  = pageData?.row_indices || [];
    renderTable(activeColumns, pageData?.rows || []);
    syncSortHeaders();
    const shown = pageData?.rows?.length || 0;
    const total = pageData?.total || 0;
    const from  = total === 0 ? 0 : (currentPage - 1) * pageSize + 1;
    const to    = Math.min(from + shown - 1, total);
    rowsInfo.textContent = (total === 0 ? "0 rows" : from + "–" + to + " of " + total + " rows")
      + " · " + (pageData?.ms != null ? pageData.ms + " ms" : "—");
    renderPager();
    setTableState(null);
  }

  // ─── server-query builders ────────────────────────────────────
  // sortKeys carries display-column-indexes (≥3, after the chk + #
  // columns); the server needs column names. Translate via
  // activeColumns; drop any key whose column has been removed.
  function buildSortsParam() {
    return sortKeys
      .map((k) => {
        const meta = activeColumns[k.col - 3];
        return meta ? { col: meta.name, dir: k.dir > 0 ? "asc" : "desc" } : null;
      })
      .filter(Boolean);
  }

  // Walk the filter builder UI, return a FilterNode tree (or null when
  // there's no actionable predicate). One group = one FilterGroup;
  // multiple groups wrapped under the outer combo as a top-level
  // FilterGroup. Single group with no outer wrapping: hand the inner
  // group out directly (saves a level of nesting on the wire).
  function buildFilterNode() {
    const groups = Array.from(groupList.querySelectorAll(".rt-group-card"))
      .map(readGroup);
    const groupNodes = groups
      .map((g) => ({
        op: g.combo.toLowerCase(),
        children: g.preds.map(predToLeaf).filter(Boolean),
      }))
      .filter((g) => g.children.length > 0);
    if (groupNodes.length === 0) return null;
    if (groupNodes.length === 1) return groupNodes[0];
    return { op: groupCombo.toLowerCase(), children: groupNodes };
  }

  function predToLeaf(p) {
    const meta = activeColumns[p.col - 3];
    if (!meta) return null;
    const op = OP_TO_WIRE[p.op];
    if (!op) return null;
    const leaf = { col: meta.name, op };
    if (!NULL_OPS.has(op)) leaf.value = p.val;
    return leaf;
  }

  function renderTable(columns, rows) {
    thead.innerHTML = '<tr>'
      + '<th class="col-chk"><input type="checkbox" class="rt-chk" id="wsSelectAll" /></th>'
      + '<th class="col-rownum">#</th>'
      + columns.map((c, i) =>
          '<th class="sortable" data-sort="' + (i + 3) + '"'
          + (DATE_DTYPES.has(c.semantic_dtype) ? ' data-type="date"' : '')
          + '>' + esc(c.name) + ' <i class="bi bi-chevron-expand sort"></i></th>'
        ).join("")
      + '</tr>';
    tbody.innerHTML = rows.map((row, i) => {
      const absIdx = rowIndices[i];
      const idxAttr = absIdx != null ? ' data-idx="' + absIdx + '"' : "";
      return '<tr' + idxAttr + '>'
        + '<td class="col-chk"><input type="checkbox" class="rt-chk" /></td>'
        + '<td class="col-n col-rownum">' + (i + 1) + '</td>'
        + columns.map((c, ci) => {
            const v = row[ci];
            const cls = v == null ? 'cell-muted editable' : 'editable';
            return '<td class="' + cls + '" data-col="' + esc(c.name) + '">'
              + esc(v == null ? "—" : v) + '</td>';
          }).join("")
        + '</tr>';
    }).join("");
    syncSel();
  }

  function setTableState(msg) {
    // State message — when no body is current (loading, error, no file).
    const designer = document.getElementById("wsDesigner");
    if (msg) {
      tableState.textContent = msg;
      tableState.hidden = false;
      table.hidden = true;
      if (designer) designer.hidden = true;
    } else {
      tableState.hidden = true;
      table.hidden = false;
      if (designer) designer.hidden = true;
    }
  }

  // ─── columns dropdown — rebuilt per file ───────────────────────
  function rebuildColsDropdown(columns) {
    colsDd.innerHTML = columns.map((c, i) =>
      '<label class="rt-dd-item"><input type="checkbox" class="rt-chk" data-col="'
      + (i + 3) + '" checked /> ' + esc(c.name) + '</label>'
    ).join("");
  }
  // Cols-toggle is delegated to the dropdown — survives rebuilds.
  colsDd.addEventListener("change", (e) => {
    const chk = e.target.closest("input[data-col]");
    if (!chk) return;
    const n = chk.dataset.col;
    const show = chk.checked ? "" : "none";
    table.querySelectorAll("thead th:nth-child(" + n + "), tbody td:nth-child(" + n + ")")
      .forEach((c) => { c.style.display = show; });
  });

  // ─── filter builder — COLS dynamic per file ────────────────────
  const OPS = [["contains", "contains"], ["is", "is"], ["not", "is not"],
               ["starts", "starts with"], ["empty", "is empty"], ["filled", "is not empty"]];

  function rebuildFilterCols(columns) {
    filterCols = columns.map((c, i) => [i + 3, c.name]);
    groupList.innerHTML = "";
    groupCombo = "AND";
    activeFilter = null;
    if (filterCols.length) addGroup();
    // Server-side filter (WS#2) — no client-side refresh() needed here;
    // loadFile awaits fetchAndRender() right after this call which
    // sends the fresh (empty) filter set to the server.
  }

  function predRow() {
    const d = document.createElement("div");
    d.className = "rt-pred";
    d.innerHTML =
      '<select class="rt-pred-col">'
      + filterCols.map((c) => '<option value="' + c[0] + '">' + esc(c[1]) + "</option>").join("")
      + "</select>"
      + '<select class="rt-pred-op">'
      + OPS.map((o) => '<option value="' + o[0] + '">' + o[1] + "</option>").join("")
      + "</select>"
      + '<input class="rt-pred-val" placeholder="value" />'
      + '<button class="rt-pred-del" type="button" title="Remove condition"><i class="bi bi-x"></i></button>';
    return d;
  }
  function groupCard() {
    const card = document.createElement("div");
    card.className = "rt-group-card";
    card.innerHTML =
      '<div class="rt-group-card-head">'
      + '<div class="rt-seg rt-group-card-combo">'
      + '<button type="button" class="is-active" data-combo="AND">AND</button>'
      + '<button type="button" data-combo="OR">OR</button>'
      + "</div>"
      + '<button class="rt-group-card-del" type="button" title="Remove group"><i class="bi bi-trash3"></i></button>'
      + "</div>"
      + '<div class="rt-pred-list"></div>'
      + '<button class="rt-btn rt-btn--glass rt-btn--block rt-add-pred" type="button">'
      + '<i class="bi bi-plus-lg"></i> Add condition</button>';
    card.querySelector(".rt-pred-list").appendChild(predRow());
    return card;
  }
  function renderSeps() {
    groupList.querySelectorAll(".rt-group-sep").forEach((s) => s.remove());
    const cards = Array.from(groupList.querySelectorAll(".rt-group-card"));
    cards.slice(0, -1).forEach((card) => {
      const sep = document.createElement("div");
      sep.className = "rt-group-sep";
      sep.innerHTML = '<button type="button">' + groupCombo + "</button>";
      card.after(sep);
    });
  }
  function addGroup() { groupList.appendChild(groupCard()); renderSeps(); }

  $("#wsAddGroup").addEventListener("click", () => { if (filterCols.length) addGroup(); });

  groupList.addEventListener("click", (e) => {
    if (e.target.closest(".rt-pred-del")) { e.target.closest(".rt-pred").remove(); return; }
    if (e.target.closest(".rt-add-pred")) {
      e.target.closest(".rt-group-card").querySelector(".rt-pred-list").appendChild(predRow());
      return;
    }
    if (e.target.closest(".rt-group-card-del")) {
      if (groupList.querySelectorAll(".rt-group-card").length > 1)
        e.target.closest(".rt-group-card").remove();
      renderSeps();
      return;
    }
    const gcBtn = e.target.closest(".rt-group-card-combo button");
    if (gcBtn) {
      gcBtn.parentElement.querySelectorAll("button").forEach((b) => b.classList.remove("is-active"));
      gcBtn.classList.add("is-active");
      return;
    }
    if (e.target.closest(".rt-group-sep button")) {
      groupCombo = groupCombo === "AND" ? "OR" : "AND";
      groupList.querySelectorAll(".rt-group-sep button").forEach((b) => { b.textContent = groupCombo; });
    }
  });
  groupList.addEventListener("change", (e) => {
    if (e.target.classList.contains("rt-pred-op")) {
      const val = e.target.closest(".rt-pred").querySelector(".rt-pred-val");
      val.disabled = ["empty", "filled"].includes(e.target.value);
      if (val.disabled) val.value = "";
    }
  });
  function readGroup(card) {
    return {
      combo: card.querySelector(".rt-group-card-combo .is-active").dataset.combo,
      preds: Array.from(card.querySelectorAll(".rt-pred")).map((p) => ({
        col: +p.querySelector(".rt-pred-col").value,
        op:  p.querySelector(".rt-pred-op").value,
        val: p.querySelector(".rt-pred-val").value.trim(),
      })),
    };
  }
  $("#wsApplyFilter").addEventListener("click", () => {
    activeFilter = buildFilterNode();
    $("#wsFilterToggle").classList.toggle("has-filter", activeFilter != null);
    currentPage = 1;
    refetchPage();
  });
  $("#wsClearFilter").addEventListener("click", () => {
    groupList.innerHTML = "";
    groupCombo = "AND";
    if (filterCols.length) addGroup();
    activeFilter = null;
    $("#wsFilterToggle").classList.remove("has-filter");
    currentPage = 1;
    refetchPage();
  });

  // ─── search — debounced, server-side via PageQuery.q ─────────
  // Page-local string match used to live here (passSearch over rendered
  // rows); deleted along with passFilter/applySort. The boundary doc
  // forbids JS data-engine code long-term — search now ships through
  // the same Page<T> wire as filter + sort.
  $("#wsRowSearch").addEventListener("input", (e) => {
    const next = e.target.value.trim();
    if (next === searchQ) return;
    searchQ = next;
    if (searchDebounce) clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => {
      currentPage = 1;
      refetchPage();
    }, 250);
  });

  // ─── sort — server-side via PageQuery.sorts ──────────────────
  // Shift-click extends the sort, plain click replaces. Same gesture
  // as before; the difference is the refetch.
  thead.addEventListener("click", (e) => {
    const th = e.target.closest("th.sortable");
    if (!th) return;
    const col = +th.dataset.sort, isDate = th.dataset.type === "date";
    const key = sortKeys.find((k) => k.col === col);
    if (e.shiftKey) {
      if (key) key.dir *= -1;
      else sortKeys.push({ col, dir: 1, isDate });
    } else if (sortKeys.length === 1 && sortKeys[0].col === col) {
      sortKeys[0].dir *= -1;
    } else {
      sortKeys = [{ col, dir: 1, isDate }];
    }
    refetchPage();
  });

  // Paint sort-direction chevrons + multi-key order numbers on the
  // header. Called from fetchAndRender after each (re)render — the
  // header is rebuilt by renderTable, so the indicators reapply.
  function syncSortHeaders() {
    table.querySelectorAll("th.sortable").forEach((h) => {
      const idx = sortKeys.findIndex((k) => k.col === +h.dataset.sort);
      const ic  = h.querySelector(".sort");
      let ord = h.querySelector(".sort-ord");
      h.classList.toggle("sorted", idx !== -1);
      if (idx === -1) {
        if (ic) ic.className = "bi sort bi-chevron-expand";
        if (ord) ord.remove();
      } else {
        if (ic) ic.className = "bi sort " + (sortKeys[idx].dir > 0 ? "bi-chevron-up" : "bi-chevron-down");
        if (sortKeys.length > 1) {
          if (!ord) { ord = document.createElement("sup"); ord.className = "sort-ord"; h.appendChild(ord); }
          ord.textContent = idx + 1;
        } else if (ord) { ord.remove(); }
      }
    });
  }

  // ─── selection ─────────────────────────────────────────────────
  const rowChecks = () => Array.from(tbody.querySelectorAll(".rt-chk"));
  function syncSel() {
    const selectAll = thead.querySelector("#wsSelectAll");
    const checked = rowChecks().filter((c) => c.checked);
    rowChecks().forEach((c) => c.closest("tr").classList.toggle("is-selected", c.checked));
    selCount.textContent = checked.length;
    selChip.classList.toggle("show", checked.length > 0);
    if (selectAll) {
      selectAll.checked = checked.length > 0 && checked.length === rowChecks().length;
      selectAll.indeterminate = checked.length > 0 && checked.length < rowChecks().length;
    }
    const armed = table.classList.contains("mode-select") && checked.length > 0;
    deleteBtn.classList.toggle("armed", armed);
    deleteBtn.title = armed ? "Delete " + checked.length + " selected" : "Delete mode";
  }
  thead.addEventListener("change", (e) => {
    if (e.target.id === "wsSelectAll") {
      rowChecks().forEach((c) => { c.checked = e.target.checked; });
      syncSel();
    }
  });
  tbody.addEventListener("change", (e) => {
    if (e.target.classList.contains("rt-chk")) syncSel();
  });
  selChip.addEventListener("click", () => {
    rowChecks().forEach((c) => { c.checked = false; });
    syncSel();
  });

  // ─── edit / select / delete modes — wired to the step engine ───
  // Cell edits and row deletes hit POST /api/files/:rid/steps with
  // kind=set_cell|drop_rows. The step engine returns the updated frame;
  // we refetchPage() to pick it up (preserves sort/filter/page state,
  // unlike loadFile which would reset). Single-flight: stepInFlight
  // gates concurrent step posts to avoid out-of-order writes.
  const modeBtns = $$(".rt-mode");
  function setMode(btn) {
    const turnOn = !btn.classList.contains("is-active");
    modeBtns.forEach((b) => b.classList.remove("is-active"));
    table.classList.remove("mode-edit", "mode-select", "mode-delete");
    tbody.querySelectorAll("td.editable").forEach((td) => td.removeAttribute("contenteditable"));
    rowChecks().forEach((c) => { c.checked = false; });
    syncSel();
    if (turnOn) {
      btn.classList.add("is-active");
      table.classList.add("mode-" + btn.dataset.mode);
      if (btn.dataset.mode === "edit")
        tbody.querySelectorAll("td.editable").forEach((td) => td.setAttribute("contenteditable", "true"));
    }
  }
  modeBtns.forEach((b) => b.addEventListener("click", () => {
    if (b.dataset.mode === "delete"
        && table.classList.contains("mode-select")
        && rowChecks().some((c) => c.checked)) {
      const indices = rowChecks().filter((c) => c.checked)
        .map((c) => parseInt(c.closest("tr")?.dataset.idx, 10))
        .filter((n) => Number.isFinite(n));
      if (indices.length) applyStep("drop_rows", { indices });
      return;
    }
    setMode(b);
  }));
  tbody.addEventListener("click", (e) => {
    if (!table.classList.contains("mode-delete")) return;
    const tr = e.target.closest("tr");
    if (!tr) return;
    const idx = parseInt(tr.dataset.idx, 10);
    if (Number.isFinite(idx)) applyStep("drop_rows", { indices: [idx] });
  });
  tbody.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && e.target.isContentEditable) {
      e.preventDefault();
      e.target.blur();
    }
  });

  // Cell-edit save — snapshot the value on focus, diff on blur, fire
  // set_cell only when changed. The "—" placeholder for nulls is also
  // the empty signal back to the server (params.value: "" → null).
  tbody.addEventListener("focusin", (e) => {
    const td = e.target.closest("td.editable[contenteditable=\"true\"]");
    if (td) td.dataset.original = td.textContent;
  });
  tbody.addEventListener("focusout", (e) => {
    const td = e.target.closest("td.editable[contenteditable=\"true\"]");
    if (!td) return;
    const original = td.dataset.original ?? "";
    const next = td.textContent;
    if (next === original) { delete td.dataset.original; return; }
    const tr  = td.closest("tr");
    const idx = parseInt(tr?.dataset.idx, 10);
    const column = td.dataset.col;
    if (!Number.isFinite(idx) || !column) return;
    // "—" is the rendered placeholder for null — treat it as a clear.
    const wireValue = (next === "" || next === "—") ? null : next;
    applyStep("set_cell", { row: idx, column, value: wireValue }, () => {
      td.textContent = original;  // revert on error
    });
    delete td.dataset.original;
  });

  // Single-flight POST → refetchPage on success, revert + status on error.
  // Errors land in rowsInfo (the bottom-left status text) so the table
  // stays visible — setTableState would blank it. The /steps response is
  // a StepResult (FileEnvelope + per-step metrics); we consume the
  // envelope bits to keep activeColumns + activeSteps in sync without
  // a second round-trip.
  async function applyStep(kind, params, onError) {
    if (!activeFileRid || stepInFlight) return;
    stepInFlight = true;
    rowsInfo.textContent = "Saving…";
    try {
      const res = await api.post("/files/" + encodeURIComponent(activeFileRid) + "/steps", { kind, params });
      if (res?.columns) activeColumns = res.columns;
      if (res?.steps)   activeSteps   = res.steps;
      syncToolbar();
      await refetchPage();
    } catch (err) {
      const msg = err?.body?.message || err?.body?.error || err?.message || "Save failed";
      rowsInfo.textContent = msg + (err?.status ? " (" + err.status + ")" : "");
      onError?.(err);
    } finally {
      stepInFlight = false;
    }
  }

  // ─── undo / redo / export — toolbar history actions ───────────
  // Undo/redo POST endpoints return the rebuilt FileEnvelope; consume
  // it to keep the toolbar enable state in sync, then refetchPage to
  // reflect the new frame. Export bypasses api.js — the response is
  // a binary stream; the browser handles the download via a click on
  // a hidden <a download>.
  const undoBtn   = $("#wsUndo");
  const redoBtn   = $("#wsRedo");
  const exportBtn = $("#wsExport");
  const exportDd  = $("#wsExportDd");

  async function doUndoRedo(action) {
    if (!activeFileRid || stepInFlight) return;
    stepInFlight = true;
    rowsInfo.textContent = action === "undo" ? "Undoing…" : "Redoing…";
    try {
      const env = await api.post("/files/" + encodeURIComponent(activeFileRid) + "/" + action);
      if (env?.columns) activeColumns = env.columns;
      if (env?.steps)   activeSteps   = env.steps;
      syncToolbar();
      await refetchPage();
    } catch (err) {
      const msg = err?.body?.message || err?.body?.error || err?.message || (action + " failed");
      rowsInfo.textContent = msg + (err?.status ? " (" + err.status + ")" : "");
    } finally {
      stepInFlight = false;
    }
  }
  undoBtn.addEventListener("click", () => doUndoRedo("undo"));
  redoBtn.addEventListener("click", () => doUndoRedo("redo"));

  exportDd.addEventListener("click", (e) => {
    const item = e.target.closest(".rt-dd-item");
    if (!item || !activeFileRid) return;
    const fmt = item.dataset.fmt || "csv";
    // Hidden <a download> triggers the browser's download flow; the
    // server's Content-Disposition: attachment owns the filename.
    const a = document.createElement("a");
    a.href = "/api/files/" + encodeURIComponent(activeFileRid)
           + "/export?format=" + encodeURIComponent(fmt);
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    exportDd.classList.remove("open");
  });

  // Paint enable/disable on the three history-toolbar buttons based
  // on the current envelope state. Undo/redo derive from activeSteps;
  // export is enabled whenever a file is open. Repaints the history
  // panel body on each call so the side panel stays current after
  // every apply/undo/redo.
  function syncToolbar() {
    const canUndo = activeSteps.some((s) => s.applied);
    const canRedo = activeSteps.some((s) => !s.applied);
    undoBtn.disabled   = !canUndo;
    redoBtn.disabled   = !canRedo;
    exportBtn.disabled = !activeFileRid;
    renderHistory();
  }

  // ─── history panel — rendered list of activeSteps ─────────────
  // Applied steps render solid; undone steps (sitting on the redo
  // stack) get .is-undone for the dim opacity. Each row carries the
  // ordinal, kind, a 3-key params summary, and a relative timestamp.
  function renderHistory() {
    const body = $("#wsHistoryBody");
    if (!body) return;
    if (!activeFileRid) {
      body.innerHTML = '<p class="rt-step-state">Open a file to see its step history.</p>';
      return;
    }
    if (!activeSteps.length) {
      body.innerHTML = '<p class="rt-step-state">No steps applied yet.</p>';
      return;
    }
    // Server returns steps in ordinal order; show newest first so the
    // most-recent action is at the top of the panel.
    const ordered = activeSteps.slice().sort((a, b) => (b.ordinal || 0) - (a.ordinal || 0));
    body.innerHTML = ordered.map(renderStep).join("");
  }
  function renderStep(step) {
    const undone = step.applied === false;
    const params = fmtStepParams(step.params);
    return ''
      + '<div class="rt-step' + (undone ? ' is-undone' : '') + '">'
      +   '<span class="rt-step-ord">' + (step.ordinal != null ? step.ordinal : "—") + '</span>'
      +   '<span class="rt-step-body">'
      +     '<span class="rt-step-kind">' + esc(step.kind || "—") + '</span>'
      +     (params ? '<span class="rt-step-params">' + esc(params) + '</span>' : '')
      +   '</span>'
      +   '<span class="rt-step-time">' + fmtRelTime(step.created_at) + '</span>'
      + '</div>';
  }
  // Short summary of step.params — first three key=value pairs, each
  // value JSON-stringified and clipped to 30 chars. Good enough for a
  // glance at the side panel; full inspection is the file's step log.
  function fmtStepParams(params) {
    if (!params || typeof params !== "object") return "";
    try {
      return Object.entries(params).slice(0, 3)
        .map(([k, v]) => {
          const s = typeof v === "string" ? v : JSON.stringify(v);
          return k + "=" + (s && s.length > 30 ? s.slice(0, 30) + "…" : s);
        })
        .join(", ");
    } catch { return ""; }
  }
  function fmtRelTime(iso) {
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return "";
    const s = Math.round((Date.now() - t) / 1000);
    if (s < 60)         return s + "s";
    const m = Math.round(s / 60);
    if (m < 60)         return m + "m";
    const h = Math.round(m / 60);
    if (h < 24)         return h + "h";
    const d = Math.round(h / 24);
    return d + "d";
  }

  // ─── side panels ───────────────────────────────────────────────
  // Filter is left-side (its own real estate). History + Tools both
  // slide from the right and share the same surface — opening one
  // closes the other so they don't overlap.
  function bindPanel(btnSel, panelSel) {
    const btn = $(btnSel), panel = $(panelSel);
    const set = (open) => {
      panel.classList.toggle("open", open);
      btn.classList.toggle("is-active", open);
    };
    btn.addEventListener("click", () => set(!panel.classList.contains("open")));
    panel.querySelector(".rt-panel-close").addEventListener("click", () => set(false));
  }
  bindPanel("#wsFilterToggle", "#wsFilterPanel");

  // Right-side mutual exclusion — clicking one closes the other.
  const RIGHT_PANELS = [
    { btn: "#wsHistoryToggle", panel: "#wsHistoryPanel" },
    { btn: "#wsToolsToggle",   panel: "#wsToolsPanel"   },
  ];
  function toggleRightPanel(target) {
    const wasOpen = $(target.panel).classList.contains("open");
    RIGHT_PANELS.forEach((p) => {
      $(p.panel).classList.remove("open");
      $(p.btn).classList.remove("is-active");
    });
    if (!wasOpen) {
      $(target.panel).classList.add("open");
      $(target.btn).classList.add("is-active");
    }
  }
  RIGHT_PANELS.forEach((p) => {
    $(p.btn).addEventListener("click", () => toggleRightPanel(p));
    $(p.panel).querySelector(".rt-panel-close").addEventListener("click", () => {
      $(p.panel).classList.remove("open");
      $(p.btn).classList.remove("is-active");
    });
  });

  // ─── tools panel — parameterised, one factory + 15 configs ─────
  toolsCtrl = mountTools($("#wsToolsBody"), {
    fileRid: () => activeFileRid,
    columns: () => activeColumns,
    summary: () => activeSummary,  // FileSummary — per-tool context reads
    // After a step lands, the server returned a fresh envelope. The
    // simplest path: re-run loadFile on the same rid (it would normally
    // no-op since the rid is unchanged, so null the cached rid first).
    // Same trick the Refresh button uses.
    onApplied: () => {
      if (!activeFileRid) return;
      const rid = activeFileRid;
      activeFileRid = null;
      loadFile(rid);
    },
  });

  // ─── report builder — second tab in the filter panel ──────────
  // Edits a ReportSpec and previews it via POST /api/group/preview.
  // The builder lives in the filter panel's Report tab; the sample
  // subtotals table renders inline below the builder so the user
  // sees the result without losing the source-data table.
  //
  // Every binding here is null-guarded — when a partial is served
  // from a stale cache (without the new IDs), we don't want mount()
  // to throw and bring the whole page down via the router's error
  // shell, which then breaks the queued loadProjects continuation.
  const reportBody = $("#wsReportBody");
  if (reportBody) {
    reportCtrl = mountReport(reportBody, {
      fileRid: () => activeFileRid,
      columns: () => activeColumns,
      setStatus: (text, kind) => {
        console[(kind === "err" ? "warn" : "log")]("[report]", text);
      },
    });
  }
  const filterTabs = $("#wsFilterTabs");
  if (filterTabs) {
    filterTabs.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-tab]");
      if (!btn) return;
      setFilterPanelTab(btn.dataset.tab);
    });
  }
  // Filter / Report tab switcher in the panel head. The panel widens
  // to 500px when Report is active so the builder + sample preview
  // table have room; back to 250px on Filter.
  function setFilterPanelTab(tab) {
    const panel = $("#wsFilterPanel");
    if (!panel) return;
    panel.querySelectorAll("[data-tab]").forEach((el) => {
      const match = el.dataset.tab === tab;
      if (el.tagName === "BUTTON" && el.parentElement?.id === "wsFilterTabs") {
        el.classList.toggle("is-active", match);
      } else {
        el.hidden = !match;
        if (el.classList.contains("rt-panel-tab")
            || el.classList.contains("rt-panel-tab-foot")) {
          el.classList.toggle("is-active", match);
        }
      }
    });
    panel.classList.toggle("has-report", tab === "report");
    if (tab === "report") reportCtrl?.refresh();
  }
  $("#wsApplyReport")?.addEventListener("click", (e) => reportCtrl?.apply(e.currentTarget));
  $("#wsClearReport")?.addEventListener("click", () => reportCtrl?.clear());

  // ─── designer — canvas + accordion config ─────────────────────
  // Mounts a no-op container at boot; load(chart) lights it up when
  // a chart-typed file is opened in loadFile. Single-tile for now
  // (the opened CHT_); dashboard files (multi-tile, new file_type)
  // are Phase 2. Source data lives on sourceCache (populated when
  // the user visits a data file); designer.js reads it for the
  // Data section + future live-preview from source.
  const designerEl = $("#wsDesigner");
  if (designerEl) {
    designerCtrl = mountDesigner(designerEl, {
      getSource: () => sourceCache,
      onSaved:   (saved) => {
        rowsInfo.textContent = "Chart · " + (saved?.title || "untitled");
        const titleSpan = $("#wsDesignerTitle")?.querySelector("span");
        if (titleSpan) titleSpan.textContent = saved?.title || "Untitled chart";
      },
    });
  }
  // Designer toolbar — config-panel toggle (hides/shows the accordion
  // when the user wants more canvas space).
  $("#wsDesignerCfgToggle")?.addEventListener("click", (e) => {
    const designer = $("#wsDesigner");
    if (!designer) return;
    const wasOpen = !designer.classList.contains("ds-config-hidden");
    designer.classList.toggle("ds-config-hidden", wasOpen);
    e.currentTarget.classList.toggle("is-active", !wasOpen);
    designerCtrl?.resize();
  });

  // Reset data-file state + swap the surface into designer mode.
  // mode = "chart" | "dashboard" — drives the toolbar icon + the
  // Add-chart label so the user knows what kind of file is open.
  function enterDesignerMode(title, mode) {
    activeColumns = [];
    activeSteps   = [];
    activeSummary = null;
    syncToolbar();
    toolsCtrl?.refresh();
    reportCtrl?.refresh();
    $("#wsSurface").classList.add("is-designer-mode");
    $("#wsSurface").dataset.designerKind = mode || "chart";
    const titleSpan = $("#wsDesignerTitle")?.querySelector("span");
    if (titleSpan) titleSpan.textContent = title || "Untitled";
    const titleIcon = $("#wsDesignerTitle")?.querySelector("i");
    if (titleIcon) {
      titleIcon.className = mode === "dashboard"
        ? "bi bi-grid-1x2"
        : "bi bi-bar-chart-line";
    }
    $("#wsTable").hidden  = true;
    $("#wsTableState").hidden = true;
    $("#wsDesigner").hidden = false;
  }
  function exitDesignerMode() {
    $("#wsSurface").classList.remove("is-designer-mode");
    delete $("#wsSurface").dataset.designerKind;
    $("#wsDesigner").hidden = true;
    $("#wsTable").hidden = false;
  }

  // Ensure sourceCache holds the chart's source data file. Fetches
  // /files/:rid for the source if the user opened the chart directly
  // without visiting the source first.
  async function ensureSourceCache(sourceRid) {
    if (!sourceRid) return;
    if (sourceCache.rid === sourceRid && sourceCache.columns.length) return;
    try {
      const env = await api.get("/files/" + encodeURIComponent(sourceRid));
      sourceCache = { rid: sourceRid, columns: env?.columns || [] };
    } catch {
      // Best-effort — designer surfaces "source file unavailable" if
      // it can't fetch. Don't block chart load.
    }
  }

  function syncNewChartButton() {
    const btn = $("#wsNewChart");
    if (!btn) return;
    const hasSource = !!sourceCache.rid && sourceCache.columns.length > 0;
    btn.disabled = !hasSource;
    btn.title = hasSource
      ? "Create a new chart sourced from this file"
      : "Open a data file first; the chart will source from it";
  }
  syncNewChartButton();

  // Create a new chart sourced from the user's current data file.
  // Used by both the rail-foot + New chart button (sourceCache from
  // the open data file) and the designer toolbar's Add chart button
  // (sourceCache = the open chart's source). POST /api/charts +
  // navigate.
  async function createChartFromSource(busyBtn) {
    if (!sourceCache.rid) return;
    if (busyBtn) busyBtn.disabled = true;
    try {
      const firstCol = sourceCache.columns[0]?.name || "";
      const created = await api.post("/charts", {
        source_file_id: sourceCache.rid,
        title:          "Untitled chart",
        spec: {
          kind:     "bar",
          group_by: firstCol,
          agg_col:  "*",
          agg_fn:   "count",
          title:    "",
        },
      });
      const newRid = created?.redpash_id;
      await loadProjects();
      if (newRid) {
        activeFileRid = null;     // force loadFile to re-open
        await loadFile(newRid);
      }
    } catch (err) {
      console.warn("[designer] create failed:", err);
    } finally {
      syncNewChartButton();
    }
  }

  $("#wsNewChart")?.addEventListener("click", (e) => createChartFromSource(e.currentTarget));

  // Designer-toolbar Add chart — branches on context:
  //   In a dashboard → create a new chart sourced from a data file
  //   in the dashboard's project AND append as a widget to the open
  //   dashboard (no navigation, new tile mounts on the canvas).
  //   In a single chart → create + navigate (existing flow).
  $("#wsDesignerAddChart")?.addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    const dashRid = designerCtrl?.getOpenDashboardRid?.();
    if (!dashRid) { createChartFromSource(btn); return; }
    btn.disabled = true;
    try {
      // Resolve a source data file. Preference order:
      //   1. sourceCache (most recently opened data file).
      //   2. First non-chart / non-dashboard file in the dashboard's
      //      own project (covers "user opened the dashboard cold").
      const dashboard = designerCtrl.getOpenDashboard?.();
      const projRid   = dashboard?.project_redpash_id;
      let src = sourceCache;
      if (!src.rid && projRid) {
        const list = await api.get("/projects/" + encodeURIComponent(projRid) + "/files");
        const dataFile = (list?.items || []).find((f) =>
          f.file_type !== "chart" && f.file_type !== "dashboard");
        if (dataFile) {
          const env = await api.get("/files/" + encodeURIComponent(dataFile.redpash_id));
          src = sourceCache = { rid: dataFile.redpash_id, columns: env?.columns || [] };
        }
      }
      if (!src.rid) {
        rowsInfo.textContent = "Add chart: this project has no data file to chart yet — upload one first.";
        return;
      }
      const firstCol = src.columns[0]?.name || "";
      const chart = await api.post("/charts", {
        source_file_id: src.rid,
        title:          "Untitled chart",
        spec: { kind: "bar", group_by: firstCol, agg_col: "*", agg_fn: "count", title: "" },
      });
      // Hand off to the designer — it appends a widget to the open
      // dashboard's spec, PUTs, and mounts the tile.
      await designerCtrl?.addChartWidget?.(chart);
      // Refresh the rail so the new CHT_ row appears alongside.
      await loadProjects();
    } catch (err) {
      console.warn("[designer] addChart failed:", err);
      rowsInfo.textContent = "Add chart failed: " + (err?.body?.message || err?.message || "see console");
    } finally {
      btn.disabled = false;
    }
  });

  // + New dashboard rail button — POST /api/dashboards in the active
  // project (the group containing the active tab; falls back to the
  // first group). Auto-opens the new dashboard.
  function activeProjectRid() {
    const activeTab = navBody.querySelector(".rt-tab.active");
    const group = (activeTab && activeTab.closest(".rt-group"))
               || navBody.querySelector(".rt-group");
    return group?.dataset?.rid || null;
  }
  $("#wsNewDashboard")?.addEventListener("click", async (e) => {
    const projRid = activeProjectRid();
    if (!projRid) {
      console.warn("[designer] + New dashboard: no active project");
      return;
    }
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      const created = await api.post("/dashboards", {
        project_redpash_id: projRid,
        title:              "Untitled dashboard",
        spec:               { template_id: "free", widgets: [] },
      });
      const newRid = created?.redpash_id;
      await loadProjects();
      if (newRid) {
        activeFileRid = null;
        await loadFile(newRid);
      }
    } catch (err) {
      console.warn("[designer] + New dashboard failed:", err);
    } finally {
      btn.disabled = false;
    }
  });

  // ─── refresh — re-fetch the project rail + the open file ──────
  // The rail is lazy by group; we drop the group-loaded marker so the
  // next expand re-fetches files, and re-render the project list from
  // /api/projects. Then re-load the open file (if any) to pick up any
  // server-side changes.
  $("#wsRefresh").addEventListener("click", (e) => {
    const i = e.currentTarget.querySelector("i");
    i.classList.remove("rt-spinning");
    void i.offsetWidth;
    i.classList.add("rt-spinning");
    loadProjects();
    if (activeFileRid) {
      const rid = activeFileRid;
      activeFileRid = null;        // force loadFile to re-run
      loadFile(rid);
    }
  });

  // ─── row numbers toggle — initial state from prefs, persists on click ─
  const rownumBtn = $("#wsRownum");
  const rownumOnAtMount = getPref("showRowNumbers") !== "0";
  rownumBtn.classList.toggle("is-active", rownumOnAtMount);
  table.classList.toggle("no-rownum", !rownumOnAtMount);
  rownumBtn.addEventListener("click", (e) => {
    const on = e.currentTarget.classList.toggle("is-active");
    table.classList.toggle("no-rownum", !on);
    setPref("showRowNumbers", on ? "1" : "0");
  });

  // Dropdown toggles (rows-per-page, columns) handled centrally
  // by /scripts/dropdown.js — bindDropdown() at app boot in main.js.

  // Rows-per-page — setPref persists through prefs.js (server PATCH +
  // local cache + the unified rp-pref-rowsPerPage key). The numeric
  // pageSize stays a workspace-local concern (the "all" wire value
  // expands to ALL_ROWS_SIZE for the fetch).
  syncRowsDropdown();
  $("#wsRowsDd").addEventListener("click", (e) => {
    const item = e.target.closest(".rt-dd-item");
    if (!item) return;
    const raw = item.dataset.rows;
    setPref("rowsPerPage", raw);
    pageSize = raw === "all" ? ALL_ROWS_SIZE : parseInt(raw, 10) || DEFAULT_PAGE_SIZE;
    currentPage = 1;
    syncRowsDropdown();
    refetchPage();
  });
  function syncRowsDropdown() {
    const raw = getPref("rowsPerPage");
    $("#wsRowsDd").querySelectorAll(".rt-dd-item").forEach((i) => {
      i.classList.remove("selected");
      const t = i.querySelector(".tick");
      if (t) t.remove();
    });
    const sel = $("#wsRowsDd").querySelector('.rt-dd-item[data-rows="' + raw + '"]')
      || $("#wsRowsDd").querySelector('.rt-dd-item[data-rows="' + DEFAULT_PAGE_SIZE + '"]');
    if (sel) {
      sel.classList.add("selected");
      sel.insertAdjacentHTML("beforeend", ' <i class="bi bi-check2 tick"></i>');
    }
    $("#wsRowsLabel").textContent = raw === "all" ? "All rows" : raw + " rows";
  }
  $("#wsColsDd").addEventListener("click", (e) => e.stopPropagation());

  // ─── pager — prev / numbers / ellipsis / next ──────────────────
  // Compact window: always show 1 and last; show current ±1; collapse
  // the rest with gaps. Disabled prev/next render as <button disabled>
  // so the CSS :disabled selector handles them.
  const pagesEl = $("#wsPages");
  function renderPager() {
    if (!activeFileRid || totalPages < 1) { pagesEl.innerHTML = ""; return; }
    const p = currentPage, last = totalPages;
    const out = [];
    out.push(pgBtn("‹", p - 1, false, p === 1));
    if (last <= 7) {
      for (let i = 1; i <= last; i++) out.push(pgBtn(String(i), i, i === p, false));
    } else {
      const want = new Set([1, last, p, p - 1, p + 1]);
      let prev = 0;
      for (let i = 1; i <= last; i++) {
        if (!want.has(i)) continue;
        if (i - prev > 1) out.push('<span class="rt-pg-gap">…</span>');
        out.push(pgBtn(String(i), i, i === p, false));
        prev = i;
      }
    }
    out.push(pgBtn("›", p + 1, false, p === last));
    pagesEl.innerHTML = out.join("");
  }
  function pgBtn(label, page, active, disabled) {
    return '<button class="rt-pg' + (active ? " active" : "") + '" type="button"'
      + (disabled ? " disabled" : ' data-page="' + page + '"') + ">" + label + "</button>";
  }
  pagesEl.addEventListener("click", (e) => {
    const btn = e.target.closest(".rt-pg[data-page]");
    if (!btn) return;
    const target = parseInt(btn.dataset.page, 10);
    if (!Number.isFinite(target) || target < 1 || target > totalPages || target === currentPage) return;
    currentPage = target;
    refetchPage();
  });

}
