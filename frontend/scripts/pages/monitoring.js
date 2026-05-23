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
  { group: "REQUESTS", key: "requests", label: "Requests", icon: "bi-globe2",         endpoint: "/metrics",                wired: true  },
  { group: "REQUESTS", key: "events",   label: "Events",   icon: "bi-envelope",       endpoint: "/monitoring/events",      wired: false },
  // ── AUDITS ─────────────────────────────────────────────────
  { group: "AUDITS",   key: "runs",     label: "Runs",     icon: "bi-play-circle",    endpoint: "/monitoring/audit-runs",  wired: false },
  { group: "AUDITS",   key: "findings", label: "Findings", icon: "bi-exclamation-triangle", endpoint: "/monitoring/audit-findings", wired: false },
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
    if (tab.key !== "requests") return;
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
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}
function cssEsc(s) {
  return window.CSS?.escape ? CSS.escape(s) : String(s).replace(/["\\]/g, "\\$&");
}
