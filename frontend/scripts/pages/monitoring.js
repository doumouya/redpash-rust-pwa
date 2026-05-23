// Monitoring — the system telemetry surface.
//
// Same shell pattern as Home (rail + body) — see shell.css. Static
// rail groups: REQUESTS / AUDITS. Phase 1 wires the Requests tab
// against GET /api/metrics?window=<1h|24h|7d|30d>. Other tabs render
// disabled in the rail until their backend list endpoints land (see
// docs/internal/admin-monitoring-surfaces.md §6).

import { api } from "/scripts/api.js";
import { mountTopbar } from "/scripts/topbar.js";

// Same MON_TABS declaration shape as home.js — explicit, RBAC-friendly.
// `endpoint` is the un-prefixed path; the /api/ literal is never in a
// string by itself so the crossing audit doesn't mistake it for a call.
const MON_TABS = [
  // ── REQUESTS ───────────────────────────────────────────────
  { group: "REQUESTS", key: "requests", label: "Requests", icon: "bi-globe2",         endpoint: "/metrics",                wired: true },
  { group: "REQUESTS", key: "events",   label: "Events",   icon: "bi-envelope",       endpoint: "/monitoring/events",      wired: true },
  // ── AUDITS ─────────────────────────────────────────────────
  { group: "AUDITS",   key: "runs",     label: "Runs",     icon: "bi-play-circle",    endpoint: "/monitoring/audit-runs",  wired: true },
  { group: "AUDITS",   key: "findings", label: "Findings", icon: "bi-exclamation-triangle", endpoint: "/monitoring/audit-findings", wired: true },
];

const MON_GROUPS = [
  { name: "REQUESTS", mark: "RQ", color: "blue"  },
  { name: "AUDITS",   mark: "AD", color: "peach" },
];

const WINDOWS = ["1h", "24h", "7d", "30d"];
const MON_DEFAULT_TAB    = "requests";
const DEFAULT_WINDOW = "24h";

