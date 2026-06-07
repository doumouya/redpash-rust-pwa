/* Purpose: see doc for details.
 * Doc: docs/internal/code/frontend/scripts/pages/dashboard.md */
// Dashboard page — the standalone chart + dashboard designer (Studio app, Slice D).
//
// Split out of the Workspace page's Data↔Dashboards rail-toggle: this page owns
// the designer surface ONLY. The rail lists each project's charts + dashboards
// (file_type chart/dashboard); the data SOURCE for new charts is a project-wide
// CSV picker (#dashSourceDd) — ANY project CSV, including SheetWise materialized
// results + connector pulls (they're plain file_type='csv' rows) — NOT a single
// active Workspace file. designer.js is mounted UNCHANGED: it's already
// ctx-polymorphic (getSource = the picked CSV, getSourceFiles = all project CSVs;
// each chart tile carries its own source_file_id).
//
// v1 scope: browse + open + create charts/dashboards from a picked source. The
// rail's rename/hide/upload/deep-link apparatus is deliberately NOT duplicated
// here — the proven-common rail core gets extracted (D0') into a shared module
// that both this page and Workspace compose; this page is the second consumer
// that reveals that shared surface.

import { api } from "/scripts/api.js";
import { mountTopbar } from "/scripts/topbar.js";
import { mountRailFooterNav } from "/scripts/rail-footer.js";
import { mountRailCollapse } from "/scripts/rail-controls.js";
import { mountDesigner } from "/scripts/designer.js";
import { getPref } from "/scripts/prefs.js";
import { esc, cssEsc } from "/scripts/dom.js";

const STAGE_DOT   = { new: "is-dirty", clean: "is-warn", design: "is-clean", publish: "is-clean" };
const MARK_COLORS = ["blue", "mauve", "teal", "peach"];

