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
import { mountSimpleTable } from "/scripts/framework/table.js";
import { mountPager } from "/scripts/framework/pager.js";
import { mountChipRow } from "/scripts/framework/chip-row.js";
import { openModal } from "/scripts/framework/modal.js";
import { esc } from "/scripts/dom.js";

// Connector sub-tab (facet) set, declared PER KIND — open-ended like the codec /
// type registries; MySQL is the template, a future kind registers its own facets.
// MySQL + PostgreSQL share one facet set — the backend dispatches /tables · /schema
// · /sync on conn.kind, so the FE surface is identical. A future engine can declare
// its own facets here (the facet map is open-ended, not enumerated in one place).
const SQL_FACETS = [
  { id: "tables",   label: "Tables",   icon: "bi-table" },
  { id: "schema",   label: "Schema",   icon: "bi-diagram-3" },
  { id: "pulls",    label: "Pulls",    icon: "bi-download" },
  { id: "settings", label: "Settings", icon: "bi-gear" },
];
// Kafka has no queryable catalog (it's a topic STREAM, not tables) — Pulls + Settings.
const KAFKA_FACETS = [
  { id: "pulls",    label: "Pulls",    icon: "bi-download" },
  { id: "settings", label: "Settings", icon: "bi-gear" },
];
const CONNECTOR_FACETS = { mysql: SQL_FACETS, postgres: SQL_FACETS, kafka: KAFKA_FACETS };
const facetsForKind = (kind) => CONNECTOR_FACETS[kind] || SQL_FACETS;
const KIND_MARK = { mysql: "#89b4fa", postgres: "#cba6f7", kafka: "#fab387", csv: "#a6e3a1" };
// Per-engine display + connect defaults, keyed by the engine-specific Add buttons.
const ENGINE_META = {
  mysql:    { label: "MySQL", port: 3306, user: "root" },
  postgres: { label: "PostgreSQL", port: 5432, user: "postgres" },
  kafka:    { label: "Kafka", bootstrap: "localhost:29092" },
};

// SSL-mode ladder (MySQL 8.4 "Using Encrypted Connections"). Required is first =
// the browser-selected default → secure-by-default. The backend enforces remote ≥
// Required; Preferred / Disabled stay loopback-only (they can send plaintext).
const SSL_MODE_OPTIONS = [
  { value: "required",        label: "Required — encrypted (default)" },
  { value: "verify_ca",       label: "Verify CA — encrypted + CA-validated" },
  { value: "verify_identity", label: "Verify identity — encrypted + hostname-validated" },
  { value: "preferred",       label: "Preferred — encrypt if available (loopback only)" },
  { value: "disabled",        label: "Disabled — plaintext (loopback only)" },
];

