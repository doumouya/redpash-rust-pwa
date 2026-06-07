/* Purpose: see doc for details.
   Doc: docs/internal/code/frontend/scripts/pages/sheetwise.md */
// SheetWise — the SQL console (view 1) + Connectors (view 2), conformed to the
// canonical rail-shell. The rail (mountRail) carries the SQL↔Connectors toggle
// (rp-rail-views data-rail-seg) + the per-view groups (Sources/Targets · the
// connectors); the surface holds the editor (mountEditorCode) + result
// (mountRedTable + mountPager), or the connector guidance. Every block is a
// framework component — the page owns only behaviour + the rp-sw-* positioning.
//
// View 1 (SQL): the active SOURCE file is queried as table `t` via the read-only
// POST /api/files/:rid/sql substrate; a result can be materialized into a new
// TARGET file (POST …/sql/materialize). View 2 (Connectors): each connector is a
// rail tab — click to pull (extracts the source table into a CSV in its project,
// POST …/sync), rename (PATCH) / delete (DELETE) on the tab affordances, "New
// connector" opens the create modal. The live source is never mutated.

import { mountTopbar } from "/scripts/topbar.js";
import { mountRail } from "/scripts/framework/rail.js";
import { mountEditorCode } from "/scripts/framework/editor-code.js";
import { mountRedTable } from "/scripts/framework/redtable.js";
import { mountPager } from "/scripts/framework/pager.js";
import { mountChipRow } from "/scripts/framework/chip-row.js";
import { openModal } from "/scripts/framework/modal.js";