export default function dashboard(app, { session }) {
  const $ = (s) => app.querySelector(s);
  const meRid = session?.redpash_id || "";

  // Topbar derives the Studio app from active="dashboard" via apps.js appForPage
  // (Slice A). Footer nav (Docs/Settings/theme/sign-out) coexists with the
  // rail-foot create button — mountRailFooterNav only manages .rp-rail-footer-nav.
  mountTopbar($("#rp-topbar"), { active: "dashboard", session });
  mountRailFooterNav($(".rp-rail-footer"), { active: "", session });

  // ─── refs ───────────────────────────────────────────────────────
  const nav         = $("#dashNav");
  const navBody     = $("#dashNavBody");
  const designerEl  = $("#dashDesigner");
  const sourceLabel = $("#dashSourceLabel");
  const sourceDd    = $("#dashSourceDd");
  const statusEl    = $("#dashStatus");

  mountRailCollapse(nav, $("#dashNavCollapse"));

  // ─── state ──────────────────────────────────────────────────────
  let cachedProjects     = [];
  let groupColorIdx      = 0;
  let focusedProjectRid  = null;
  let activeFileRid      = null;
  let designerCtrl       = null;
  let sourceCache        = { rid: null, columns: [] };       // the PICKED source CSV → getSource()
  let projectSourceFiles = { projRid: null, files: [] };     // ALL project CSVs → getSourceFiles()
  let railSearchQ        = "";
  let ownerFilter        = "all";

  function setStatus(msg) { if (statusEl) statusEl.textContent = msg || ""; }
  function setTitle(title, mode) {
    const head = $("#dashTitle");
    const t = head?.querySelector("span");
    const i = head?.querySelector("i");
    if (t) t.textContent = title || "Untitled";
    if (i) i.className = mode === "dashboard" ? "bi bi-grid-1x2" : "bi bi-bar-chart-line";
  }

  // ─── designer (mounted UNCHANGED — already ctx-polymorphic) ─────
  if (designerEl) {
    designerCtrl = mountDesigner(designerEl, {
      getSource:      () => sourceCache,             // the picked project CSV
      getSourceFiles: () => projectSourceFiles.files, // all project CSVs (per-tile dropdown)
      onSaved: (saved) => {
        if (!saved) { setStatus("Chart deleted."); loadProjects(); return; }
        setStatus("Saved · " + (saved.title || "untitled"));
        setTitle(saved.title || "Untitled");
        loadProjects(); // a save can change the rail stage dot / add a row
      },
      onDashboardSaveUnavailable: () => {
        setStatus("Open or create a dashboard to save a multi-chart layout — a single chart saves via its own tile.");
      },
    });
    designerCtrl?.load(null); // show the designer's own empty state until a file opens
  }

  // ─── designer toolbar — config toggle + Add chart ──────────────
  $("#dashCfgToggle")?.addEventListener("click", (e) => {
    const wasOpen = !designerEl.classList.contains("rp-dash-config-hidden");
    designerEl.classList.toggle("rp-dash-config-hidden", wasOpen);
    e.currentTarget.classList.toggle("is-active", !wasOpen);
    designerCtrl?.resize();
  });
  // Add chart: on a real dashboard append a widget; on a standalone chart
  // (synthetic wrapper, no DSH_ rid) promote it to a real dashboard first.
  $("#dashAddChart")?.addEventListener("click", async (e) => {
    const btn = e.currentTarget; btn.disabled = true;
    try {
      if (!designerCtrl?.getOpenDashboardRid?.()) {
        const promoted = await promoteChartToDashboard();
        if (!promoted) return; // message already surfaced
      }
      await addChartToOpenDashboard();
    } catch (err) {
      console.warn("[dashboard] addChart failed:", err);
      setStatus("Add chart failed: " + (err?.body?.message || err?.message || "see console"));
    } finally { btn.disabled = false; }
  });

  // ─── rail-foot — New dashboard ─────────────────────────────────
  $("#dashCreate")?.addEventListener("click", async (e) => {
    const btn = e.currentTarget; btn.disabled = true;
    try { await createDashboard(); } finally { btn.disabled = false; }
  });

  // ─── source picker — the project-wide CSV list (the core of Slice D) ──
  // [data-dd] open/close is the global bindDropdown handler (main.js); the
  // item click below runs first (bubble), then the document handler closes.
  function renderSourcePicker() {
    const files = projectSourceFiles.files;
    if (!files.length) {
      sourceDd.innerHTML = '<div class="rp-menu-item" data-empty="1">No data files in this project</div>';
      if (!sourceCache.rid) sourceLabel.textContent = "No data file";
      return;
    }
    sourceDd.innerHTML = files.map((f) =>
      '<div class="rp-menu-item' + (f.rid === sourceCache.rid ? " selected" : "") + '" data-source="' + esc(f.rid) + '">'
      + esc(f.name) + (f.rid === sourceCache.rid ? ' <i class="bi bi-check2 rp-menu-tick"></i>' : "")
      + '</div>').join("");
  }
  sourceDd?.addEventListener("click", async (e) => {
    const item = e.target.closest(".rp-menu-item[data-source]");
    if (item) await setSource(item.dataset.source);
  });
  async function setSource(rid) {
    const f = projectSourceFiles.files.find((x) => x.rid === rid);
    sourceLabel.textContent = f?.name || "Data file";
    try {
      const env = await api.get("/files/" + encodeURIComponent(rid));
      sourceCache = { rid, columns: env?.columns || [] };
    } catch { sourceCache = { rid, columns: [] }; }
    renderSourcePicker();
  }
  // Refresh the focused project's CSV list + default the picked source to its
  // first CSV (incl. SheetWise/connector outputs — all file_type='csv').
  async function refreshSources(projRid) {
    if (!projRid) return;
    try {
      const list = await api.get("/projects/" + encodeURIComponent(projRid) + "/files");
      const files = (list?.items || [])
        .filter((f) => f.file_type !== "chart" && f.file_type !== "dashboard")
        .map((f) => ({ rid: f.redpash_id, name: f.display_name || f.filename || f.redpash_id }));
      projectSourceFiles = { projRid, files };
      if (!sourceCache.rid || !files.some((f) => f.rid === sourceCache.rid)) {
        if (files.length) { await setSource(files[0].rid); return; }
        sourceCache = { rid: null, columns: [] };
      }
      renderSourcePicker();
    } catch { /* keep prior cache */ }
  }

  // ─── rail — projects → their charts + dashboards ───────────────
  async function loadProjects() {
    try {
      const data = await api.get("/projects");
      cachedProjects = data?.items || [];
      renderRail(cachedProjects);
    } catch (err) {
      navBody.setAttribute("aria-busy", "false");
      navBody.innerHTML = '<div class="rp-rail-state">Couldn’t load projects'
        + (err.status ? " (" + err.status + ")" : "") + ".</div>";
    }
  }
  function renderRail(items) {
    navBody.setAttribute("aria-busy", "false");
    groupColorIdx = 0;
    if (!items.length) { navBody.innerHTML = '<div class="rp-rail-state">No projects yet.</div>'; return; }
    navBody.innerHTML = items.map(projectGroup).join("");
    applyRailFilters();
    // Expand the default/first group for context + seed the source picker.
    const first = navBody.querySelector('.rp-rail-group[data-default="1"]') || navBody.querySelector(".rp-rail-group");
    if (first) {
      first.classList.add("expanded");
      if (!focusedProjectRid) focusedProjectRid = first.dataset.rid || null;
      loadFilesForGroup(first);
      refreshSources(first.dataset.rid);
    }
  }
  function projectGroup(p) {
    const c = MARK_COLORS[(groupColorIdx++) % MARK_COLORS.length];
    const initials = ((p.name || "?").trim().split(/\s+/).map((w) => w[0]).join("") || "?").slice(0, 2).toUpperCase();
    const ownership = [p.owner_id === meRid ? "personal" : "shared"];
    if (p.company_id) ownership.push("company");
    return '<div class="rp-rail-group" data-rid="' + esc(p.redpash_id) + '"'
      + ' data-ownership="' + ownership.join(" ") + '"' + (p.is_default ? ' data-default="1"' : '') + '>'
      +   '<button class="rp-rail-group-head" type="button">'
      +     '<i class="bi bi-chevron-down rp-rail-group-caret"></i>'
      +     '<span class="rp-rail-group-mark" data-c="' + c + '">' + esc(initials) + '</span>'
      +     '<span class="rp-rail-group-name">' + esc(p.name) + '</span>'
      +     '<span class="rp-rail-group-count">' + (p.file_count || 0) + '</span>'
      +   '</button>'
      +   '<div class="rp-rail-group-body" aria-busy="false"></div>'
      + '</div>';
  }
  async function loadFilesForGroup(group) {
    if (!group || group.dataset.filesLoaded === "1") return;
    const body = group.querySelector(".rp-rail-group-body");
    const rid  = group.dataset.rid;
    body.setAttribute("aria-busy", "true");
    body.innerHTML = '<div class="rp-rail-state">Loading…</div>';
    try {
      const data  = await api.get("/projects/" + encodeURIComponent(rid) + "/files");
      const items = (data?.items || []).filter((f) => f.file_type === "chart" || f.file_type === "dashboard");
      body.innerHTML = items.length ? items.map(fileTab).join("")
        : '<div class="rp-rail-state">No charts or dashboards yet.</div>';
      group.dataset.filesLoaded = "1";
      const badge = group.querySelector(":scope > .rp-rail-group-head .rp-rail-group-count");
      if (badge) badge.textContent = String(items.length);
    } catch {
      body.innerHTML = '<div class="rp-rail-state">Couldn’t load files.</div>';
    } finally { body.setAttribute("aria-busy", "false"); }
  }
  function fileTab(f) {
    const dot  = STAGE_DOT[f.stage] || "is-clean";
    const name = f.display_name || f.filename || "(unnamed)";
    const icon = f.file_type === "dashboard" ? "bi-grid-1x2" : "bi-bar-chart-line";
    return '<button class="rp-rail-tab" type="button" data-rid="' + esc(f.redpash_id) + '">'
      +   '<i class="bi ' + icon + ' rp-rail-tab-icon"></i>'
      +   '<span class="rp-rail-tab-name">' + esc(name) + '</span>'
      +   '<span class="rp-rail-tab-dot ' + dot + '" title="' + esc(f.stage || "") + '"></span>'
      + '</button>';
  }
  // Client-side render-time filter (search + ownership) — toggles group
  // visibility, never the data source.
  function applyRailFilters() {
    const q = railSearchQ.trim().toLowerCase();
    navBody.querySelectorAll(".rp-rail-group").forEach((g) => {
      const tokens  = (g.dataset.ownership || "").split(/\s+/).filter(Boolean);
      const ownerOk = ownerFilter === "all" || tokens.includes(ownerFilter);
      const name    = (g.querySelector(".rp-rail-group-name")?.textContent || "").toLowerCase();
      g.hidden = !(ownerOk && (!q || name.includes(q)));
    });
  }

  // rail delegator — open a file, or expand/collapse a project group
  navBody.addEventListener("click", (e) => {
    const tab = e.target.closest(".rp-rail-tab");
    if (tab) { loadFile(tab.dataset.rid); return; }
    const head = e.target.closest(".rp-rail-group-head");
    if (head) {
      const group = head.closest(".rp-rail-group");
      const expanded = group.classList.toggle("expanded");
      focusedProjectRid = group.dataset.rid || focusedProjectRid;
      if (expanded) { loadFilesForGroup(group); refreshSources(group.dataset.rid); }
    }
  });

  // rail search + ownership pills
  $("#dashRailSearch")?.addEventListener("input", (e) => { railSearchQ = e.target.value || ""; applyRailFilters(); });
  $("#dashOwnerFilter")?.addEventListener("click", (e) => {
    const chip = e.target.closest("[data-owner]");
    if (!chip) return;
    ownerFilter = chip.dataset.owner || "all";
    $("#dashOwnerFilter").querySelectorAll(".rp-chip").forEach((c) => c.classList.toggle("is-active", c === chip));
    applyRailFilters();
  });

  // ─── open an existing chart / dashboard ────────────────────────
  // A standalone chart renders wrapped as a synthetic 1-widget dashboard
  // (redpash_id=null) — designer.js + the Add-chart promote path recognise it.
  function chartAsDashboard(chart) {
    if (!chart) return null;
    return {
      redpash_id: null,
      project_redpash_id: chart.project_redpash_id || null,
      title: chart.title || "Untitled chart",
      description: null,
      folder: null,
      spec: { template_id: "", widgets: [{ slot: "w1", kind: "chart", spec: { chart_id: chart.redpash_id } }] },
    };
  }
  async function loadFile(rid) {
    if (!rid || rid === activeFileRid) return;
    activeFileRid = rid;
    setStatus("");
    try {
      if (rid.startsWith("CHT_")) {
        const chart = await api.get("/charts/" + encodeURIComponent(rid));
        if (chart?.project_redpash_id) { focusedProjectRid = chart.project_redpash_id; await refreshSources(chart.project_redpash_id); }
        setTitle(chart?.title || "Untitled chart", "chart");
        designerCtrl?.load({ type: "dashboard", dashboard: chartAsDashboard(chart) });
      } else {
        const dash = await api.get("/dashboards/" + encodeURIComponent(rid));
        if (dash?.project_redpash_id) { focusedProjectRid = dash.project_redpash_id; await refreshSources(dash.project_redpash_id); }
        setTitle(dash?.title || "Untitled dashboard", "dashboard");
        designerCtrl?.load({ type: "dashboard", dashboard: dash });
      }
    } catch (err) {
      console.warn("[dashboard] loadFile failed:", err);
      activeFileRid = null;
      setStatus("Couldn’t open this file — see console.");
    }
  }

  // ─── create flows ──────────────────────────────────────────────
  function activeProjectRid() {
    return focusedProjectRid
      || navBody.querySelector('.rp-rail-group[data-default="1"]')?.dataset?.rid
      || navBody.querySelector(".rp-rail-group")?.dataset?.rid
      || null;
  }
  async function createDashboard() {
    const projRid = activeProjectRid();
    if (!projRid) { setStatus("New dashboard: open or create a project first."); return; }
    try {
      const created = await api.post("/dashboards", {
        project_redpash_id: projRid,
        title: "Untitled dashboard",
        spec: { template_id: "free", widgets: [] },
      });
      const newRid = created?.redpash_id;
      const group = navBody.querySelector('.rp-rail-group[data-rid="' + cssEsc(projRid) + '"]');
      if (group) delete group.dataset.filesLoaded; // force re-list so the new row shows
      await loadProjects();
      if (newRid) { activeFileRid = null; await loadFile(newRid); }
    } catch (err) {
      console.warn("[dashboard] New dashboard failed:", err);
      setStatus("New dashboard failed — see console.");
    }
  }
  // Append a chart (from the picked source) to the open REAL dashboard.
  async function addChartToOpenDashboard() {
    if (!designerCtrl?.getOpenDashboardRid?.()) return false;
    if (!sourceCache.rid) { setStatus("Add chart: pick a data source in the toolbar first."); return true; }
    const firstCol    = sourceCache.columns[0]?.name || "";
    const defaultKind = getPref("workspace-defaultChartKind") || "bar";
    const chart = await api.post("/charts", {
      source_file_id: sourceCache.rid,
      title: "Untitled chart",
      spec: { kind: defaultKind, group_by: firstCol, agg_col: "*", agg_fn: "count", title: "" },
    });
    await designerCtrl?.addChartWidget?.(chart);
    loadProjects(); // the new CHT_ appears in the rail
    return true;
  }
  // Promote a standalone chart (synthetic wrapper) into a real dashboard
  // containing it, then open that dashboard — so Add chart is never a no-op.
  async function promoteChartToDashboard() {
    const synthetic = designerCtrl?.getOpenDashboard?.();
    const chartRid = synthetic?.spec?.widgets?.[0]?.spec?.chart_id
                  || (activeFileRid?.startsWith("CHT_") ? activeFileRid : null);
    const projRid  = synthetic?.project_redpash_id || focusedProjectRid;
    if (!chartRid || !projRid) { setStatus("Add chart: couldn’t resolve this chart’s project."); return null; }
    const created = await api.post("/dashboards", {
      project_redpash_id: projRid,
      title: "Untitled dashboard",
      spec: { template_id: "free", widgets: [{ slot: "w1", kind: "chart", spec: { chart_id: chartRid } }] },
    });
    const newRid = created?.redpash_id;
    if (!newRid) return null;
    await loadProjects();
    activeFileRid = null;
    await loadFile(newRid);
    return newRid;
  }

  // ─── init ──────────────────────────────────────────────────────
  loadProjects();
}