export default function sheetwise(app, { session }) {
  const $ = (s) => app.querySelector(s);

  mountTopbar($("#rp-topbar"), { active: "sheetwise", session });

  const state = {
    view: "sql", files: [], activeRid: null, targets: [],
    connectors: [], connLoaded: false,
    activeConnector: null, activeFacet: null, schemaTable: null,
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
  $("#swConnNewPg").addEventListener("click", () => openNewConnectorModal("postgres"));
  $("#swConnNewMy").addEventListener("click", () => openNewConnectorModal("mysql"));
  $("#swConnNewKa").addEventListener("click", () => openNewConnectorModal("kafka"));

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
    footer: { create: { label: "New connector" }, nav: { active: "", session } },
    on: {
      tab: onRailTab,
      groupToggle: onConnToggle,                          // expand a connector → show its Tables
      groupRename: (id, next) => renameConnector(id, next), // connector groups only (renamable)
      groupHide: (id) => deleteConnector(id),               // connector groups only (hidable)
      groupAdd: () => openNewConnectorModal(),              // the empty-state "New connector"
      create: () => openNewConnectorModal(),                // footer "New connector"
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
  // Each connector is its OWN retractable group; its sub-tabs are the kind's facets
  // (Tables/Schema/Pulls/Settings). Rename/delete ride the group affordances.
  function connGroups() {
    if (!state.connectors.length) {
      return [{ id: "__empty", name: "Connectors", addLabel: "New connector", tabs: [] }];
    }
    return state.connectors.map((c) => ({
      id: c.redpash_id,
      name: c.name,
      mark: KIND_MARK[c.kind],
      renamable: true, hidable: true,
      collapsed: c.redpash_id !== state.activeConnector,
      tabs: facetsForKind(c.kind).map((f) => ({
        id: c.redpash_id + "::" + f.id,
        name: f.label, icon: f.icon,
        active: state.activeFacet === c.redpash_id + "::" + f.id,
      })),
    }));
  }
  function refreshRail() { rail.setGroups(state.view === "sql" ? sqlGroups() : connGroups()); }

  // ── view toggle (data-rail-seg) — flip the surface + swap the rail groups ──
  function switchView(v) {
    state.view = v;
    $("#swViewSql").hidden = v !== "sql";
    $("#swViewConnectors").hidden = v !== "connectors";
    refreshRail();
    if (v === "connectors") {
      if (!state.connLoaded) { state.connLoaded = true; loadConnectors(); }
      const hasFacet = !!state.activeFacet;        // show the open facet, else the guidance
      $("#swConnGuide").hidden = hasFacet;
      $("#swConnFacet").hidden = !hasFacet;
    }
  }

  // ── rail interactions ──
  function onRailTab(tabId, groupId) {
    if (groupId === "sources") { selectTable(tabId, false); return; }
    if (groupId === "targets") { selectTable(tabId, true); return; }
    // connectors view: a facet tab "CON_…::<facet>"
    const sep = tabId.indexOf("::");
    if (sep > 0) renderFacet(tabId.slice(0, sep), tabId.slice(sep + 2));
  }
  // Expanding a connector group selects it + opens its FIRST facet (SQL → Tables,
  // kafka → Pulls — kafka has no Tables/Schema, so never default to a facet its
  // backend would reject).
  function onConnToggle(connId, collapsed) {
    if (collapsed || connId === "__empty") return;
    state.activeConnector = connId;
    const conn = state.connectors.find((c) => c.redpash_id === connId);
    renderFacet(connId, facetsForKind(conn && conn.kind)[0].id);
  }

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
      id: "swTable", // id ON THE TABLE → parity with Workspace's wsTable; SheetWise tweaks under #swTable
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

  // ════ Connectors view — each connector a group; facets render in the surface ════
  async function loadConnectors() {
    try {
      const d = await api("/api/connectors");
      state.connectors = d.items || [];
      if (state.view === "connectors") refreshRail();
    } catch (e) { setErr(e.message); }
  }

  // ── facet surface router — renders the active connector facet into #swConnFacet ──
  const facetHead = (icon, html) => '<div class="rp-sw-facet-head"><i class="bi ' + icon + '"></i> ' + html + '</div>';

  function renderFacet(connId, facet) {
    const conn = state.connectors.find((c) => c.redpash_id === connId);
    if (!conn) return;
    state.activeConnector = connId;
    state.activeFacet = connId + "::" + facet;
    $("#swConnGuide").hidden = true;
    const host = $("#swConnFacet"); host.hidden = false;
    rail.setGroups(connGroups());                 // reflect the active facet tab + keep this connector expanded
    if (facet === "schema") renderSchemaFacet(host, conn);
    else if (facet === "pulls") renderPullsFacet(host, conn);
    else if (facet === "settings") renderSettingsFacet(host, conn);
    else renderTablesFacet(host, conn);
  }

  // Browse the source tables → click a row to inspect its Schema (where Pull lives).
  async function renderTablesFacet(host, conn) {
    host.innerHTML = facetHead("bi-table", "Tables in <b>" + esc(conn.name) + "</b>") + '<p class="rp-empty">Loading…</p>';
    try {
      const items = (await api("/api/connectors/" + encodeURIComponent(conn.redpash_id) + "/tables")).items || [];
      host.innerHTML = facetHead("bi-table", items.length + " tables in <b>" + esc(conn.name) + "</b>") + '<div class="rp-sw-facet-table"></div>';
      mountSimpleTable(host.querySelector(".rp-sw-facet-table"), {
        columns: [
          { key: "name", label: "Table" },
          { key: "rows", label: "Rows", kind: "num" },
          { key: "kind", label: "Type" },
        ],
        rows: items.map((t) => ({
          rid: t.name,
          name: t.name,
          rows: t.rows != null ? "≈" + Number(t.rows).toLocaleString() : "",
          kind: t.kind && t.kind !== "BASE TABLE" ? t.kind : "",
        })),
        empty: "No tables in this database.",
        onRowClick: (table) => { state.schemaTable = table; renderFacet(conn.redpash_id, "schema"); },
      });
    } catch (e) {
      host.innerHTML = facetHead("bi-table", "Tables") + '<p class="rp-empty">Couldn\'t list tables — ' + esc(e.message) + '</p>';
    }
  }

  async function renderSchemaFacet(host, conn) {
    const table = state.schemaTable;
    if (!table) { host.innerHTML = facetHead("bi-diagram-3", "Schema") + '<p class="rp-empty">Pick a table in <b>Tables</b> to view its columns.</p>'; return; }
    host.innerHTML = facetHead("bi-diagram-3", "Schema · <b>" + esc(table) + "</b>") + '<p class="rp-empty">Loading…</p>';
    try {
      const cols = (await api("/api/connectors/" + encodeURIComponent(conn.redpash_id) + "/schema?table=" + encodeURIComponent(table))).items || [];
      host.innerHTML = facetHead("bi-diagram-3", esc(table) + " · " + cols.length + " columns")
        + '<div class="rp-sw-facet-table"></div>'
        + '<div class="rp-sw-facet-foot"><button type="button" class="rp-btn-icon rp-btn-icon--accent" id="swSchemaPull"><i class="bi bi-download"></i><span>Pull ' + esc(table) + '</span></button></div>';
      mountSimpleTable(host.querySelector(".rp-sw-facet-table"), {
        columns: [
          { key: "name", label: "Column" },
          { key: "data_type", label: "Type" },
          { key: "nullable", label: "Null" },
          { key: "key", label: "Key" },
          { key: "projection", label: "Projection" },
        ],
        rows: cols.map((c) => ({
          name: c.name,
          data_type: c.data_type,
          nullable: c.nullable ? "" : "NOT NULL",
          key: c.key || "",
          projection: c.projection && c.projection !== "text" ? "→ " + c.projection : "",
        })),
        empty: "No columns.",
      });
      host.querySelector("#swSchemaPull").addEventListener("click", (e) => pullTable(conn.redpash_id, table, e.currentTarget));
    } catch (e) {
      host.innerHTML = facetHead("bi-diagram-3", "Schema") + '<p class="rp-empty">Couldn\'t read schema — ' + esc(e.message) + '</p>';
    }
  }

  async function renderPullsFacet(host, conn) {
    host.innerHTML = facetHead("bi-download", "Pulled files") + '<p class="rp-empty">Loading…</p>';
    try {
      const files = ((await api("/api/files")).items || [])
        .filter((f) => f.project_id === conn.project_id && String(f.redpash_id).startsWith("FIL_"));
      host.innerHTML = facetHead("bi-download", files.length + " files in this connector's project") + '<div class="rp-sw-facet-table"></div>';
      mountSimpleTable(host.querySelector(".rp-sw-facet-table"), {
        columns: [
          { key: "filename", label: "File" },
          { key: "rows", label: "Rows", kind: "num" },
        ],
        rows: files.map((f) => ({
          rid: f.redpash_id,
          filename: f.filename,
          rows: f.row_count != null ? Number(f.row_count).toLocaleString() : "",
        })),
        empty: "No files in this connector's project yet — pull a table from Tables.",
        onRowClick: (rid) => { rail.seg.set("sql"); refreshSources().then(() => selectTable(rid, true)); },
      });
    } catch (e) {
      host.innerHTML = facetHead("bi-download", "Pulled files") + '<p class="rp-empty">Couldn\'t list files — ' + esc(e.message) + '</p>';
    }
  }

  function renderSettingsFacet(host, conn) {
    host.innerHTML = facetHead("bi-gear", "Settings")
      + '<div class="rp-sw-facet-table"></div>'
      + '<div class="rp-sw-facet-foot">'
      +   '<button class="rp-btn rp-btn--glass" id="swConnTest" type="button"><i class="bi bi-plug"></i> Test connection</button>'
      +   '<span class="rp-sw-stat" id="swConnTestStat" role="status" aria-live="polite"></span>'
      + '</div>'
      + '<p class="rp-sw-facet-note">Rename or delete this connector from the ✎ / ✕ on its rail header. '
      + 'Host / database / SSL mode editing arrives with the connector-config endpoint.</p>';
    mountSimpleTable(host.querySelector(".rp-sw-facet-table"), {
      columns: [{ key: "field", label: "Field" }, { key: "value", label: "Value" }],
      rows: [
        { field: "Name", value: conn.name },
        { field: "Kind", value: conn.kind || "—" },
        { field: "Destination project", value: conn.project_id || "—" },
        { field: "Connection id", value: conn.redpash_id },
      ],
    });
    const btn = host.querySelector("#swConnTest");
    const stat = host.querySelector("#swConnTestStat");
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      stat.className = "rp-sw-stat";
      stat.textContent = "Testing…";
      try {
        await api("/api/connectors/" + encodeURIComponent(conn.redpash_id) + "/test", { method: "POST" });
        stat.className = "rp-sw-stat is-ok";
        stat.textContent = "✓ Connected";
      } catch (e) {
        stat.className = "rp-sw-stat is-err";
        stat.textContent = "✕ " + e.message;
      } finally {
        btn.disabled = false;
      }
    });
  }

  // Pull one table → CSV (sync with a {table} override), then jump to SQL.
  async function pullTable(connId, table, btn) {
    const prev = btn.innerHTML; btn.disabled = true; btn.innerHTML = '<i class="bi bi-hourglass-split"></i>';
    try {
      await api("/api/connectors/" + encodeURIComponent(connId) + "/sync",
        { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ table }) });
      btn.innerHTML = '<i class="bi bi-check2"></i>';
      await refreshSources();
      setTimeout(() => rail.seg.set("sql"), 450);            // the pulled CSV is now a source
    } catch (e) {
      btn.disabled = false; btn.innerHTML = '<i class="bi bi-exclamation-triangle"></i>'; btn.title = "Pull failed — " + e.message;
      setTimeout(() => { btn.innerHTML = prev; btn.title = "Pull this table → CSV"; }, 2600);
    }
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
    const c = state.connectors.find((x) => x.redpash_id === rid);
    if (!window.confirm('Delete connector "' + (c ? c.name : rid) + '"? The CSVs already pulled into the project stay.')) return;
    try {
      await api("/api/connectors/" + encodeURIComponent(rid), { method: "DELETE" });
      state.connectors = state.connectors.filter((x) => x.redpash_id !== rid);
      if (state.activeConnector === rid) { state.activeConnector = null; state.activeFacet = null; $("#swConnFacet").hidden = true; $("#swConnGuide").hidden = false; }
      refreshRail();
    } catch (e) { setErr("Delete failed — " + e.message); loadConnectors(); }
  }
  // New connector — the openModal flow (modal.js) over the engine config + a
  // destination-project picker (same project-picker model as connection-setup.js).
  // `kind` ("mysql" | "postgres") comes from the engine-specific Add buttons → the
  // modal is locked to that engine (no Engine picker, engine-correct defaults). With
  // no `kind` (the rail's generic add) the Engine picker is shown.
  async function openNewConnectorModal(kind) {
    const eng = ENGINE_META[kind]; // undefined → generic (Engine picker shown)
    let projects = [];
    try { projects = (await api("/api/projects")).items || []; } catch (_) { /* empty → new-project path */ }
    const projectOptions = [{ value: "", label: "＋ New project (auto-named)" }]
      .concat(projects.map((p) => ({ value: p.redpash_id, label: p.name || p.redpash_id })));
    // Kafka is a STREAM, not a SQL engine: a topic + bootstrap, no host/db/table. The
    // SASL secret is ENCRYPTED at rest server-side (AES-256-GCM); leave the creds blank
    // to use the connector .env (single-cluster RC).
    if (kind === "kafka") {
      openModal({
        title: "New Kafka connector", submitLabel: "Create & Pull", submitIcon: "bi-database-add",
        fields: [
          { key: "topic", label: "Topic", required: true, placeholder: "orders.v1" },
          { key: "bootstrap", label: "Bootstrap servers", required: true, placeholder: eng.bootstrap,
            hint: "host:port of the Kafka brokers (Confluent Cloud or local). TLS (SASL_SSL) is mandatory." },
          { key: "sasl_username", label: "SASL key / username",
            hint: "Confluent API key (or SASL username). Leave blank to use the connector .env credentials." },
          { key: "sasl_password", label: "SASL secret / password", type: "password",
            hint: "Encrypted at rest (AES-256-GCM) — never stored in plaintext. Leave blank to use the .env credentials." },
          { key: "project_id", label: "Destination project", type: "select", options: projectOptions,
            hint: "Where the consumed records land as a CSV — RBAC-checked exactly like a file upload." },
        ],
        onSubmit: async (v) => {
          const topic = (v.topic || "").trim();
          const bootstrap = (v.bootstrap || "").trim();
          if (!topic) throw new Error("Topic is required.");
          if (!bootstrap) throw new Error("Bootstrap servers are required.");
          let projectId = v.project_id;
          if (!projectId) {
            const p = await api("/api/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: topic }) });
            projectId = p.redpash_id || (p.project && p.project.redpash_id);
          }
          const config = { bootstrap, security_protocol: "SASL_SSL" };
          const saslUser = (v.sasl_username || "").trim();
          const saslSecret = v.sasl_password || "";
          if (saslUser) config.sasl_user = saslUser;
          if (saslSecret) config.sasl_secret = saslSecret; // server encrypts → sasl_secret_enc
          const con = await api("/api/connectors", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "kafka." + topic, project_id: projectId, kind: "kafka", topic, config }) });
          try { await api("/api/connectors/" + encodeURIComponent(con.redpash_id) + "/sync", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }); } catch (_) { /* created; pull can be retried from the rail */ }
          state.connLoaded = false; loadConnectors(); refreshSources();
        },
      });
      return;
    }
    const fields = [];
    if (!eng) {
      fields.push({ key: "kind", label: "Engine", type: "select", options: [
            { value: "mysql", label: "MySQL" },
            { value: "postgres", label: "PostgreSQL" },
          ],
          hint: "MySQL or PostgreSQL — both pull a table → CSV through the same RBAC-checked pipeline." });
    }
    fields.push(
      { key: "host", label: "Host", placeholder: "127.0.0.1",
        hint: "Loopback (127.0.0.1) or a remote host. A remote host needs SSL mode ≥ Required — plaintext is refused off-loopback." },
      { key: "port", label: "Port", placeholder: eng ? String(eng.port) : "3306 (MySQL) · 5432 (Postgres)" },
      { key: "user", label: "User", placeholder: eng ? eng.user : "root / postgres" },
      { key: "password", label: "Password", type: "password" },
      { key: "ssl_mode", label: "SSL mode", type: "select", options: SSL_MODE_OPTIONS,
        hint: "Required encrypts the link (default). Verify CA / identity also validate the server cert. Preferred / Disabled are loopback-only." },
      { key: "database", label: "Database", required: true, placeholder: "employees" },
    );
    // Schema is PostgreSQL-only — show it for postgres, or in the generic modal (the
    // user may pick postgres there). MySQL ignores it.
    if (!eng || kind === "postgres") {
      fields.push({ key: "schema", label: "Schema", placeholder: "public",
        hint: "PostgreSQL only — the schema holding the table (defaults to public)." + (eng ? "" : " Ignored for MySQL.") });
    }
    fields.push(
      { key: "table", label: "Table", required: true, placeholder: "employees" },
      { key: "project_id", label: "Destination project", type: "select", options: projectOptions,
        hint: "Where the pulled CSV lands — RBAC-checked exactly like a file upload." },
    );
    openModal({
      title: eng ? ("New " + eng.label + " connector") : "New connector",
      submitLabel: "Create & Pull", submitIcon: "bi-database-add",
      fields,
      onSubmit: async (v) => {
        const k = kind || v.kind || "mysql";
        const isPg = k === "postgres";
        const db = (v.database || "").trim(), table = (v.table || "").trim();
        if (!db || !table) throw new Error("Database and table are required.");
        let projectId = v.project_id;
        if (!projectId) {
          const p = await api("/api/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: db }) });
          projectId = p.redpash_id || (p.project && p.project.redpash_id);
        }
        const config = {
          host: (v.host || "127.0.0.1").trim(),
          port: Number(v.port) || (isPg ? 5432 : 3306),
          user: (v.user || (isPg ? "postgres" : "root")).trim(),
          password: v.password || "", database: db, table,
          ssl_mode: v.ssl_mode || "required",
        };
        if (isPg) config.schema = (v.schema || "public").trim();
        const con = await api("/api/connectors", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: db + "." + table, project_id: projectId, kind: k, config }) });
        try { await api("/api/connectors/" + encodeURIComponent(con.redpash_id) + "/sync", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }); } catch (_) { /* created; pull can be retried from the rail */ }
        state.connLoaded = false; loadConnectors(); refreshSources();
      },
    });
  }

  // ── boot: sync the surface to the persisted view, then load sources ──
  switchView(rail.seg.current());
  loadFiles();
}