export default function monitoring(app, { session }) {
  mountTopbar(app.querySelector("#rp-topbar"), { active: "monitoring", session });

  const nav     = app.querySelector("#rpMonNav");
  const navBody = app.querySelector("#rpMonNavBody");
  const view    = app.querySelector("#rpMonView");

  // List-view specs for the three non-Requests tabs. Same Page<T>
  // shape across all three endpoints, so the renderer is generic; per
  // tab only the columns + row HTML differ. Declared before any
  // execution path that touches it (renderTabBody → renderListBody)
  // so the const isn't in TDZ when activate() runs below.
  const LIST_VIEWS = {
    events: {
      title: "Events",
      endpoint: "/monitoring/events",
      useWindow: true,
      columns: ["Time", "Level", "Origin", "Kind", "Message", "Status"],
      row: (e) =>
        '<tr>'
        + '<td>' + fmtTime(e.occurred_at) + '</td>'
        + '<td>' + levelChip(e.level) + '</td>'
        + '<td>' + esc(e.origin) + '</td>'
        + '<td>' + esc(e.kind) + '</td>'
        + '<td>' + esc(e.message) + '</td>'
        + '<td class="is-num">' + (e.http_status != null ? e.http_status : "—") + '</td>'
        + '</tr>',
    },
    runs: {
      title: "Audit runs",
      endpoint: "/monitoring/audit-runs",
      useWindow: false,
      columns: ["Time", "Tool", "SHA", "Branch", "Headline"],
      row: (r) =>
        '<tr>'
        + '<td>' + fmtTime(r.ran_at) + '</td>'
        + '<td><span class="rp-mon-method">' + esc(r.tool) + '</span></td>'
        + '<td>' + (r.git_sha ? '<code>' + esc(String(r.git_sha).slice(0, 7)) + '</code>' : "—") + '</td>'
        + '<td>' + esc(r.git_branch || "—") + '</td>'
        + '<td>' + summarizeStats(r.stats) + '</td>'
        + '</tr>',
    },
    findings: {
      title: "Audit findings",
      endpoint: "/monitoring/audit-findings",
      useWindow: false,
      columns: ["Run", "Tool", "Kind", "Finding", "Severity"],
      row: (f) =>
        '<tr>'
        + '<td class="is-num">#' + f.run_id + '</td>'
        + '<td><span class="rp-mon-method">' + esc(f.tool) + '</span></td>'
        + '<td>' + esc(f.kind) + '</td>'
        + '<td>' + esc(f.finding_key) + '</td>'
        + '<td class="is-num">' + (f.severity != null ? f.severity : "—") + '</td>'
        + '</tr>',
    },
  };

  // ─── rail collapse (same affordance as Workspace + Home) ────
  app.querySelector("#rpMonNavCollapse").addEventListener("click", (e) => {
    nav.classList.toggle("compact");
    e.currentTarget.querySelector("i").className = nav.classList.contains("compact")
      ? "bi bi-chevron-double-right" : "bi bi-chevron-double-left";
  });

  // ─── render the rail (static groups → tabs) ─────────────────
  navBody.innerHTML = MON_GROUPS.map(renderGroup).join("");
  navBody.querySelectorAll(".rt-group").forEach((g) => g.classList.add("expanded"));

  // Active tab — from hash (?tab=<key>) or default. Only wired keys
  // activate; an unwired hash coerces to the default tab.
  const params = new URLSearchParams(location.hash.split("?")[1] || "");
  const wantTab = params.get("tab") || MON_DEFAULT_TAB;
  activate(wantTab);

  // ─── rail click delegation ───────────────────────────────────
  navBody.addEventListener("click", (e) => {
    const head = e.target.closest(".rt-group-head");
    if (head) { head.closest(".rt-group").classList.toggle("expanded"); return; }
    const tab = e.target.closest(".rt-tab");
    if (tab) activate(tab.dataset.key);
  });

  // ─── rail helpers ────────────────────────────────────────────
  function renderGroup(g) {
    const tabs = MON_TABS.filter((t) => t.group === g.name);
    return ''
      + '<div class="rt-group">'
      +   '<button class="rt-group-head" type="button">'
      +     '<i class="bi bi-chevron-down rt-group-caret"></i>'
      +     '<span class="rt-group-mark" data-c="' + g.color + '">' + g.mark + '</span>'
      +     '<span class="rt-group-name">' + esc(g.name) + '</span>'
      +     '<span class="rt-group-count">' + tabs.length + '</span>'
      +   '</button>'
      +   '<div class="rt-group-body">' + tabs.map(renderTab).join("") + '</div>'
      + '</div>';
  }
  function renderTab(t) {
    const attrs = t.wired
      ? ' data-key="' + esc(t.key) + '"'
      : ' disabled title="Coming soon — endpoint /api' + esc(t.endpoint) + ' pending"';
    return ''
      + '<button class="rt-tab" type="button"' + attrs + '>'
      +   '<i class="' + esc(t.icon) + ' rt-tab-icon"></i>'
      +   '<span class="rt-tab-name">' + esc(t.label) + '</span>'
      + '</button>';
  }

  // ─── tab activation ──────────────────────────────────────────
  function activate(key) {
    const requested = MON_TABS.find((t) => t.key === key);
    const tab = (requested && requested.wired)
      ? requested
      : MON_TABS.find((t) => t.key === MON_DEFAULT_TAB);
    navBody.querySelectorAll(".rt-tab.active").forEach((t) => t.classList.remove("active"));
    const btn = navBody.querySelector('.rt-tab[data-key="' + cssEsc(tab.key) + '"]');
    if (btn) btn.classList.add("active");
    renderTabBody(tab);
  }

  function renderTabBody(tab) {
    if (tab.key === "requests") return renderRequestsBody();
    const view = LIST_VIEWS[tab.key];
    if (view) return renderListBody(tab, view);
  }

  function renderRequestsBody() {
    view.innerHTML = ''
      + headHTML("Requests", "")
      + windowChipsHTML(DEFAULT_WINDOW)
      + kpiStripHTML([
          { label: "Requests",   id: "rp-kpi-req-count" },
          { label: "Error rate", id: "rp-kpi-req-err"   },
          { label: "p50",        id: "rp-kpi-req-p50"   },
          { label: "p95",        id: "rp-kpi-req-p95"   },
        ])
      + topRoutesPanel()
      + pendingPanel("Latency over time", "Bucketed time-series",
                     "/monitoring/requests?bucket=1m (or similar)")
      + pendingPanel("Status code mix", "Distribution by HTTP status",
                     "/monitoring/requests?group_by=status (or similar)");

    // Window-chip click delegation — refetch on change.
    view.querySelector(".rp-mon-window").addEventListener("click", (e) => {
      const chip = e.target.closest(".rp-mon-window-chip");
      if (!chip) return;
      view.querySelectorAll(".rp-mon-window-chip.is-active").forEach((c) => c.classList.remove("is-active"));
      chip.classList.add("is-active");
      fetchMetrics(chip.dataset.window);
    });

    fetchMetrics(DEFAULT_WINDOW);
  }

  // ─── list-view tabs (Events / Runs / Findings) ───────────────
  // The three monitoring list endpoints share the same Page<T> shape,
  // so one renderer handles all three — only columns + row HTML
  // differ. LIST_VIEWS at the bottom of the file declares each tab's
  // shape. Window chips apply only to Events (the others have no
  // time-window filter at the wire layer).
  let listPage   = 1;
  const LIST_PAGE_SIZE = 50;
  let listTotalPages = 1;
  let listWindow = DEFAULT_WINDOW;

  function renderListBody(tab, viewSpec) {
    listPage = 1;
    listWindow = DEFAULT_WINDOW;
    view.innerHTML = ''
      + headHTML(viewSpec.title, "")
      + (viewSpec.useWindow ? windowChipsHTML(DEFAULT_WINDOW) : "")
      + kpiStripHTML([
          { label: "Total",     id: "rp-mon-list-total"  },
          { label: "On page",   id: "rp-mon-list-shown"  },
          { label: "Page",      id: "rp-mon-list-page"   },
          { label: "Last fetch", id: "rp-mon-list-ms"    },
        ])
      + listPanel(viewSpec.columns)
      + '<div class="rp-mon-list-pager" id="rp-mon-list-pager"></div>';

    if (viewSpec.useWindow) {
      view.querySelector(".rp-mon-window").addEventListener("click", (e) => {
        const chip = e.target.closest(".rp-mon-window-chip");
        if (!chip) return;
        view.querySelectorAll(".rp-mon-window-chip.is-active").forEach((c) => c.classList.remove("is-active"));
        chip.classList.add("is-active");
        listWindow = chip.dataset.window;
        listPage = 1;
        fetchList(viewSpec);
      });
    }
    view.querySelector("#rp-mon-list-pager").addEventListener("click", (e) => {
      const btn = e.target.closest(".rt-pg[data-page]");
      if (!btn) return;
      const target = parseInt(btn.dataset.page, 10);
      if (!Number.isFinite(target) || target < 1 || target > listTotalPages || target === listPage) return;
      listPage = target;
      fetchList(viewSpec);
    });

    fetchList(viewSpec);
  }

  async function fetchList(viewSpec) {
    setKpi("rp-mon-list-total", "…");
    setKpi("rp-mon-list-shown", "…");
    setKpi("rp-mon-list-page",  String(listPage));
    setKpi("rp-mon-list-ms",    "…");
    const tbody = view.querySelector("#rp-mon-list-tbody");
    const colCount = viewSpec.columns.length;
    if (tbody) tbody.innerHTML = '<tr><td colspan="' + colCount + '">Loading…</td></tr>';

    const qs = "?page=" + listPage + "&size=" + LIST_PAGE_SIZE
             + (viewSpec.useWindow ? "&window=" + encodeURIComponent(listWindow) : "");
    const t0 = performance.now();
    try {
      const data = await api.get(viewSpec.endpoint + qs);
      const rows = data?.rows || [];
      listTotalPages = data?.pages || 1;
      listPage       = data?.page  || listPage;
      const elapsed = Math.round(performance.now() - t0);
      setKpi("rp-mon-list-total", fmtCount(data?.total || 0));
      setKpi("rp-mon-list-shown", String(rows.length));
      setKpi("rp-mon-list-page",  listPage + " / " + listTotalPages);
      setKpi("rp-mon-list-ms",    elapsed + "ms");
      const head = view.querySelector(".rp-shell-head-count");
      if (head) head.textContent = (data?.total || 0) + (viewSpec.useWindow ? " in " + listWindow : "");
      if (tbody) {
        tbody.innerHTML = rows.length
          ? rows.map(viewSpec.row).join("")
          : '<tr><td colspan="' + colCount + '">No rows.</td></tr>';
      }
      renderListPager();
    } catch (err) {
      setKpi("rp-mon-list-total", "—");
      setKpi("rp-mon-list-shown", "—");
      setKpi("rp-mon-list-page",  "—");
      setKpi("rp-mon-list-ms",    "—");
      if (tbody) tbody.innerHTML = '<tr><td colspan="' + colCount + '">Couldn’t load'
        + (err?.status ? " (" + err.status + ")" : "") + '.</td></tr>';
    }
  }

  function renderListPager() {
    const el = view.querySelector("#rp-mon-list-pager");
    if (!el || listTotalPages < 1) { if (el) el.innerHTML = ""; return; }
    const p = listPage, last = listTotalPages;
    const out = [];
    out.push(pagerBtn("‹", p - 1, false, p === 1));
    if (last <= 7) {
      for (let i = 1; i <= last; i++) out.push(pagerBtn(String(i), i, i === p, false));
    } else {
      const want = new Set([1, last, p, p - 1, p + 1]);
      let prev = 0;
      for (let i = 1; i <= last; i++) {
        if (!want.has(i)) continue;
        if (i - prev > 1) out.push('<span class="rt-pg-gap">…</span>');
        out.push(pagerBtn(String(i), i, i === p, false));
        prev = i;
      }
    }
    out.push(pagerBtn("›", p + 1, false, p === last));
    el.innerHTML = '<div class="rt-pages">' + out.join("") + '</div>';
  }
  function pagerBtn(label, page, active, disabled) {
    return '<button class="rt-pg' + (active ? " active" : "") + '" type="button"'
      + (disabled ? " disabled" : ' data-page="' + page + '"') + ">" + label + "</button>";
  }

  // ─── /api/metrics fetch + paint ──────────────────────────────
  async function fetchMetrics(window) {
    setKpi("rp-kpi-req-count", "…");
    setKpi("rp-kpi-req-err",   "…");
    setKpi("rp-kpi-req-p50",   "…");
    setKpi("rp-kpi-req-p95",   "…");
    const tbody = view.querySelector("#rp-mon-routes-tbody");
    if (tbody) tbody.innerHTML = '<tr><td colspan="5" class="is-num">Loading…</td></tr>';
    try {
      const data = await api.get("/metrics?window=" + encodeURIComponent(window));
      paintKpis(data?.overall);
      paintTopRoutes(data?.by_route || []);
      const head = view.querySelector(".rp-shell-head-count");
      if (head) head.textContent = (data?.window?.label || window) + " window";
    } catch (err) {
      setKpi("rp-kpi-req-count", "—");
      setKpi("rp-kpi-req-err",   "—");
      setKpi("rp-kpi-req-p50",   "—");
      setKpi("rp-kpi-req-p95",   "—");
      if (tbody) tbody.innerHTML = '<tr><td colspan="5" class="is-num">Couldn’t load metrics'
        + (err?.status ? " (" + err.status + ")" : "") + '.</td></tr>';
    }
  }

  function paintKpis(o) {
    if (!o) return;
    setKpi("rp-kpi-req-count", fmtCount(o.count));
    setKpi("rp-kpi-req-err",   fmtPct(o.error_rate));
    setKpi("rp-kpi-req-p50",   o.p50_ms + "ms");
    setKpi("rp-kpi-req-p95",   o.p95_ms + "ms");
  }

  function paintTopRoutes(rows) {
    const tbody = view.querySelector("#rp-mon-routes-tbody");
    if (!tbody) return;
    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="5" class="is-num">No requests in this window.</td></tr>';
      return;
    }
    // Rank by p95 desc — slowest routes first, the operator's
    // interesting tail. Ties broken by count desc.
    const ranked = rows.slice().sort((a, b) => {
      if (b.p95_ms !== a.p95_ms) return b.p95_ms - a.p95_ms;
      return b.count - a.count;
    }).slice(0, 10);
    tbody.innerHTML = ranked.map((r) =>
      '<tr>'
      + '<td><span class="rp-mon-method">' + esc(r.method) + '</span> ' + esc(r.route) + '</td>'
      + '<td class="is-num">' + fmtCount(r.count) + '</td>'
      + '<td class="is-num ' + errBand(r.error_rate) + '">' + fmtPct(r.error_rate) + '</td>'
      + '<td class="is-num">' + r.p50_ms + 'ms</td>'
      + '<td class="is-num">' + r.p95_ms + 'ms</td>'
      + '</tr>'
    ).join("");
  }

  // ─── render utilities ────────────────────────────────────────
  function headHTML(title, count) {
    return '<header class="rp-shell-head">'
      +   '<h2 class="rp-shell-head-title">' + esc(title) + '</h2>'
      +   '<span class="rp-shell-head-count">' + esc(count) + '</span>'
      + '</header>';
  }
  function windowChipsHTML(active) {
    return '<div class="rp-mon-window">'
      + WINDOWS.map((w) =>
          '<button type="button" class="rp-mon-window-chip' + (w === active ? ' is-active' : '') + '"'
          + ' data-window="' + esc(w) + '">' + esc(w) + '</button>'
        ).join("")
      + '</div>';
  }
  function kpiStripHTML(tiles) {
    return '<div class="rp-kpi-strip">'
      + tiles.map((t) =>
          '<div class="rp-kpi">'
          + '<span class="rp-kpi-label">' + esc(t.label) + '</span>'
          + '<span class="rp-kpi-value" id="' + esc(t.id) + '">—</span>'
          + '</div>'
        ).join("")
      + '</div>';
  }
  function topRoutesPanel() {
    return '<section class="rp-mon-panel">'
      + '<div class="rp-mon-panel-head">'
      +   '<h3 class="rp-mon-panel-title">Top routes</h3>'
      +   '<span class="rp-mon-panel-hint">ranked by p95 latency</span>'
      + '</div>'
      + '<table class="rp-mon-table">'
      +   '<thead><tr>'
      +     '<th>Route</th><th>Count</th><th>Error %</th><th>p50</th><th>p95</th>'
      +   '</tr></thead>'
      +   '<tbody id="rp-mon-routes-tbody"></tbody>'
      + '</table>'
      + '</section>';
  }
  function pendingPanel(title, hint, endpoint) {
    return '<section class="rp-mon-panel is-pending">'
      + '<div class="rp-mon-panel-head">'
      +   '<h3 class="rp-mon-panel-title">' + esc(title) + '</h3>'
      +   '<span class="rp-mon-panel-hint">' + esc(hint) + '</span>'
      + '</div>'
      + '<p>Coming when its backend endpoint lands.</p>'
      + '<span class="rp-mon-panel-endpoint">' + esc(endpoint) + '</span>'
      + '</section>';
  }
  function setKpi(id, val) {
    const el = view.querySelector("#" + id);
    if (el) el.textContent = val;
  }
  function errBand(rate) {
    if (rate == null) return "";
    if (rate < 1)  return "rp-mon-err-low";
    if (rate < 5)  return "rp-mon-err-mid";
    return "rp-mon-err-high";
  }
  function fmtCount(n) {
    if (n == null) return "—";
    if (n < 1000)    return String(n);
    if (n < 1000000) return (n / 1000).toFixed(1) + "k";
    return (n / 1000000).toFixed(1) + "M";
  }
  function fmtPct(v) {
    if (v == null) return "—";
    return (Math.round(v * 100) / 100) + "%";
  }
  function fmtTime(iso) {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return "—";
    // Compact form — "May 23, 19:42:07". Local time, which is fine for
    // a single-operator dev tool; switch to UTC if we ship to a team.
    const date = d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    const time = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
    return date + ", " + time;
  }
  function levelChip(level) {
    const v = String(level || "").toLowerCase();
    const cls = v === "error" || v === "err" || v === "panic" ? "rp-mon-err-high"
              : v === "warn"  || v === "warning"              ? "rp-mon-err-mid"
              : v === "info"  || v === "debug" || v === "trace" ? "rp-mon-err-low"
              : "";
    return '<span class="rp-mon-method ' + cls + '">' + esc(level || "—") + '</span>';
  }
  function summarizeStats(stats) {
    if (!stats || typeof stats !== "object") return "—";
    // Pick the two or three most-informative top-level numeric fields.
    // Each audit tool's `stats` shape is different (css has reachable
    // / orphans, html has conflictCount / divergentCount, etc.); we
    // grab whatever's there in priority order.
    const keys = ["files", "errors", "warnings", "conflictCount",
                  "divergentCount", "orphans", "reachable", "danglingImports"];
    const chips = [];
    for (const k of keys) {
      if (stats[k] != null && chips.length < 3) {
        chips.push('<span class="rp-mon-stat-chip">' + esc(k) + ' ' + esc(String(stats[k])) + '</span>');
      }
    }
    return chips.length ? chips.join(" ") : "—";
  }
  function listPanel(columns) {
    return '<section class="rp-mon-panel">'
      + '<table class="rp-mon-table">'
      +   '<thead><tr>' + columns.map((c) => '<th>' + esc(c) + '</th>').join("") + '</tr></thead>'
      +   '<tbody id="rp-mon-list-tbody"></tbody>'
      + '</table>'
      + '</section>';
  }

}

function esc(s) {
  return String(s ?? "").replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}
function cssEsc(s) {
  return window.CSS?.escape ? CSS.escape(s) : String(s).replace(/["\\]/g, "\\$&");
}
