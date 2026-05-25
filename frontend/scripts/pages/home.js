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
import { getPref, setPref } from "/scripts/prefs.js";
import {
  headHTML, kpiStripHTML, chartsStripHTML, chipRowHTML, listToolbarHTML,
  listPanel as _listPanel,
  setKpi as _setKpi,
  renderListPager as _renderListPager,
  createListCharts,
} from "/scripts/list-page.js";

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
  // Cases — flat-table read of /api/cases for the rail. The /cases
  // page renders the kanban + detail; this Home tab gives the
  // sortable inventory view alongside Users / Companies / Memberships.
  { group: "ORG",    key: "cases",       label: "Cases",       icon: "bi-card-list",    perm: "user",  endpoint: "/cases",             wired: true  },
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

export default function home(app, { session: _session }) {
  mountTopbar(app.querySelector("#rp-topbar"), { active: "home", session: _session });

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
    _renderListPager(view, "rp-home-list-pager", {
      page: listPage, totalPages: listTotalPages,
      total: listTotal, shown: listShown, pageSize: listPageSize(),
    });
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
      // Composite layout for this tab — KPI tiles flanked by the two
      // charts in a single row. Per Em's 2026-05-25 spec (Users tab
      // only): [chart1 20%] [stats 2×2, 15% each] [chart2 20%].
      // Other tabs keep the default kpi-strip-then-charts-strip
      // stacked shape.
      compositeStrip: true,
      // Visual placeholder — `?window=` isn't wired on /admin/users yet
      // (backend TODO). The chip submits the query param but the
      // backend ignores it today; flipping the active chip is a no-op
      // until that lands. Keeps the unified 6-section stack visible.
      chipRows: [{
        name: "window",
        label: "Activity",
        options: [
          { label: "All time", value: "all" },
          { label: "Last 7d",  value: "7d"  },
          { label: "Last 30d", value: "30d" },
        ],
        default: "all",
      }],
      charts: [
        { id: "rp-home-users-plan",   title: "By plan",       kind: "donut",
          data: (s) => s.by_plan },
        { id: "rp-home-users-active", title: "Active last 7d", kind: "gauge",
          data: (s) => s.total ? Math.round((s.active_7d / s.total) * 100) : 0,
          opts: { max: 100, unit: "%" } },
      ],
      // Placeholder matches the backend's ILIKE columns on /admin/users
      // (username + display_name + email + organisation). Sort not yet
      // wired backend-side; modes/columns/export disabled per the Files
      // toolbar's first-slice convention.
      toolbar: {
        searchPlaceholder: "Search name, handle, org…",
        refresh: true,
      },
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
      compositeStrip: true,   // 2 charts → KPI 2×2 flanked
      // Visual placeholder — `?view=` isn't wired on /admin/companies
      // yet (backend TODO). Same shape as the users tab's window chip.
      chipRows: [{
        name: "view",
        label: "View",
        options: [
          { label: "All",         value: "all"    },
          { label: "Active 30d",  value: "active" },
          { label: "With projects", value: "wp"   },
        ],
        default: "all",
      }],
      charts: [
        { id: "rp-home-co-active", title: "Active last 30d", kind: "gauge",
          data: (s) => s.total ? Math.round((s.active_30d / s.total) * 100) : 0,
          opts: { max: 100, unit: "%" } },
        { id: "rp-home-co-proj",   title: "With projects",   kind: "gauge",
          data: (s) => s.total ? Math.round((s.with_projects / s.total) * 100) : 0,
          opts: { max: 100, unit: "%" } },
      ],
      toolbar: {
        searchPlaceholder: "Search name, slug…",
        refresh: true,
      },
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
      compositeStrip: true,   // 2 charts → KPI 2×2 flanked
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
        { id: "rp-home-mem-role",     title: "By role",     kind: "rose",
          data: (s) => s.by_role },
        // Second chart added 2026-05-25 so memberships joins the
        // composite-strip layout (needs ≥2 charts). Same `by_role`
        // data, different viz — Em "random for now, no worries"
        // pending a real second metric on /admin/memberships/stats.
        { id: "rp-home-mem-role-bar", title: "Roles (bar)", kind: "bar",
          data: (s) => s.by_role },
      ],
      // /admin/memberships doesn't take ?q= today — the chipRow above
      // is the scope filter. Suppress the search box so the toolbar
      // doesn't promise a non-functional input. Only refresh is wired
      // — matches every other tab now per [[unify-behavior-not-names]].
      toolbar: {
        searchPlaceholder: false,
        refresh: true,
      },
      columns: ["Member", "Role", "Scope", "Joined"],
      row: (m) =>
        '<tr>'
        + '<td>' + esc(m.user_display_name) + ' <span class="rp-mon-method">@' + esc(m.user_username) + '</span></td>'
        + '<td>' + roleChip(m.role) + '</td>'
        + '<td>' + esc(m.scope_name) + '</td>'
        + '<td>' + fmtTime(m.joined_at) + '</td>'
        + '</tr>',
    },
    cases: {
      title: "Cases",
      // /api/cases returns { items, total, page, size } (paginated
      // — see routes/cases.rs:list). fetchList's items-fallback
      // handles the shape; pagination + ?q= / ?status= / ?assignee=
      // are real on this endpoint, unlike the projects + admin
      // placeholders elsewhere in this file.
      endpoint: "/cases",
      // No dedicated /cases/stats — charts derive from the list
      // payload, same pattern as the Projects tab.
      statsEndpoint: "/cases",
      compositeStrip: true,   // 2 charts → KPI 2×2 flanked
      // Edit / Select / Delete modes — Cases is the first Home tab
      // to wire the toolbar mode buttons. `select` toggles a
      // checkbox column + selection chip; `delete` bulk-removes the
      // selected cases via DELETE /api/cases/:rid. `edit` stays
      // disabled until the per-cell editor lands (separate slice).
      modes: { select: true, delete: true },
      // Status filter is FUNCTIONAL — backend supports ?status= on
      // the list endpoint. Empty value (default "All") sends no
      // status param.
      chipRows: [{
        name: "status",
        label: "Status",
        options: [
          { label: "All",         value: ""            },
          { label: "Backlog",     value: "backlog"     },
          { label: "Todo",        value: "todo"        },
          { label: "In progress", value: "in_progress" },
          { label: "In review",   value: "in_review"   },
          { label: "Done",        value: "done"        },
        ],
        default: "",
      }],
      charts: [
        { id: "rp-home-cases-status", title: "By status", kind: "donut",
          data: (stats) => (stats?.items || []).reduce((acc, r) => {
            const k = r.status || "backlog"; acc[k] = (acc[k] || 0) + 1; return acc;
          }, {}) },
        { id: "rp-home-cases-priority", title: "By priority", kind: "donut",
          data: (stats) => (stats?.items || []).reduce((acc, r) => {
            const k = r.priority || "medium"; acc[k] = (acc[k] || 0) + 1; return acc;
          }, {}) },
      ],
      toolbar: {
        searchPlaceholder: "Search title, description…",
        // Cases is the one Home tab with wired select + delete modes
        // (bulk-delete via DELETE /api/cases/:rid). Other tabs don't
        // expose modes today — they'll join when their delete endpoints
        // land. Per [[unify-behavior-not-names]]: visible options only
        // when functional.
        modes: { select: true, delete: true },
        refresh: true,
      },
      columns: ["Title", "Type", "Status", "Priority", "Assignee", "Updated"],
      // Row click → /cases?id=… so the Cases detail page opens for
      // the picked case (same pattern as Charts/Projects rows
      // routing into Workspace).
      row: (c) =>
        '<tr class="rp-home-row--clickable"'
        + ' data-rid="' + esc(c.redpash_id || "") + '"'
        + ' data-href="#/cases?id=' + encodeURIComponent(c.redpash_id) + '">'
        + '<td>' + esc(c.title || "(untitled)") + '</td>'
        + '<td><span class="rp-mon-method">' + esc(c.type || "task") + '</span></td>'
        + '<td>' + caseStatusChip(c.status) + '</td>'
        + '<td>' + priorityChip(c.priority) + '</td>'
        + '<td>' + esc(c.assignee_display_name || c.assignee_id || "—") + '</td>'
        + '<td>' + fmtTime(c.updated_at) + '</td>'
        + '</tr>',
    },
    files: {
      title: "Files",
      endpoint: "/admin/files",
      statsEndpoint: "/admin/files/stats",
      compositeStrip: true,   // 3 charts → first 2 flank, 3rd renders below
      // Functional — /admin/files's FilesQuery already accepts ?stage=
      // (see backend/crates/api/src/routes/admin.rs:86). Empty value
      // means "no filter".
      chipRows: [{
        name: "stage",
        label: "Stage",
        options: [
          { label: "All",     value: ""        },
          { label: "New",     value: "new"     },
          { label: "Clean",   value: "clean"   },
          { label: "Design",  value: "design"  },
          { label: "Publish", value: "publish" },
        ],
        default: "",
      }],
      // Trimmed from 3 to 2 charts (Em 2026-05-25 "random for now")
      // to fit the composite-strip cleanly. Kept stage + cleanness
      // (composition + quality); by-type bar dropped — its info
      // overlaps with the type column already visible in the row.
      charts: [
        { id: "rp-home-files-stage", title: "By stage",  kind: "donut",
          data: (s) => s.by_stage },
        { id: "rp-home-files-clean", title: "Cleanness", kind: "gauge",
          data: (s) => s.avg_cleanness ?? 0, opts: { max: 100, unit: "%" } },
      ],
      // Toolbar — search + sort + refresh are wired. Modes/columns/
      // export stripped 2026-05-25 per [[unify-behavior-not-names]]
      // (no disabled-stub buttons; they'll return when their handlers
      // land). undoRedo + history intentionally omitted (no list-level
      // history to model).
      toolbar: {
        searchPlaceholder: "Search filename, project…",
        refresh: true,
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
      compositeStrip: true,   // 2 charts → KPI 2×2 flanked
      // Visual placeholder — /admin/charts doesn't accept ?window= yet
      // (backend TODO). Mirrors the users tab's activity-window shape.
      chipRows: [{
        name: "window",
        label: "Window",
        options: [
          { label: "All time", value: "all" },
          { label: "Last 7d",  value: "7d"  },
          { label: "Last 30d", value: "30d" },
        ],
        default: "all",
      }],
      charts: [
        { id: "rp-home-cht-recent", title: "Created last 7d", kind: "gauge",
          data: (s) => s.total ? Math.round((s.last_7d / s.total) * 100) : 0,
          opts: { max: 100, unit: "%" } },
        { id: "rp-home-cht-reports", title: "In a report",    kind: "gauge",
          data: (s) => s.total ? Math.round((s.used_in_reports / s.total) * 100) : 0,
          opts: { max: 100, unit: "%" } },
      ],
      toolbar: {
        searchPlaceholder: "Search chart name…",
        refresh: true,
      },
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
    projects: {
      title: "Projects",
      compositeStrip: true,   // 3 charts → first 2 flank, 3rd renders below
      // /api/projects today returns { items: [...] } (no Page<T>
      // wrapper, no pagination). fetchList falls back to `items` when
      // `rows` is absent; page size becomes a no-op for this endpoint.
      // Backend Page<T> conversion + ?status= / ?q= / ?sort= queued
      // as a follow-up; the visual chips below will start filtering
      // once that lands.
      endpoint: "/projects",
      // No dedicated /projects/stats endpoint. Charts source from the
      // same /projects payload — `statsEndpoint` is set to the list
      // endpoint so the charts controller fetches the list shape and
      // the data callbacks derive aggregates client-side. Single
      // duplicate fetch is acceptable for projects-volume; if we cross
      // ~500 projects the right move is a dedicated stats endpoint.
      statsEndpoint: "/projects",
      // Visual placeholder — `?status=` isn't wired on /api/projects
      // yet. Backend TODO mirrors the users / companies / charts chips.
      chipRows: [{
        name: "status",
        label: "Status",
        options: [
          { label: "All",      value: "all"      },
          { label: "Active",   value: "active"   },
          { label: "Draft",    value: "draft"    },
          { label: "Archived", value: "archived" },
        ],
        default: "all",
      }],
      // Each data callback reads `stats.items` (the list payload) and
      // aggregates client-side. The data shape (ProjectSummary[]) is
      // stable across the spec.
      //
      // Trimmed from 3 to 2 charts (Em 2026-05-25 "random for now")
      // to fit the composite-strip cleanly. Kept stage + cleanness
      // (composition + quality); files-per-project bar dropped —
      // file_count is already in the row's Files column.
      charts: [
        { id: "rp-home-proj-stage", title: "By stage",   kind: "donut",
          data: (stats) => (stats?.items || []).reduce((acc, r) => {
            const k = r.stage || "new"; acc[k] = (acc[k] || 0) + 1; return acc;
          }, {}) },
        { id: "rp-home-proj-clean", title: "Avg cleanness", kind: "gauge",
          data: (stats) => {
            const xs = (stats?.items || []).map((r) => r.cleanness_pct).filter((v) => v != null);
            return xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : 0;
          },
          opts: { max: 100, unit: "%" } },
      ],
      toolbar: {
        searchPlaceholder: "Search project name…",
        refresh: true,
      },
      columns: ["Name", "Files", "Stage", "Status", "Updated"],
      // Click-through to the Workspace with the project rid pinned —
      // same pattern as charts above so the rail tab acts as a
      // launchpad into the working surface.
      row: (p) =>
        '<tr class="rp-home-row--clickable"'
        + ' data-href="#/workspace?project=' + encodeURIComponent(p.redpash_id) + '">'
        + '<td>' + esc(p.name || "(untitled)") + '</td>'
        + '<td class="is-num">' + (p.file_count != null ? p.file_count : "—") + '</td>'
        + '<td>' + stageChip(p.stage) + '</td>'
        + '<td>' + esc(p.status || "—") + '</td>'
        + '<td>' + fmtTime(p.updated_at) + '</td>'
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

  // List-tab paging + filter state. Declared BEFORE the activate()
  // call below — Projects is the default tab and now goes through
  // renderListBody (since it joined LIST_VIEWS in `0434935`), which
  // touches these on its first paint. Leaving the `let`s further
  // down hit a TDZ on default-tab activation.
  let listPage = 1;
  let listTotalPages = 1;
  let listTotal = 0;     // total row count from the last fetch (for the pager rows-info readout)
  let listShown = 0;     // rows actually returned on the current page
  let listSearch = "";
  let listSort   = null;  // { col, dir } | null

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
  // Every rail tab — including Projects — renders through the same
  // 6-section stack (head / chip-row / kpi-strip / charts / toolbar /
  // table) driven by its LIST_VIEWS spec. Projects previously had a
  // bespoke card-grid renderer; it moved into the unified path so
  // the rail's UI shape is identical across tabs.
  function renderTabBody(tab) {
    const spec = LIST_VIEWS[tab.key];
    if (spec) renderListBody(tab, spec);
  }

  // ─── list-view tabs (Users / Companies / Memberships / Files /
  //     Charts / Projects) — one renderer driven by a LIST_VIEWS spec.
  // The page-state `let`s (listPage / listTotalPages / listSearch /
  // listSort) hoist to the top of this function above the activate()
  // call — see the TDZ note there.
  //
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

  // Composite KPI / charts row — replaces the default kpiStrip +
  // chartsStrip stack when `spec.compositeStrip === true`. Layout
  // per Em's Users-tab spec (2026-05-25):
  //
  //   [ chart1 20% ] [ 4 KPI tiles in 2×2, each 15% ] [ chart2 20% ]
  //
  // The middle column houses the 4 standard list KPIs (Total / On
  // page / Page / Last fetch) in a 2-col × 2-row sub-grid. Falls
  // back gracefully if the spec has fewer than 2 charts — the
  // empty chart-card slot still reserves layout space so the row
  // doesn't reflow. Class names sit in list-page.css's home block
  // (see `.rp-home-composite*`).
  function compositeStripHTML(tiles, charts) {
    const chartCard = (c) => c
      ? '<div class="rp-home-chart-card">'
      +   '<div class="rp-home-chart-title">' + esc(c.title || "") + '</div>'
      +   '<div class="rp-home-chart-canvas" id="' + esc(c.id) + '"></div>'
      + '</div>'
      : '<div class="rp-home-chart-card rp-home-chart-card--empty"></div>';
    const statsCells = tiles.map((t) =>
      '<div class="rp-kpi">'
      + '<span class="rp-kpi-label">' + esc(t.label) + '</span>'
      + '<span class="rp-kpi-value" id="' + esc(t.id) + '">—</span>'
      + '</div>'
    ).join("");
    return '<div class="rp-home-composite">'
      +   chartCard(charts[0])
      +   '<div class="rp-home-composite__stats">' + statsCells + '</div>'
      +   chartCard(charts[1])
      + '</div>';
  }

  function renderListBody(tab, spec) {
    listPage   = 1;
    listSearch = "";
    listSort   = null;
    // Per-chip-row state — { chipRowName → current value }. Sent to
    // the endpoint as additional query params; click on a chip flips
    // the value + resets page to 1 + refetches.
    const chipState = {};
    (spec.chipRows || []).forEach((cr) => { chipState[cr.name] = cr.default; });

    // ── select / delete mode state ───────────────────────────────
    // Reset on each renderListBody so tab switches don't carry it.
    // `selectMode` toggles the checkbox column + selection-chip
    // visibility; `selected` is the live set of picked rids; the
    // delete-mode toolbar button enables only when selected.size > 0.
    // Edit-mode deferred — per-cell editor lands as a separate slice.
    let selectMode = false;
    const selected = new Set();

    // Decorate the tbody with a leading checkbox column when select
    // mode is on. Called after every fetchList paint (since fetchList
    // rewrites tbody.innerHTML wholesale) + after every mode toggle.
    // Idempotent: a row that already has the .rp-list-sel cell is
    // skipped. Reads rid from data-rid on each <tr>.
    function decorateSelectMode() {
      const tbody = view.querySelector("#rp-home-list-tbody");
      if (!tbody) return;
      const thead = view.querySelector(".rt-table thead tr");
      // Header checkbox column — strip first, re-add if selectMode.
      thead?.querySelector(".rp-list-sel-th")?.remove();
      tbody.querySelectorAll("td.rp-list-sel").forEach((td) => td.remove());
      if (!selectMode) return;
      if (thead) {
        const th = document.createElement("th");
        th.className = "rp-list-sel-th";
        th.innerHTML = '<input type="checkbox" data-sel-all>';
        thead.insertBefore(th, thead.firstChild);
      }
      tbody.querySelectorAll("tr[data-rid]").forEach((tr) => {
        const rid = tr.dataset.rid;
        const checked = selected.has(rid);
        if (checked) tr.classList.add("is-selected");
        const td = document.createElement("td");
        td.className = "rp-list-sel";
        td.innerHTML = '<input type="checkbox"' + (checked ? " checked" : "") + '>';
        tr.insertBefore(td, tr.firstChild);
      });
    }

    function updateSelChip() {
      const chip   = view.querySelector("#rp-list-toolbar-sel-chip");
      const count  = view.querySelector("#rp-list-toolbar-sel-count");
      const delBtn = view.querySelector('.rt-mode[data-mode="delete"]');
      if (chip)  chip.hidden = !selectMode;
      if (count) count.textContent = selected.size;
      // Delete button enables only with a non-empty selection.
      if (delBtn) {
        if (selectMode && selected.size > 0) delBtn.removeAttribute("disabled");
        else                                 delBtn.setAttribute("disabled", "");
      }
    }

    function toggleSelectMode() {
      selectMode = !selectMode;
      selected.clear();
      view.querySelector('.rt-mode[data-mode="select"]')?.classList.toggle("is-active", selectMode);
      decorateSelectMode();
      updateSelChip();
    }

    async function bulkDelete() {
      if (!selected.size) return;
      const n = selected.size;
      if (!confirm(`Delete ${n} ${n === 1 ? "case" : "cases"}? This cannot be undone.`)) return;
      const rids = [...selected];
      // Fire all DELETEs in parallel — small N (selection is bounded
      // by page size, default 25). allSettled so partial failures
      // don't block the refetch.
      const results = await Promise.allSettled(
        rids.map((rid) => api.delete(spec.endpoint + "/" + encodeURIComponent(rid)))
      );
      const failed = results.filter((r) => r.status === "rejected");
      if (failed.length) {
        console.warn("[home] bulk-delete: " + failed.length + " failed");
      }
      selected.clear();
      selectMode = false;
      view.querySelector('.rt-mode[data-mode="select"]')?.classList.remove("is-active");
      updateSelChip();
      fetchList(spec, chipState);
    }

    const kpiTiles = [
      { label: "Total",      id: "rp-home-list-total" },
      { label: "On page",    id: "rp-home-list-shown" },
      { label: "Page",       id: "rp-home-list-page" },
      { label: "Last fetch", id: "rp-home-list-ms"   },
    ];

    // Composite tabs: charts[0]+[1] flank the KPI 2×2; any extras
    // (charts[2+]) render below as a standard chartsStrip so no
    // chart gets dropped. Specs with 0-1 charts stay on the
    // stacked default — the asymmetric "chart left, empty right"
    // composite slot reads worse than the legacy stack. Named
    // `specCharts` (not `charts`) to avoid shadowing the
    // module-scope `charts` controller from createListCharts().
    const specCharts      = spec.charts || [];
    const useComposite    = spec.compositeStrip && specCharts.length >= 2;
    const compositeCharts = useComposite ? specCharts.slice(0, 2) : [];
    const extraCharts     = useComposite ? specCharts.slice(2)    : specCharts;

    view.innerHTML = ''
      + headHTML(spec.title, "")
      + (spec.chipRows || []).map((cr) => chipRowHTML(cr, chipState[cr.name])).join("")
      + (useComposite
          ? compositeStripHTML(kpiTiles, compositeCharts) + chartsStripHTML(extraCharts)
          : kpiStripHTML(kpiTiles) + chartsStripHTML(extraCharts))
      + (spec.toolbar ? listToolbarHTML(spec.toolbar) : "")
      + listPanel(spec.columns)
      + '<div class="rt-pager" id="rp-home-list-pager"></div>';

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
      // One-shot spin on click (0.6s ease, matches Workspace's #wsRefresh):
      // remove → reflow → add retriggers the animation on every click,
      // independent of how fast the fetch resolves. Fetch is fire-and-
      // forget here; tying the spin to the await made it flicker on the
      // sub-100ms responses that dominate Home list endpoints.
      view.querySelector("#rp-list-toolbar-refresh")?.addEventListener("click", (e) => {
        const icon = e.currentTarget.querySelector("i");
        if (icon) {
          icon.classList.remove("rt-spinning");
          void icon.offsetWidth;
          icon.classList.add("rt-spinning");
        }
        fetchList(spec, chipState);
      });

      // Rows-per-page dropdown — mirrors workspace's #wsRowsDd shape.
      // Writes the rowsPerPageHome pref + resets to page 1 + refetches.
      // The label/selection indicator are kept in sync via syncRowsLabel().
      const rowsDd = view.querySelector("#rp-list-toolbar-rows-dd");
      function syncRowsLabel() {
        const raw = getPref("rowsPerPageHome") || "25";
        const lbl = view.querySelector("#rp-list-toolbar-rows-label");
        if (lbl) lbl.textContent = raw === "all" ? "All rows" : raw + " rows";
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
        setPref("rowsPerPageHome", item.dataset.rows);
        listPage = 1;
        syncRowsLabel();
        fetchList(spec, chipState);
      });

      // Click-to-sort — header delegation. Three-state per column:
      // first click sets desc, second flips to asc, third clears.
      // After clearing, the backend falls back to its default sort.
      view.querySelector(".rt-table thead")?.addEventListener("click", (e) => {
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

    // ── mode buttons: enable + wire for specs that opted in ─────
    if (spec.modes?.select) {
      const btn = view.querySelector('.rt-mode[data-mode="select"]');
      if (btn) {
        btn.removeAttribute("disabled");
        btn.title = "Select mode (toggle)";
        btn.addEventListener("click", toggleSelectMode);
      }
      // Header select-all checkbox — delegated `change` listener on
      // the thead so it survives re-renders (decorateSelectMode
      // strips + re-adds the cell on every refetch + mode toggle).
      view.querySelector(".rt-table thead")?.addEventListener("change", (e) => {
        const cb = e.target.closest("input[data-sel-all]");
        if (!cb || !selectMode) return;
        const tbody = view.querySelector("#rp-home-list-tbody");
        tbody?.querySelectorAll("tr[data-rid]").forEach((tr) => {
          const rid = tr.dataset.rid;
          if (cb.checked) selected.add(rid);
          else            selected.delete(rid);
          tr.classList.toggle("is-selected", cb.checked);
          const rowCb = tr.querySelector(".rp-list-sel input");
          if (rowCb) rowCb.checked = cb.checked;
        });
        updateSelChip();
      });
    }
    if (spec.modes?.delete) {
      const btn = view.querySelector('.rt-mode[data-mode="delete"]');
      if (btn) {
        // Stays disabled until the selection is non-empty (updated
        // by updateSelChip every time the set changes).
        btn.title = "Delete selected";
        btn.addEventListener("click", bulkDelete);
      }
    }

    // Row click — in select mode toggles selection; otherwise navigates.
    // Delegated on the tbody so the binding survives every fetchList
    // re-render (tbody.innerHTML is rewritten wholesale on each fetch).
    view.querySelector("#rp-home-list-tbody")?.addEventListener("click", (e) => {
      if (selectMode) {
        const tr = e.target.closest("tr[data-rid]");
        if (!tr) return;
        const rid = tr.dataset.rid;
        if (selected.has(rid)) selected.delete(rid);
        else                    selected.add(rid);
        tr.classList.toggle("is-selected", selected.has(rid));
        const cb = tr.querySelector(".rp-list-sel input");
        if (cb) cb.checked = selected.has(rid);
        updateSelChip();
        return;
      }
      const tr = e.target.closest("tr[data-href]");
      if (!tr) return;
      location.hash = tr.dataset.href.replace(/^#/, "");
    });

    // Expose the decorate hook to fetchList so it re-paints checkboxes
    // after each refetch. Stashed on the view element so fetchList can
    // call it without a closure capture (it's defined module-scope
    // outside the renderListBody closure).
    view._decorateSelectMode = decorateSelectMode;

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
      // Page<T> endpoints (admin/*) carry `rows` + `total` + `pages`.
      // Legacy endpoints (`/api/projects` today) return `{ items: [...] }`
      // — fall back to `items` and synthesise the pagination fields so
      // the same render path serves both. When projects moves to
      // Page<T> shape (queued follow-up), the fallback becomes dead
      // weight + can be removed.
      const rows = data?.rows || data?.items || [];
      const total = data?.total != null ? data.total : rows.length;
      listTotalPages = data?.pages || 1;
      listPage       = data?.page  || listPage;
      listTotal      = total;
      listShown      = rows.length;
      const elapsed = Math.round(performance.now() - t0);
      setKpi("rp-home-list-total", fmtCount(total));
      setKpi("rp-home-list-shown", String(rows.length));
      setKpi("rp-home-list-page",  listPage + " / " + listTotalPages);
      setKpi("rp-home-list-ms",    elapsed + "ms");
      view.querySelector(".rp-shell-head-count").textContent = total + " rows";
      if (tbody) {
        tbody.innerHTML = rows.length
          ? rows.map(spec.row).join("")
          : '<tr><td colspan="' + colCount + '">No rows.</td></tr>';
      }
      // Re-paint select-mode checkboxes if the active tab has them
      // enabled. The hook is set up in renderListBody for specs that
      // declare `spec.modes.select`; absent on other tabs (no-op).
      if (typeof view._decorateSelectMode === "function") {
        view._decorateSelectMode();
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

  // ─── small render utilities ──────────────────────────────────
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
  // Cases status — flow: backlog → todo → in_progress → in_review → done.
  // Mid-flow states (in_progress / in_review) get the warmer tone; the
  // terminal `done` gets low (cool/green-ish vibe via the chip token).
  function caseStatusChip(status) {
    const v = String(status || "").toLowerCase();
    const tone = v === "in_progress" || v === "in_review" ? "rp-mon-err-mid"
              : v === "todo"        ? "rp-mon-err-low"
              : "";
    return '<span class="rp-mon-method ' + tone + '">' + esc(status || "—") + '</span>';
  }
  // Cases priority — low / medium / high / critical. Tone scales with
  // urgency; medium gets no tone (it's the default + most rows).
  function priorityChip(priority) {
    const v = String(priority || "").toLowerCase();
    const tone = v === "critical" ? "rp-mon-err-high"
              : v === "high"     ? "rp-mon-err-mid"
              : v === "low"      ? "rp-mon-err-low"
              : "";
    return '<span class="rp-mon-method ' + tone + '">' + esc(priority || "—") + '</span>';
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

