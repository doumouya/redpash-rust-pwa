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
// D0' (2026-06-07): the rail is the framework `mountRail` component (the same one
// admin-console / sheetwise / database use) — this page no longer hand-builds the
// projects→files tree. The page holds a groups data-model (cachedProjects +
// filesByGroup + expanded) and re-renders via rail.setGroups(buildGroups());
// mountRail owns the markup, collapse, search/chips wiring, and footer.

import { api } from "/scripts/api.js";
import { mountTopbar } from "/scripts/topbar.js";
import { mountRail } from "/scripts/framework/rail.js";
import { mountDesigner } from "/scripts/designer.js";
import { getPref } from "/scripts/prefs.js";
import { esc } from "/scripts/dom.js";

const STAGE_DOT = { new: "is-dirty", clean: "is-warn", design: "is-clean", publish: "is-clean" };
// Group-mark colours as CSS tokens (mountRail fills the mark square via --mark).
const MARK_COLORS = ["var(--rp-info)", "var(--rp-mauve)", "var(--rp-teal)", "var(--rp-peach)"];

export default function dashboard(app, { session }) {
  const $ = (s) => app.querySelector(s);
  const meRid = session?.redpash_id || "";

  // Topbar derives the Studio app from active="dashboard" via apps.js appForPage.
  mountTopbar($("#rp-topbar"), { active: "dashboard", session });

  // ─── refs ───────────────────────────────────────────────────────
  const designerEl  = $("#dashDesigner");
  const sourceLabel = $("#dashSourceLabel");
  const sourceDd    = $("#dashSourceDd");
  const statusEl    = $("#dashStatus");

  // ─── state ──────────────────────────────────────────────────────
  let cachedProjects     = [];                              // /projects roster
  const filesByGroup     = new Map();                       // projRid → tabs[] (lazy)
  const expanded         = new Set();                       // expanded group rids
  let focusedProjectRid  = null;
  let activeFileRid      = null;
  let designerCtrl       = null;
  let creating           = false;                           // New-dashboard in-flight guard
  let sourceCache        = { rid: null, columns: [] };      // the PICKED source CSV → getSource()
  let projectSourceFiles = { projRid: null, files: [] };    // ALL project CSVs → getSourceFiles()
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

  // ─── rail (framework component — same as admin/sheetwise/database) ──
  const rail = mountRail($("#dashNav"), {
    title: "Dashboards",
    collapsible: true,
    search: { placeholder: "Search projects…", onInput: (q) => { railSearchQ = q; refreshRail(); } },
    chips: [
      { value: "all",      label: "All", active: true },
      { value: "personal", label: "Personal" },
      { value: "shared",   label: "Shared" },
      { value: "company",  label: "Company" },
    ],
    onChip: (v) => {
      ownerFilter = v;
      rail.el.querySelectorAll(".rp-rail-chips .rp-chip").forEach((c) => c.classList.toggle("is-active", c.dataset.chip === v));
      refreshRail();
    },
    groups: [],
    footer: { create: { label: "New dashboard" }, nav: { active: "", session } },
    on: {
      tab: (tabId) => loadFile(tabId),
      groupToggle: (groupId, collapsed) => {
        if (collapsed) expanded.delete(groupId); else expanded.add(groupId);
        focusedProjectRid = groupId;
        if (!collapsed) { loadFilesForGroup(groupId); refreshSources(groupId); }
      },
      create: () => createDashboard(),
    },
  });

  // ─── rail data-model → mountRail groups ────────────────────────
  function ownershipTokens(p) {
    const t = [p.owner_id === meRid ? "personal" : "shared"];
    if (p.company_id) t.push("company");
    return t;
  }
  function matchesFilters(p) {
    const ownerOk = ownerFilter === "all" || ownershipTokens(p).includes(ownerFilter);
    const q = railSearchQ.trim().toLowerCase();
    const nameOk = !q || (p.name || "").toLowerCase().includes(q);
    return ownerOk && nameOk;
  }
  function buildGroups() {
    let ci = 0;
    return cachedProjects.filter(matchesFilters).map((p) => {
      const id   = p.redpash_id;
      const tabs = (filesByGroup.get(id) || []).map((f) => ({
        id:   f.redpash_id,
        name: f.display_name || f.filename || "(unnamed)",
        icon: f.file_type === "dashboard" ? "bi-grid-1x2" : "bi-bar-chart-line",
        dot:  STAGE_DOT[f.stage] || "is-clean",
        active: f.redpash_id === activeFileRid,
      }));
      return {
        id, name: p.name,
        mark: MARK_COLORS[(ci++) % MARK_COLORS.length],
        // Before a group is expanded its file list isn't loaded — show the
        // server's roster count; once loaded, the rendered (chart/dashboard) count.
        count: filesByGroup.has(id) ? tabs.length : (p.file_count || 0),
        collapsed: !expanded.has(id),
        tabs,
      };
    });
  }
  function refreshRail() { rail?.setGroups(buildGroups()); }

  // Lazy-load a group's chart/dashboard files on first expand, then re-render.
  async function loadFilesForGroup(rid) {
    if (!rid || filesByGroup.has(rid)) return;
    try {
      const data = await api.get("/projects/" + encodeURIComponent(rid) + "/files");
      filesByGroup.set(rid, (data?.items || []).filter((f) => f.file_type === "chart" || f.file_type === "dashboard"));
    } catch { filesByGroup.set(rid, []); }
    refreshRail();
  }

  async function loadProjects() {
    try {
      const data = await api.get("/projects");
      cachedProjects = data?.items || [];
    } catch (err) {
      setStatus("Couldn’t load projects" + (err.status ? " (" + err.status + ")" : "") + ".");
      rail?.setGroups([]);
      return;
    }
    // Seed a focused/expanded group (a #/dashboard?source= deep-link may have
    // pre-set focusedProjectRid; else the default/first project).
    if (!focusedProjectRid) {
      const def = cachedProjects.find((p) => p.is_default) || cachedProjects[0];
      focusedProjectRid = def?.redpash_id || null;
    }
    if (focusedProjectRid) expanded.add(focusedProjectRid);
    refreshRail();
    if (focusedProjectRid) { await loadFilesForGroup(focusedProjectRid); await refreshSources(focusedProjectRid); }
  }

  // ─── designer (mounted UNCHANGED — already ctx-polymorphic) ─────
  if (designerEl) {
    designerCtrl = mountDesigner(designerEl, {
      getSource:      () => sourceCache,             // the picked project CSV
      getSourceFiles: () => projectSourceFiles.files, // all project CSVs (per-tile dropdown)
      onSaved: (saved) => {
        if (!saved) { setStatus("Chart deleted."); reloadFocusedGroup(); return; }
        setStatus("Saved · " + (saved.title || "untitled"));
        setTitle(saved.title || "Untitled");
        reloadFocusedGroup(); // a save can change the rail stage dot / add a row
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
      refreshRail(); // re-highlight the active tab
    } catch (err) {
      console.warn("[dashboard] loadFile failed:", err);
      activeFileRid = null;
      setStatus("Couldn’t open this file — see console.");
    }
  }

  // ─── create flows ──────────────────────────────────────────────
  function activeProjectRid() {
    return focusedProjectRid
      || cachedProjects.find((p) => p.is_default)?.redpash_id
      || cachedProjects[0]?.redpash_id
      || null;
  }
  // Invalidate the focused group's file cache + reload the roster so a freshly
  // created/saved chart or dashboard row appears in the rail.
  async function reloadFocusedGroup() {
    if (focusedProjectRid) filesByGroup.delete(focusedProjectRid);
    await loadProjects();
  }
  async function createDashboard() {
    if (creating) return;
    creating = true;
    try {
      const projRid = activeProjectRid();
      if (!projRid) { setStatus("New dashboard: open or create a project first."); return; }
      const created = await api.post("/dashboards", {
        project_redpash_id: projRid,
        title: "Untitled dashboard",
        spec: { template_id: "free", widgets: [] },
      });
      const newRid = created?.redpash_id;
      filesByGroup.delete(projRid);     // force the group to re-list
      expanded.add(projRid);
      focusedProjectRid = projRid;
      await loadProjects();
      if (newRid) { activeFileRid = null; await loadFile(newRid); }
    } catch (err) {
      console.warn("[dashboard] New dashboard failed:", err);
      setStatus("New dashboard failed — see console.");
    } finally { creating = false; }
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
    reloadFocusedGroup(); // the new CHT_ appears in the rail
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
    filesByGroup.delete(projRid);
    expanded.add(projRid);
    focusedProjectRid = projRid;
    await loadProjects();
    activeFileRid = null;
    await loadFile(newRid);
    return newRid;
  }

  // ─── init ──────────────────────────────────────────────────────
  // Optional deep-link #/dashboard?source=<FIL_rid> — the Workspace per-row
  // "Visualize" affordance (Slice D) lands here: focus that file's project
  // and pre-pick it as the chart source. Best-effort — an unknown or
  // non-data rid just falls back to the default first-CSV pick.
  (async () => {
    const qs = location.hash.split("?")[1];
    const wantSource = qs ? new URLSearchParams(qs).get("source") : null;
    if (wantSource) {
      try {
        const env = await api.get("/files/" + encodeURIComponent(wantSource));
        const ft  = env?.summary?.file_type;
        if (env?.summary?.project_redpash_id && ft !== "chart" && ft !== "dashboard") {
          focusedProjectRid = env.summary.project_redpash_id;
        }
      } catch { /* unknown rid — fall through to the default pick */ }
    }
    await loadProjects();
    if (wantSource && focusedProjectRid) {
      await refreshSources(focusedProjectRid);
      if (projectSourceFiles.files.some((f) => f.rid === wantSource)) await setSource(wantSource);
    }
  })();
}
