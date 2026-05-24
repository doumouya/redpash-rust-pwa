// Home — the org command center.
//
// Shell pattern shared with Workspace: a topbar over a greeting,
// then a rail (.rt-nav, static groups) on the left and a body view
// on the right. The rail tab routes to a per-entity body renderer.
//
// Phase 1 (this build): Projects tab is fully wired against the
// existing GET /api/projects. Other tabs render an honest
// "endpoint pending" stub citing the missing backend route — same
// discipline as the parity inventory's disabled tool buttons. See
// docs/internal/admin-monitoring-surfaces.md for the full IA + the
// wire contract Phase 2 wants from Gus.

import { api } from "/scripts/api.js";
import { mountTopbar } from "/scripts/topbar.js";
import { esc, cssEsc } from "/scripts/dom.js";
import { getPref } from "/scripts/prefs.js";
import {
  headHTML, kpiStripHTML, chartsStripHTML, chipRowHTML, listToolbarHTML,
  listPanel as _listPanel,
  setKpi as _setKpi,
  renderListPager as _renderListPager,
  createListCharts,
} from "/scripts/list-page.js";

// Stage labels mirror backend's file_stages view (migration 022,
// 2026-06-05). Renamed from `import|report` to `new|design`:
//   new    — file just arrived (no presumption that data is raw —
//            an already-clean upload sits here too until it goes to design).
//   clean  — at least one cleaning step has been applied.
//   design — file is the source of ≥1 chart (the design surface).
//   publish — a chart from this file lives in a public dashboard.
const STAGES = ["new", "clean", "design", "publish"];

// Declarative tab definitions — also drives the rail render. The
// `perm` field is non-load-bearing today (everyone is admin in
// pre-prod / solo-dev); kept so the RBAC switch later is filter,
// not rewrite. `endpoint` is the un-prefixed path (no /api/) — it's
// for the pending-stub display only, not a call site; keeping the
// /api/ prefix out lets the crossing audit not mistake it for one.
const HOME_TABS = [
  // ── ORG ────────────────────────────────────────────────────
  { group: "ORG",    key: "users",       label: "Users",       icon: "bi-people",       perm: "admin", endpoint: "/admin/users",       wired: true  },
  { group: "ORG",    key: "companies",   label: "Companies",   icon: "bi-building",     perm: "admin", endpoint: "/admin/companies",   wired: true  },
  { group: "ORG",    key: "memberships", label: "Memberships", icon: "bi-link-45deg",   perm: "admin", endpoint: "/admin/memberships", wired: true  },
  // ── DATA ───────────────────────────────────────────────────
  { group: "DATA",   key: "projects",    label: "Projects",    icon: "bi-folder",       perm: "user",  endpoint: "/projects",          wired: true  },
  { group: "DATA",   key: "files",       label: "Files",       icon: "bi-file-earmark", perm: "user",  endpoint: "/admin/files",       wired: true  },
  { group: "DATA",   key: "charts",      label: "Charts",      icon: "bi-bar-chart",    perm: "user",  endpoint: "/admin/charts",      wired: true  },
  // Steps moved to /monitoring (AUDITS group) — operational audit-
  // trail records of cleaning ops, fits Monitoring's "what happened"
  // framing better than Home's org/data inventory.
  // ── MANAGE — stripped redtable variant ─────────────────────
  // Disabled until the unified org-management endpoint lands. The
  // button telegraphs the future surface (workspace-style filter +
  // read-only table across users / companies / memberships); not
  // clickable yet. Parallel pattern to Monitoring's INSPECT > Logs.
  { group: "MANAGE", key: "org",         label: "Org",         icon: "bi-diagram-3",    perm: "admin", endpoint: "/admin/org",         wired: false },
];

const HOME_GROUPS = [
  { name: "ORG",    mark: "OR", color: "mauve" },
  { name: "DATA",   mark: "DA", color: "teal"  },
  { name: "MANAGE", mark: "MG", color: "peach" },
];

const HOME_DEFAULT_TAB = "projects";

