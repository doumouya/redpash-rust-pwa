/* Purpose: Database console page — a platform admin browses + runs READ-ONLY SQL
   against a connected Postgres through the connector, and pulls a table → CSV.
   One of the Admin app's pages (Slice B2). The dogfood surface: do through the app
   what we'd otherwise do via direct DB access (starting with our own DB).
   Doc: docs/internal/code/frontend/scripts/pages/database.md */
// ── Database console ────────────────────────────────────────────────────────
// Consumes the live read-only query substrate (POST /api/connectors/:rid/query —
// platform-admin gated, READ-ONLY transaction + statement_timeout + LIMIT, server
// side) plus the connector endpoints SheetWise uses (GET /connectors, /:rid/tables,
// /:rid/schema, /:rid/sync). The RAIL lists the Postgres connectors (one tab each)
// + a "Connect a database" create action (the SheetWise pattern); the body shows
// the active connector's console — schema explorer + SQL editor + result grid +
// Pull. Every UI block is a framework component (mountRail · mountEditorCode ·
// mountRedTable · mountChipRow · openModal); this page owns only behaviour + the
// rp-dbc-* positioning. Slice B2 = READ (browse + ad-hoc SELECT + pull); the WRITE
// side (a SQL console for INSERT/UPDATE/DDL) is a separate role-gated slice.

import { mountTopbar } from "/scripts/topbar.js";
import { mountRail } from "/scripts/framework/rail.js";
import { mountEditorCode } from "/scripts/framework/editor-code.js";
import { mountRedTable } from "/scripts/framework/redtable.js";
import { mountChipRow } from "/scripts/framework/chip-row.js";
import { openModal } from "/scripts/framework/modal.js";
import { esc } from "/scripts/dom.js";

const SSL_MODE_OPTIONS = [
  { value: "required",        label: "Required — encrypted (default)" },
  { value: "verify_ca",       label: "Verify CA — encrypted + CA-validated" },
  { value: "verify_identity", label: "Verify identity — encrypted + hostname-validated" },
  { value: "preferred",       label: "Preferred — encrypt if available (loopback only)" },
  { value: "disabled",        label: "Disabled — plaintext (loopback only)" },
];
const DEFAULT_LIMIT = 200; // UI default; the backend independently clamps to [1,1000].

