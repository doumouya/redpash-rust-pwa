// Monitoring — the system telemetry surface.
//
// Same shell pattern as Home (rail + body) — see shell.css. Static
// rail groups: REQUESTS / AUDITS. Phase 1 wires the Requests tab
// against GET /api/metrics?window=<1h|24h|7d|30d>. Other tabs render
// disabled in the rail until their backend list endpoints land (see
// docs/internal/admin-monitoring-surfaces.md §6).

import { api } from "/scripts/api.js";
import { mountTopbar } from "/scripts/topbar.js";
import { esc, cssEsc } from "/scripts/dom.js";
import { chartTheme, ensureRegisteredThemes } from "/scripts/echarts-theme.js";
import { getPref } from "/scripts/prefs.js";
import {
  headHTML, kpiStripHTML, chartsStripHTML,
  windowChipsHTML as _windowChipsHTML,
  listPanel as _listPanel,
  setKpi as _setKpi,
  renderListPager as _renderListPager,
  createListCharts,
} from "/scripts/list-page.js";

// Same MON_TABS declaration shape as home.js — explicit, RBAC-friendly.
// `endpoint` is the un-prefixed path; the /api/ literal is never in a
// string by itself so the crossing audit doesn't mistake it for a call.
const MON_TABS = [
  // ── REQUESTS ───────────────────────────────────────────────
  { group: "REQUESTS", key: "requests", label: "Requests", icon: "bi-globe2",         endpoint: "/metrics",                wired: true },
  { group: "REQUESTS", key: "events",   label: "Events",   icon: "bi-envelope",       endpoint: "/monitoring/events",      wired: true },
  // ── AUDITS ─────────────────────────────────────────────────
  { group: "AUDITS",   key: "runs",     label: "Runs",     icon: "bi-play-circle",          endpoint: "/monitoring/audit-runs",     wired: true },
  { group: "AUDITS",   key: "findings", label: "Findings", icon: "bi-exclamation-triangle", endpoint: "/monitoring/audit-findings", wired: true },
  // Moved from Home — Steps are operational audit-trail records of
  // cleaning ops, fits Monitoring's "what happened" framing better
  // than Home's org/data inventory.
  { group: "AUDITS",   key: "steps",    label: "Steps",    icon: "bi-wrench",               endpoint: "/admin/steps",               wired: true },
  // ── OPTIMIZATION — known opportunities × live measurements ─
  // Spec: docs/internal/specs/optimization-map.md. Each row pairs a
  // doc-side optimization point with the metadata to evaluate its
  // current cost; the server returns current_value + tipped on every
  // fetch.
  { group: "OPTIMIZATION", key: "optimization", label: "Map", icon: "bi-wrench-adjustable", endpoint: "/monitoring/optimization-points", wired: true },
  // ── USERS — per-user activity feed (M-2 from slice E) ────
  // "What is this user doing right now?" lens — different from
  // /admin/users (organisational inventory). Combines request_log
  // + events into one time-ordered timeline scoped to a user_rid.
  { group: "USERS",    key: "user_activity", label: "Activity", icon: "bi-person-lines-fill", endpoint: "/monitoring/users",        wired: true },
  // ── INSPECT — stripped redtable variant ────────────────────
  // Disabled until Gus ships the unified /api/monitoring/logs
  // endpoint. The button telegraphs the surface that's coming
  // (workspace-style filter + read-only table across event /
  // request / audit / finding sources); not clickable yet.
  { group: "INSPECT",  key: "logs",     label: "Logs",     icon: "bi-card-list",            endpoint: "/monitoring/logs",           wired: false },
];