export default function home(app, { session }) {
  mountTopbar(app.querySelector("#rp-topbar"), { active: "home", session });
  renderGreeting(app, session);

  const nav     = app.querySelector("#rpHomeNav");
  const navBody = app.querySelector("#rpHomeNavBody");
  const view    = app.querySelector("#rpHomeView");

  // List-page bindings — partial-apply the view + the page-specific
  // ID prefixes once so call sites keep their original short-arg
  // signatures (setKpi(id, val), renderListPager(), listPanel(cols)).
  // The chart controller hosts mount/dispose against the shared
  // /scripts/list-page.js runtime.
  const charts          = createListCharts(view, { logPrefix: "home" });
  const setKpi          = (id, val) => _setKpi(view, id, val);
  const renderListPager = () =>
    _renderListPager(view, "rp-home-list-pager", { page: listPage, totalPages: listTotalPages });
  const listPanel       = (columns) => _listPanel(columns, "rp-home-list-tbody");

  // List-view specs for the six non-Projects tabs. Same Page<T> shape
  // across every /api/admin/* endpoint, so one generic renderer
  // (renderListBody + fetchList) drives all six — only columns, row
  // HTML and optional chipRows differ. Declared before activate()
  // runs below so the const isn't in TDZ when renderTabBody dispatches.
  const LIST_VIEWS = {
    users: {
      title: "Users",
      endpoint: "/admin/users",
      charts: [
        { id: "rp-home-users-plan",   title: "By plan",       kind: "donut",
          data: (s) => s.by_plan },
        { id: "rp-home-users-active", title: "Active last 7d", kind: "gauge",
          data: (s) => s.total ? Math.round((s.active_7d / s.total) * 100) : 0,
          opts: { max: 100, unit: "%" } },
      ],
      columns: ["Name", "Plan", "Job", "Org", "Role", "Joined"],
      row: (u) =>
        '<tr>'
        + '<td class="rp-home-user-name">'
        +   '<span class="rp-home-user-display">' + esc(u.display_name) + '</span>'
        +   ' <span class="rp-home-handle">@' + esc(u.username) + '</span>'
        + '</td>'
        + '<td>' + planChip(u.plan) + '</td>'
        + '<td class="rp-home-meta">' + esc(u.job_title || "—") + '</td>'
        + '<td>' + (u.org_name ? orgChip(u.org_name) : '<span class="rp-home-meta">—</span>') + '</td>'
        + '<td>' + (u.org_role ? roleChip(u.org_role) : '<span class="rp-home-meta">—</span>') + '</td>'
        + '<td class="rp-home-meta">' + fmtTime(u.created_at) + '</td>'
        + '</tr>',
    },
    companies: {
      title: "Companies",
      endpoint: "/admin/companies",
      charts: [
        { id: "rp-home-co-active", title: "Active last 30d", kind: "gauge",
          data: (s) => s.total ? Math.round((s.active_30d / s.total) * 100) : 0,
          opts: { max: 100, unit: "%" } },
        { id: "rp-home-co-proj",   title: "With projects",   kind: "gauge",
          data: (s) => s.total ? Math.round((s.with_projects / s.total) * 100) : 0,
          opts: { max: 100, unit: "%" } },
      ],
      columns: ["Name", "Members", "My role", "Created"],
      row: (c) =>
        '<tr>'
        + '<td>' + esc(c.name) + ' <span class="rp-mon-method">' + esc(c.slug) + '</span></td>'
        + '<td class="is-num">' + (c.member_count || 0) + '</td>'
        + '<td>' + (c.my_role ? roleChip(c.my_role) : "—") + '</td>'
        + '<td>' + fmtTime(c.created_at) + '</td>'
        + '</tr>',
    },
    memberships: {
      title: "Memberships",
      endpoint: "/admin/memberships",
      // The endpoint takes ?scope=project|company; flip via the chip row.
      chipRows: [{
        name: "scope",
        label: "Scope",
        options: [
          { label: "Project", value: "project" },
          { label: "Company", value: "company" },
        ],
        default: "project",
      }],
      // Stats endpoint also reads ?scope=; the charts controller threads
      // chipState through via spec.chipRows when statsEndpoint is
      // unset (default behavior).
      charts: [
        { id: "rp-home-mem-role", title: "By role", kind: "rose",
          data: (s) => s.by_role },
      ],
      columns: ["Member", "Role", "Scope", "Joined"],
      row: (m) =>
        '<tr>'
        + '<td>' + esc(m.user_display_name) + ' <span class="rp-mon-method">@' + esc(m.user_username) + '</span></td>'
        + '<td>' + roleChip(m.role) + '</td>'
        + '<td>' + esc(m.scope_name) + '</td>'
        + '<td>' + fmtTime(m.joined_at) + '</td>'
        + '</tr>',
    },
    files: {
      title: "Files",
      endpoint: "/admin/files",
      statsEndpoint: "/admin/files/stats",
      charts: [
        { id: "rp-home-files-stage", title: "By stage",  kind: "donut",
          data: (s) => s.by_stage },
        { id: "rp-home-files-type",  title: "By type",   kind: "bar",
          data: (s) => s.by_type },
        { id: "rp-home-files-clean", title: "Cleanness", kind: "gauge",
          data: (s) => s.avg_cleanness ?? 0, opts: { max: 100, unit: "%" } },
      ],
      // Toolbar — first validation slice (Em's 2026-05-24 ask). Search
      // + sort + refresh are wired; modes/columns/export buttons
      // render disabled until the next slice. undoRedo + history
      // intentionally omitted (no list-level history to model).
      toolbar: {
        searchPlaceholder: "Search filename, project…",
        modes: true, refresh: true, columns: true, export: true,
      },
      // Sortable columns map to /admin/files's SORTABLE_FILES allowlist
      // (filename / file_type / stage / row_count / updated_at). Project
      // intentionally not sortable — name lives on a JOIN and isn't in
      // the allowlist yet.
      columns: [
        { label: "Filename", key: "filename",   sortable: true  },
        { label: "Project",  key: "project",    sortable: false },
        { label: "Type",     key: "file_type",  sortable: true  },
        { label: "Stage",    key: "stage",      sortable: true  },
        { label: "Rows",     key: "row_count",  sortable: true  },
        { label: "Updated",  key: "updated_at", sortable: true  },
      ],
      row: (f) =>
        '<tr>'
        + '<td>' + esc(f.display_name || f.filename) + '</td>'
        + '<td>' + esc(f.project_name) + '</td>'
        + '<td><span class="rp-mon-method">' + esc(f.file_type) + '</span></td>'
        + '<td>' + stageChip(f.stage) + '</td>'
        + '<td class="is-num">' + (f.row_count != null ? f.row_count : "—") + '</td>'
        + '<td>' + fmtTime(f.updated_at) + '</td>'
        + '</tr>',
    },
    charts: {
      title: "Charts",
      endpoint: "/admin/charts",
      charts: [
        { id: "rp-home-cht-recent", title: "Created last 7d", kind: "gauge",
          data: (s) => s.total ? Math.round((s.last_7d / s.total) * 100) : 0,
          opts: { max: 100, unit: "%" } },
        { id: "rp-home-cht-reports", title: "In a report",    kind: "gauge",
          data: (s) => s.total ? Math.round((s.used_in_reports / s.total) * 100) : 0,
          opts: { max: 100, unit: "%" } },
      ],
      columns: ["Name", "Project", "Stage", "Updated"],
      // Rows are clickable — navigate to the Workspace with the
      // chart's source project + chart rid as deep-link params so
      // the Designer opens directly on this chart.
      row: (c) =>
        '<tr class="rp-home-row--clickable"'
        + ' data-href="#/workspace?project=' + encodeURIComponent(c.project_redpash_id)
        + '&file=' + encodeURIComponent(c.redpash_id) + '">'
        + '<td>' + esc(c.display_name || c.filename) + '</td>'
        + '<td>' + esc(c.project_name) + '</td>'
        + '<td>' + stageChip(c.stage) + '</td>'
        + '<td>' + fmtTime(c.updated_at) + '</td>'
        + '</tr>',
    },
  };

  // ─── rail collapse — same affordance as the Workspace rail ───
  app.querySelector("#rpHomeNavCollapse").addEventListener("click", (e) => {
    nav.classList.toggle("compact");
    e.currentTarget.querySelector("i").className = nav.classList.contains("compact")
      ? "bi bi-chevron-double-right" : "bi bi-chevron-double-left";
  });

  // ─── render the rail (static groups → tabs) ──────────────────
  navBody.innerHTML = HOME_GROUPS.map(renderGroup).join("");
  // Expand both groups by default — the entity list is short and
  // there's no scroll cost.
  navBody.querySelectorAll(".rt-group").forEach((g) => g.classList.add("expanded"));

  // Active tab — from hash (?tab=<key>) or default.
  const params = new URLSearchParams(location.hash.split("?")[1] || "");
  const wantTab = params.get("tab") || HOME_DEFAULT_TAB;
  activate(wantTab);

  // ─── rail click delegation ───────────────────────────────────
  navBody.addEventListener("click", (e) => {
    const head = e.target.closest(".rt-group-head");
    if (head) {
      head.closest(".rt-group").classList.toggle("expanded");
      return;
    }
    const tab = e.target.closest(".rt-tab");
    if (tab) {
      activate(tab.dataset.key);
    }
  });

  // ─── rail render helpers ─────────────────────────────────────
  function renderGroup(g) {
    const tabs = HOME_TABS.filter((t) => t.group === g.name);
    return ''
      + '<div class="rt-group">'
      +   '<button class="rt-group-head" type="button">'
      +     '<i class="bi bi-chevron-down rt-group-caret"></i>'
      +     '<span class="rt-group-mark" data-c="' + g.color + '">' + g.mark + '</span>'
      +     '<span class="rt-group-name">' + esc(g.name) + '</span>'
      +     '<span class="rt-group-count">' + tabs.length + '</span>'
      +   '</button>'
      +   '<div class="rt-group-body">'
      +     tabs.map(renderTab).join("")
      +   '</div>'
      + '</div>';
  }
  function renderTab(t) {
    // Unwired tabs render visible but disabled. Em's call: don't hide
    // future surfaces (the rail telegraphs what's coming), but don't
    // let the user click into an empty body either. When Gus lands the
    // endpoint, flip `wired: true` and the tab activates — no other
    // change needed.
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
  // Only wired tabs activate. Unwired tabs are rendered disabled by
  // renderTab (no data-key) so clicks pass through; this fallback also
  // handles a deep-link to an unwired key (e.g. #/home?tab=users) by
  // coercing to HOME_DEFAULT_TAB rather than blanking the body.
  function activate(key) {
    const requested = HOME_TABS.find((t) => t.key === key);
    const tab = (requested && requested.wired)
      ? requested
      : HOME_TABS.find((t) => t.key === HOME_DEFAULT_TAB);
    navBody.querySelectorAll(".rt-tab.active").forEach((t) => t.classList.remove("active"));
    const btn = navBody.querySelector('.rt-tab[data-key="' + cssEsc(tab.key) + '"]');
    if (btn) btn.classList.add("active");
    renderTabBody(tab);
  }

  // ─── per-tab body renderers ──────────────────────────────────
  // Dispatch: Projects keeps its card-grid renderer; the six admin
  // tabs share renderListBody (driven by LIST_VIEWS above).
  function renderTabBody(tab) {
    if (tab.key === "projects") return renderProjectsBody();
    const spec = LIST_VIEWS[tab.key];
    if (spec) renderListBody(tab, spec);
  }

  async function renderProjectsBody() {
    view.innerHTML = ''
      + headHTML("Projects", "")
      + kpiStripHTML([
          { label: "Total",        id: "rp-kpi-projects" },
          { label: "With files",   id: "rp-kpi-with-files" },
          { label: "Avg cleanness", id: "rp-kpi-clean" },
          { label: "Active 7d",    id: "rp-kpi-active" },
        ])
      + '<div class="rp-home__board" id="rp-home-board" aria-busy="true">'
      +   '<p class="rp-shell-state">Loading your projects…</p>'
      + '</div>';

    const board = view.querySelector("#rp-home-board");
    try {
      const data  = await api.get("/projects");
      const items = data?.items || [];
      paintProjectKpis(items);
      paintProjectBoard(board, items);
      view.querySelector(".rp-shell-head-count").textContent = items.length
        ? items.length + (items.length === 1 ? " project" : " projects") : "";
    } catch (err) {
      board.setAttribute("aria-busy", "false");
      board.innerHTML = '<p class="rp-shell-state">Couldn’t load your projects'
        + (err.status ? " (" + err.status + ")" : "") + ".</p>";
    }
  }

  // ─── list-view tabs (Users / Companies / Memberships / Files /
  //     Charts / Steps) — one renderer driven by a LIST_VIEWS spec.
  let listPage = 1;
  let listTotalPages = 1;
  // Honors the user's `rowsPerPageHome` pref (set on /settings). "all"
  // maps to a large one-shot page so the same paginated path stays in
  // service. Read on each fetch so a mid-session pref change picks up
  // on the next navigation. Workspace + Monitoring have their own
  // per-surface keys (rowsPerPageWorkspace / rowsPerPageMonitoring).
  function listPageSize() {
    const raw = getPref("rowsPerPageHome");
    if (raw === "all") return 500; // backend MAX_PAGE_SIZE
    const n = parseInt(raw || "", 10);
    return Number.isFinite(n) && n > 0 ? n : 25;
  }

  // Per-tab toolbar state — search query + active sort. Reset on each
  // renderListBody so tab-switching doesn't carry one tab's filter
  // into another.
  let listSearch = "";
  let listSort   = null;  // { col, dir } | null

  function renderListBody(tab, spec) {
    listPage   = 1;
    listSearch = "";
    listSort   = null;
    // Per-chip-row state — { chipRowName → current value }. Sent to
    // the endpoint as additional query params; click on a chip flips
    // the value + resets page to 1 + refetches.
    const chipState = {};
    (spec.chipRows || []).forEach((cr) => { chipState[cr.name] = cr.default; });

    view.innerHTML = ''
      + headHTML(spec.title, "")
      + (spec.chipRows || []).map((cr) => chipRowHTML(cr, chipState[cr.name])).join("")
      + kpiStripHTML([
          { label: "Total",      id: "rp-home-list-total" },
          { label: "On page",    id: "rp-home-list-shown" },
          { label: "Page",       id: "rp-home-list-page" },
          { label: "Last fetch", id: "rp-home-list-ms"   },
        ])
      + chartsStripHTML(spec.charts || [])
      + (spec.toolbar ? listToolbarHTML(spec.toolbar) : "")
      + listPanel(spec.columns)
      + '<div class="rp-list-pager" id="rp-home-list-pager"></div>';

    // Tear down any charts from a prior tab + mount this tab's
    // (if it declares any) against the /stats endpoint. Each tab's
    // charts share one stats fetch — small payload, three viz from
    // the same response. chipState threads through so memberships'
    // ?scope= flips the stats payload alongside the list.
    charts.dispose();
    if (spec.charts && spec.charts.length) {
      charts.mount(spec, chipState).catch((err) => {
        console.warn("[home] charts mount failed:", err);
      });
    }

    // Wire each chip row's click handler.
    view.querySelectorAll(".rp-chip-row").forEach((row) => {
      row.addEventListener("click", (e) => {
        const chip = e.target.closest(".rp-chip");
        if (!chip) return;
        const chipName = row.dataset.chipName;
        if (!chipName) return;
        chipState[chipName] = chip.dataset.value;
        row.querySelectorAll(".rp-chip.is-active").forEach((c) => c.classList.remove("is-active"));
        chip.classList.add("is-active");
        listPage = 1;
        fetchList(spec, chipState);
        // Chip flip can change the stats shape too (memberships'
        // ?scope=…). Refetch + re-render the charts so the cards
        // stay in sync with the list.
        if (spec.charts && spec.charts.length) {
          charts.dispose();
          charts.mount(spec, chipState).catch((err) =>
            console.warn("[home] charts refetch failed:", err));
        }
      });
    });

    // Wire the pager click handler.
    view.querySelector("#rp-home-list-pager").addEventListener("click", (e) => {
      const btn = e.target.closest(".rt-pg[data-page]");
      if (!btn) return;
      const target = parseInt(btn.dataset.page, 10);
      if (!Number.isFinite(target) || target < 1 || target > listTotalPages || target === listPage) return;
      listPage = target;
      fetchList(spec, chipState);
    });

    // Toolbar handlers — only wired when spec.toolbar is declared.
    if (spec.toolbar) {
      // Search — debounced so we don't fire on every keystroke. 200ms
      // matches the topbar omnisearch dropdown's debounce.
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
            fetchList(spec, chipState);
          }, 200);
        });
      }

      // Refresh — re-runs the fetch with the current page/sort/search.
      view.querySelector("#rp-list-toolbar-refresh")?.addEventListener("click", () => {
        fetchList(spec, chipState);
      });

      // Click-to-sort — header delegation. Three-state per column:
      // first click sets desc, second flips to asc, third clears.
      // After clearing, the backend falls back to its default sort.
      view.querySelector(".rp-mon-table thead")?.addEventListener("click", (e) => {
        const th = e.target.closest("th.rp-list-sortable");
        if (!th) return;
        const key = th.dataset.sort;
        if (!key) return;
        if (!listSort || listSort.col !== key) {
          listSort = { col: key, dir: "desc" };
        } else if (listSort.dir === "desc") {
          listSort = { col: key, dir: "asc" };
        } else {
          listSort = null;
        }
        paintSortHeaders();
        listPage = 1;
        fetchList(spec, chipState);
      });

      // Apply visual indicator to the active sort header. Idempotent —
      // called on each click + once after the initial fetchList paints
      // the table so a refresh keeps the chevron visible.
      function paintSortHeaders() {
        view.querySelectorAll("th.rp-list-sortable").forEach((th) => {
          th.classList.remove("is-asc", "is-desc");
          if (listSort && th.dataset.sort === listSort.col) {
            th.classList.add(listSort.dir === "asc" ? "is-asc" : "is-desc");
          }
        });
      }
    }

    // Row click → navigate. Delegated on the table so the binding
    // survives re-renders (every fetchList rewrites tbody.innerHTML).
    view.querySelector("#rp-home-list-tbody")?.addEventListener("click", (e) => {
      const tr = e.target.closest("tr[data-href]");
      if (!tr) return;
      location.hash = tr.dataset.href.replace(/^#/, "");
    });

    fetchList(spec, chipState);
  }

  async function fetchList(spec, chipState) {
    setKpi("rp-home-list-total", "…");
    setKpi("rp-home-list-shown", "…");
    setKpi("rp-home-list-page",  String(listPage));
    setKpi("rp-home-list-ms",    "…");
    const tbody = view.querySelector("#rp-home-list-tbody");
    const colCount = spec.columns.length;
    if (tbody) tbody.innerHTML = '<tr><td colspan="' + colCount + '">Loading…</td></tr>';

    const params = new URLSearchParams();
    params.set("page", String(listPage));
    params.set("size", String(listPageSize()));
    if (listSearch) params.set("q", listSearch);
    if (listSort)   { params.set("sort", listSort.col); params.set("dir", listSort.dir); }
    for (const [name, value] of Object.entries(chipState || {})) {
      if (value != null && value !== "") params.set(name, value);
    }
    const t0 = performance.now();
    try {
      const data = await api.get(spec.endpoint + "?" + params.toString());
      const rows = data?.rows || [];
      listTotalPages = data?.pages || 1;
      listPage       = data?.page  || listPage;
      const elapsed = Math.round(performance.now() - t0);
      setKpi("rp-home-list-total", fmtCount(data?.total || 0));
      setKpi("rp-home-list-shown", String(rows.length));
      setKpi("rp-home-list-page",  listPage + " / " + listTotalPages);
      setKpi("rp-home-list-ms",    elapsed + "ms");
      view.querySelector(".rp-shell-head-count").textContent = (data?.total || 0) + " rows";
      if (tbody) {
        tbody.innerHTML = rows.length
          ? rows.map(spec.row).join("")
          : '<tr><td colspan="' + colCount + '">No rows.</td></tr>';
      }
      renderListPager();
    } catch (err) {
      setKpi("rp-home-list-total", "—");
      setKpi("rp-home-list-shown", "—");
      setKpi("rp-home-list-page",  "—");
      setKpi("rp-home-list-ms",    "—");
      if (tbody) tbody.innerHTML = '<tr><td colspan="' + colCount + '">Couldn’t load'
        + (err?.status ? " (" + err.status + ")" : "") + '.</td></tr>';
    }
  }

  function paintProjectKpis(items) {
    const withFiles = items.filter((p) => (p.file_count || 0) > 0).length;
    const cleans = items.map((p) => p.cleanness_pct).filter((v) => v != null);
    const avgClean = cleans.length
      ? Math.round(cleans.reduce((a, b) => a + b, 0) / cleans.length)
      : null;
    const weekAgo = Date.now() - 7 * 24 * 3600 * 1000;
    const active7d = items.filter((p) => {
      const t = Date.parse(p.updated_at);
      return Number.isFinite(t) && t >= weekAgo;
    }).length;
    setKpi("rp-kpi-projects", items.length);
    setKpi("rp-kpi-with-files", withFiles);
    setKpi("rp-kpi-clean", avgClean == null ? "—" : avgClean + "%");
    setKpi("rp-kpi-active", active7d);
  }

  function paintProjectBoard(board, items) {
    board.setAttribute("aria-busy", "false");
    if (!items.length) {
      board.innerHTML = '<p class="rp-shell-state">No projects yet — '
        + 'scan a CSV from the <a href="#/login">landing page</a> to start.</p>';
      return;
    }
    board.innerHTML = items.map(projectCard).join("");
  }

  function projectCard(p) {
    const at = STAGES.indexOf(p.stage);
    const pipe = STAGES.map((s, i) => {
      const cls = i < at ? " is-done" : i === at ? " is-current" : "";
      return '<li class="rp-proj__step' + cls + '">' + cap(s) + "</li>";
    }).join("");
    const meta = [
      p.file_count + (p.file_count === 1 ? " file" : " files"),
      "updated " + fmtDate(p.updated_at),
    ].join("  ·  ");
    return '<a class="rp-proj" href="#/workspace?project=' + encodeURIComponent(p.redpash_id) + '">'
      +   '<div class="rp-proj__top">'
      +     '<h2 class="rp-proj__name">' + esc(p.name) + "</h2>"
      +     (p.is_default ? '<span class="rp-proj__tag">default</span>' : "")
      +   "</div>"
      +   '<ol class="rp-proj__pipe">' + pipe + "</ol>"
      +   '<p class="rp-proj__meta">' + meta + "</p>"
      +   cleannessBar(p.cleanness_pct)
      + "</a>";
  }

  function cleannessBar(pct) {
    if (pct == null) return "";
    const v = Math.max(0, Math.min(100, pct));
    const band = v >= 80 ? "is-ok" : v >= 50 ? "is-warn" : "";
    return '<div class="rp-proj__cleanness">'
      +   '<div class="rp-proj__cleanness-track">'
      +     '<div class="rp-proj__cleanness-fill ' + band + '" style="width:' + v + '%"></div>'
      +   "</div>"
      +   '<span class="rp-proj__cleanness-label">' + Math.round(v) + "% clean</span>"
      + "</div>";
  }

  // ─── small render utilities ──────────────────────────────────
  function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }
  function fmtDate(iso) {
    const d = new Date(iso);
    return isNaN(d.getTime())
      ? "—"
      : d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  }
  // Compact local timestamp for list rows — "May 23, 19:42".
  function fmtTime(iso) {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return "—";
    const date = d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    const time = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });
    return date + ", " + time;
  }
  function fmtCount(n) {
    if (n == null) return "—";
    if (n < 1000)    return String(n);
    if (n < 1000000) return (n / 1000).toFixed(1) + "k";
    return (n / 1000000).toFixed(1) + "M";
  }

  // Coloured badges for list-row signal columns. Use existing
  // .rp-mon-method base + .rp-mon-err-{low,mid,high} for tone, so the
  // visual vocabulary stays consistent with /monitoring.
  function roleChip(role) {
    const v = String(role || "").toLowerCase();
    const tone = v === "owner" ? "rp-mon-err-high"
              : v === "admin" || v === "collaborator" ? "rp-mon-err-mid"
              : v === "member" || v === "viewer" ? "rp-mon-err-low"
              : "";
    return '<span class="rp-mon-method ' + tone + '">' + esc(role || "—") + '</span>';
  }
  function stageChip(stage) {
    const v = String(stage || "").toLowerCase();
    const tone = v === "publish" ? "rp-mon-err-low"
              : v === "design"   ? "rp-mon-err-mid"
              : v === "clean"    ? "rp-mon-err-mid"
              : "";
    return '<span class="rp-mon-method ' + tone + '">' + esc(stage || "—") + '</span>';
  }
  function planChip(plan) {
    const v = String(plan || "").toLowerCase();
    const tone = v === "free" ? "" : "rp-mon-err-low";
    return '<span class="rp-mon-method ' + tone + '">' + esc(plan || "—") + '</span>';
  }
  // Org affiliation — softer than role/plan (which carry signal). The
  // dot prefix makes the cell read "this user belongs to: X" without
  // a full pill that fights the colored Role chip beside it.
  function orgChip(name) {
    return '<span class="rp-home-org">'
      +   '<i class="bi bi-building rp-home-org__icon"></i>'
      +   esc(name)
      + '</span>';
  }

}

// Time-of-day salutation + first_name (display_name fallback).
function renderGreeting(app, session) {
  const el = app.querySelector("#rp-home-greeting");
  if (!el) return;
  const hour = new Date().getHours();
  const tod  = hour < 5  ? "Good night"
            : hour < 12 ? "Good morning"
            : hour < 18 ? "Good afternoon"
            : hour < 22 ? "Good evening"
            :             "Good night";
  const name = session?.first_name || session?.display_name || "there";
  el.textContent = tod + ", " + name + ".";
}

