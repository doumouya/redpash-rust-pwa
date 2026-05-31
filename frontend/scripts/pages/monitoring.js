/* Purpose: see doc for details.
 * Doc: docs/internal/code/frontend/scripts/pages/monitoring.md */
// Monitoring — the system telemetry surface.
//
// Same shell pattern as Home (rail + body) — see shell.css. Static
// rail groups: REQUESTS / AUDITS. Phase 1 wires the Requests tab
// against GET /api/metrics?window=<1h|24h|7d|30d>. Other tabs render
// disabled in the rail until their backend list endpoints land (see
// docs/internal/admin-monitoring-surfaces.md §6).

import { api } from "/scripts/api.js";
import { mountTopbar } from "/scripts/topbar.js";
import { mountRailFooterNav } from "/scripts/rail-footer.js";
import { mountRailCollapse } from "/scripts/rail-controls.js";
import { esc, cssEsc } from "/scripts/dom.js";
import { getPref, setPref } from "/scripts/prefs.js";
import {
  headHTML, kpiStripHTML, compositeStripHTML, listToolbarHTML,
  windowChipsHTML as _windowChipsHTML,
  listPanel as _listPanel,
  setKpi as _setKpi,
  renderListPager as _renderListPager,
  createListCharts,
  wireListColumnsExport,
} from "/scripts/list-page.js";

// Tab inventory + group partition + window options extracted into
// `monitoring/tabs.js` as slice 5 of the god-object decomposition
// (broadcast.md 00:53; mirror of slice 4's home/tabs.js extract).
// Module-private to monitoring.js — promote if another page composes
// the same vocabulary.
import {
  MON_TABS,
  MON_GROUPS,
  WINDOWS,
  MON_DEFAULT_TAB,
  DEFAULT_WINDOW,
} from "/scripts/pages/monitoring/tabs.js";

// Slice D — pref-driven user charts. When the user has saved chart
// specs under `monitoringCharts.<tab>` (configured in Settings), they
// REPLACE the tab's curated kpiX charts in the composite strip,
// rendered via the unified `renderChart` pipeline. Empty pref falls
// back to the existing kpiX path unchanged.
import { renderChart } from "/scripts/charts/render.js";
import { chartsForTab } from "/scripts/charts/monitoring-bank.js";

