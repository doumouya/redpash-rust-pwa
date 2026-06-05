/* Purpose: see doc for details.
 * Doc: docs/internal/code/frontend/scripts/pages/sheetwise.md */
// SheetWise page — the SQL console (view 1) + Connectors (view 2), the
// whole-app design-language pilot, now a real in-app route.
//
// View 1 (SQL): the active SOURCE file is queried as table `t` via the
// read-only POST /api/files/:rid/sql substrate; a result can be materialized
// into a new TARGET file (POST …/sql/materialize). View 2 (Connectors): pick a
// connector, configure source + destination, Create & Pull — the loader
// extracts the source into a CSV in the chosen project (POST /api/connectors +
// …/sync), which then appears in SOURCES. The live source is never mutated —
// SQL runs on the CSV copy (Em's zero-risk model).
//
// Ported from the standalone /sheetwise.html: the page's own topbar + theme
// switcher are gone (the app topbar carries brand/nav/theme; the page follows
// the global theme), and DOM lookups are scoped to the mounted `app` node.

import { mountTopbar } from "/scripts/topbar.js";

export default function sheetwise(app, { session }) {
  const $  = (s) => app.querySelector(s);
  const $$ = (s) => Array.from(app.querySelectorAll(s));
  const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

  mountTopbar($("#rp-topbar"), { active: "sheetwise", session });

  const state = { files: [], activeRid: null, cols: [], page: 1, size: 50, total: 0, pages: 1, lastSql: "", targets: [] };

  // ── editor: syntax highlight overlay (cosmetic only — never parses/executes) ─
  const KW = new Set(("select from where group by order having limit offset distinct as join inner left right full outer on "
    + "union all and or not in is null like between case when then else end asc desc with on count sum avg min max").split(" "));
  const FN = new Set("count sum avg min max coalesce upper lower round cast".split(" "));
  const ta = $("#swTa"), hi = $("#swHi"), ed = $("#swEd");
  function highlight(src) {
    let out = "";
    const s = src;
    let k = 0;
    while (k < s.length) {
      const c = s[k];
      if (c === "-" && s[k + 1] === "-") { let j = s.indexOf("\n", k); if (j < 0) j = s.length; out += `<span class="tok-com">${esc(s.slice(k, j))}</span>`; k = j; continue; }
      if (c === "'") { let j = k + 1; while (j < s.length && !(s[j] === "'")) j++; j = Math.min(j + 1, s.length); out += `<span class="tok-str">${esc(s.slice(k, j))}</span>`; k = j; continue; }
      if (/[0-9]/.test(c)) { let j = k; while (j < s.length && /[0-9.]/.test(s[j])) j++; out += `<span class="tok-num">${esc(s.slice(k, j))}</span>`; k = j; continue; }
      if (/[A-Za-z_]/.test(c)) {
        let j = k; while (j < s.length && /[A-Za-z0-9_]/.test(s[j])) j++; const w = s.slice(k, j); const lw = w.toLowerCase();
        const cls = KW.has(lw) ? "tok-kw" : (FN.has(lw) ? "tok-fn" : ""); out += cls ? `<span class="${cls}">${esc(w)}</span>` : esc(w); k = j; continue;
      }
      out += esc(c); k++;
    }
    return out + "\n";
  }
  function sync() { hi.innerHTML = highlight(ta.value); hi.scrollTop = ta.scrollTop; hi.scrollLeft = ta.scrollLeft; }
  ta.addEventListener("input", sync);
  ta.addEventListener("scroll", () => { hi.scrollTop = ta.scrollTop; hi.scrollLeft = ta.scrollLeft; });
  ta.addEventListener("focus", () => ed.classList.add("is-focus"));
  ta.addEventListener("blur", () => ed.classList.remove("is-focus"));
  ta.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); run(); }
    else if (e.key === "Tab") { e.preventDefault(); const s = ta.selectionStart, en = ta.selectionEnd; ta.setRangeText("  ", s, en, "end"); sync(); }
  });
  $("#swClear").addEventListener("click", () => { ta.value = ""; sync(); ta.focus(); });
  function insertAtCaret(text) { const s = ta.selectionStart, e = ta.selectionEnd; ta.setRangeText(text, s, e, "end"); ta.dispatchEvent(new Event("input")); ta.focus(); }

  // ── data ───────────────────────────────────────────────────────────────────
  // Self-contained fetch wrapper (same-origin cookie session). Kept local rather
  // than api.js so the SheetWise-specific 401 message + raw /api/files/:rid/sql
  // paths stay identical to the proven standalone path.
  async function api(path, opts) {
    const r = await fetch(path, opts);
    if (r.status === 401) throw Object.assign(new Error("Not signed in — reload the app and log in."), { status: 401 });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(body.error || ("HTTP " + r.status)), { status: r.status, body });
    return body;
  }
  async function loadFiles() {
    try {
      const d = await api("/api/files");
      state.files = (d.items || []).filter((f) => String(f.redpash_id).startsWith("FIL_") && (f.row_count ?? 0) > 0);
      renderTables();
      if (state.files.length) selectTable(state.files[0].redpash_id, true);
    } catch (e) { $("#swTables").innerHTML = `<p style="padding:.5rem;color:var(--rp-text-mute);font-size:var(--rp-text-sm)">${esc(e.message)}</p>`; }
  }
  function renderTables() {
    const host = $("#swTables"); host.textContent = "";
    state.files.forEach((f) => {
      const wrap = document.createElement("div"); wrap.className = "sw-tbl"; wrap.dataset.rid = f.redpash_id;
      const btn = document.createElement("button");
      const nm = document.createElement("span"); nm.textContent = f.filename;
      const alias = document.createElement("span"); alias.className = "alias"; alias.textContent = (f.redpash_id === state.activeRid) ? "t" : "";
      btn.append(nm, alias);
      btn.addEventListener("click", () => selectTable(f.redpash_id));
      const cols = document.createElement("div"); cols.className = "sw-cols";
      wrap.append(btn, cols); host.append(wrap);
    });
  }
  async function selectTable(rid, autorun) {
    state.activeRid = rid; state.page = 1;
    $$(".sw-tbl").forEach((w) => {
      const on = w.dataset.rid === rid; w.setAttribute("aria-current", String(on));
      w.querySelector(".alias").textContent = on ? "t" : "";
    });
    try {
      const env = await api("/api/files/" + encodeURIComponent(rid));
      state.cols = (env.columns || []).map((c) => c.name);
      const colsHost = app.querySelector(`.sw-tbl[data-rid="${CSS.escape(rid)}"] .sw-cols`);
      if (colsHost) {
        colsHost.textContent = "";
        (env.columns || []).forEach((c) => {
          const b = document.createElement("button");
          const n = document.createElement("span"); n.textContent = c.name;
          const ty = document.createElement("span"); ty.className = "ty"; ty.textContent = c.dtype || "";
          b.append(n, ty); b.addEventListener("click", () => insertAtCaret(c.name)); colsHost.append(b);
        });
      }
    } catch (_) {}
    if (!ta.value.trim()) { ta.value = "SELECT * FROM t LIMIT 100"; sync(); }
    if (autorun) run();
  }
  function renderResult(p) {
    state.total = p.total; state.pages = p.pages; state.page = p.page; state.size = p.size;
    const grid = $("#swGrid");
    if (!p.rows.length) { grid.innerHTML = '<div class="sw-empty">No rows.</div>'; }
    else {
      const t = document.createElement("table"); t.className = "sw-t";
      const thead = document.createElement("thead"); const htr = document.createElement("tr");
      p.columns.forEach((c) => { const th = document.createElement("th"); th.textContent = c; htr.append(th); });
      thead.append(htr); t.append(thead);
      const tb = document.createElement("tbody");
      p.rows.forEach((row) => {
        const tr = document.createElement("tr");
        row.forEach((cell) => { const td = document.createElement("td"); if (cell === null) { td.textContent = "∅"; td.className = "nul"; } else { td.textContent = cell; } tr.append(td); });
        tb.append(tr);
      });
      t.append(tb); grid.textContent = ""; grid.append(t);
    }
    $("#swStat").textContent = `${p.total.toLocaleString()} rows · page ${p.page}/${p.pages} · ${p.ms} ms`;
    $("#swSave").disabled = false;
    renderPager();
  }
  // ── target: materialize the result as a new file (source→target) ────────────
  async function saveTarget() {
    if (!state.activeRid || !state.lastSql) return;
    const name = ($("#swTargetName").value || "").trim() || "sql_result";
    const btn = $("#swSave"); btn.disabled = true; btn.textContent = "… Saving";
    $("#swErr").style.display = "none";
    try {
      const env = await api("/api/files/" + encodeURIComponent(state.activeRid) + "/sql/materialize",
        { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sql: state.lastSql, name }) });
      const s = env.summary;
      state.targets.unshift({ rid: s.redpash_id, name: s.filename, rows: s.row_count || 0 });
      renderTargets();
      $("#swTargetName").value = "";
      $("#swStat").textContent = `Saved target "${s.filename}" · ${(s.row_count || 0).toLocaleString()} rows`;
    } catch (e) {
      const box = $("#swErr"); box.style.display = "block";
      box.textContent = (e.status === 400 ? "Materialize error: " : "") + e.message;
    } finally { btn.disabled = false; btn.textContent = "＋ Save as table"; }
  }
  function renderTargets() {
    const host = $("#swTargetList"); host.textContent = "";
    state.targets.forEach((t) => {
      const d = document.createElement("div"); d.className = "sw-target";
      d.title = "Query this target — loads it as t";
      const ok = document.createElement("span"); ok.className = "ok"; ok.textContent = "✓";
      const n = document.createElement("span"); n.textContent = t.name;
      const r = document.createElement("span"); r.className = "n"; r.textContent = (t.rows || 0).toLocaleString() + " rows";
      d.append(ok, n, r);
      d.addEventListener("click", async () => { await refreshSources(); await selectTable(t.rid, true); });
      host.append(d);
    });
  }
  async function refreshSources() {
    try {
      const d = await api("/api/files");
      state.files = (d.items || []).filter((f) => String(f.redpash_id).startsWith("FIL_") && (f.row_count ?? 0) > 0);
      renderTables();
    } catch (_) {}
  }
  function renderPager() {
    const host = $("#swPager"); host.textContent = "";
    if (state.pages <= 1) return;
    const mk = (label, pg, cur, dis) => {
      const b = document.createElement("button"); b.textContent = label;
      if (cur) b.setAttribute("aria-current", "true"); if (dis) b.disabled = true;
      if (!dis && !cur) b.addEventListener("click", () => { state.page = pg; run(state.lastSql); }); return b;
    };
    host.append(mk("‹", state.page - 1, false, state.page <= 1));
    const win = []; for (let i = Math.max(1, state.page - 2); i <= Math.min(state.pages, state.page + 2); i++) win.push(i);
    win.forEach((i) => host.append(mk(String(i), i, i === state.page, false)));
    host.append(mk("›", state.page + 1, false, state.page >= state.pages));
  }
  async function run(sql) {
    if (!state.activeRid) return;
    const q = (typeof sql === "string") ? sql : ta.value.trim();
    if (!q) return;
    if (q !== state.lastSql) state.page = 1;
    state.lastSql = q;
    const btn = $("#swRun"); btn.disabled = true; btn.textContent = "… Running";
    $("#swErr").style.display = "none";
    try {
      const p = await api("/api/files/" + encodeURIComponent(state.activeRid) + "/sql",
        { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sql: q, page: state.page, size: state.size }) });
      renderResult(p);
    } catch (e) {
      const box = $("#swErr"); box.style.display = "block";
      box.textContent = (e.status === 400 ? "Query error: " : "") + e.message;
      $("#swStat").textContent = "—";
    } finally { btn.disabled = false; btn.textContent = "▶ Run"; }
  }
  $("#swRun").addEventListener("click", () => run());
  $("#swSave").addEventListener("click", saveTarget);

  // ── view switcher: SQL ↔ Connectors ─────────────────────────────────────────
  let connLoaded = false;
  $$("#swSeg button").forEach((b) => b.addEventListener("click", () => {
    const view = b.dataset.view;
    $$("#swSeg button").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    $("#swViewSql").hidden = view !== "sql";
    $("#swViewConnectors").hidden = view !== "connectors";
    if (view === "connectors" && !connLoaded) { connLoaded = true; loadProjects(); loadConnectors(); }
  }));
  $$("#swConnCards .sw-conn-card").forEach((c) => c.addEventListener("click", () => {
    $$("#swConnCards .sw-conn-card").forEach((x) => x.classList.toggle("is-active", x === c));
    const k = c.dataset.conn;
    $("#swConnMysql").hidden = k !== "mysql";
    $("#swConnKafka").hidden = k !== "kafka";
    $("#swConnCsv").hidden = k !== "csv";
  }));

  async function loadProjects() {
    try {
      const d = await api("/api/projects");
      const items = d.items || (Array.isArray(d) ? d : []);
      const sel = $("#myProj"); sel.textContent = "";
      items.forEach((p) => { const o = document.createElement("option"); o.value = p.redpash_id; o.textContent = p.name || p.redpash_id; sel.append(o); });
      if (!items.length) $("#myNewProj").checked = true;
    } catch (_) {}
  }
  async function loadConnectors() {
    const host = $("#swConnList");
    try {
      const d = await api("/api/connectors");
      const items = d.items || [];
      if (!items.length) { host.innerHTML = '<p class="sw-conn-note">None yet — create one above.</p>'; return; }
      host.textContent = "";
      items.forEach((c) => {
        const row = document.createElement("div"); row.className = "sw-conn-row"; row.dataset.rid = c.redpash_id;
        const nm = document.createElement("span"); nm.className = "nm"; nm.textContent = c.name;
        const k = document.createElement("span"); k.className = "k"; k.textContent = c.kind;
        const sp = document.createElement("span"); sp.className = "sp2";
        const ren = document.createElement("button"); ren.className = "sw-btn sw-btn--ghost"; ren.title = "Rename"; ren.textContent = "✎";
        ren.addEventListener("click", () => renameConnector(c.redpash_id, nm));
        const del = document.createElement("button"); del.className = "sw-btn sw-btn--ghost"; del.title = "Delete"; del.textContent = "🗑";
        del.addEventListener("click", () => deleteConnector(c.redpash_id, del, row));
        const pull = document.createElement("button"); pull.className = "sw-btn sw-btn--ghost"; pull.textContent = "▶ Pull";
        pull.addEventListener("click", () => pullConnector(c.redpash_id, pull));
        row.append(nm, k, sp, ren, del, pull); host.append(row);
      });
    } catch (e) { host.innerHTML = '<p class="sw-conn-note">' + esc(e.message) + "</p>"; }
  }
  async function pullConnector(rid, btn) {
    const prev = btn.textContent; btn.disabled = true; btn.textContent = "… Pulling";
    const err = $("#swConnErr"); err.style.display = "none"; err.textContent = "";
    try {
      await api("/api/connectors/" + encodeURIComponent(rid) + "/sync", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      btn.textContent = "✓ Pulled"; await refreshSources();
      setTimeout(() => { btn.disabled = false; btn.textContent = prev; }, 1800);
    } catch (e) {
      btn.textContent = "✗ failed";
      err.textContent = "Pull failed — " + e.message; err.style.display = "block";
      console.error("pull", e);
      setTimeout(() => { btn.disabled = false; btn.textContent = prev; }, 2500);
    }
  }
  // Rename — inline edit → PATCH /api/connectors/:rid. Server gates on Admin+
  // reach to the connector's project (manage = admin power).
  async function renameConnector(rid, nmEl) {
    const cur = nmEl.textContent;
    const input = document.createElement("input"); input.className = "sw-conn-rename"; input.value = cur;
    nmEl.replaceWith(input); input.focus(); input.select();
    let done = false;
    const restore = (text) => { input.replaceWith(nmEl); nmEl.textContent = text; };
    const commit = async () => {
      if (done) return; done = true;
      const next = input.value.trim();
      if (!next || next === cur) { restore(cur); return; }
      try {
        const c = await api("/api/connectors/" + encodeURIComponent(rid),
          { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: next }) });
        restore(c.name || next);
      } catch (e) {
        restore(cur);
        const err = $("#swConnErr"); err.textContent = "Rename failed — " + e.message; err.style.display = "block";
      }
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); commit(); }
      else if (e.key === "Escape") { done = true; restore(cur); }
    });
    input.addEventListener("blur", commit);
  }
  // Delete — two-click confirm (no browser dialog) → DELETE /api/connectors/:rid (204).
  async function deleteConnector(rid, btn, row) {
    if (btn.dataset.armed !== "1") {
      btn.dataset.armed = "1"; btn.textContent = "Sure?"; btn.classList.add("sw-btn--danger");
      setTimeout(() => {
        if (btn.dataset.armed === "1") { btn.dataset.armed = ""; btn.textContent = "🗑"; btn.classList.remove("sw-btn--danger"); }
      }, 2500);
      return;
    }
    btn.disabled = true; btn.textContent = "…";
    try {
      await api("/api/connectors/" + encodeURIComponent(rid), { method: "DELETE" });
      row.remove();
      if (!$("#swConnList").querySelector(".sw-conn-row")) loadConnectors();
    } catch (e) {
      btn.disabled = false; btn.dataset.armed = ""; btn.textContent = "🗑"; btn.classList.remove("sw-btn--danger");
      const err = $("#swConnErr"); err.textContent = "Delete failed — " + e.message; err.style.display = "block";
    }
  }
  $("#myCreate").addEventListener("click", async () => {
    const msg = $("#myMsg"); const btn = $("#myCreate");
    const db = ($("#myDb").value || "").trim(), table = ($("#myTable").value || "").trim();
    if (!db || !table) { msg.textContent = "Database and table are required."; return; }
    btn.disabled = true; btn.textContent = "… Working"; msg.textContent = "";
    try {
      let projectId = $("#myProj").value;
      if ($("#myNewProj").checked || !projectId) {
        const p = await api("/api/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: db }) });
        projectId = p.redpash_id || (p.project && p.project.redpash_id);
      }
      const config = {
        host: ($("#myHost").value || "127.0.0.1").trim(), port: Number($("#myPort").value) || 3306,
        user: ($("#myUser").value || "root").trim(), password: $("#myPass").value || "", database: db, table,
      };
      const con = await api("/api/connectors", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: db + "." + table, project_id: projectId, kind: "mysql", config }) });
      msg.textContent = "Created — pulling…";
      try {
        await api("/api/connectors/" + encodeURIComponent(con.redpash_id) + "/sync", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
        msg.textContent = `Pulled "${table}" → a CSV is now in your project. Switch to SQL to query it.`;
        await refreshSources();
      } catch (e) { msg.textContent = "Connector created, but pull failed: " + e.message; }
      await loadConnectors();
    } catch (e) { msg.textContent = "Error: " + e.message; }
    finally { btn.disabled = false; btn.textContent = "▶ Create & Pull"; }
  });

  sync();
  loadFiles();
}