export default function sheetwise(app, { session }) {
  const $ = (s) => app.querySelector(s);

  mountTopbar($("#rp-topbar"), { active: "sheetwise", session });

  const state = {
    view: "sql", files: [], activeRid: null, targets: [],
    connectors: [], connLoaded: false,
    page: 1, size: 50, total: 0, pages: 1, lastSql: "",
  };

  // Self-contained fetch wrapper (same-origin cookie session) — kept local so the
  // SheetWise-specific 401 message + raw /api/files/:rid/sql paths stay identical
  // to the proven path.
  async function api(path, opts) {
    const r = await fetch(path, opts);
    if (r.status === 401) throw Object.assign(new Error("Not signed in — reload the app and log in."), { status: 401 });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(body.error || ("HTTP " + r.status)), { status: r.status, body });
    return body;
  }
  const mkBtn = (html, cls, on) => {
    const b = document.createElement("button"); b.type = "button"; b.className = cls;
    b.innerHTML = html; b.addEventListener("click", on); return b;
  };
  const setErr = (msg) => { const e = $("#swErr"); e.textContent = msg || ""; e.hidden = !msg; };

  // ── SQL editor (framework component) — the one genuine page-content surface ──
  const editor = mountEditorCode($("#swEditor"), {
    language: "sql", ariaLabel: "SQL query", placeholder: "SELECT * FROM t LIMIT 100",
    bar: true, hint: "Query the active table as t · ⌘/Ctrl+Enter to run",
    onRun: () => run(),
  });
  editor.actions.append(
    mkBtn("Clear", "rp-btn-icon rp-btn-icon--ghost", () => { editor.setValue(""); editor.focus(); }),
    mkBtn('<i class="bi bi-play-fill"></i><span>Run</span>', "rp-btn-icon rp-btn-icon--accent", () => run()),
  );

  // ── result pager (framework component) ──
  const pager = mountPager($("#swPager"), { onPage: (n) => { state.page = n; run(state.lastSql); } });
  $("#swSave").addEventListener("click", saveTarget);
  $("#swConnNew").addEventListener("click", openNewConnectorModal);

  // ════ rail (framework component) — toggle + per-view groups ════
  const rail = mountRail($("#swRail"), {
    title: "SheetWise",
    collapsible: true,
    views: {
      pref: "sheetwiseRailView", fallback: "sql",
      options: [
        { value: "sql", label: "SQL", icon: "bi-database-gear" },
        { value: "connectors", label: "Connectors", icon: "bi-plug" },
      ],
      onChange: switchView,
    },
    groups: sqlGroups(),
    footer: { nav: { active: "", session } },
    on: {
      tab: onRailTab,
      tabRename: onRailTabRename,
      tabHide: onRailTabHide,
      groupAdd: () => openNewConnectorModal(),
    },
  });

  // ── rail group builders (re-rendered via rail.setGroups on view/data change) ──
  function sqlGroups() {
    const sources = state.files.map((f) => ({
      id: f.redpash_id, name: f.filename, icon: "bi-file-earmark-spreadsheet",
      active: f.redpash_id === state.activeRid,
    }));
    const targets = state.targets.map((t) => ({
      id: t.rid, name: t.name, icon: "bi-table",
      active: t.rid === state.activeRid,
    }));
    return [
      { id: "sources", name: "Sources", count: sources.length, tabs: sources },
      { id: "targets", name: "Targets", count: targets.length, tabs: targets },
    ];
  }
  function connGroups() {
    return [{
      id: "connectors", name: "Connectors", count: state.connectors.length,
      addLabel: "New connector",
      tabs: state.connectors.map((c) => ({
        id: c.redpash_id, name: c.name, icon: "bi-database",
        renamable: true, hidable: true,
      })),
    }];
  }
  function refreshRail() { rail.setGroups(state.view === "sql" ? sqlGroups() : connGroups()); }

  // ── view toggle (data-rail-seg) — flip the surface + swap the rail groups ──
  function switchView(v) {
    state.view = v;
    $("#swViewSql").hidden = v !== "sql";
    $("#swViewConnectors").hidden = v !== "connectors";
    refreshRail();
    if (v === "connectors" && !state.connLoaded) { state.connLoaded = true; loadConnectors(); }
  }

  // ── rail interactions ──
  function onRailTab(tabId, groupId) {
    if (groupId === "connectors") { pullConnector(tabId); return; }
    selectTable(tabId, groupId === "targets"); // targets re-select + autorun
  }
  function onRailTabRename(tabId, next) { if (state.view === "connectors") renameConnector(tabId, next); }
  function onRailTabHide(tabId) { if (state.view === "connectors") deleteConnector(tabId); }

  // ════ SQL view — sources, columns, run, materialize ════
  async function loadFiles() {
    try {
      const d = await api("/api/files");
      state.files = (d.items || []).filter((f) => String(f.redpash_id).startsWith("FIL_") && (f.row_count ?? 0) > 0);
      refreshRail();
      if (state.files.length) selectTable(state.files[0].redpash_id, true);
    } catch (e) { setErr(e.message); }
  }
  async function refreshSources() {
    try {
      const d = await api("/api/files");
      state.files = (d.items || []).filter((f) => String(f.redpash_id).startsWith("FIL_") && (f.row_count ?? 0) > 0);
      if (state.view === "sql") refreshRail();
    } catch (_) { /* keep the current rail on a transient list failure */ }
  }
  async function selectTable(rid, autorun) {
    state.activeRid = rid; state.page = 1;
    refreshRail();
    // active file's columns → a chip row; click inserts the name into the editor
    try {
      const env = await api("/api/files/" + encodeURIComponent(rid));
      mountChipRow($("#swCols"), {
        chips: (env.columns || []).map((c) => ({ value: c.name, label: c.name, title: c.dtype || "" })),
        onChip: (v) => editor.insertAtCaret(v),
      });
    } catch (_) { $("#swCols").innerHTML = ""; }
    if (!editor.getValue().trim()) editor.setValue("SELECT * FROM t LIMIT 100");
    if (autorun) run();
  }
  async function run(sql) {
    if (!state.activeRid) return;
    const q = (typeof sql === "string") ? sql : editor.getValue().trim();
    if (!q) return;
    if (q !== state.lastSql) state.page = 1;
    state.lastSql = q;
    setErr("");
    try {
      const p = await api("/api/files/" + encodeURIComponent(state.activeRid) + "/sql",
        { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sql: q, page: state.page, size: state.size }) });
      renderResult(p);
    } catch (e) {
      setErr((e.status === 400 ? "Query error: " : "") + e.message);
      $("#swStat").textContent = "—";
    }
  }
  function renderResult(p) {
    state.total = p.total; state.pages = p.pages; state.page = p.page; state.size = p.size;
    // dynamic columns per query → re-mount the redtable each result
    mountRedTable($("#swGrid"), {
      columns: p.columns.map((c, i) => ({ key: String(i), label: c })),
      rows: p.rows,
      getCell: (row, _col, i) => (row[i] === null ? "∅" : row[i]),
      empty: "No rows.",
    });
    $("#swStat").textContent = `${p.total.toLocaleString()} rows · page ${p.page}/${p.pages} · ${p.ms} ms`;
    $("#swSave").disabled = false;
    pager.render({ page: p.page, totalPages: p.pages, total: p.total, pageSize: p.size, shown: p.rows.length });
  }
  async function saveTarget() {
    if (!state.activeRid || !state.lastSql) return;
    const name = ($("#swTargetName").value || "").trim() || "sql_result";
    const btn = $("#swSave"); btn.disabled = true; setErr("");
    try {
      const env = await api("/api/files/" + encodeURIComponent(state.activeRid) + "/sql/materialize",
        { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sql: state.lastSql, name }) });
      const s = env.summary;
      state.targets.unshift({ rid: s.redpash_id, name: s.filename, rows: s.row_count || 0 });
      refreshRail();
      $("#swTargetName").value = "";
      $("#swStat").textContent = `Saved target "${s.filename}" · ${(s.row_count || 0).toLocaleString()} rows`;
    } catch (e) {
      setErr((e.status === 400 ? "Materialize error: " : "") + e.message);
    } finally { btn.disabled = false; }
  }

  // ════ Connectors view — list (rail tabs) + pull / rename / delete / create ════
  async function loadConnectors() {
    try {
      const d = await api("/api/connectors");
      state.connectors = d.items || [];
      if (state.view === "connectors") refreshRail();
    } catch (e) { setErr(e.message); }
  }
  async function pullConnector(rid) {
    setErr("");
    try {
      await api("/api/connectors/" + encodeURIComponent(rid) + "/sync",
        { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      await refreshSources();
      rail.seg.set("sql");                                    // jump to SQL — the CSV is now a source
    } catch (e) { setErr("Pull failed — " + e.message); }
  }
  // Rename / delete hit PATCH / DELETE /api/connectors/:rid (Admin+ gated server-side).
  async function renameConnector(rid, next) {
    try {
      const c = await api("/api/connectors/" + encodeURIComponent(rid),
        { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: next }) });
      const hit = state.connectors.find((x) => x.redpash_id === rid); if (hit) hit.name = c.name || next;
      refreshRail();
    } catch (e) { setErr("Rename failed — " + e.message); loadConnectors(); }
  }
  async function deleteConnector(rid) {
    try {
      await api("/api/connectors/" + encodeURIComponent(rid), { method: "DELETE" });
      state.connectors = state.connectors.filter((x) => x.redpash_id !== rid);
      refreshRail();
    } catch (e) { setErr("Delete failed — " + e.message); loadConnectors(); }
  }
  // New connector — the openModal flow (modal.js) over the MySQL config + a
  // destination-project picker (same project-picker model as connection-setup.js).
  async function openNewConnectorModal() {
    let projects = [];
    try { projects = (await api("/api/projects")).items || []; } catch (_) { /* empty → new-project path */ }
    const projectOptions = [{ value: "", label: "＋ New project (named after the database)" }]
      .concat(projects.map((p) => ({ value: p.redpash_id, label: p.name || p.redpash_id })));
    openModal({
      title: "New MySQL connector", submitLabel: "Create & Pull", submitIcon: "bi-database-add",
      fields: [
        { key: "host", label: "Host", placeholder: "127.0.0.1" },
        { key: "port", label: "Port", placeholder: "3306" },
        { key: "user", label: "User", placeholder: "root" },
        { key: "password", label: "Password", type: "password" },
        { key: "database", label: "Database", required: true, placeholder: "employees" },
        { key: "table", label: "Table", required: true, placeholder: "employees" },
        { key: "project_id", label: "Destination project", type: "select", options: projectOptions,
          hint: "Where the pulled CSV lands — RBAC-checked exactly like a file upload." },
      ],
      onSubmit: async (v) => {
        const db = (v.database || "").trim(), table = (v.table || "").trim();
        if (!db || !table) throw new Error("Database and table are required.");
        let projectId = v.project_id;
        if (!projectId) {
          const p = await api("/api/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: db }) });
          projectId = p.redpash_id || (p.project && p.project.redpash_id);
        }
        const config = {
          host: (v.host || "127.0.0.1").trim(), port: Number(v.port) || 3306,
          user: (v.user || "root").trim(), password: v.password || "", database: db, table,
        };
        const con = await api("/api/connectors", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: db + "." + table, project_id: projectId, kind: "mysql", config }) });
        try { await api("/api/connectors/" + encodeURIComponent(con.redpash_id) + "/sync", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }); } catch (_) { /* created; pull can be retried from the rail */ }
        state.connLoaded = false; loadConnectors(); refreshSources();
      },
    });
  }

  // ── boot: sync the surface to the persisted view, then load sources ──
  switchView(rail.seg.current());
  loadFiles();
}