export default function monitoring(app, { session }) {
  mountTopbar(app.querySelector("#rp-topbar"), { active: "monitoring", session });
  mountRailFooterNav(app.querySelector(".rt-nav-foot"), { active: "", session });

  const nav     = app.querySelector("#rpMonNav");
  const navBody = app.querySelector("#rpMonNavBody");
  const view    = app.querySelector("#rpMonView");

  // CAS_274EDF3B — platform-admin gate for the ADMIN group on the
  // Monitoring rail. Resolved once at mount via /api/me; cached so
  // every renderRail call reads it without re-fetching. Defaults
  // false until /me lands — the worst case is the ADMIN group
  // appears a beat late for an admin (no privilege leak since the
  // backend /admin/* endpoints enforce the real auth). Non-admins
  // never see the group; renderGroup filters MON_GROUPS by this.
  let isPlatformAdmin = false;
  api.get("/me")
    .then((me) => {
      isPlatformAdmin = !!me?.is_platform_admin;
      // Re-render the rail once /me lands so the ADMIN group
      // appears (or stays hidden) without requiring an interaction.
      if (typeof renderRail === "function") renderRail();
    })
    .catch(() => { /* leave false; backend is the real gate */ });

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
      // Object-form column specs (Em 2026-05-25) so the rt-table headers
      // render as sortable chevron-clicks like Home. `key` matches the
      // backend field for ?sort=. Backend support for /monitoring/events
      // ?sort= is queued for Gus — until it lands the chevron flips but
      // the order doesn't change. Not broken, just a no-op.
      columns: [
        { label: "Time",    key: "occurred_at", sortable: true  },
        { label: "Level",   key: "level",       sortable: true  },
        { label: "Origin",  key: "origin",      sortable: true  },
        { label: "Kind",    key: "kind",        sortable: true  },
        { label: "Message", key: "message",     sortable: false },
        { label: "Status",  key: "http_status", sortable: true  },
      ],
      row: (e) => {
        // M-4: 5xx-from-AppError events carry `context.error_chain`
        // (populated by the airlock per c12b1fe — sanitized via
        // redact_chain, capped 2048 chars). Render an expandable
        // sibling row holding the chain in a <pre>. Click on the
        // primary row toggles it. No expander when the field's
        // absent — keeps non-error rows clean.
        const chain = e.context?.error_chain;
        const expandable = !!chain;
        const primary = '<tr' + (expandable ? ' class="rp-mon-row-expandable"' : '') + '>'
          + '<td>' + (expandable ? '<i class="bi bi-chevron-right rp-mon-row-caret"></i> ' : '')
            + fmtTime(e.occurred_at) + '</td>'
          + '<td>' + levelChip(e.level) + '</td>'
          + '<td>' + esc(e.origin) + '</td>'
          + '<td>' + esc(e.kind) + '</td>'
          + '<td>' + esc(e.message) + '</td>'
          + '<td class="is-num">' + (e.http_status != null ? e.http_status : "—") + '</td>'
          + '</tr>';
        if (!expandable) return primary;
        const errKind = e.context?.error_kind ? '<span class="rp-mon-chain-kind">' + esc(e.context.error_kind) + '</span>' : '';
        return primary
          + '<tr class="rp-mon-row-expansion" hidden>'
          +   '<td colspan="6">'
          +     '<div class="rp-mon-chain">'
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
      columns: [
        { label: "Time",     key: "ran_at",      sortable: true  },
        { label: "Tool",     key: "tool",        sortable: true  },
        { label: "SHA",      key: "git_sha",     sortable: false },
        { label: "Branch",   key: "git_branch",  sortable: true  },
        { label: "Headline", key: "stats",       sortable: false },
      ],
      row: (r) =>
        '<tr>'
        + '<td>' + fmtTime(r.ran_at) + '</td>'
        + '<td><span class="rt-mono-pill">' + esc(r.tool) + '</span></td>'
        + '<td>' + (r.git_sha ? '<code>' + esc(String(r.git_sha).slice(0, 7)) + '</code>' : "—") + '</td>'
        + '<td>' + esc(r.git_branch || "—") + '</td>'
        + '<td>' + summarizeStats(r.stats) + '</td>'
        + '</tr>',
    },
    findings: {
      title: "Audit findings",
      endpoint: "/monitoring/audit-findings",
      useWindow: false,
      columns: [
        { label: "Run",      key: "run_id",      sortable: true  },
        { label: "Tool",     key: "tool",        sortable: true  },
        { label: "Kind",     key: "kind",        sortable: true  },
        { label: "Finding",  key: "finding_key", sortable: true  },
        { label: "Severity", key: "severity",    sortable: true  },
      ],
      row: (f) =>
        '<tr>'
        + '<td class="is-num">#' + f.run_id + '</td>'
        + '<td><span class="rt-mono-pill">' + esc(f.tool) + '</span></td>'
        + '<td>' + esc(f.kind) + '</td>'
        + '<td>' + esc(f.finding_key) + '</td>'
        + '<td class="is-num">' + (f.severity != null ? f.severity : "—") + '</td>'
        + '</tr>',
    },
    requests: {
      title: "Requests",
      endpoint: "/monitoring/requests",
      useWindow: true,
      // status-mix donut populated from /monitoring/requests/stats?window=…
      // The lambda closes over `listWindow` (renderListBody scope) so it
      // stays in sync with the active chip without per-call wiring.
      statsEndpoint: () => "/monitoring/requests/stats?window="
        + encodeURIComponent(listWindow),
      charts: [
        { id: "rp-mon-req-status", title: "By status", kind: "donut",
          data: (s) => s?.status_mix || {} },
      ],
      columns: [
        { label: "Time",    key: "at",          sortable: true  },
        { label: "Method",  key: "method",      sortable: true  },
        { label: "Status",  key: "status",      sortable: true  },
        { label: "Route",   key: "route",       sortable: true  },
        { label: "Latency", key: "duration_ms", sortable: true  },
        { label: "ID",      key: "request_id",  sortable: false },
      ],
      row: requestRowHTML,
    },
    steps: {
      title: "Cleanings",
      endpoint: "/admin/steps",
      useWindow: false,
      charts: [
        { id: "rp-mon-steps-kind", title: "By kind (top 10)", kind: "barH",
          data: (s) => s.by_kind, opts: { top: 10 } },
        { id: "rp-mon-steps-24h",  title: "Active last 24h",  kind: "gauge",
          data: (s) => s.total ? Math.round((s.last_24h / s.total) * 100) : 0,
          opts: { max: 100, unit: "%" } },
      ],
      columns: [
        { label: "File",    key: "file_filename", sortable: true  },
        { label: "#",       key: "ordinal",       sortable: true  },
        { label: "Kind",    key: "kind",          sortable: true  },
        { label: "Applied", key: "applied",       sortable: true  },
        { label: "When",    key: "created_at",    sortable: true  },
      ],
      row: (s) =>
        '<tr>'
        + '<td>' + esc(s.file_filename) + '</td>'
        + '<td class="is-num">' + s.ordinal + '</td>'
        + '<td><span class="rt-mono-pill">' + esc(s.kind) + '</span></td>'
        + '<td>' + (s.applied ? '<span class="rt-mono-pill rt-tone--low">yes</span>'
                              : '<span class="rt-mono-pill">no</span>') + '</td>'
        + '<td>' + fmtTime(s.created_at) + '</td>'
        + '</tr>',
    },
    // CAS_274EDF3B — Fields tab. Consumes GET /api/admin/fields
    // (shipped by the other Torv in 339e413). Each row is a
    // (object, field) pair with a write|read|none cell per RBAC
    // tier. Editor wiring waits on slice 2 (PUT) — for now the
    // tab is read-only; the chip-enum framework + col.editEndpoint
    // override are ready to drop in when PUT lands.
    fields: {
      title: "Fields",
      endpoint: "/admin/fields",
      useWindow: false,
      columns: [
        { label: "Object",     key: "object",       sortable: true  },
        { label: "Field",      key: "field",        sortable: true  },
        { label: "Editable",   key: "is_editable",  sortable: true  },
        { label: "Sortable",   key: "is_sortable",  sortable: true  },
        { label: "Owner",      key: "owner",        sortable: false },
        { label: "Admin",      key: "admin",        sortable: false },
        { label: "Member",     key: "member",       sortable: false },
        { label: "Viewer",     key: "viewer",       sortable: false },
      ],
      row: (f) =>
        '<tr>'
        + '<td>' + esc(f.object || "—") + '</td>'
        + '<td><span class="rt-mono-pill">' + esc(f.field || "—") + '</span></td>'
        + '<td>' + (f.is_editable ? '<span class="rt-mono-pill rt-tone--low">yes</span>'
                                  : '<span class="rt-mono-pill">no</span>') + '</td>'
        + '<td>' + (f.is_sortable ? '<span class="rt-mono-pill rt-tone--low">yes</span>'
                                  : '<span class="rt-mono-pill">no</span>') + '</td>'
        + '<td>' + accessChip(f.owner)  + '</td>'
        + '<td>' + accessChip(f.admin)  + '</td>'
        + '<td>' + accessChip(f.member) + '</td>'
        + '<td>' + accessChip(f.viewer) + '</td>'
        + '</tr>',
    },
    // CAS_274EDF3B — Audit catalog tab. Consumes GET /api/admin/
    // audit-catalog (shipped by the other Torv in ff00aa6). One row
    // per audit tool with severity buckets + diff-vs-prev.
    audit_catalog: {
      title: "Audit catalog",
      endpoint: "/admin/audit-catalog",
      useWindow: false,
      // Endpoint returns {tools: [...]} not Page<T>, so the runtime
      // needs to unwrap. The list-page renderer falls back to
      // `items` then `rows`; we adapt via a custom unwrap hint.
      itemsKey: "tools",
      columns: [
        { label: "Tool",       key: "tool",          sortable: true  },
        { label: "Last run",   key: "ran_at",        sortable: true  },
        { label: "Total",      key: "findings_total", sortable: false },
        { label: "High",       key: "findings_high", sortable: false },
        { label: "Medium",     key: "findings_med",  sortable: false },
        { label: "Low",        key: "findings_low",  sortable: false },
        { label: "Δ new",      key: "diff_new",      sortable: false },
        { label: "Δ regressed",key: "diff_regressed",sortable: false },
        { label: "Δ improved", key: "diff_improved", sortable: false },
        { label: "Δ fixed",    key: "diff_fixed",    sortable: false },
      ],
      row: (t) => {
        const sev = (n, tone) => '<td class="is-num">'
          + (n > 0 ? '<span class="rt-mono-pill ' + tone + '">' + n + '</span>' : '—')
          + '</td>';
        const diff = (n) => '<td class="is-num">'
          + (typeof n === 'number' ? (n > 0 ? '+' + n : String(n)) : '—')
          + '</td>';
        const f = t.findings || {};
        const d = t.diff || {};
        return '<tr>'
          + '<td><span class="rt-mono-pill">' + esc(t.tool || "—") + '</span></td>'
          + '<td>' + (t.ran_at ? fmtTime(t.ran_at) : '—') + '</td>'
          + '<td class="is-num">' + (f.total || 0) + '</td>'
          + sev(f.high || 0, 'rt-tone--high')
          + sev(f.med  || 0, 'rt-tone--mid')
          + sev(f.low  || 0, 'rt-tone--low')
          + diff(d.new)
          + diff(d.regressed)
          + diff(d.improved)
          + diff(d.fixed)
          + '</tr>';
      },
    },
    queries: {
      title: "DB Queries",
      endpoint: "/monitoring/queries",
      useWindow: false,
      columns: [
        { label: "Time",     key: "at",             sortable: true  },
        { label: "Duration", key: "duration_ms",    sortable: true  },
        { label: "Rows",     key: "rows",           sortable: true  },
        { label: "Status",   key: "status",         sortable: true  },
        { label: "Query",    key: "query_template", sortable: false },
        { label: "Route",    key: "route",          sortable: true  },
      ],
      row: (r) =>
        '<tr>'
        + '<td>' + fmtTime(r.at) + '</td>'
        + '<td class="is-num">' + (r.duration_ms != null ? r.duration_ms + 'ms' : '—') + '</td>'
        + '<td class="is-num">' + (r.rows != null ? r.rows : '—') + '</td>'
        + '<td>' + (r.status
            ? '<span class="rt-mono-pill">error</span>'
            : '<span class="rt-mono-pill rt-tone--low">ok</span>') + '</td>'
        + '<td><code>' + esc(r.query_template) + '</code></td>'
        + '<td>' + esc(r.route || '—') + '</td>'
        + '</tr>',
    },
  };

  // Honors the user's `rowsPerPageMonitoring` pref (set on /settings).
  // Read on each fetch so a mid-session pref change picks up on the
  // next navigation. Workspace + Home have their own per-surface
  // keys (rowsPerPageWorkspace / rowsPerPageHome).
  function pageSizeFromPref() {
    const n = parseInt(getPref("rowsPerPageMonitoring") || "", 10);
    return Number.isFinite(n) && n > 0 ? n : 25;
  }

  // List-tab state — hoisted above activate() so renderListBody (called
  // synchronously on first mount via activate → renderTabBody) can read +
  // mutate them without tripping TDZ. Previously safe because the default
  // tab landed on a non-list renderer; now Requests routes through
  // renderListBody too, so these need to be live before activate fires.
  let listPage   = 1;
  let listTotalPages = 1;
  let listTotal  = 0;     // total row count for the pager rows-info readout
  let listShown  = 0;     // rows actually on the current page
  let listWindow = DEFAULT_WINDOW;
  let listSearch = "";    // ?q= text from the toolbar search input
  let activeTabKey = null; // the rail tab currently rendered in the body
  // Columns/export wiring (shared list-page helper). lastMonRows caches
  // the current page's raw rows for export; colsCtrl holds the helper's
  // re-apply hooks (hidden-column + reorder) called after each repaint.
  let lastMonRows = [];
  let colsCtrl    = null;

  // ── rail tab hide/restore — pure display:none-style declutter.
  //    Em 2026-05-28: hiding a tab is a rail-display concern only; it
  //    must NOT cut the data source. A hidden tab's endpoint still
  //    serves wherever else it's referenced (charts, the per-user
  //    activity feed, etc.) — we only drop its nav entry from the rail.
  //    Mirrors the workspace/cases/home recovery pattern per
  //    docs/internal/processes/replicable-feature-pattern.md. Stored as
  //    [{key, label}] so the recovery surface labels without a lookup.
  const HIDDEN_TABS_KEY = "monitoring_hidden_tabs";
  function getHiddenTabs() {
    const list = getPref(HIDDEN_TABS_KEY);
    return Array.isArray(list) ? list : [];
  }
  function hideTab(entry) {
    const list = getHiddenTabs();
    if (list.some((x) => x.key === entry.key)) return;
    list.push(entry);
    setPref(HIDDEN_TABS_KEY, list);
  }
  function unhideTab(key) {
    setPref(HIDDEN_TABS_KEY, getHiddenTabs().filter((x) => x.key !== key));
  }

  // List-page bindings — partial-apply view + ID prefixes once so
  // call sites keep their original short-arg signatures. Charts
  // controller is the dispose/mount handle.
  const charts          = createListCharts(view, { logPrefix: "monitoring" });
  // User-built chart instances (Slice D) — renderChart-mounted, lives
  // outside the kpiX charts controller so the tab-switch / window-flip
  // teardown can dispose both controllers from one site.
  let userInstances = [];
  function disposeUserInstances() {
    userInstances.forEach((i) => { try { i.dispose(); } catch { /* gone */ } });
    userInstances = [];
  }
  const setKpi          = (id, val) => _setKpi(view, id, val);
  const renderListPager = () =>
    _renderListPager(view, "rp-mon-list-pager", {
      page: listPage, totalPages: listTotalPages,
      total: listTotal, shown: listShown, pageSize: pageSizeFromPref(),
    });
  const listPanel       = (columns) => _listPanel(columns, "rp-mon-list-tbody");

  // ─── rail collapse (shared rail-controls helper) ────────────
  mountRailCollapse(nav, app.querySelector("#rpMonNavCollapse"));

  // ─── render the rail (static groups → tabs, minus hidden) ───
  renderRail();

  // Active tab. An explicit ?tab= deep-link wins even over a user's
  // declutter (and an unwired key still coerces to default inside
  // activate). A bare load lands on the first still-visible tab, so we
  // never render a body whose nav entry the user has hidden.
  const params = new URLSearchParams(location.hash.split("?")[1] || "");
  const wantTab = params.get("tab") || firstVisibleTabKey() || MON_DEFAULT_TAB;
  activate(wantTab);

  // ─── rail click delegation ───────────────────────────────────
  navBody.addEventListener("click", (e) => {
    const head = e.target.closest(".rt-group-head");
    if (head) { head.closest(".rt-group").classList.toggle("expanded"); return; }
    // Hide × — declutters the rail (pref write + re-render), never a
    // data cut. Caught before the tab branch + returns per Invariant 2
    // so the click doesn't also activate the tab it's removing.
    const hideBtn = e.target.closest(".rt-tab-close");
    if (hideBtn) {
      e.stopPropagation();
      const tab = hideBtn.closest(".rt-tab");
      if (tab?.dataset.key) onHideTab(tab.dataset.key);
      return;
    }
    // Recovery item — restore the tab (drop from pref + re-render). The
    // body view is untouched; reapplyActive re-marks the live tab.
    const restoreItem = e.target.closest(".rt-hidden-item");
    if (restoreItem?.dataset.key) {
      unhideTab(restoreItem.dataset.key);
      renderRail();
      reapplyActive();
      return;
    }
    const tab = e.target.closest(".rt-tab");
    if (tab && tab.dataset.key) activate(tab.dataset.key);
  });

  // ─── rail helpers ────────────────────────────────────────────
  // Rebuilds the rail body from MON_GROUPS minus the hidden set, plus
  // the recovery surface. Re-callable on hide/restore — it wipes the
  // active class (reapplyActive / activate restores it) but never the
  // body view (#rpMonView), so no data refetch happens.
  function renderRail() {
    const hidden = new Set(getHiddenTabs().map((x) => x.key));
    // ADMIN group is platform-admin-only (CAS_274EDF3B). Skip it for
    // callers without is_platform_admin; backend /admin/* endpoints
    // are the real auth, this is just UX hide.
    const groups = MON_GROUPS.filter((g) => g.name !== "ADMIN" || isPlatformAdmin);
    let html = groups.map((g) => renderGroup(g, hidden)).join("");
    html += renderHiddenTabsSection();
    navBody.innerHTML = html;
    navBody.querySelectorAll(".rt-group").forEach((g) => g.classList.add("expanded"));
  }
  function renderGroup(g, hidden) {
    const tabs = MON_TABS.filter((t) => t.group === g.name && !hidden.has(t.key));
    // Whole group hidden → drop the section header too (no empty groups).
    if (!tabs.length) return "";
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
    // Hide × only on wired tabs — disabled tabs swallow child clicks, and
    // the "coming soon" placeholders are meant to stay visible anyway.
    return ''
      + '<button class="rt-tab" type="button"' + attrs + '>'
      +   '<i class="' + esc(t.icon) + ' rt-tab-icon"></i>'
      +   '<span class="rt-tab-name">' + esc(t.label) + '</span>'
      +   (t.wired ? '<span class="rt-tab-close" title="Hide from rail"><i class="bi bi-x"></i></span>' : '')
      + '</button>';
  }
  function renderHiddenTabsSection() {
    const hidden = getHiddenTabs();
    if (!hidden.length) return "";
    const items = hidden.map((h) =>
      '<button class="rt-hidden-item" type="button" data-key="' + esc(h.key) + '">'
      +   '<span class="rt-hidden-name">' + esc(h.label || h.key) + '</span>'
      +   '<i class="bi bi-arrow-counterclockwise rt-hidden-restore" title="Restore"></i>'
      + '</button>'
    ).join("");
    return '<details class="rt-hidden">'
      +   '<summary class="rt-hidden-summary">'
      +     '<i class="bi bi-eye-slash"></i> Hidden (' + hidden.length + ')'
      +   '</summary>'
      +   '<div class="rt-hidden-body">' + items + '</div>'
      + '</details>';
  }
  // First still-visible wired tab, preferring the default — used as the
  // landing tab when the user hides the one they're currently viewing.
  function firstVisibleTabKey() {
    const hidden = new Set(getHiddenTabs().map((x) => x.key));
    if (!hidden.has(MON_DEFAULT_TAB)) return MON_DEFAULT_TAB;
    return MON_TABS.find((t) => t.wired && !hidden.has(t.key))?.key || null;
  }
  function reapplyActive() {
    if (!activeTabKey) return;
    navBody.querySelector('.rt-tab[data-key="' + cssEsc(activeTabKey) + '"]')?.classList.add("active");
  }
  function onHideTab(key) {
    const meta = MON_TABS.find((t) => t.key === key);
    hideTab({ key, label: meta?.label || key });
    renderRail();
    // Hiding the active tab → land on the first survivor (re-renders the
    // body). Hiding any other tab keeps the current body; just re-mark it.
    if (activeTabKey === key) {
      const fallback = firstVisibleTabKey();
      if (fallback) activate(fallback);
    } else {
      reapplyActive();
    }
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
    activeTabKey = tab.key;
    renderTabBody(tab);
  }

  function renderTabBody(tab) {
    if (tab.key === "optimization")    return renderOptimizationBody();
    if (tab.key === "user_activity")   return renderUserActivityBody();
    if (tab.key === "case_categories") return renderCaseCategoriesBody();
    const view = LIST_VIEWS[tab.key];
    if (view) return renderListBody(tab, view);
  }

  function requestRowHTML(r) {
    // data-request-id gates which rows are clickable (legacy /
    // pre-correlation requests with NULL request_id stay
    // unclickable — there's nothing to drill into).
    const clickable = r.request_id ? ' class="rp-mon-row-clickable" data-request-id="' + esc(r.request_id) + '"' : '';
    return '<tr' + clickable + '>'
      + '<td>' + fmtTime(r.at) + '</td>'
      + '<td><span class="rt-mono-pill">' + esc(r.method) + '</span></td>'
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
      modal.className = "rp-modal";
      document.body.appendChild(modal);
    }
    modal.innerHTML = ''
      + '<div class="rp-modal-backdrop"></div>'
      + '<div class="rp-modal-body" role="dialog" aria-modal="true" aria-labelledby="rp-mon-modal-title">'
      +   '<header class="rp-modal-head">'
      +     '<h3 id="rp-mon-modal-title" class="rp-modal-title">Request <code class="rp-mon-modal-id">' + esc(requestId) + '</code></h3>'
      +     '<button type="button" class="rt-icon-btn rp-modal-close" aria-label="Close">' +
                '<i class="bi bi-x-lg"></i></button>'
      +   '</header>'
      +   '<div class="rp-modal-content" id="rp-mon-modal-content">'
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
    modal.querySelector(".rp-modal-backdrop").addEventListener("click", close);
    modal.querySelector(".rp-modal-close").addEventListener("click", close);

    // Event-row expander inside the modal — same pattern as M-3 + M-4.
    modal.querySelector(".rp-modal-body").addEventListener("click", (e) => {
      const row = e.target.closest("tr.rp-mon-row-expandable");
      if (!row) return;
      const expansion = row.nextElementSibling;
      if (!expansion || !expansion.classList.contains("rp-mon-row-expansion")) return;
      const opening = expansion.hidden;
      expansion.hidden = !opening;
      const caret = row.querySelector(".rp-mon-row-caret");
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
        +   '<span class="rt-mono-pill">' + esc(req.method || "?") + '</span>'
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
      +     'Timeline <span class="rt-card-hint">' + events.length + ' event' + (events.length === 1 ? '' : 's') + '</span>'
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
    const primary = '<tr' + (expandable ? ' class="rp-mon-row-expandable"' : '') + '>'
      + '<td>' + (expandable ? '<i class="bi bi-chevron-right rp-mon-row-caret"></i> ' : '')
        + fmtTime(e.occurred_at) + '</td>'
      + '<td>' + levelChip(e.level) + '</td>'
      + '<td>' + esc(e.kind) + '</td>'
      + '<td>' + esc(e.message || "") + '</td>'
      + '</tr>';
    if (!expandable) return primary;
    return primary
      + '<tr class="rp-mon-row-expansion" hidden>'
      +   '<td colspan="4">'
      +     '<div class="rp-mon-chain">'
      +       '<span class="rp-mon-chain-kind">context</span>'
      +       '<pre>' + esc(ctxJson) + '</pre>'
      +     '</div>'
      +   '</td>'
      + '</tr>';
  }

  function statusBand(status) {
    const code = status | 0;
    if (code >= 500) return "rt-tone--high";
    if (code >= 400) return "rt-tone--mid";
    if (code >= 300) return "";
    return "rt-tone--low";
  }

  // ─── list-view tabs (Requests / Events / Runs / Findings / Steps) ─
  // All five monitoring list endpoints share the same Page<T> shape,
  // so one renderer handles them — only columns + row HTML differ.
  // LIST_VIEWS at the top of the file declares each tab's shape. Window
  // chips apply only to time-windowed tabs (`useWindow: true`). The
  // list-tab state vars are hoisted further up so activate() can drive
  // renderListBody synchronously without tripping TDZ.

  // Composite strip — `compositeStripHTML` is imported from
  // /scripts/list-page.js (the shared atom both Home + Monitoring
  // use). The local `monCompositeStripHTML` that lived here was
  // consolidated 2026-05-25 per [[feedback-compose-atoms-dont-parallel]].

  function renderListBody(tab, viewSpec) {
    charts.dispose();      // user switching between list tabs
    disposeUserInstances();// dispose any Slice D user-built charts too
    listPage = 1;
    listWindow = DEFAULT_WINDOW;
    listSearch = "";
    const kpiTiles = [
      { label: "Total",      id: "rp-mon-list-total"  },
      { label: "On page",    id: "rp-mon-list-shown"  },
      { label: "Page",       id: "rp-mon-list-page"   },
      { label: "Last fetch", id: "rp-mon-list-ms"    },
    ];
    // Monitoring is read-only — no edit / select / delete on these
    // tabs (the entities are tracked, not mutated). `modes: false`
    // suppresses the mode-button group entirely.
    // `?q=` wired on four monitoring endpoints 2026-05-25 (events / runs /
    // findings / steps); /monitoring/requests will follow. Until then the
    // Requests search input is structurally present but no-op against the
    // backend — same pattern as the sort chevrons on Events (queued for
    // Gus). The per-tab placeholder hints what fields each search covers.
    const placeholders = {
      requests: "Search route, method, status…",
      events:   "Search kind, message…",
      runs:     "Search tool, branch, sha…",
      findings: "Search tool, kind, finding…",
      steps:    "Search step kind, filename…",
    };
    const toolbarSpec = {
      searchPlaceholder: placeholders[tab.key] || "Search…",
      modes: false,
    };

    // Structure now matches Home exactly (Em 2026-05-25 ask: "for all
    // non parallel candidates match this structure"):
    //   header (rp-shell-head-title + rp-shell-head-count)
    //   rp-chip-row (window chips for time-windowed tabs)
    //   rp-list-composite (2 charts + 2×2 stats + 2 charts)
    //   listToolbarHTML (search / refresh / rows / cols / export / history)
    //   listPanel (the canonical rt-table with sortable headers)
    //   rt-pager
    // The previous filter panel + rp-surface-body wrapper are gone —
    // Home doesn't have them, so neither does Monitoring. Future
    // per-tab filters land via spec.chipRows (the same path Home
    // already uses), not via a sliding panel.
    // Slice D — pref-driven chart strip. When the user has saved
    // chart specs for this tab in `monitoringCharts.<tab>`, they
    // REPLACE the curated kpiX path entirely (rendered via the
    // unified `renderChart`). Otherwise the existing viewSpec.charts
    // / charts.mount path stays in effect.
    const userPref       = getPref("monitoringCharts") || {};
    const userCharts     = Array.isArray(userPref[tab.key]) && userPref[tab.key].length
                              ? userPref[tab.key]
                              : null;
    const stripCharts    = userCharts
                              ? userCharts.map((c) => ({ id: c.id, title: c.title }))
                              : (viewSpec.charts || []);

    view.innerHTML = ''
      + headHTML(viewSpec.title, "")
      + (viewSpec.useWindow ? windowChipsHTML(DEFAULT_WINDOW) : "")
      + compositeStripHTML(kpiTiles, stripCharts)
      + listToolbarHTML(toolbarSpec)
      + listPanel(viewSpec.columns)
      + '<div class="rt-pager" id="rp-mon-list-pager"></div>';

    // ── chart mount (one path or the other, never both) ─────────
    // userInstances is hoisted to the outer scope so tab-switch +
    // window-flip teardown can dispose it alongside the kpiX
    // controller. Local mountUserCharts uses the outer disposer.
    function mountUserCharts(specs) {
      disposeUserInstances();
      specs.forEach((spec) => {
        const el = view.querySelector('[id="' + cssEsc(spec.id) + '"]');
        if (!el) return;
        // Per-spec window override: when the tab's chip is active,
        // spread the chip window onto the spec so the resolver
        // fetches with it. The spec's own .source.window stays the
        // saved default for tabs that aren't window-aware.
        const liveSource = viewSpec.useWindow
          ? { ...spec.source, window: listWindow }
          : spec.source;
        renderChart(el, { ...spec, source: liveSource })
          .then((inst) => { if (inst) userInstances.push(inst); })
          .catch((err) => console.warn("[monitoring] user chart render failed:", spec.id, err));
      });
    }

    if (userCharts) {
      mountUserCharts(userCharts);
    } else if (viewSpec.charts && viewSpec.charts.length) {
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
        // Window-sensitive charts re-derive from /stats?window=…;
        // remount so they track the chip. Same branch as initial mount.
        if (userCharts) {
          // renderChart instances aren't tracked by the createListCharts
          // controller; the DOM nodes get blown away on next selection
          // change. For window flips inside one tab, we re-render in
          // place — the prior ECharts instances inside those nodes
          // get garbage-collected when the new init overwrites them.
          mountUserCharts(userCharts);
        } else if (viewSpec.charts && viewSpec.charts.length) {
          charts.dispose();
          charts.mount(viewSpec).catch((err) =>
            console.warn("[monitoring] charts remount on window change failed:", err));
        }
      });
    }

    // Toolbar — refresh + rows-per-page picker. Same handlers as Home,
    // adapted to monitoring's fetchList signature (no chipState arg).
    view.querySelector("#rp-list-toolbar-refresh")?.addEventListener("click", (e) => {
      const icon = e.currentTarget.querySelector("i");
      if (icon) {
        icon.classList.remove("rt-spinning");
        void icon.offsetWidth;
        icon.classList.add("rt-spinning");
      }
      fetchList(viewSpec);
    });
    const rowsDd = view.querySelector("#rp-list-toolbar-rows-dd");
    function syncRowsLabel() {
      const raw = getPref("rowsPerPageMonitoring") || "25";
      const lbl = view.querySelector("#rp-list-toolbar-rows-label");
      if (lbl) lbl.textContent = raw + " rows";
      if (rowsDd) {
        rowsDd.querySelectorAll(".rt-dd-item").forEach((i) => {
          i.classList.remove("selected");
          const t = i.querySelector(".tick"); if (t) t.remove();
        });
        const sel = rowsDd.querySelector('.rt-dd-item[data-rows="' + raw + '"]')
          || rowsDd.querySelector('.rt-dd-item[data-rows="25"]');
        if (sel) {
          sel.classList.add("selected");
          sel.insertAdjacentHTML("beforeend", ' <i class="bi bi-check2 tick"></i>');
        }
      }
    }
    syncRowsLabel();
    rowsDd?.addEventListener("click", (e) => {
      const item = e.target.closest(".rt-dd-item");
      if (!item) return;
      setPref("rowsPerPageMonitoring", item.dataset.rows);
      listPage = 1;
      syncRowsLabel();
      fetchList(viewSpec);
    });

    // Search — debounced 200ms so we don't fire on every keystroke.
    // Resets to page 1 on every change so the new result set always
    // starts at the top.
    const searchEl = view.querySelector("#rp-list-toolbar-search");
    if (searchEl) {
      let timer = null;
      searchEl.addEventListener("input", () => {
        const q = searchEl.value.trim();
        if (q === listSearch) return;
        listSearch = q;
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          listPage = 1;
          fetchList(viewSpec);
        }, 200);
      });
    }

    // Columns picker + export — shared list-page helper (same wiring as
    // Home). getRows reads the cached current page; the returned hooks
    // re-apply hidden-column + reorder state after every fetchList paint.
    colsCtrl = wireListColumnsExport(view, {
      columns:    viewSpec.columns || [],
      storageKey: tab.key,
      getRows:    () => lastMonRows,
      exportName: tab.key,
    });

    view.querySelector("#rp-mon-list-pager").addEventListener("click", (e) => {
      const btn = e.target.closest(".rt-pg[data-page]");
      if (!btn) return;
      const target = parseInt(btn.dataset.page, 10);
      if (!Number.isFinite(target) || target < 1 || target > listTotalPages || target === listPage) return;
      listPage = target;
      fetchList(viewSpec);
    });

    // Tbody click delegate — two row patterns, both opt-in by class:
    //   • M-1 .rp-mon-row-clickable[data-request-id] → request-replay modal
    //     (Requests tab — recent-requests rows drill into the per-request
    //     event timeline).
    //   • M-4 .rp-mon-row-expandable → toggle the sibling .rp-mon-row-
    //     expansion (Events tab's error_chain pane). Caret class flips
    //     for visual feedback.
    // Scoped to tbody so it doesn't fight the pager handler above.
    const tbodyEl = view.querySelector("#rp-mon-list-tbody");
    if (tbodyEl) {
      tbodyEl.addEventListener("click", (e) => {
        const clickable = e.target.closest("tr.rp-mon-row-clickable[data-request-id]");
        if (clickable) { openRequestReplay(clickable.dataset.requestId); return; }
        const row = e.target.closest("tr.rp-mon-row-expandable");
        if (!row) return;
        const expansion = row.nextElementSibling;
        if (!expansion || !expansion.classList.contains("rp-mon-row-expansion")) return;
        const opening = expansion.hidden;
        expansion.hidden = !opening;
        const caret = row.querySelector(".rp-mon-row-caret");
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
             + (viewSpec.useWindow ? "&window=" + encodeURIComponent(listWindow) : "")
             + (listSearch ? "&q=" + encodeURIComponent(listSearch) : "");
    const t0 = performance.now();
    try {
      const data = await api.get(viewSpec.endpoint + qs);
      // viewSpec.itemsKey lets a tab unwrap non-Page<T> responses
      // (e.g. audit-catalog returns `{tools: [...]}` not `{rows}`).
      // Falls back to the standard `rows` so existing tabs unchanged.
      const rows = (viewSpec.itemsKey && Array.isArray(data?.[viewSpec.itemsKey]))
        ? data[viewSpec.itemsKey]
        : (data?.rows || []);
      listTotalPages = data?.pages || 1;
      listPage       = data?.page  || listPage;
      listTotal      = data?.total ?? rows.length;
      listShown      = rows.length;
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
      // Cache for export + re-apply the columns picker / reorder state
      // so the freshly-rendered rows inherit hidden + ordered columns.
      // Reorder before hide: hide indexes tbody positionally off TH
      // position, so thead+tbody must be in lockstep first.
      lastMonRows = rows;
      colsCtrl?.applyColumnOrder();
      colsCtrl?.applyHiddenColumns();
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
    charts.dispose();
    disposeUserInstances();
    userActivityPick = null;
    view.innerHTML = ''
      + headHTML("Per-user activity", "")
      + '<section class="rt-card">'
      +   '<div class="rp-mon-user-picker-shell">'
      +     '<label for="rp-mon-user-input" class="rt-field-lbl">User</label>'
      +     '<div class="rp-user-picker-wrap">'
      +       '<input id="rp-mon-user-input" type="text" autocomplete="off" '
      +         'placeholder="Search by username, display name, or email…" />'
      +       '<div id="rp-mon-user-results" class="rp-user-picker-results" hidden></div>'
      +     '</div>'
      +     '<span class="rp-mon-user-hint" id="rp-mon-user-hint">'
      +       'Pick a user to see their unified activity timeline — requests + events merged server-side, last 24h, newest first.'
      +     '</span>'
      +   '</div>'
      + '</section>'
      + '<section class="rt-card" id="rp-mon-user-activity" hidden>'
      +   '<div class="rt-card-head">'
      +     '<h3 class="rt-card-title" id="rp-mon-user-activity-title">Activity</h3>'
      +     '<span class="rt-card-hint" id="rp-mon-user-activity-count">—</span>'
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

    // Tbody click delegate — same dual-pattern as renderListBody's:
    //   • rp-mon-row-clickable[data-request-id] → request-replay modal
    //     (request-source rows drill into the per-request timeline)
    //   • rp-mon-row-expandable → toggle the context-jsonb pane
    //     (event-source rows with non-empty context)
    view.querySelector("#rp-mon-user-activity-tbody")?.addEventListener("click", (e) => {
      const clickable = e.target.closest("tr.rp-mon-row-clickable[data-request-id]");
      if (clickable) { openRequestReplay(clickable.dataset.requestId); return; }
      const row = e.target.closest("tr.rp-mon-row-expandable");
      if (!row) return;
      const expansion = row.nextElementSibling;
      if (!expansion || !expansion.classList.contains("rp-mon-row-expansion")) return;
      const opening = expansion.hidden;
      expansion.hidden = !opening;
      const caret = row.querySelector(".rp-mon-row-caret");
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
        results.innerHTML = '<div class="rt-ac-empty">No matches.</div>';
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
      results.innerHTML = '<div class="rt-ac-empty">Couldn’t search'
        + (err?.status ? " (" + err.status + ")" : "") + '.</div>';
      results.hidden = false;
    }
  }

  // Per-user activity feed. Backend returns Page<ActivityRow> from a
  // server-side UNION ALL over events + request_log (true merged
  // pagination — the prior dual-array shape silently dropped rows
  // past either source's cap from the merged stream). Size 500 keeps
  // the picker UX a single-page fetch; pager wiring follows the
  // standard list-tab pattern when the volume justifies it.
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
      const data = await api.get("/monitoring/users/" + encodeURIComponent(rid)
        + "/activity?size=500&window=24h");
      const rows = data?.rows || [];
      if (!rows.length) {
        tbody.innerHTML = '<tr><td colspan="4">No activity in the last 24h.</td></tr>';
        if (count) count.textContent = "0";
        return;
      }
      const reqCount = rows.filter((r) => r.source === "request").length;
      const evtCount = rows.length - reqCount;
      const total    = data?.total ?? rows.length;
      const moreTag  = total > rows.length ? " of " + total : "";
      if (count) count.textContent = rows.length + moreTag
        + " · " + reqCount + " req / " + evtCount + " ev";
      tbody.innerHTML = rows.map(userActivityRow).join("");
    } catch (err) {
      tbody.innerHTML = '<tr><td colspan="4">Couldn’t load activity'
        + (err?.status ? " (" + err.status + ")" : "") + '.</td></tr>';
      if (count) count.textContent = "—";
    }
  }

  // Friendly rendering for known event kinds in the activity feed.
  // Per epic CAS_9A0C the comment kinds are the headline — they were
  // rendering as a raw `case_comment_post` mono-pill. Each entry maps
  // a kind → { cat (the Type-column category), icon, label }. Unmapped
  // kinds fall back to a prettified snake_case label + their family
  // category inferred from the prefix, so a new kind reads sensibly
  // without a map edit. The raw kind stays as a title= tooltip so
  // it's still greppable/debuggable.
  const ACTIVITY_KIND_META = {
    case_create:          { cat: "Case",    icon: "plus-circle",     label: "Case created" },
    case_delete:          { cat: "Case",    icon: "trash",           label: "Case deleted" },
    case_status_change:   { cat: "Case",    icon: "arrow-repeat",    label: "Status changed" },
    case_priority_change: { cat: "Case",    icon: "flag",            label: "Priority changed" },
    case_assignee_change: { cat: "Case",    icon: "person",          label: "Reassigned" },
    case_type_change:     { cat: "Case",    icon: "tag",             label: "Type changed" },
    case_category_change: { cat: "Case",    icon: "tags",            label: "Category changed" },
    case_metadata_change: { cat: "Case",    icon: "pencil-square",   label: "Case edited" },
    case_comment_post:    { cat: "Comment", icon: "chat-left-text",  label: "Comment posted" },
    case_comment_edit:    { cat: "Comment", icon: "pencil",          label: "Comment edited" },
    case_comment_delete:  { cat: "Comment", icon: "chat-left-dots",  label: "Comment deleted" },
    step_apply:           { cat: "Step",    icon: "wrench",          label: "Cleaning step" },
    file_snapshot:        { cat: "File",    icon: "camera",          label: "Snapshot" },
    file_join_create:     { cat: "File",    icon: "diagram-2",       label: "Join created" },
    file_re_encode:       { cat: "File",    icon: "type",            label: "Re-encoded" },
    file_cleanness_recompute: { cat: "File", icon: "stars",          label: "Cleanness recomputed" },
    company_member_add:        { cat: "Member", icon: "person-plus",  label: "Member added" },
    company_member_remove:     { cat: "Member", icon: "person-dash",  label: "Member removed" },
    company_member_leave:      { cat: "Member", icon: "box-arrow-left", label: "Member left" },
    company_member_role_change:{ cat: "Member", icon: "person-gear",  label: "Role changed" },
    me_prefs_update:      { cat: "Pref",    icon: "sliders",         label: "Preferences updated" },
  };
  // Prefix → category for unmapped kinds (graceful fallback).
  function activityKindMeta(kind) {
    const hit = ACTIVITY_KIND_META[kind];
    if (hit) return hit;
    const k = String(kind || "event");
    const cat = k.startsWith("case_comment") ? "Comment"
              : k.startsWith("case_")         ? "Case"
              : k.startsWith("step_")         ? "Step"
              : k.startsWith("file_")         ? "File"
              : k.includes("_member_")        ? "Member"
              : k.includes("pref")            ? "Pref"
              : "Event";
    const label = k.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
    return { cat, icon: "dot", label };
  }

  // Render one ActivityRow. Source = 'event' carries level + a context
  // jsonb worth expanding (matches the M-4 expander pattern). Source =
  // 'request' carries status + duration_ms inside context; row is
  // click-to-replay via the same M-1 modal Requests uses, when the
  // ref_id (= request_id) is present.
  function userActivityRow(item) {
    if (item.source === "request") {
      const ctx = item.context || {};
      const status = parseInt(item.summary, 10);
      const reqId = item.ref_id;
      const clickable = reqId
        ? ' class="rp-mon-row-clickable" data-request-id="' + esc(reqId) + '"'
        : '';
      return '<tr' + clickable + '>'
        + '<td>' + fmtTime(item.at) + '</td>'
        + '<td><span class="rt-mono-pill">REQ</span></td>'
        + '<td>'
        +   '<span class="rt-mono-pill">' + esc(item.kind) + '</span>'
        +   ' <span class="rp-mon-modal-meta">' + (ctx.duration_ms ?? "?") + 'ms</span>'
        + '</td>'
        + '<td class="is-num ' + statusBand(status) + '">' + (item.summary || "?") + '</td>'
        + '</tr>';
    }
    // source === 'event'
    const ctx = item.context;
    const hasCtx = ctx && (typeof ctx === "object" ? Object.keys(ctx).length > 0 : String(ctx).length > 0);
    const ctxJson = hasCtx ? JSON.stringify(ctx, null, 2) : "";
    const expandable = hasCtx;
    // Friendly kind rendering: category mono-pill in the Type column +
    // icon + human label in the Detail column, with the original
    // message as secondary text and the raw kind as a tooltip.
    const meta = activityKindMeta(item.kind);
    const primary = '<tr' + (expandable ? ' class="rp-mon-row-expandable"' : '') + '>'
      + '<td>' + (expandable ? '<i class="bi bi-chevron-right rp-mon-row-caret"></i> ' : '')
        + fmtTime(item.at) + '</td>'
      + '<td><span class="rt-mono-pill" title="' + esc(item.kind) + '">' + esc(meta.cat) + '</span></td>'
      + '<td>'
      +   '<i class="bi bi-' + esc(meta.icon) + ' rp-mon-act-icon"></i> '
      +   '<span class="rp-mon-act-label">' + esc(meta.label) + '</span>'
      +   (item.summary ? ' <span class="rp-mon-modal-meta">' + esc(item.summary) + '</span>' : "")
      + '</td>'
      + '<td class="is-num">' + levelChip(item.level) + '</td>'
      + '</tr>';
    if (!expandable) return primary;
    return primary
      + '<tr class="rp-mon-row-expansion" hidden>'
      +   '<td colspan="4">'
      +     '<div class="rp-mon-chain">'
      +       '<span class="rp-mon-chain-kind">context</span>'
      +       '<pre>' + esc(ctxJson) + '</pre>'
      +     '</div>'
      +   '</td>'
      + '</tr>';
  }

  // optimization-map.md.
  const OPT_STATUSES = ["all", "open", "planned", "done", "wontfix"];
  let optStatus = "all";

  function renderOptimizationBody() {
    charts.dispose();
    disposeUserInstances();
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

  // ─── Case categories — dormant taxonomy surfaced read-only ───
  // Per epic CAS_9A0CBB3A59FF4F75B0C8BB2444C71261 (surface remaining
  // DB objects). case_categories is plumbed but dormant; this tab
  // makes the taxonomy visible. Dedicated renderer because
  // /cases/categories returns a flat `{ items }` (CategoryList), not
  // the paginated Page<T> the generic LIST_VIEWS runtime expects.
  // Two-level hierarchy (parent_id self-FK); parent names + scope
  // (company vs global) resolve client-side from the one flat fetch.
  function renderCaseCategoriesBody() {
    charts.dispose();
    disposeUserInstances();
    view.innerHTML = ''
      + headHTML("Case categories", "")
      + kpiStripHTML([
          { label: "Total",          id: "rp-mon-cat-total"   },
          { label: "Parents",        id: "rp-mon-cat-parents" },
          { label: "Subcategories",  id: "rp-mon-cat-subs"    },
          { label: "Company-scoped", id: "rp-mon-cat-co"      },
        ])
      + catTablePanel();
    fetchCategories();
  }

  function catTablePanel() {
    return '<section class="rt-card">'
      + '<table class="rt-table">'
      +   '<thead><tr>'
      +     '<th>Name</th>'
      +     '<th>Parent</th>'
      +     '<th>Scope</th>'
      +     '<th>ID</th>'
      +     '<th>Created</th>'
      +   '</tr></thead>'
      +   '<tbody id="rp-mon-cat-tbody"></tbody>'
      + '</table>'
      + '</section>';
  }

  async function fetchCategories() {
    const tbody = view.querySelector("#rp-mon-cat-tbody");
    if (tbody) tbody.innerHTML = '<tr><td colspan="5">Loading…</td></tr>';
    ["total", "parents", "subs", "co"].forEach((k) => setKpi("rp-mon-cat-" + k, "…"));
    try {
      const data  = await api.get("/cases/categories");
      const items = data?.items || [];
      // rid→name map so the Parent column resolves without a 2nd
      // lookup. Order: each parent (alpha) immediately followed by its
      // children (alpha), so the flat table reads as a tree. Orphans
      // (child whose parent isn't in the set) trail at the end.
      const nameById   = new Map(items.map((c) => [c.redpash_id, c.name]));
      const byName     = (a, b) => String(a.name).localeCompare(String(b.name));
      const parents    = items.filter((c) => !c.parent_id).sort(byName);
      const childrenOf = (pid) => items.filter((c) => c.parent_id === pid).sort(byName);
      const orphans    = items.filter((c) => c.parent_id && !nameById.has(c.parent_id)).sort(byName);
      const ordered = [];
      for (const p of parents) { ordered.push(p); childrenOf(p.redpash_id).forEach((c) => ordered.push(c)); }
      ordered.push(...orphans);

      paintCatKpis(items);
      if (tbody) {
        tbody.innerHTML = ordered.length
          ? ordered.map((c) => catRowHTML(c, nameById)).join("")
          : '<tr><td colspan="5">No categories. The taxonomy is seeded but empty.</td></tr>';
      }
      const head = view.querySelector(".rp-shell-head-count");
      if (head) head.textContent = String(items.length);
    } catch (err) {
      ["total", "parents", "subs", "co"].forEach((k) => setKpi("rp-mon-cat-" + k, "—"));
      if (tbody) tbody.innerHTML = '<tr><td colspan="5">Couldn’t load'
        + (err?.status ? " (" + err.status + ")" : "") + '.</td></tr>';
    }
  }

  function catRowHTML(c, nameById) {
    const isChild    = !!c.parent_id;
    const parentName = c.parent_id ? (nameById.get(c.parent_id) || c.parent_id) : "—";
    const scope      = c.company_id ? "company" : "global";
    return '<tr>'
      + '<td>' + (isChild ? "↳ " : "") + esc(c.name) + '</td>'
      + '<td>' + esc(parentName) + '</td>'
      + '<td><span class="rt-mono-pill">' + esc(scope) + '</span></td>'
      + '<td><span class="rt-mono-pill">' + esc(c.redpash_id) + '</span></td>'
      + '<td>' + fmtTime(c.created_at) + '</td>'
      + '</tr>';
  }

  function paintCatKpis(items) {
    setKpi("rp-mon-cat-total",   String(items.length));
    setKpi("rp-mon-cat-parents", String(items.filter((c) => !c.parent_id).length));
    setKpi("rp-mon-cat-subs",    String(items.filter((c) => c.parent_id).length));
    setKpi("rp-mon-cat-co",      String(items.filter((c) => c.company_id).length));
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
      + '<td class="is-num ' + (r.tipped === true ? "rt-tone--high" : "") + '">'
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
    return '<section class="rt-card">'
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

  // ─── render utilities ────────────────────────────────────────
  // windowChipsHTML in this page is partial-applied with the local
  // WINDOWS list — wraps the shared module helper.
  function windowChipsHTML(active) { return _windowChipsHTML(WINDOWS, active); }

  function fmtCount(n) {
    if (n == null) return "—";
    if (n < 1000)    return String(n);
    if (n < 1000000) return (n / 1000).toFixed(1) + "k";
    return (n / 1000000).toFixed(1) + "M";
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
  // CAS_274EDF3B — Fields tab access cell. Three states per
  // (object × field × tier): write / read / none. Tones map to
  // visibility — write = high (admin-ish weight), read = mid, none
  // = dim. Matches the backend's GET /api/admin/fields cell shape.
  function accessChip(value) {
    const v = String(value || "none").toLowerCase();
    const tone = v === "write" ? "rt-tone--high"
               : v === "read"  ? "rt-tone--mid"
               : "rp-meta";
    if (v === "none" || v === "" || v === "—") return '<span class="rp-meta">—</span>';
    return '<span class="rt-mono-pill ' + tone + '">' + esc(v) + '</span>';
  }
  function levelChip(level) {
    const v = String(level || "").toLowerCase();
    const cls = v === "error" || v === "err" || v === "panic" ? "rt-tone--high"
              : v === "warn"  || v === "warning"              ? "rt-tone--mid"
              : v === "info"  || v === "debug" || v === "trace" ? "rt-tone--low"
              : "";
    return '<span class="rt-mono-pill ' + cls + '">' + esc(level || "—") + '</span>';
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