export default function database(app, { session }) {
  mountTopbar(app.querySelector("#rp-topbar"), { active: "database", session });

  const surface = app.querySelector("#dbSurface");
  if (!session?.is_platform_admin) {
    surface.innerHTML = '<div class="rp-adm-placeholder">'
      + '<i class="bi bi-shield-lock"></i>'
      + '<p>The Database console is restricted to platform administrators.</p>'
      + '<p><a class="rp-btn rp-btn--glass" href="#/home">Back to home</a></p>'
      + '</div>';
    return;
  }

  const state = { connectors: [], activeConnId: null, tables: [], activeTable: null, lastSql: "" };

  async function api(path, opts) {
    const r = await fetch(path, opts);
    if (r.status === 401) throw Object.assign(new Error("Not signed in — reload the app and log in."), { status: 401 });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(body.error || ("HTTP " + r.status)), { status: r.status, body });
    return body;
  }

  // ── rail — the Postgres connectors + a Connect action ──
  const rail = mountRail(app.querySelector("#dbRail"), {
    title: "Database",
    collapsible: true,
    groups: connGroups(),
    footer: { create: { label: "Connect a database" }, nav: { active: "", session } },
    on: {
      tab: (id) => selectConnector(id),
      create: openConnectModal,
      groupAdd: openConnectModal,
    },
  });
  function connGroups() {
    if (!state.connectors.length) {
      return [{ id: "databases", name: "Databases", addLabel: "Connect a database", tabs: [] }];
    }
    return [{
      id: "databases", name: "Databases",
      tabs: state.connectors.map((c) => ({
        id: c.redpash_id, name: c.name, icon: "bi-hdd-stack",
        active: c.redpash_id === state.activeConnId,
      })),
    }];
  }
  const refreshRail = () => rail.setGroups(connGroups());

  // ── body shell ──
  surface.innerHTML = ''
    + '<section class="rp-dbc" aria-label="Database console">'
    +   '<div class="rp-dbc-bar">'
    +     '<span class="rp-dbc-conn-name" id="dbcConnName">No database connected</span>'
    +     '<span class="rp-dbc-foot-sp"></span>'
    +     '<button class="rp-btn-icon rp-btn-icon--glass" id="dbcTest" type="button" title="Test the connection" disabled><i class="bi bi-plug"></i><span>Test</span></button>'
    +     '<span class="rp-dbc-stat" id="dbcConnStat" role="status" aria-live="polite"></span>'
    +   '</div>'
    +   '<div class="rp-dbc-body">'
    +     '<aside class="rp-dbc-tables" id="dbcTables" aria-label="Tables"><p class="rp-empty">Pick a database in the rail, or connect one (start with our own — 127.0.0.1:5433/redpash_prerelease).</p></aside>'
    +     '<div class="rp-dbc-main">'
    +       '<div class="rp-dbc-editbar">'
    +         '<div class="rp-dbc-cols" id="dbcCols"></div>'
    +         '<div id="dbcEditor"></div>'
    +       '</div>'
    +       '<div class="rp-dbc-err" id="dbcErr" role="alert" aria-live="assertive" hidden></div>'
    +       '<div id="dbcGrid"></div>'
    +       '<div class="rp-dbc-foot">'
    +         '<span class="rp-dbc-stat" id="dbcStat">—</span>'
    +         '<span class="rp-dbc-foot-sp"></span>'
    +         '<button class="rp-btn-icon rp-btn-icon--glass" id="dbcPull" type="button" disabled title="Pull the selected table into a CSV file in this connector\'s project"><i class="bi bi-download"></i><span>Pull table</span></button>'
    +       '</div>'
    +     '</div>'
    +   '</div>'
    + '</section>';

  const $ = (s) => surface.querySelector(s);
  const setErr = (msg) => { const e = $("#dbcErr"); e.textContent = msg || ""; e.hidden = !msg; };
  const setConnStat = (msg, cls) => { const el = $("#dbcConnStat"); el.className = "rp-dbc-stat" + (cls ? " " + cls : ""); el.textContent = msg || ""; };

  const editor = mountEditorCode($("#dbcEditor"), {
    language: "sql", ariaLabel: "Read-only SQL query", placeholder: "SELECT * FROM users LIMIT 100",
    bar: true, hint: "Read-only SELECT / WITH against the live database · ⌘/Ctrl+Enter to run",
    onRun: () => runQuery(),
  });
  editor.actions.append(
    mkBtn("Clear", "rp-btn-icon rp-btn-icon--ghost", () => { editor.setValue(""); editor.focus(); }),
    mkBtn('<i class="bi bi-play-fill"></i><span>Run</span>', "rp-btn-icon rp-btn-icon--accent", () => runQuery()),
  );

  $("#dbcTest").addEventListener("click", testConnection);
  $("#dbcPull").addEventListener("click", pullActiveTable);

  loadConnectors();

  // ════ connectors ════
  async function loadConnectors(selectRid) {
    try {
      const d = await api("/api/connectors");
      state.connectors = (d.items || []).filter((c) => c.kind === "postgres");
      refreshRail();
      const target = selectRid && state.connectors.some((c) => c.redpash_id === selectRid)
        ? selectRid
        : (state.activeConnId && state.connectors.some((c) => c.redpash_id === state.activeConnId) ? state.activeConnId : null);
      if (target) selectConnector(target);
    } catch (e) { setConnStat("Couldn't list connectors — " + e.message, "is-err"); }
  }
  function selectConnector(rid) {
    if (!rid) return;
    state.activeConnId = rid;
    state.activeTable = null;
    setErr(""); setConnStat("");
    $("#dbcCols").innerHTML = "";
    $("#dbcPull").disabled = true;
    $("#dbcTest").disabled = false;
    const conn = state.connectors.find((c) => c.redpash_id === rid);
    $("#dbcConnName").textContent = conn ? conn.name : "—";
    refreshRail();
    loadTables();
  }
  async function testConnection() {
    if (!state.activeConnId) return;
    const btn = $("#dbcTest");
    btn.disabled = true;
    setConnStat("Testing…");
    try {
      await api("/api/connectors/" + encodeURIComponent(state.activeConnId) + "/test", { method: "POST" });
      setConnStat("✓ Connected", "is-ok");
    } catch (e) { setConnStat("✕ " + e.message, "is-err"); }
    finally { btn.disabled = false; }
  }

  // ════ schema explorer ════
  async function loadTables() {
    const aside = $("#dbcTables");
    aside.innerHTML = '<p class="rp-empty">Loading tables…</p>';
    try {
      const items = (await api("/api/connectors/" + encodeURIComponent(state.activeConnId) + "/tables")).items || [];
      state.tables = items;
      renderTables();
    } catch (e) { aside.innerHTML = '<p class="rp-empty">Couldn\'t list tables — ' + esc(e.message) + '</p>'; }
  }
  function renderTables() {
    const aside = $("#dbcTables");
    if (!state.tables.length) {
      aside.innerHTML = '<p class="rp-empty">No tables in this database\'s schema. Cross-schema browse is single-schema per the connector config; a schema-qualified query (e.g. <code>SELECT * FROM audit.run</code>) still works.</p>';
      return;
    }
    const rows = state.tables.map((t) => {
      const rc = t.rows != null && t.rows >= 0 ? '<span class="rp-dbc-table-rows">≈' + Number(t.rows).toLocaleString() + '</span>' : "";
      const active = t.name === state.activeTable ? " is-active" : "";
      return '<li><button type="button" class="rp-dbc-table' + active + '" data-table="' + esc(t.name) + '">'
        + '<i class="bi bi-table"></i><span class="rp-dbc-table-name">' + esc(t.name) + '</span>' + rc + '</button></li>';
    }).join("");
    aside.innerHTML = '<div class="rp-dbc-tables-head">' + state.tables.length + ' tables</div>'
      + '<ul class="rp-dbc-table-list">' + rows + '</ul>';
    aside.querySelectorAll(".rp-dbc-table").forEach((b) => b.addEventListener("click", () => pickTable(b.dataset.table)));
  }
  async function pickTable(name) {
    state.activeTable = name;
    renderTables();
    $("#dbcPull").disabled = false;
    if (!editor.getValue().trim()) editor.setValue("SELECT * FROM " + qIdent(name) + " LIMIT 100");
    try {
      const cols = (await api("/api/connectors/" + encodeURIComponent(state.activeConnId) + "/schema?table=" + encodeURIComponent(name))).items || [];
      mountChipRow($("#dbcCols"), {
        chips: cols.map((c) => ({ value: c.name, label: c.name, title: c.data_type || "" })),
        onChip: (v) => editor.insertAtCaret(v),
      });
    } catch (_) { $("#dbcCols").innerHTML = ""; }
  }

  // ════ run query (the read-only substrate) ════
  async function runQuery(sql) {
    if (!state.activeConnId) { setErr("Pick a database in the rail first."); return; }
    const q = (typeof sql === "string") ? sql : editor.getValue().trim();
    if (!q) return;
    state.lastSql = q;
    setErr("");
    $("#dbcStat").textContent = "Running…";
    const t0 = performance.now();
    try {
      const res = await api("/api/connectors/" + encodeURIComponent(state.activeConnId) + "/query", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ sql: q, limit: DEFAULT_LIMIT }),
      });
      renderResult(res, Math.round(performance.now() - t0));
    } catch (e) {
      setErr((e.status === 400 ? "Query rejected: " : "") + e.message);
      $("#dbcStat").textContent = "—";
    }
  }
  function renderResult(res, ms) {
    const columns = res.columns || [];
    const rows = res.rows || [];
    mountRedTable($("#dbcGrid"), {
      id: "dbcTable",
      columns: columns.map((c, i) => ({ key: String(i), label: c })),
      rows,
      getCell: (row, col) => (row[col.key] === null ? "∅" : row[col.key]),
      empty: "No rows.",
    });
    const capped = res.truncated ? ` · capped at ${DEFAULT_LIMIT} (raise LIMIT in the query for more)` : "";
    $("#dbcStat").textContent = `${rows.length.toLocaleString()} row${rows.length === 1 ? "" : "s"} · ${ms} ms${capped}`;
  }

  // ════ pull ════
  async function pullActiveTable() {
    if (!state.activeConnId || !state.activeTable) return;
    const btn = $("#dbcPull");
    const prev = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<i class="bi bi-hourglass-split"></i><span>Pulling…</span>';
    try {
      await api("/api/connectors/" + encodeURIComponent(state.activeConnId) + "/sync", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ table: state.activeTable }),
      });
      btn.innerHTML = '<i class="bi bi-check2"></i><span>Pulled → file</span>';
      setTimeout(() => { btn.innerHTML = prev; btn.disabled = false; }, 2200);
    } catch (e) {
      setErr("Pull failed — " + e.message);
      btn.innerHTML = prev;
      btn.disabled = false;
    }
  }

  // ════ connect a database (focused Postgres create — the in-app registration) ════
  async function openConnectModal() {
    let projects = [];
    try { projects = (await api("/api/projects")).items || []; } catch (_) { /* empty → auto-create */ }
    const projectOptions = [{ value: "", label: "＋ New project (auto-named)" }]
      .concat(projects.map((p) => ({ value: p.redpash_id, label: p.name || p.redpash_id })));
    openModal({
      title: "Connect a PostgreSQL database",
      submitLabel: "Connect", submitIcon: "bi-database-add",
      fields: [
        { key: "host", label: "Host", placeholder: "127.0.0.1", hint: "Loopback or a remote host. A remote host needs SSL mode ≥ Required — plaintext is refused off-loopback." },
        { key: "port", label: "Port", placeholder: "5432" },
        { key: "user", label: "User", placeholder: "postgres" },
        { key: "password", label: "Password", type: "password" },
        { key: "ssl_mode", label: "SSL mode", type: "select", options: SSL_MODE_OPTIONS, hint: "Required encrypts the link (default). Verify CA / identity also validate the server cert." },
        { key: "database", label: "Database", required: true, placeholder: "redpash_prerelease" },
        { key: "schema", label: "Schema", placeholder: "public", hint: "The schema browsed in the Tables list (defaults to public). Queries can still reach other schemas." },
        { key: "project_id", label: "Destination project", type: "select", options: projectOptions, hint: "Where a pulled table's CSV lands — RBAC-checked exactly like a file upload." },
      ],
      onSubmit: async (v) => {
        const db = (v.database || "").trim();
        if (!db) throw new Error("Database is required.");
        let projectId = v.project_id;
        if (!projectId) {
          const p = await api("/api/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: db }) });
          projectId = p.redpash_id || (p.project && p.project.redpash_id);
        }
        const config = {
          host: (v.host || "127.0.0.1").trim(), port: Number(v.port) || 5432,
          user: (v.user || "postgres").trim(), password: v.password || "",
          database: db, schema: (v.schema || "public").trim(), table: "",
          ssl_mode: v.ssl_mode || "required",
        };
        const con = await api("/api/connectors", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: db + " (database)", project_id: projectId, kind: "postgres", config }) });
        loadConnectors(con.redpash_id);
      },
    });
  }

  // ── helpers ──
  function mkBtn(html, cls, on) {
    const b = document.createElement("button");
    b.type = "button"; b.className = cls; b.innerHTML = html;
    b.addEventListener("click", on);
    return b;
  }
  function qIdent(name) { return '"' + String(name).replace(/"/g, '""') + '"'; }
}