const MON_GROUPS = [
  { name: "REQUESTS",     mark: "RQ", color: "blue"  },
  { name: "AUDITS",       mark: "AD", color: "peach" },
  { name: "OPTIMIZATION", mark: "OP", color: "green" },
  { name: "USERS",        mark: "US", color: "sky"   },
  { name: "INSPECT",      mark: "IN", color: "mauve" },
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
      row: (e) => {
        // M-4: 5xx-from-AppError events carry `context.error_chain`
        // (populated by the airlock per c12b1fe — sanitized via
        // redact_chain, capped 2048 chars). Render an expandable
        // sibling row holding the chain in a <pre>. Click on the
        // primary row toggles it. No expander when the field's
        // absent — keeps non-error rows clean.
        const chain = e.context?.error_chain;
        const expandable = !!chain;
        const primary = '<tr' + (expandable ? ' class="rt-mon-row-expandable"' : '') + '>'
          + '<td>' + (expandable ? '<i class="bi bi-chevron-right rt-mon-row-caret"></i> ' : '')
            + fmtTime(e.occurred_at) + '</td>'
          + '<td>' + levelChip(e.level) + '</td>'
          + '<td>' + esc(e.origin) + '</td>'
          + '<td>' + esc(e.kind) + '</td>'
          + '<td>' + esc(e.message) + '</td>'
          + '<td class="is-num">' + (e.http_status != null ? e.http_status : "—") + '</td>'
          + '</tr>';
        if (!expandable) return primary;
        const errKind = e.context?.error_kind ? '<span class="rt-mon-chain-kind">' + esc(e.context.error_kind) + '</span>' : '';
        return primary
          + '<tr class="rt-mon-row-expansion" hidden>'
          +   '<td colspan="6">'
          +     '<div class="rt-mon-chain">'
          +       errKind
          +       '<pre>' + esc(chain) + '</pre>'
          +     '</div>'
          +   '</td>'
          + '</tr>';
      },
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
    steps: {
      title: "Steps",
      endpoint: "/admin/steps",
      useWindow: false,
      charts: [
        { id: "rp-mon-steps-kind", title: "By kind (top 10)", kind: "barH",
          data: (s) => s.by_kind, opts: { top: 10 } },
        { id: "rp-mon-steps-24h",  title: "Active last 24h",  kind: "gauge",
          data: (s) => s.total ? Math.round((s.last_24h / s.total) * 100) : 0,
          opts: { max: 100, unit: "%" } },
      ],
      columns: ["File", "#", "Kind", "Applied", "When"],
      row: (s) =>
        '<tr>'
        + '<td>' + esc(s.file_filename) + '</td>'
        + '<td class="is-num">' + s.ordinal + '</td>'
        + '<td><span class="rp-mon-method">' + esc(s.kind) + '</span></td>'
        + '<td>' + (s.applied ? '<span class="rp-mon-method rp-mon-err-low">yes</span>'
                              : '<span class="rp-mon-method">no</span>') + '</td>'
        + '<td>' + fmtTime(s.created_at) + '</td>'
        + '</tr>',
    },
  };

  // Per-Requests-tab state for the donut + Recent requests drill-down.
  // Window state lives in the active chip (read on demand). Declared
  // up here — before activate() runs below — so the const isn't in
  // TDZ when renderTabBody → renderRequestsBody → disposeRequestsCharts
  // touches it on the first mount.
  let rawPage = 1;
  let rawTotalPages = 1;
  let donutChart = null;  // ECharts instance — disposed on body rebuild

  // Honors the user's `rowsPerPageMonitoring` pref (set on /settings).
  // "all" maps to a large one-shot page so the same paginated path
  // stays in service. Read on each fetch so a mid-session pref change
  // picks up on the next navigation. Workspace + Home have their own
  // per-surface keys (rowsPerPageWorkspace / rowsPerPageHome).
  function pageSizeFromPref() {
    const raw = getPref("rowsPerPageMonitoring");
    if (raw === "all") return 500; // backend MAX_PAGE_SIZE
    const n = parseInt(raw || "", 10);
    return Number.isFinite(n) && n > 0 ? n : 25;
  }

  // List-page bindings — partial-apply view + ID prefixes once so
  // call sites keep their original short-arg signatures. Charts
  // controller is the dispose/mount handle.
  const charts          = createListCharts(view, { logPrefix: "monitoring" });
  const setKpi          = (id, val) => _setKpi(view, id, val);
  const renderListPager = () =>
    _renderListPager(view, "rp-mon-list-pager", { page: listPage, totalPages: listTotalPages });
  const listPanel       = (columns) => _listPanel(columns, "rp-mon-list-tbody");

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
    if (tab.key === "requests")      return renderRequestsBody();
    if (tab.key === "optimization")  return renderOptimizationBody();
    if (tab.key === "user_activity") return renderUserActivityBody();
    const view = LIST_VIEWS[tab.key];
    if (view) return renderListBody(tab, view);
  }

  function disposeRequestsCharts() {
    if (donutChart) { try { donutChart.dispose(); } catch { /* already gone */ } }
    donutChart = null;
  }

  function renderRequestsBody() {
    disposeRequestsCharts();
    charts.dispose();
    rawPage = 1;
    view.innerHTML = ''
      + headHTML("Requests", "")
      + windowChipsHTML(DEFAULT_WINDOW)
      + kpiStripHTML([
          { label: "Requests",   id: "rp-kpi-req-count" },
          { label: "Error rate", id: "rp-kpi-req-err"   },
          { label: "p50",        id: "rp-kpi-req-p50"   },
          { label: "p95",        id: "rp-kpi-req-p95"   },
        ])
      + panicPanel()                       // M-3 — slot above the charts row
      + '<div class="rp-mon-charts-row">'
      +   statusMixPanel()
      +   topRoutesPanel()
      + '</div>'
      + pendingPanel("Latency over time", "Bucketed time-series",
                     "/monitoring/requests?bucket=1m (or similar)")
      + recentRequestsPanel();

    // Window-chip click delegation — refetch all four sources.
    view.querySelector(".rp-chip-row").addEventListener("click", (e) => {
      const chip = e.target.closest(".rp-chip");
      if (!chip) return;
      view.querySelectorAll(".rp-chip.is-active").forEach((c) => c.classList.remove("is-active"));
      chip.classList.add("is-active");
      const w = chip.dataset.window;
      rawPage = 1;
      fetchMetrics(w);
      fetchRequestsStats(w);
      fetchRecentRequests(w);
      fetchRecentPanics(w);
    });

    // M-3 — click-to-expand on a panic row toggles its backtrace_head pane.
    view.querySelector("#rp-mon-panic-tbody")?.addEventListener("click", (e) => {
      const row = e.target.closest("tr.rt-mon-row-expandable");
      if (!row) return;
      const expansion = row.nextElementSibling;
      if (!expansion || !expansion.classList.contains("rt-mon-row-expansion")) return;
      const opening = expansion.hidden;
      expansion.hidden = !opening;
      const caret = row.querySelector(".rt-mon-row-caret");
      if (caret) {
        caret.classList.toggle("bi-chevron-down", opening);
        caret.classList.toggle("bi-chevron-right", !opening);
      }
    });

    // Raw-table pager.
    view.querySelector("#rp-mon-raw-pager").addEventListener("click", (e) => {
      const btn = e.target.closest(".rt-pg[data-page]");
      if (!btn) return;
      const target = parseInt(btn.dataset.page, 10);
      if (!Number.isFinite(target) || target < 1 || target > rawTotalPages || target === rawPage) return;
      rawPage = target;
      fetchRecentRequests(activeWindow());
    });

    // M-1 — click a Recent requests row → request-replay modal.
    // Rows without a request_id (legacy / pre-correlation entries) are
    // not clickable; data-request-id gates the openable rows.
    view.querySelector("#rp-mon-raw-tbody")?.addEventListener("click", (e) => {
      const row = e.target.closest("tr[data-request-id]");
      if (!row) return;
      openRequestReplay(row.dataset.requestId);
    });

    fetchMetrics(DEFAULT_WINDOW);
    fetchRequestsStats(DEFAULT_WINDOW);
    fetchRecentRequests(DEFAULT_WINDOW);
    fetchRecentPanics(DEFAULT_WINDOW);
  }

  function activeWindow() {
    const chip = view.querySelector(".rp-chip-row .rp-chip.is-active");
    return chip?.dataset.window || DEFAULT_WINDOW;
  }

  // ─── M-3: recent panics pane on the Requests landing ─────────
  // Fetches events?kind=panic for the active window, renders the
  // last 5 with an inline expander showing context.backtrace_head.
  // Empty state — the common case — hides the whole pane so the
  // landing stays clean unless there's actually something to surface.
  async function fetchRecentPanics(window) {
    const wrap = view.querySelector("#rp-mon-panic-pane");
    const tbody = view.querySelector("#rp-mon-panic-tbody");
    const countEl = view.querySelector("#rp-mon-panic-count");
    if (!wrap || !tbody) return;
    try {
      const data = await api.get(
        "/monitoring/events?kind=panic&window=" + encodeURIComponent(window) + "&size=5"
      );
      const rows = data?.rows || [];
      const total = data?.total || 0;
      if (!rows.length) {
        wrap.hidden = true;
        return;
      }
      wrap.hidden = false;
      if (countEl) countEl.textContent = total + (total === 1 ? " panic" : " panics") + " in " + window;
      tbody.innerHTML = rows.map(panicRowHTML).join("");
    } catch {
      // Fire-and-forget surface — silent failure keeps the landing
      // usable when the panic feed itself errors.
      wrap.hidden = true;
    }
  }

  function panicRowHTML(e) {
    const head = e.context?.backtrace_head;
    const loc  = e.context?.location;
    const message = e.message || e.kind;
    const expandable = !!head;
    const primary = '<tr' + (expandable ? ' class="rt-mon-row-expandable"' : '') + '>'
      + '<td>' + (expandable ? '<i class="bi bi-chevron-right rt-mon-row-caret"></i> ' : '')
        + fmtTime(e.occurred_at) + '</td>'
      + '<td>' + esc(message) + '</td>'
      + '<td class="is-mono">' + (loc ? esc(loc) : "—") + '</td>'
      + '</tr>';
    if (!expandable) return primary;
    return primary
      + '<tr class="rt-mon-row-expansion" hidden>'
      +   '<td colspan="3">'
      +     '<div class="rt-mon-chain">'
      +       '<span class="rt-mon-chain-kind">backtrace</span>'
      +       '<pre>' + esc(head) + '</pre>'
      +     '</div>'
      +   '</td>'
      + '</tr>';
  }

  // ─── /api/monitoring/requests/stats → status-code donut ──────
  async function fetchRequestsStats(window) {
    try {
      const data = await api.get("/monitoring/requests/stats?window=" + encodeURIComponent(window));
      paintDonut(data?.status_mix || {});
    } catch {
      paintDonut({});  // empty donut on error; KPI strip carries the diagnostic
    }
  }

  function paintDonut(statusMix) {
    const el = view.querySelector("#rp-mon-donut");
    if (!el || !window.echarts) return;
    if (!donutChart) {
      ensureRegisteredThemes();
      donutChart = window.echarts.init(el, chartTheme());
    }
    // Map { "200": 457, "500": 48, ... } → ECharts pie data, coloured
    // by status band (2xx green / 3xx blue / 4xx amber / 5xx red).
    const entries = Object.entries(statusMix)
      .filter(([, v]) => v > 0)
      .sort((a, b) => b[1] - a[1]);
    const palette = {
      "2": getCSSVar("--rp-ok"),
      "3": getCSSVar("--rp-accent-2"),
      "4": getCSSVar("--rp-warn"),
      "5": getCSSVar("--rp-accent"),
    };
    const data = entries.map(([code, count]) => ({
      name:  code,
      value: count,
      itemStyle: { color: palette[String(code)[0]] || getCSSVar("--rp-text-mute") },
    }));
    const total = entries.reduce((acc, [, v]) => acc + v, 0);
    const textColor = getCSSVar("--rp-text-dim");
    donutChart.setOption({
      animation: false,
      tooltip: { trigger: "item", formatter: "{b}: {c} ({d}%)" },
      series: [{
        type: "pie",
        radius: ["55%", "78%"],
        avoidLabelOverlap: false,
        label: {
          show: true,
          position: "center",
          formatter: total === 0
            ? "no requests"
            : "{total|" + fmtCount(total) + "}\n{label|requests}",
          rich: {
            total: { fontSize: 22, fontWeight: 700, color: getCSSVar("--rp-text") },
            label: { fontSize: 11, color: textColor, padding: [4, 0, 0, 0] },
          },
        },
        labelLine: { show: false },
        data,
      }],
    }, true);
    donutChart.resize();
  }

  // ─── /api/monitoring/requests → paginated drill-down redtable ─
  async function fetchRecentRequests(window) {
    const tbody = view.querySelector("#rp-mon-raw-tbody");
    if (tbody) tbody.innerHTML = '<tr><td colspan="6">Loading…</td></tr>';
    try {
      const data = await api.get("/monitoring/requests?window=" + encodeURIComponent(window)
        + "&page=" + rawPage + "&size=" + pageSizeFromPref());
      const rows = data?.rows || [];
      rawTotalPages = data?.pages || 1;
      rawPage       = data?.page  || rawPage;
      if (tbody) {
        tbody.innerHTML = rows.length
          ? rows.map(requestRowHTML).join("")
          : '<tr><td colspan="6">No requests in this window.</td></tr>';
      }
      renderRawPager();
    } catch (err) {
      if (tbody) tbody.innerHTML = '<tr><td colspan="6">Couldn’t load'
        + (err?.status ? " (" + err.status + ")" : "") + '.</td></tr>';
    }
  }

  function requestRowHTML(r) {
    // data-request-id gates which rows are clickable (legacy /
    // pre-correlation requests with NULL request_id stay
    // unclickable — there's nothing to drill into).
    const clickable = r.request_id ? ' class="rt-mon-row-clickable" data-request-id="' + esc(r.request_id) + '"' : '';
    return '<tr' + clickable + '>'
      + '<td>' + fmtTime(r.at) + '</td>'
      + '<td><span class="rp-mon-method">' + esc(r.method) + '</span></td>'
      + '<td class="is-num ' + statusBand(r.status) + '">' + r.status + '</td>'
      + '<td>' + esc(r.route) + '</td>'
      + '<td class="is-num">' + r.duration_ms + 'ms</td>'
      + '<td>' + (r.request_id ? '<code>' + esc(r.request_id.slice(0, 8)) + '</code>' : "—") + '</td>'
      + '</tr>';
  }

  // ─── M-1: request-replay modal ───────────────────────────────
  // Opens a fixed-position modal over the Monitoring page; fetches
  // GET /api/monitoring/request/:request_id (returns { request, events })
  // and renders a top-bar with the request line + a time-ordered
  // event timeline. Each event row click-expands to show its full
  // context JSONB. Backdrop click + ESC + close button all dismiss.
  function openRequestReplay(requestId) {
    if (!requestId) return;
    // Reuse the same DOM node across opens — strip any prior content
    // so a quick-second-click doesn't stack modals.
    let modal = document.getElementById("rp-mon-modal");
    if (!modal) {
      modal = document.createElement("div");
      modal.id = "rp-mon-modal";
      modal.className = "rp-mon-modal";
      document.body.appendChild(modal);
    }
    modal.innerHTML = ''
      + '<div class="rp-mon-modal-backdrop"></div>'
      + '<div class="rp-mon-modal-body" role="dialog" aria-modal="true" aria-labelledby="rp-mon-modal-title">'
      +   '<header class="rp-mon-modal-head">'
      +     '<h3 id="rp-mon-modal-title" class="rp-mon-modal-title">Request <code>' + esc(requestId) + '</code></h3>'
      +     '<button type="button" class="rp-mon-modal-close" aria-label="Close">' +
                '<i class="bi bi-x-lg"></i></button>'
      +   '</header>'
      +   '<div class="rp-mon-modal-content" id="rp-mon-modal-content">'
      +     '<p class="rp-mon-modal-loading">Loading…</p>'
      +   '</div>'
      + '</div>';
    modal.hidden = false;
    modal.classList.add("is-open");

    const close = () => {
      modal.classList.remove("is-open");
      modal.hidden = true;
      modal.innerHTML = "";
      document.removeEventListener("keydown", onKey);
    };
    const onKey = (e) => { if (e.key === "Escape") close(); };
    document.addEventListener("keydown", onKey);
    modal.querySelector(".rp-mon-modal-backdrop").addEventListener("click", close);
    modal.querySelector(".rp-mon-modal-close").addEventListener("click", close);

    // Event-row expander inside the modal — same pattern as M-3 + M-4.
    modal.querySelector(".rp-mon-modal-body").addEventListener("click", (e) => {
      const row = e.target.closest("tr.rt-mon-row-expandable");
      if (!row) return;
      const expansion = row.nextElementSibling;
      if (!expansion || !expansion.classList.contains("rt-mon-row-expansion")) return;
      const opening = expansion.hidden;
      expansion.hidden = !opening;
      const caret = row.querySelector(".rt-mon-row-caret");
      if (caret) {
        caret.classList.toggle("bi-chevron-down", opening);
        caret.classList.toggle("bi-chevron-right", !opening);
      }
    });

    // Fetch + render.
    api.get("/monitoring/request/" + encodeURIComponent(requestId))
      .then((data) => {
        const content = modal.querySelector("#rp-mon-modal-content");
        if (!content) return;
        content.innerHTML = renderRequestReplay(data);
      })
      .catch((err) => {
        const content = modal.querySelector("#rp-mon-modal-content");
        if (!content) return;
        const msg = err?.status === 404
          ? "No record found for this request id."
          : "Couldn’t load request" + (err?.status ? " (" + err.status + ")" : "") + ".";
        content.innerHTML = '<p class="rp-mon-modal-error">' + esc(msg) + '</p>';
      });
  }

  function renderRequestReplay(data) {
    const req = data?.request;
    const events = data?.events || [];
    const reqLine = req
      ? '<section class="rp-mon-modal-request">'
        + '<div class="rp-mon-modal-request-row">'
        +   '<span class="rp-mon-method">' + esc(req.method || "?") + '</span>'
        +   '<span class="is-num ' + statusBand(req.status) + '">' + (req.status || "?") + '</span>'
        +   '<span class="rp-mon-modal-route">' + esc(req.route || "—") + '</span>'
        +   '<span class="rp-mon-modal-meta">' + (req.duration_ms ?? "?") + 'ms · ' + fmtTime(req.at) + '</span>'
        + '</div>'
      + '</section>'
      : '<section class="rp-mon-modal-request rp-mon-modal-request--missing">'
      +   'request_log row absent — events shown without the request line context'
      + '</section>';

    if (!events.length) {
      return reqLine + '<p class="rp-mon-modal-empty">No events captured for this request.</p>';
    }
    return reqLine
      + '<section class="rp-mon-modal-timeline">'
      +   '<h4 class="rp-mon-modal-section-title">'
      +     'Timeline <span class="rp-mon-panel-hint">' + events.length + ' event' + (events.length === 1 ? '' : 's') + '</span>'
      +   '</h4>'
      +   '<table class="rt-table">'
      +     '<thead><tr><th>Time</th><th>Level</th><th>Kind</th><th>Message</th></tr></thead>'
      +     '<tbody>' + events.map(eventTimelineRow).join("") + '</tbody>'
      +   '</table>'
      + '</section>';
  }

  function eventTimelineRow(e) {
    const ctx = e.context;
    const hasCtx = ctx && (typeof ctx === "object" ? Object.keys(ctx).length > 0 : String(ctx).length > 0);
    const ctxJson = hasCtx ? JSON.stringify(ctx, null, 2) : "";
    const expandable = hasCtx;
    const primary = '<tr' + (expandable ? ' class="rt-mon-row-expandable"' : '') + '>'
      + '<td>' + (expandable ? '<i class="bi bi-chevron-right rt-mon-row-caret"></i> ' : '')
        + fmtTime(e.occurred_at) + '</td>'
      + '<td>' + levelChip(e.level) + '</td>'
      + '<td>' + esc(e.kind) + '</td>'
      + '<td>' + esc(e.message || "") + '</td>'
      + '</tr>';
    if (!expandable) return primary;
    return primary
      + '<tr class="rt-mon-row-expansion" hidden>'
      +   '<td colspan="4">'
      +     '<div class="rt-mon-chain">'
      +       '<span class="rt-mon-chain-kind">context</span>'
      +       '<pre>' + esc(ctxJson) + '</pre>'
      +     '</div>'
      +   '</td>'
      + '</tr>';
  }

  function statusBand(status) {
    const code = status | 0;
    if (code >= 500) return "rp-mon-err-high";
    if (code >= 400) return "rp-mon-err-mid";
    if (code >= 300) return "";
    return "rp-mon-err-low";
  }

  function renderRawPager() {
    const el = view.querySelector("#rp-mon-raw-pager");
    if (!el || rawTotalPages < 1) { if (el) el.innerHTML = ""; return; }
    const p = rawPage, last = rawTotalPages;
    const out = [];
    out.push(pagerBtnHTML("‹", p - 1, false, p === 1));
    if (last <= 7) {
      for (let i = 1; i <= last; i++) out.push(pagerBtnHTML(String(i), i, i === p, false));
    } else {
      const want = new Set([1, last, p, p - 1, p + 1]);
      let prev = 0;
      for (let i = 1; i <= last; i++) {
        if (!want.has(i)) continue;
        if (i - prev > 1) out.push('<span class="rt-pg-gap">…</span>');
        out.push(pagerBtnHTML(String(i), i, i === p, false));
        prev = i;
      }
    }
    out.push(pagerBtnHTML("›", p + 1, false, p === last));
    el.innerHTML = '<div class="rt-pages">' + out.join("") + '</div>';
  }
  function pagerBtnHTML(label, page, active, disabled) {
    return '<button class="rt-pg' + (active ? " active" : "") + '" type="button"'
      + (disabled ? " disabled" : ' data-page="' + page + '"') + ">" + label + "</button>";
  }

  // ─── list-view tabs (Events / Runs / Findings) ───────────────
  // The three monitoring list endpoints share the same Page<T> shape,
  // so one renderer handles all three — only columns + row HTML
  // differ. LIST_VIEWS at the bottom of the file declares each tab's
  // shape. Window chips apply only to Events (the others have no
  // time-window filter at the wire layer).
  let listPage   = 1;
  let listTotalPages = 1;
  let listWindow = DEFAULT_WINDOW;

  function renderListBody(tab, viewSpec) {
    disposeRequestsCharts();  // user switching away from Requests
    charts.dispose();      // user switching between list tabs
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
      + chartsStripHTML(viewSpec.charts || [])
      + listPanel(viewSpec.columns)
      + '<div class="rp-list-pager" id="rp-mon-list-pager"></div>';

    if (viewSpec.charts && viewSpec.charts.length) {
      charts.mount(viewSpec).catch((err) =>
        console.warn("[monitoring] charts mount failed:", err));
    }

    if (viewSpec.useWindow) {
      view.querySelector(".rp-chip-row").addEventListener("click", (e) => {
        const chip = e.target.closest(".rp-chip");
        if (!chip) return;
        view.querySelectorAll(".rp-chip.is-active").forEach((c) => c.classList.remove("is-active"));
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

    // M-4: row-expander delegate — click an expandable primary row to
    // toggle its sibling .rt-mon-row-expansion (the error_chain pane).
    // Caret class flips for visual feedback. Idempotent + scoped to
    // tbody so it doesn't fight the pager handler above.
    const tbodyEl = view.querySelector("#rp-mon-list-tbody");
    if (tbodyEl) {
      tbodyEl.addEventListener("click", (e) => {
        const row = e.target.closest("tr.rt-mon-row-expandable");
        if (!row) return;
        const expansion = row.nextElementSibling;
        if (!expansion || !expansion.classList.contains("rt-mon-row-expansion")) return;
        const opening = expansion.hidden;
        expansion.hidden = !opening;
        const caret = row.querySelector(".rt-mon-row-caret");
        if (caret) {
          caret.classList.toggle("bi-chevron-down", opening);
          caret.classList.toggle("bi-chevron-right", !opening);
        }
      });
    }

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

    const qs = "?page=" + listPage + "&size=" + pageSizeFromPref()
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

  // ─── Optimization map — known opportunities × live measurements
  // Dedicated renderer (not LIST_VIEWS) because the KPI strip is
  // derived from the rows (Total · Open · Tipped · Done) and the
  // filter axis is status, not window. Spec: docs/internal/specs/
  // ─── M-2: per-user activity feed ────────────────────────────
  // New surface (no LIST_VIEWS entry because the picker + dual-source
  // shape doesn't fit the generic list runtime). Top-of-body: text
  // input that searches /admin/users?q=... with debounced fetch +
  // dropdown of matches. User pick → GET /monitoring/users/:rid/activity
  // → render combined time-ordered redtable of requests + events.
  // "What is this user doing right now?" lens — runtime side of /admin/users.
  let userActivityPick = null;          // last-picked user { rid, label }
  let userActivityPickerTimer = null;   // debounce handle for the search input

  function renderUserActivityBody() {
    disposeRequestsCharts();
    charts.dispose();
    userActivityPick = null;
    view.innerHTML = ''
      + headHTML("Per-user activity", "")
      + '<section class="rp-mon-panel">'
      +   '<div class="rp-mon-user-picker-shell">'
      +     '<label for="rp-mon-user-input" class="rt-field-lbl">User</label>'
      +     '<div class="rp-user-picker-wrap">'
      +       '<input id="rp-mon-user-input" type="text" autocomplete="off" '
      +         'placeholder="Search by username, display name, or email…" />'
      +       '<div id="rp-mon-user-results" class="rp-user-picker-results" hidden></div>'
      +     '</div>'
      +     '<span class="rp-mon-user-hint" id="rp-mon-user-hint">'
      +       'Pick a user to see their request + event timeline (last 1h, newest first).'
      +     '</span>'
      +   '</div>'
      + '</section>'
      + '<section class="rp-mon-panel" id="rp-mon-user-activity" hidden>'
      +   '<div class="rp-mon-panel-head">'
      +     '<h3 class="rp-mon-panel-title" id="rp-mon-user-activity-title">Activity</h3>'
      +     '<span class="rp-mon-panel-hint" id="rp-mon-user-activity-count">—</span>'
      +   '</div>'
      +   '<table class="rt-table">'
      +     '<thead><tr><th>Time</th><th>Type</th><th>Detail</th><th class="is-num">Status / Level</th></tr></thead>'
      +     '<tbody id="rp-mon-user-activity-tbody"></tbody>'
      +   '</table>'
      + '</section>';

    const input    = view.querySelector("#rp-mon-user-input");
    const results  = view.querySelector("#rp-mon-user-results");
    if (!input || !results) return;

    input.addEventListener("input", () => {
      const q = input.value.trim();
      clearTimeout(userActivityPickerTimer);
      if (!q) { results.hidden = true; results.innerHTML = ""; return; }
      userActivityPickerTimer = setTimeout(() => searchUsers(q), 200);
    });
    input.addEventListener("focus", () => {
      if (results.innerHTML) results.hidden = false;
    });
    document.addEventListener("click", (e) => {
      if (!view.contains(e.target)) return;
      if (e.target.closest(".rp-user-picker-wrap")) return;
      results.hidden = true;
    });

    results.addEventListener("click", (e) => {
      const item = e.target.closest("[data-user-rid]");
      if (!item) return;
      const rid = item.dataset.userRid;
      const label = item.dataset.userLabel;
      userActivityPick = { rid, label };
      input.value = label;
      results.hidden = true;
      results.innerHTML = "";
      fetchUserActivity(rid, label);
    });

    // Activity row expander (events with context) — same atom as M-1/M-3/M-4.
    view.querySelector("#rp-mon-user-activity-tbody")?.addEventListener("click", (e) => {
      const row = e.target.closest("tr.rt-mon-row-expandable");
      if (!row) return;
      const expansion = row.nextElementSibling;
      if (!expansion || !expansion.classList.contains("rt-mon-row-expansion")) return;
      const opening = expansion.hidden;
      expansion.hidden = !opening;
      const caret = row.querySelector(".rt-mon-row-caret");
      if (caret) {
        caret.classList.toggle("bi-chevron-down", opening);
        caret.classList.toggle("bi-chevron-right", !opening);
      }
    });
  }

  async function searchUsers(q) {
    const results = view.querySelector("#rp-mon-user-results");
    if (!results) return;
    try {
      const data = await api.get("/admin/users?q=" + encodeURIComponent(q) + "&size=10");
      const rows = data?.rows || [];
      if (!rows.length) {
        results.innerHTML = '<div class="rp-user-picker-empty">No matches.</div>';
      } else {
        results.innerHTML = rows.map((u) => {
          const label = u.display_name || u.username || u.redpash_id;
          const sub   = [u.username, u.email].filter(Boolean).join(" · ");
          return '<div class="rp-user-picker-result" '
            + 'data-user-rid="' + esc(u.redpash_id) + '" '
            + 'data-user-label="' + esc(label) + '">'
            +   '<span class="rp-user-picker-result-name">' + esc(label) + '</span>'
            +   (sub ? '<span class="rp-user-picker-result-sub">' + esc(sub) + '</span>' : '')
            + '</div>';
        }).join("");
      }
      results.hidden = false;
    } catch (err) {
      results.innerHTML = '<div class="rp-user-picker-empty">Couldn’t search'
        + (err?.status ? " (" + err.status + ")" : "") + '.</div>';
      results.hidden = false;
    }
  }

  async function fetchUserActivity(rid, label) {
    const wrap   = view.querySelector("#rp-mon-user-activity");
    const tbody  = view.querySelector("#rp-mon-user-activity-tbody");
    const title  = view.querySelector("#rp-mon-user-activity-title");
    const count  = view.querySelector("#rp-mon-user-activity-count");
    if (!wrap || !tbody) return;
    wrap.hidden = false;
    if (title) title.textContent = "Activity · " + label;
    if (count) count.textContent = "Loading…";
    tbody.innerHTML = '<tr><td colspan="4">Loading…</td></tr>';
    try {
      const data = await api.get("/monitoring/users/" + encodeURIComponent(rid) + "/activity");
      const requests = (data?.requests || []).map((r) => ({ _kind: "request", ts: r.at, payload: r }));
      const events   = (data?.events   || []).map((e) => ({ _kind: "event",   ts: e.occurred_at, payload: e }));
      const merged = requests.concat(events).sort((a, b) => (a.ts < b.ts ? 1 : -1));
      if (!merged.length) {
        tbody.innerHTML = '<tr><td colspan="4">No activity in the last hour.</td></tr>';
        if (count) count.textContent = "0";
        return;
      }
      if (count) count.textContent = merged.length + " · " + requests.length + " req / " + events.length + " ev";
      tbody.innerHTML = merged.map(userActivityRow).join("");
    } catch (err) {
      tbody.innerHTML = '<tr><td colspan="4">Couldn’t load activity'
        + (err?.status ? " (" + err.status + ")" : "") + '.</td></tr>';
      if (count) count.textContent = "—";
    }
  }

  function userActivityRow(item) {
    if (item._kind === "request") {
      const r = item.payload;
      return '<tr>'
        + '<td>' + fmtTime(r.at) + '</td>'
        + '<td><span class="rp-mon-method">REQ</span></td>'
        + '<td>'
        +   '<span class="rp-mon-method">' + esc(r.method || "?") + '</span> '
        +   '<span class="rp-mon-modal-route">' + esc(r.route || "—") + '</span>'
        +   ' <span class="rp-mon-modal-meta">' + (r.duration_ms ?? "?") + 'ms</span>'
        + '</td>'
        + '<td class="is-num ' + statusBand(r.status) + '">' + (r.status || "?") + '</td>'
        + '</tr>';
    }
    // event
    const e = item.payload;
    const ctx = e.context;
    const hasCtx = ctx && (typeof ctx === "object" ? Object.keys(ctx).length > 0 : String(ctx).length > 0);
    const ctxJson = hasCtx ? JSON.stringify(ctx, null, 2) : "";
    const expandable = hasCtx;
    const primary = '<tr' + (expandable ? ' class="rt-mon-row-expandable"' : '') + '>'
      + '<td>' + (expandable ? '<i class="bi bi-chevron-right rt-mon-row-caret"></i> ' : '')
        + fmtTime(e.occurred_at) + '</td>'
      + '<td><span class="rp-mon-method">EVT</span></td>'
      + '<td>'
      +   '<span class="rp-mon-method">' + esc(e.kind) + '</span> '
      +   esc(e.message || "")
      + '</td>'
      + '<td class="is-num">' + levelChip(e.level) + '</td>'
      + '</tr>';
    if (!expandable) return primary;
    return primary
      + '<tr class="rt-mon-row-expansion" hidden>'
      +   '<td colspan="4">'
      +     '<div class="rt-mon-chain">'
      +       '<span class="rt-mon-chain-kind">context</span>'
      +       '<pre>' + esc(ctxJson) + '</pre>'
      +     '</div>'
      +   '</td>'
      + '</tr>';
  }

  // optimization-map.md.
  const OPT_STATUSES = ["all", "open", "planned", "done", "wontfix"];
  let optStatus = "all";

  function renderOptimizationBody() {
    disposeRequestsCharts();
    optStatus = "all";
    view.innerHTML = ''
      + headHTML("Optimization map", "")
      + statusChipsHTML(optStatus)
      + kpiStripHTML([
          { label: "Total",   id: "rp-mon-opt-total"   },
          { label: "Open",    id: "rp-mon-opt-open"    },
          { label: "Tipped",  id: "rp-mon-opt-tipped"  },
          { label: "Done",    id: "rp-mon-opt-done"    },
        ])
      + optTablePanel();

    view.querySelector(".rp-chip-row").addEventListener("click", (e) => {
      const chip = e.target.closest(".rp-chip");
      if (!chip) return;
      view.querySelectorAll(".rp-chip.is-active").forEach((c) => c.classList.remove("is-active"));
      chip.classList.add("is-active");
      optStatus = chip.dataset.status;
      fetchOptimization();
    });

    // Status pill change → PATCH then full refetch (the refetch is
    // what re-sorts the row into its new status bucket + refreshes
    // KPIs). Optimistic disable + on-error rollback keeps a flapping
    // server clean.
    view.querySelector("#rp-mon-opt-tbody").addEventListener("change", async (e) => {
      const sel = e.target.closest(".rp-mon-opt-status-select");
      if (!sel) return;
      const id   = sel.dataset.optId;
      const prev = sel.dataset.prev;
      const next = sel.value;
      if (next === prev) return;
      sel.disabled = true;
      try {
        await api.patch("/monitoring/optimization-points/" + id, { status: next });
        fetchOptimization();
      } catch (err) {
        sel.value = prev;
        sel.disabled = false;
        alert("Couldn’t update status"
          + (err?.status ? " (" + err.status + ")" : "") + ".");
      }
    });

    fetchOptimization();
  }

  async function fetchOptimization() {
    const tbody = view.querySelector("#rp-mon-opt-tbody");
    if (tbody) tbody.innerHTML = '<tr><td colspan="6">Loading…</td></tr>';
    setKpi("rp-mon-opt-total",  "…");
    setKpi("rp-mon-opt-open",   "…");
    setKpi("rp-mon-opt-tipped", "…");
    setKpi("rp-mon-opt-done",   "…");
    // Server's default size is plenty for ~20 rows; bump to 100 so the
    // KPI strip totals match the whole table without paging math.
    const qs = "?size=100" + (optStatus !== "all" ? "&status=" + encodeURIComponent(optStatus) : "");
    try {
      const data = await api.get("/monitoring/optimization-points" + qs);
      const rows = data?.rows || [];
      paintOptKpis(rows, data?.total ?? rows.length);
      if (tbody) {
        tbody.innerHTML = rows.length
          ? rows.map(optRowHTML).join("")
          : '<tr><td colspan="6">No rows.</td></tr>';
      }
      const head = view.querySelector(".rp-shell-head-count");
      if (head) head.textContent = (data?.total || 0) + (optStatus !== "all" ? " " + optStatus : "");
    } catch (err) {
      setKpi("rp-mon-opt-total",  "—");
      setKpi("rp-mon-opt-open",   "—");
      setKpi("rp-mon-opt-tipped", "—");
      setKpi("rp-mon-opt-done",   "—");
      if (tbody) tbody.innerHTML = '<tr><td colspan="6">Couldn’t load'
        + (err?.status ? " (" + err.status + ")" : "") + '.</td></tr>';
    }
  }

  function paintOptKpis(rows, total) {
    const open   = rows.filter((r) => r.status === "open").length;
    const tipped = rows.filter((r) => r.tipped === true).length;
    const done   = rows.filter((r) => r.status === "done").length;
    setKpi("rp-mon-opt-total",  String(total));
    setKpi("rp-mon-opt-open",   String(open));
    setKpi("rp-mon-opt-tipped", String(tipped));
    setKpi("rp-mon-opt-done",   String(done));
  }

  function optRowHTML(r) {
    // horizon + notes ride along as a hover tooltip so the table
    // stays compact (6 cols) without losing the deep context.
    const tip = [r.horizon, r.notes].filter(Boolean).join("\n— ");
    return '<tr'
      + (tip ? ' title="' + esc(tip) + '"' : "")
      + '>'
      + '<td>' + esc(r.subsystem) + '</td>'
      + '<td>' + esc(r.phase) + '</td>'
      + '<td>' + esc(r.current_cost) + '</td>'
      + '<td class="is-num ' + (r.tipped === true ? "rp-mon-err-high" : "") + '">'
      +   fmtMeasurement(r.current_value, r.threshold_unit)
      + '</td>'
      + '<td class="is-num">' + fmtMeasurement(r.threshold_value, r.threshold_unit) + '</td>'
      + '<td>' + statusPill(r.id, r.status) + '</td>'
      + '</tr>';
  }

  function statusChipsHTML(active) {
    return '<div class="rp-chip-row">'
      + OPT_STATUSES.map((s) =>
          '<button type="button" class="rp-chip' + (s === active ? ' is-active' : '') + '"'
          + ' data-status="' + esc(s) + '">' + esc(s) + '</button>'
        ).join("")
      + '</div>';
  }

  function optTablePanel() {
    return '<section class="rp-mon-panel">'
      + '<table class="rt-table">'
      +   '<thead><tr>'
      +     '<th>Subsystem</th>'
      +     '<th>Phase</th>'
      +     '<th>Current cost</th>'
      +     '<th>Live value</th>'
      +     '<th>Threshold</th>'
      +     '<th>Status</th>'
      +   '</tr></thead>'
      +   '<tbody id="rp-mon-opt-tbody"></tbody>'
      + '</table>'
      + '</section>';
  }

  // "fraction" units (e.g. error_rate_24h: 0.5) render as percentages;
  // other units pass through. null value renders as muted "—".
  function fmtMeasurement(value, unit) {
    if (value == null) return '<span class="rp-mon-opt-na">—</span>';
    if (unit === "fraction") return (Math.round(value * 100 * 10) / 10) + "%";
    const pretty = (unit === "requests_24h") ? "req/24h" : (unit || "");
    return fmtCount(value) + (pretty ? " " + pretty : "");
  }

  // Status pill rendered as a styled <select> so clicking it flips
  // the row's status via PATCH /optimization-points/:id. The four
  // editable values mirror the server's CHECK constraint; "all" only
  // exists as a filter chip, not a row value.
  const OPT_STATUS_VALUES = ["open", "planned", "done", "wontfix"];
  function statusPill(id, status) {
    const v = String(status || "open").toLowerCase();
    return '<select class="rp-mon-opt-pill rp-mon-opt-pill--' + esc(v)
      + ' rp-mon-opt-status-select"'
      + ' data-opt-id="' + esc(String(id)) + '"'
      + ' data-prev="'   + esc(v) + '"'
      + ' title="Click to change status">'
      + OPT_STATUS_VALUES.map((s) =>
          '<option value="' + esc(s) + '"' + (s === v ? ' selected' : '') + '>'
          + esc(s) + '</option>'
        ).join("")
      + '</select>';
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
  // windowChipsHTML in this page is partial-applied with the local
  // WINDOWS list — wraps the shared module helper.
  function windowChipsHTML(active) { return _windowChipsHTML(WINDOWS, active); }

  function topRoutesPanel() {
    return '<section class="rp-mon-panel">'
      + '<div class="rp-mon-panel-head">'
      +   '<h3 class="rp-mon-panel-title">Top routes</h3>'
      +   '<span class="rp-mon-panel-hint">ranked by p95 latency</span>'
      + '</div>'
      + '<table class="rt-table">'
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
  function statusMixPanel() {
    return '<section class="rp-mon-panel">'
      + '<div class="rp-mon-panel-head">'
      +   '<h3 class="rp-mon-panel-title">Status code mix</h3>'
      +   '<span class="rp-mon-panel-hint">distribution by HTTP status</span>'
      + '</div>'
      + '<div class="rp-mon-chart" id="rp-mon-donut"></div>'
      + '</section>';
  }
  function recentRequestsPanel() {
    return '<section class="rp-mon-panel">'
      + '<div class="rp-mon-panel-head">'
      +   '<h3 class="rp-mon-panel-title">Recent requests</h3>'
      +   '<span class="rp-mon-panel-hint">paginated, newest first</span>'
      + '</div>'
      + '<table class="rt-table">'
      +   '<thead><tr>'
      +     '<th>Time</th><th>Method</th><th>Status</th><th>Route</th><th>Duration</th><th>Request ID</th>'
      +   '</tr></thead>'
      +   '<tbody id="rp-mon-raw-tbody"></tbody>'
      + '</table>'
      + '<div class="rp-list-pager" id="rp-mon-raw-pager"></div>'
      + '</section>';
  }
  // M-3 — panic pane on the Requests landing. The wrapper has hidden=true
  // by default so the panel disappears entirely when the window has no
  // panics. The fetchRecentPanics path flips hidden + populates the
  // count + 5 most recent rows; clicking a row expands the backtrace_head
  // via the same expander shape used by the events redtable (M-4).
  function panicPanel() {
    return '<section class="rp-mon-panel rp-mon-panel--panic" id="rp-mon-panic-pane" hidden>'
      + '<div class="rp-mon-panel-head">'
      +   '<h3 class="rp-mon-panel-title">'
      +     '<i class="bi bi-exclamation-octagon"></i> Recent panics'
      +   '</h3>'
      +   '<span class="rp-mon-panel-hint" id="rp-mon-panic-count">—</span>'
      + '</div>'
      + '<table class="rt-table">'
      +   '<thead><tr><th>Time</th><th>Message</th><th>Location</th></tr></thead>'
      +   '<tbody id="rp-mon-panic-tbody"></tbody>'
      + '</table>'
      + '</section>';
  }
  // Read a CSS custom property (theme token) at runtime so ECharts
  // colours track the active theme. Falls back to a sensible default
  // if the var is missing or empty.
  function getCSSVar(name) {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || "#6c7086";
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
}

