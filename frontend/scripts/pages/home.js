/* Purpose: see doc for details.
 * Doc: docs/internal/code/frontend/scripts/pages/home.md */
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
import { mountRailFooterNav } from "/scripts/rail-footer.js";
import { mountRailCollapse } from "/scripts/rail-controls.js";
import { esc, cssEsc } from "/scripts/dom.js";
import { getPref, setPref } from "/scripts/prefs.js";
import {
  headHTML, kpiStripHTML, chartsStripHTML, compositeStripHTML,
  chipRowHTML, listToolbarHTML,
  listPanel as _listPanel,
  setKpi as _setKpi,
  renderListPager as _renderListPager,
  createListCharts,
  wireListColumnsExport,
} from "/scripts/list-page.js";

// Tab definitions extracted into `home/tabs.js` as slice 4 of the
// god-object decomposition (broadcast.md 00:53). HOME_TABS drives
// the rail + redtable surface; HOME_GROUPS partitions the rail into
// ORG / DATA sections; HOME_DEFAULT_TAB is the boot fallback.
// Module-private to home.js — promote if another page composes the
// same tab vocabulary.
import { HOME_TABS, HOME_GROUPS, HOME_DEFAULT_TAB } from "/scripts/pages/home/tabs.js";

// Slice D2 — pref-driven user charts on Home tabs. Same pattern as
// Monitoring (Slice D): when `homeCharts.<tab>` is saved, REPLACE the
// curated kpiX strip with user-built specs rendered via the unified
// `renderChart` pipeline. Empty pref falls back to the existing kpiX
// path unchanged. Builder lives on the Settings page.
import { renderChart } from "/scripts/charts/render.js";

export default function home(app, { session: _session }) {
  mountTopbar(app.querySelector("#rp-topbar"), { active: "home", session: _session });
  mountRailFooterNav(app.querySelector(".rt-nav-foot"), { active: "", session: _session });

  const nav     = app.querySelector("#rpHomeNav");
  const navBody = app.querySelector("#rpHomeNavBody");
  const view    = app.querySelector("#rpHomeView");

  // Rail-foot create button + generic create-modal refs — captured
  // here (rather than next to their helpers later in the file) because
  // the FIRST activate() call at the boot path fires before that point
  // and needs syncCreateButton's closure to see initialised consts.
  const createBtn      = app.querySelector("#rpHomeNavCreate");
  const createBtnIcon  = app.querySelector("#rpHomeNavCreateIcon");
  const createBtnLabel = app.querySelector("#rpHomeNavCreateLabel");
  const createModal    = app.querySelector("#rpHomeCreateModal");
  const createForm     = app.querySelector("#rpHomeCreateForm");
  const createFields   = app.querySelector("#rpHomeCreateFields");
  const createTitle    = app.querySelector("#rpHomeCreateTitle");
  const createError    = app.querySelector("#rpHomeCreateError");
  const createSubmit   = app.querySelector("#rpHomeCreateSubmit");
  let   activeCreateSpec = null;

  // ── hide / restore per Home tab — replicates the workspace 8d070eb
  //    pattern per docs/internal/processes/replicable-feature-pattern.md.
  //    Em's call 2026-05-28: per-tab recovery surface, like workspace.
  //    Pref key namespace: home_hidden_<tabKey>. Each value is an array
  //    of {rid, name, sub?} — pre-resolved labels so the recovery
  //    surface renders with zero network.
  const HOME_HIDDEN_KEY = (tabKey) => "home_hidden_" + tabKey;
  function getHomeHidden(tabKey) {
    const list = getPref(HOME_HIDDEN_KEY(tabKey));
    return Array.isArray(list) ? list : [];
  }
  function hideHomeRow(tabKey, entry) {
    const list = getHomeHidden(tabKey);
    if (list.some((x) => x.rid === entry.rid)) return;
    list.push(entry);
    setPref(HOME_HIDDEN_KEY(tabKey), list);
  }
  function unhideHomeRow(tabKey, rid) {
    setPref(HOME_HIDDEN_KEY(tabKey), getHomeHidden(tabKey).filter((x) => x.rid !== rid));
  }
  // Invariant 1: filter at render-time, never fetch-time. Server returns
  // the full page; the hidden set is applied here before tbody-render
  // so the same /admin/* endpoints stay shape-stable.
  function applyHomeHiddenFilter(spec, tabKey, rows) {
    if (!spec.hideMeta) return rows;
    const hidden = new Set(getHomeHidden(tabKey).map((x) => x.rid));
    if (!hidden.size) return rows;
    return rows.filter((r) => !hidden.has(spec.hideMeta(r).rid));
  }
  function hideCellHTML(rid) {
    return '<td class="rp-home-hide-cell">'
      + '<span class="rt-tab-close rp-home-hide" data-hide-rid="' + esc(rid) + '" title="Hide from list">'
      +   '<i class="bi bi-x"></i>'
      + '</span>'
      + '</td>';
  }
  function renderHomeHiddenSection(tabKey) {
    const hidden = getHomeHidden(tabKey);
    if (!hidden.length) return "";
    const items = hidden.map((h) =>
      '<button class="rt-hidden-item" type="button" data-rid="' + esc(h.rid) + '">'
      +   '<span class="rt-hidden-name">' + esc(h.name || h.rid)
      +     (h.sub ? ' <span class="rt-hidden-meta">· ' + esc(h.sub) + '</span>' : "")
      +   '</span>'
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
  function paintHomeHiddenSection() {
    const tabKey = view.dataset.activeTab || "";
    const host = view.querySelector("#rp-home-hidden-host");
    if (host) host.innerHTML = renderHomeHiddenSection(tabKey);
  }

  // Set by renderListBody to a closure capturing the active tab's
  // spec + chipState. Hide × removes a row visually + writes the
  // pref (no network). Restore drops from the pref and refetches so
  // the row reappears in the table.
  let refetchActiveList = null;

  // Single delegator on the page surface — view is a stable element
  // (view.innerHTML changes per renderListBody but the node persists),
  // so this listener wires once at mount and stays valid across tab
  // switches. Both branches end in `return` per Invariant 2 — don't
  // let a hide click also fire a row action (select-mode checkbox,
  // edit-mode focus) that lives in the same delegation tree.
  view.addEventListener("click", (e) => {
    const hideBtn = e.target.closest(".rp-home-hide");
    if (hideBtn) {
      e.preventDefault();
      e.stopPropagation();
      const tabKey = view.dataset.activeTab || "";
      if (!tabKey) return;
      hideHomeRow(tabKey, {
        rid:  hideBtn.dataset.hideRid,
        name: hideBtn.dataset.hideName,
        sub:  hideBtn.dataset.hideSub,
      });
      // Visual remove — cheaper than refetch + matches the user's
      // mental model (click × → row gone immediately).
      hideBtn.closest("tr")?.remove();
      paintHomeHiddenSection();
      return;
    }
    const restoreItem = e.target.closest(".rt-hidden-item");
    if (restoreItem?.dataset.rid) {
      e.preventDefault();
      e.stopPropagation();
      const tabKey = view.dataset.activeTab || "";
      if (!tabKey) return;
      unhideHomeRow(tabKey, restoreItem.dataset.rid);
      // Refetch — restoring requires the row's data to reappear in
      // the table, and the source of truth for that data is the
      // server response. paintHomeHiddenSection is implicit since
      // fetchList re-runs the full render path including the host.
      paintHomeHiddenSection();
      refetchActiveList?.();
      return;
    }
  });

  // List-page bindings — partial-apply the view + the page-specific
  // ID prefixes once so call sites keep their original short-arg
  // signatures (setKpi(id, val), renderListPager(), listPanel(cols)).
  // The chart controller hosts mount/dispose against the shared
  // /scripts/list-page.js runtime.
  const charts          = createListCharts(view, { logPrefix: "home" });
  // Slice D2 — user-built chart instances tracked outside the kpiX
  // controller so tab-switch + chip-flip teardown disposes both from
  // one site. Same hoisted-tracker shape as monitoring.js.
  let userInstances = [];
  function disposeUserInstances() {
    userInstances.forEach((i) => { try { i.dispose(); } catch { /* gone */ } });
    userInstances = [];
  }
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
      // Hide/restore — per [[replicable-feature-pattern]]. Each tab's
      // hideMeta(item) returns the {rid, name, sub?} captured into the
      // home_hidden_<tabKey> pref when the user hits the × on a row.
      // Defined per tab because the displayable fields differ across
      // entity types. Tabs without hideMeta opt out of hide/restore.
      hideMeta: (u) => ({
        rid:  u.redpash_id,
        name: u.display_name || u.username,
        sub:  u.username ? "@" + u.username : "",
      }),
      // createSpec drives the rail-foot "New <noun>" button + the generic
      // modal renderer. kind:"modal" posts a JSON body built from
      // fields[]; kind:"route" navigates to href. The label/icon shows
      // on the button when the tab is active. After a successful POST
      // the active tab refetches so the new row appears in the list.
      createSpec: {
        kind:     "modal",
        label:    "New user",
        icon:     "bi-person-plus",
        endpoint: "/users",
        title:    "New user",
        fields: [
          { key: "display_name", label: "Display name", required: true, placeholder: "Full name" },
          { key: "username",     label: "Handle",       required: true, placeholder: "e.g. mansa", autocomplete: "off" },
          { key: "email",        label: "Email",        required: false, type: "email", placeholder: "optional" },
        ],
      },
      // DELETE /api/admin/users/:rid — added 2026-05-25. Cascades to
      // projects (owner_id), memberships (CASCADE), sessions (CASCADE).
      // PATCH /api/users/:rid — sparse update; display_name is the
      // editable column today (job_title / org_name need their own
      // editors later — chip-style for org_role, picker for org).
      patchEndpoint: "/users",
      itemNoun: "user",
      itemNounPlural: "users",
      modes: { select: true, delete: true },
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
        modes: { select: true, delete: true },
        refresh: true,
      },
      // Sortable wire-keys must match the SORTABLE_USERS allowlist in
      // backend/crates/api/src/routes/admin.rs. The header chevron only
      // renders for columns flagged sortable: true.
      // Every field on UserSummary gets a column — picker (toggle via
      // toolbar columns icon) controls visibility. Less-useful fields
      // are flagged `defaultHidden: true` so the initial render stays
      // identical to before; the data is reachable via the picker.
      columns: [
        { label: "Name",        key: "display_name", sortable: true  },
        { label: "Handle",      key: "username",     sortable: true,  defaultHidden: true },
        { label: "Email",       key: "email",        sortable: true,  defaultHidden: true, editable: true, editKey: "email" },
        { label: "Plan",        key: "plan",         sortable: true  },
        { label: "Job",         key: "job_title",    sortable: true, editable: true, editKey: "job_title" },
        { label: "Profile org", key: "organisation", sortable: true,  defaultHidden: true, editable: true, editKey: "organisation" },
        { label: "Org",         key: "org_name",     sortable: true  },
        { label: "Role",        key: "org_role",     sortable: true  },
        { label: "Avatar",      key: "avatar_url",   sortable: false, defaultHidden: true },
        { label: "Joined",      key: "created_at",   sortable: true  },
        { label: "ID",          key: "redpash_id",   sortable: false, defaultHidden: true },
      ],
      // Only clean-text cells (no nested chip / icon markup) are flagged
      // editable. Cells that wrap display_name in <span> chips with
      // @handle suffixes etc. can't be edited via contenteditable
      // without dropping the formatting — those need a dedicated
      // cell-editor render path which is its own slice.
      row: (u) =>
        '<tr data-rid="' + esc(u.redpash_id || "") + '">'
        + '<td class="rp-home-user-name">'
        +   '<span class="rp-home-user-display">' + esc(u.display_name) + '</span>'
        +   ' <span class="rp-home-handle">@' + esc(u.username) + '</span>'
        + '</td>'
        + '<td class="rp-meta">@' + esc(u.username || "") + '</td>'
        + '<td class="rp-meta">' + esc(u.email || "—") + '</td>'
        + '<td>' + planChip(u.plan) + '</td>'
        + '<td class="rp-meta">' + esc(u.job_title || "—") + '</td>'
        + '<td class="rp-meta">' + esc(u.organisation || "—") + '</td>'
        + '<td>' + (u.org_name ? orgChip(u.org_name) : '<span class="rp-meta">—</span>') + '</td>'
        + '<td>' + (u.org_role ? roleChip(u.org_role) : '<span class="rp-meta">—</span>') + '</td>'
        + '<td class="rp-meta">' + esc(u.avatar_url || "—") + '</td>'
        + '<td class="rp-meta">' + fmtTime(u.created_at) + '</td>'
        + '<td><span class="rt-mono-pill">' + esc(u.redpash_id || "—") + '</span></td>'
        + '</tr>',
    },
    companies: {
      title: "Companies",
      endpoint: "/admin/companies",
      hideMeta: (c) => ({
        rid:  c.redpash_id,
        name: c.name,
        sub:  c.slug ? c.slug : "",
      }),
      createSpec: {
        kind:     "modal",
        label:    "New company",
        icon:     "bi-building-add",
        endpoint: "/companies",
        title:    "New company",
        fields: [
          { key: "name", label: "Name", required: true, placeholder: "Company name" },
          { key: "slug", label: "Slug", required: false, placeholder: "optional — auto-derived from name" },
        ],
      },
      // DELETE /api/admin/companies/:rid — added 2026-05-25. Cascades
      // to company_memberships; projects.company_id is SET NULL so
      // company-scoped projects survive as personal.
      itemNoun: "company",
      itemNounPlural: "companies",
      modes: { select: true, delete: true },
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
        modes: { select: true, delete: true },
        refresh: true,
      },
      // Sortable wire-keys → SORTABLE_COMPANIES allowlist (admin.rs).
      // "My role" stays unsortable — it's a per-caller computed value
      // (RBAC pending), not a column the DB can sort by. Slug / avatar /
      // updated / ID are defaultHidden — opt-in via the picker.
      columns: [
        { label: "Name",    key: "name",         sortable: true  },
        { label: "Slug",    key: "slug",         sortable: true,  defaultHidden: true },
        { label: "Members", key: "member_count", sortable: true  },
        { label: "My role", key: "my_role",      sortable: false },
        { label: "Avatar",  key: "avatar_url",   sortable: false, defaultHidden: true },
        { label: "Created", key: "created_at",   sortable: true  },
        { label: "Updated", key: "updated_at",   sortable: true,  defaultHidden: true },
        { label: "ID",      key: "redpash_id",   sortable: false, defaultHidden: true },
      ],
      row: (c) =>
        '<tr data-rid="' + esc(c.redpash_id || "") + '">'
        + '<td>' + esc(c.name) + ' <span class="rt-mono-pill">' + esc(c.slug) + '</span></td>'
        + '<td><span class="rt-mono-pill">' + esc(c.slug || "—") + '</span></td>'
        + '<td class="is-num">' + (c.member_count || 0) + '</td>'
        + '<td>' + (c.my_role ? roleChip(c.my_role) : "—") + '</td>'
        + '<td class="rp-meta">' + esc(c.avatar_url || "—") + '</td>'
        + '<td>' + fmtTime(c.created_at) + '</td>'
        + '<td>' + fmtTime(c.updated_at) + '</td>'
        + '<td><span class="rt-mono-pill">' + esc(c.redpash_id || "—") + '</span></td>'
        + '</tr>',
    },
    memberships: {
      title: "Memberships",
      endpoint: "/admin/memberships",
      // Memberships use a synthetic compound rid (matches row()'s
      // data-rid attr) since the table PK is composite.
      hideMeta: (m) => ({
        rid:  (m.scope || "") + ":" + (m.scope_redpash_id || "") + ":" + (m.user_redpash_id || ""),
        name: m.user_display_name || m.user_username || "—",
        sub:  m.scope_name || m.scope || "",
      }),
      // DELETE /api/admin/memberships/:rid — added 2026-05-25. The rid
      // is a synthetic compound: `{scope}:{scope_id}:{user_id}` since
      // membership rows have a composite PK. row() below constructs
      // this rid from the response; backend parses + dispatches to the
      // right table (project_memberships vs company_memberships).
      itemNoun: "membership",
      itemNounPlural: "memberships",
      // First consumer of the generic create-modal's select +
      // entity-picker field types — scope flips both the scope_id
      // picker endpoint and the role options. POST /api/admin/memberships
      // landed in 1fc0a63; the scope/role allow-lists below mirror the
      // backend's PROJECT_ROLES / COMPANY_ROLES + the SQL CHECK.
      createSpec: {
        kind:     "modal",
        label:    "New membership",
        icon:     "bi-person-plus-fill",
        endpoint: "/admin/memberships",
        title:    "New membership",
        fields: [
          { key: "scope", label: "Scope", type: "select",
            options: [
              { value: "project", label: "Project" },
              { value: "company", label: "Company" },
            ],
            default: "project",
          },
          { key: "scope_id", label: "Project / company", type: "entity-picker",
            required: true,
            placeholder: "Search by name…",
            dependsOn: ["scope"],
            endpointFn: (s) => s.scope === "company" ? "/admin/companies" : "/projects",
            labelKey: "name",
            ridKey:   "redpash_id",
          },
          { key: "user_id", label: "User", type: "entity-picker",
            required: true,
            placeholder: "Search by name, handle, email…",
            endpoint: "/admin/users",
            labelKey: "display_name",
            subKey:   "username",
            ridKey:   "redpash_id",
          },
          { key: "role", label: "Role", type: "select",
            dependsOn: ["scope"],
            optionsFn: (s) => s.scope === "company"
              ? [
                  { value: "member", label: "Member" },
                  { value: "admin",  label: "Admin"  },
                  { value: "owner",  label: "Owner"  },
                ]
              : [
                  { value: "viewer",       label: "Viewer"       },
                  { value: "collaborator", label: "Collaborator" },
                  { value: "owner",        label: "Owner"        },
                ],
            // Default mirrors the migration column-default per scope
            // (project=viewer, company=member). selectHTML falls back
            // to the first option when default doesn't match — for
            // memberships the first option IS the per-scope default,
            // so the fall-back happens to be correct.
            default: "viewer",
          },
        ],
      },
      modes: { select: true, delete: true },
      compositeStrip: true,   // 2 charts → KPI 2×2 flanked
      // The endpoint takes ?scope=project|company; flip via the chip row.
      chipRows: [{
        name: "scope",
        label: "Scope",
        // Plural labels — entity categories read plural everywhere else
        // (Home rail tabs, omnisearch sections, kindLabel). values stay
        // singular: they're the ?scope= wire enum.
        options: [
          { label: "Projects", value: "project" },
          { label: "Companies", value: "company" },
          // Case Team Member = case-scope Membership (rbac/membership.md,
          // v3). Disabled placeholder telegraphing the coming scope — the
          // backend (case_memberships + /admin/memberships?scope=case)
          // isn't built yet, so it can't be selected.
          { label: "Cases", value: "case", disabled: true,
            title: "Case Team Members — coming soon" },
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
      // /admin/memberships now accepts ?q= (2026-05-25 backend addition) —
      // ILIKE search across user_display_name + user_username + scope_name
      // (project / company name). Search box re-enabled per
      // [[unify-behavior-not-names]] — every tab shows the same controls
      // now that the backend supports them.
      toolbar: {
        searchPlaceholder: "Search member, scope…",
        modes: { select: true, delete: true },
        refresh: true,
      },
      // Sortable wire-keys → SORTABLE_MEMBERSHIPS allowlist (admin.rs).
      // Scope_name resolves to p.name / c.name in the backend per-branch.
      // User/scope IDs are defaultHidden — opt-in for debugging.
      columns: [
        { label: "Member",     key: "user_display_name", sortable: true  },
        { label: "Handle",     key: "user_username",     sortable: true,  defaultHidden: true },
        { label: "Role",       key: "role",              sortable: true  },
        { label: "Scope type", key: "scope",             sortable: true,  defaultHidden: true },
        { label: "Scope",      key: "scope_name",        sortable: true  },
        { label: "Scope ID",   key: "scope_redpash_id",  sortable: false, defaultHidden: true },
        { label: "User ID",    key: "user_redpash_id",   sortable: false, defaultHidden: true },
        { label: "Joined",     key: "joined_at",         sortable: true  },
      ],
      // Synthetic compound rid for DELETE: `{scope}:{scope_id}:{user_id}`.
      // The backend admin.rs delete_membership handler parses this triple.
      row: (m) =>
        '<tr data-rid="'
        + esc((m.scope || "") + ":" + (m.scope_redpash_id || "") + ":" + (m.user_redpash_id || ""))
        + '">'
        + '<td>' + esc(m.user_display_name) + ' <span class="rt-mono-pill">@' + esc(m.user_username) + '</span></td>'
        + '<td class="rp-meta">@' + esc(m.user_username || "") + '</td>'
        + '<td>' + roleChip(m.role) + '</td>'
        + '<td><span class="rt-mono-pill">' + esc(m.scope || "—") + '</span></td>'
        + '<td>' + esc(m.scope_name) + '</td>'
        + '<td><span class="rt-mono-pill">' + esc(m.scope_redpash_id || "—") + '</span></td>'
        + '<td><span class="rt-mono-pill">' + esc(m.user_redpash_id || "—") + '</span></td>'
        + '<td>' + fmtTime(m.joined_at) + '</td>'
        + '</tr>',
    },
    cases: {
      title: "Cases",
      hideMeta: (c) => ({
        rid:  c.redpash_id,
        name: c.title || "(untitled)",
        sub:  c.status || "",
      }),
      // /api/cases returns { items, total, page, size } (paginated
      // — see routes/cases.rs:list). fetchList's items-fallback
      // handles the shape; pagination + ?q= / ?status= / ?assignee=
      // are real on this endpoint, unlike the projects + admin
      // placeholders elsewhere in this file.
      endpoint: "/cases",
      createSpec: {
        kind:     "modal",
        label:    "New case",
        icon:     "bi-plus-lg",
        endpoint: "/cases",
        title:    "New case",
        fields: [
          { key: "title",       label: "Title",       required: true, placeholder: "What's the case about?" },
          { key: "description", label: "Description", required: false, type: "textarea",
            placeholder: "Steps to reproduce, context, expected behavior… (optional)" },
        ],
      },
      // PATCH /api/cases/:rid — same path as DELETE; defaults via
      // spec.endpoint, no override needed. Title is the editable cell.
      itemNoun: "case",
      itemNounPlural: "cases",
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
      // Sortable wire-keys → SORTABLE_CASES allowlist (cases.rs).
      // Assignee sorts on the hydrated display_name (NULLS LAST for
      // unassigned). Updated_at is the default. The picker exposes
      // every Case field; defaults match the prior curated set.
      columns: [
        // Title is the editable cell — clean text in the row render.
        // Type / Status / Priority / Assignee need pickers (chip ↔
        // dropdown), not contenteditable; deferred.
        { label: "Title",       key: "title",                 sortable: true, editable: true, editKey: "title" },
        { label: "Type",        key: "type",                  sortable: true  },
        { label: "Status",      key: "status",                sortable: true  },
        { label: "Priority",    key: "priority",              sortable: true  },
        { label: "Assignee",    key: "assignee_display_name", sortable: true  },
        { label: "Reporter",    key: "reporter_display_name", sortable: true,  defaultHidden: true },
        { label: "Project",     key: "project_id",            sortable: true,  defaultHidden: true },
        { label: "Company",     key: "company_id",            sortable: true,  defaultHidden: true },
        { label: "Category",    key: "category_name",         sortable: true,  defaultHidden: true },
        { label: "Description", key: "description",           sortable: false, defaultHidden: true },
        { label: "Error",       key: "error_message",         sortable: false, defaultHidden: true },
        { label: "Created",     key: "created_at",            sortable: true,  defaultHidden: true },
        { label: "Updated",     key: "updated_at",            sortable: true  },
        { label: "ID",          key: "redpash_id",            sortable: false, defaultHidden: true },
      ],
      // Row click → /cases?id=… so the Cases detail page opens for
      // the picked case (same pattern as Charts/Projects rows
      // routing into Workspace).
      row: (c) => {
        const categoryLabel = c.category_parent_name
          ? esc(c.category_parent_name) + " &rsaquo; " + esc(c.category_name || "")
          : esc(c.category_name || "—");
        return '<tr class="rp-home-row--clickable"'
          + ' data-rid="' + esc(c.redpash_id || "") + '"'
          + ' data-href="#/cases?id=' + encodeURIComponent(c.redpash_id) + '">'
          + '<td>' + esc(c.title || "(untitled)") + '</td>'
          + '<td><span class="rt-mono-pill">' + esc(c.type || "task") + '</span></td>'
          + '<td>' + caseStatusChip(c.status) + '</td>'
          + '<td>' + priorityChip(c.priority) + '</td>'
          + '<td>' + esc(c.assignee_display_name || c.assignee_id || "—") + '</td>'
          + '<td>' + esc(c.reporter_display_name || c.reporter_id || "—") + '</td>'
          + '<td><span class="rt-mono-pill">' + esc(c.project_id || "—") + '</span></td>'
          + '<td><span class="rt-mono-pill">' + esc(c.company_id || "—") + '</span></td>'
          + '<td>' + categoryLabel + '</td>'
          + '<td class="rp-meta">' + esc((c.description || "").slice(0, 120) || "—") + '</td>'
          + '<td class="rp-meta">' + esc((c.error_message || "").slice(0, 80) || "—") + '</td>'
          + '<td>' + fmtTime(c.created_at) + '</td>'
          + '<td>' + fmtTime(c.updated_at) + '</td>'
          + '<td><span class="rt-mono-pill">' + esc(c.redpash_id || "—") + '</span></td>'
          + '</tr>';
      },
    },
    files: {
      title: "Files",
      endpoint: "/admin/files",
      hideMeta: (f) => ({
        rid:  f.redpash_id,
        name: f.display_name || f.filename || "(untitled)",
        sub:  f.project_name || "",
      }),
      // DELETE goes to /api/files/:rid (the file ownership endpoint),
      // not /admin/files. Decoupled so the bulk-delete handler in
      // renderListBody can hit the right route. PATCH is the same
      // path — display_name is the editable cell.
      deleteEndpoint: "/files",
      patchEndpoint:  "/files",
      itemNoun: "file",
      itemNounPlural: "files",
      // File creation = upload, which lives on the Workspace surface
      // (the rail-foot wsUpload button + the wsUploadInput file input).
      // Route the Home Files-tab Create button there rather than build
      // a duplicate uploader here.
      createSpec: {
        kind:  "route",
        label: "Upload file",
        icon:  "bi-upload",
        href:  "#/workspace",
      },
      // Wired modes: select toggles the checkbox column, delete fires
      // bulk DELETE /files/:rid against the selection.
      modes: { select: true, delete: true },
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
        modes: { select: true, delete: true },
        refresh: true,
      },
      // Sortable columns map to /admin/files's SORTABLE_FILES allowlist
      // (filename / file_type / stage / row_count / updated_at). Project
      // intentionally not sortable — name lives on a JOIN and isn't in
      // the allowlist yet. Filename is editable (clean-text render).
      // Cols / size / cleanness / created / ID are defaultHidden.
      columns: [
        { label: "Filename",  key: "filename",       sortable: true,  editable: true, editKey: "display_name" },
        { label: "Project",   key: "project",        sortable: false },
        { label: "Type",      key: "file_type",      sortable: true  },
        { label: "Stage",     key: "stage",          sortable: true  },
        { label: "Rows",      key: "row_count",      sortable: true  },
        { label: "Cols",      key: "col_count",      sortable: true,  defaultHidden: true },
        { label: "Size",      key: "file_size_bytes",sortable: true,  defaultHidden: true },
        { label: "Cleanness", key: "cleanness_pct",  sortable: true,  defaultHidden: true },
        { label: "Created",   key: "created_at",     sortable: true,  defaultHidden: true },
        { label: "Updated",   key: "updated_at",     sortable: true  },
        { label: "ID",        key: "redpash_id",     sortable: false, defaultHidden: true },
      ],
      row: (f) => {
        const sizeKb = f.file_size_bytes != null
          ? Math.round(f.file_size_bytes / 1024) + " KB"
          : "—";
        const clean = f.cleanness_pct != null ? Math.round(f.cleanness_pct) + "%" : "—";
        return '<tr data-rid="' + esc(f.redpash_id || "") + '">'
          + '<td>' + esc(f.display_name || f.filename) + '</td>'
          + '<td>' + esc(f.project_name) + '</td>'
          + '<td><span class="rt-mono-pill">' + esc(f.file_type) + '</span></td>'
          + '<td>' + stageChip(f.stage) + '</td>'
          + '<td class="is-num">' + (f.row_count != null ? f.row_count : "—") + '</td>'
          + '<td class="is-num">' + (f.col_count != null ? f.col_count : "—") + '</td>'
          + '<td class="is-num rp-meta">' + sizeKb + '</td>'
          + '<td class="is-num">' + clean + '</td>'
          + '<td>' + fmtTime(f.created_at) + '</td>'
          + '<td>' + fmtTime(f.updated_at) + '</td>'
          + '<td><span class="rt-mono-pill">' + esc(f.redpash_id || "—") + '</span></td>'
          + '</tr>';
      },
    },
    charts: {
      title: "Charts",
      endpoint: "/admin/charts",
      hideMeta: (c) => ({
        rid:  c.redpash_id,
        name: c.display_name || c.filename || "(untitled)",
        sub:  c.project_name || "",
      }),
      // DELETE goes to /api/charts/:rid (the chart-specific endpoint).
      // Charts are project_files under the hood; the canonical PATCH
      // for display_name is /api/files/:rid (the file ownership path),
      // not /api/charts/:rid (which only takes the chart spec payload).
      deleteEndpoint: "/charts",
      patchEndpoint:  "/files",
      itemNoun: "chart",
      itemNounPlural: "charts",
      // Chart creation requires an open data file in the Workspace
      // designer — there's no standalone "create chart" form. Route to
      // workspace; the user opens a CSV → New chart from the designer.
      createSpec: {
        kind:  "route",
        label: "New chart",
        icon:  "bi-bar-chart-line",
        href:  "#/workspace",
      },
      modes: { select: true, delete: true },
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
        modes: { select: true, delete: true },
        refresh: true,
      },
      // Sortable wire-keys → SORTABLE_CHARTS allowlist (admin.rs).
      // "Name" sorts on COALESCE(display_name, filename) so the visible
      // label drives the order even when display_name is unset. Raw
      // filename / created / IDs are defaultHidden.
      columns: [
        { label: "Name",       key: "display_name",        sortable: true, editable: true, editKey: "display_name" },
        { label: "Filename",   key: "filename",            sortable: true,  defaultHidden: true },
        { label: "Project",    key: "project_name",        sortable: true  },
        { label: "Project ID", key: "project_redpash_id",  sortable: false, defaultHidden: true },
        { label: "Stage",      key: "stage",               sortable: true  },
        { label: "Created",    key: "created_at",          sortable: true,  defaultHidden: true },
        { label: "Updated",    key: "updated_at",          sortable: true  },
        { label: "ID",         key: "redpash_id",          sortable: false, defaultHidden: true },
      ],
      // Rows are clickable — navigate to the Workspace with the
      // chart's source project + chart rid as deep-link params so
      // the Designer opens directly on this chart.
      row: (c) =>
        '<tr class="rp-home-row--clickable"'
        + ' data-rid="' + esc(c.redpash_id || "") + '"'
        + ' data-href="#/workspace?project=' + encodeURIComponent(c.project_redpash_id)
        + '&file=' + encodeURIComponent(c.redpash_id) + '">'
        + '<td>' + esc(c.display_name || c.filename) + '</td>'
        + '<td>' + esc(c.filename || "—") + '</td>'
        + '<td>' + esc(c.project_name) + '</td>'
        + '<td><span class="rt-mono-pill">' + esc(c.project_redpash_id || "—") + '</span></td>'
        + '<td>' + stageChip(c.stage) + '</td>'
        + '<td>' + fmtTime(c.created_at) + '</td>'
        + '<td>' + fmtTime(c.updated_at) + '</td>'
        + '<td><span class="rt-mono-pill">' + esc(c.redpash_id || "—") + '</span></td>'
        + '</tr>',
    },
    projects: {
      title: "Projects",
      hideMeta: (p) => ({
        rid:  p.redpash_id,
        name: p.name,
        sub:  p.company_name || (p.is_default ? "default" : ""),
      }),
      // DELETE + PATCH both go to /api/projects/:rid — same path as
      // the list endpoint so deleteEndpoint / patchEndpoint default
      // via spec.endpoint, no override needed. Name is editable.
      itemNoun: "project",
      itemNounPlural: "projects",
      createSpec: {
        kind:     "modal",
        label:    "New project",
        icon:     "bi-folder-plus",
        endpoint: "/projects",
        title:    "New project",
        fields: [
          { key: "name",        label: "Name",        required: true, placeholder: "Project name" },
          { key: "description", label: "Description", required: false, type: "textarea",
            placeholder: "Optional — what's this project for?" },
        ],
      },
      // Note: the owner's DEFAULT project can't be deleted (backend
      // returns 400 is_default). Promise.allSettled in bulkDelete
      // handles the partial failure cleanly — non-default ones still
      // get deleted, the default stays + the refetch shows reality.
      modes: { select: true, delete: true },
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
        modes: { select: true, delete: true },
        refresh: true,
      },
      // No sortable wire-keys yet — /api/projects returns a bare
      // { items: [] } shape today. Backend Page<T> conversion + ?sort=
      // queued as a separate slice; until then all columns render
      // non-sortable so the chevron stays hidden (no false affordance).
      // Name is the editable cell — clean text render, PATCH /projects/:rid.
      // Description / owner / company / default / cleanness / created /
      // ID are defaultHidden — opt-in via the picker.
      columns: [
        { label: "Name",        key: "name",               sortable: false, editable: true, editKey: "name" },
        { label: "Files",       key: "file_count",         sortable: false },
        { label: "Stage",       key: "stage",              sortable: false },
        { label: "Status",      key: "status",             sortable: false },
        { label: "Default",     key: "is_default",         sortable: false, defaultHidden: true },
        { label: "Owner",       key: "owner_display_name", sortable: false, defaultHidden: true },
        { label: "Company",     key: "company_id",         sortable: false, defaultHidden: true },
        { label: "Cleanness",   key: "cleanness_pct",      sortable: false, defaultHidden: true },
        { label: "Description", key: "description",        sortable: false, defaultHidden: true },
        { label: "Created",     key: "created_at",         sortable: false, defaultHidden: true },
        { label: "Updated",     key: "updated_at",         sortable: false },
        { label: "ID",          key: "redpash_id",         sortable: false, defaultHidden: true },
      ],
      // Click-through to the Workspace with the project rid pinned —
      // same pattern as charts above so the rail tab acts as a
      // launchpad into the working surface.
      row: (p) => {
        const clean = p.cleanness_pct != null ? Math.round(p.cleanness_pct) + "%" : "—";
        return '<tr class="rp-home-row--clickable"'
          + ' data-rid="' + esc(p.redpash_id || "") + '"'
          + ' data-href="#/workspace?project=' + encodeURIComponent(p.redpash_id) + '">'
          + '<td>' + esc(p.name || "(untitled)") + '</td>'
          + '<td class="is-num">' + (p.file_count != null ? p.file_count : "—") + '</td>'
          + '<td>' + stageChip(p.stage) + '</td>'
          + '<td>' + esc(p.status || "—") + '</td>'
          + '<td>' + (p.is_default ? '<i class="bi bi-check2"></i>' : '<span class="rp-meta">—</span>') + '</td>'
          + '<td>' + esc(p.owner_display_name || p.owner_id || "—") + '</td>'
          + '<td><span class="rt-mono-pill">' + esc(p.company_id || "—") + '</span></td>'
          + '<td class="is-num">' + clean + '</td>'
          + '<td class="rp-meta">' + esc((p.description || "").slice(0, 120) || "—") + '</td>'
          + '<td>' + fmtTime(p.created_at) + '</td>'
          + '<td>' + fmtTime(p.updated_at) + '</td>'
          + '<td><span class="rt-mono-pill">' + esc(p.redpash_id || "—") + '</span></td>'
          + '</tr>';
      },
    },
  };

  // ─── composite-strip twin-chart padding ──────────────────────
  // The composite-strip has 4 chart slots flanking the 2×2 KPI
  // grid. Most tabs declare only 2 real charts today; we pad
  // spec.charts to 4 by REUSING each real chart's data callback
  // with a different `kind` — so the right-side slots show the
  // same distribution as a bar / donut / etc. instead of empty
  // placeholders or fake constant data. Em 2026-05-25: "if there's
  // a donut you use the same data to create a bar lol".
  //
  // Kind swap: donut ⇄ bar, rose → donut, barH → bar, gauge stays
  // as gauge (single-number; no honest alternative). When a tab
  // declares a 3rd / 4th real chart, the twins peel off naturally.
  const TWIN_KIND_SWAP = {
    donut: "bar",
    bar:   "donut",
    barH:  "bar",
    rose:  "donut",
    pie:   "bar",
    line:  "bar",
    gauge: "gauge",
  };
  function twinChart(tabKey, slot, source) {
    return {
      id:    "rp-home-" + tabKey + "-twin-" + slot,
      title: source.title,
      kind:  TWIN_KIND_SWAP[source.kind] || source.kind,
      data:  source.data,
      ...(source.opts ? { opts: source.opts } : {}),
    };
  }
  for (const [tabKey, viewSpec] of Object.entries(LIST_VIEWS)) {
    if (!viewSpec.compositeStrip) continue;
    viewSpec.charts = viewSpec.charts || [];
    const real = viewSpec.charts.slice();
    if (real.length === 0) continue;
    while (viewSpec.charts.length < 4) {
      const source = real[viewSpec.charts.length % real.length];
      viewSpec.charts.push(twinChart(tabKey, viewSpec.charts.length, source));
    }
  }

  // ─── rail collapse — shared rail-controls helper ────────────
  mountRailCollapse(nav, app.querySelector("#rpHomeNavCollapse"));

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

  // Active tab — precedence: explicit ?tab=<key> in the hash (deep
  // link wins) → `homeActiveTab` pref (last tab the user activated
  // in any prior session) → HOME_DEFAULT_TAB. activate() coerces
  // unknown / unwired keys to the default, so a stale pref naming a
  // retired tab degrades gracefully.
  const params  = new URLSearchParams(location.hash.split("?")[1] || "");
  const wantTab = params.get("tab") || getPref("homeActiveTab") || HOME_DEFAULT_TAB;
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
    syncCreateButton(tab);
    // Persist the actually-rendered tab key (after any coercion to
    // HOME_DEFAULT_TAB for unwired requests) so the next reload lands
    // back here instead of always defaulting to Projects.
    setPref("homeActiveTab", tab.key);
  }

  // ─── rail-foot create button + generic create-modal ──────────
  // Single button repointed per active tab from the tab's createSpec
  // in LIST_VIEWS. kind:"modal" opens the generic form (#rpHomeCreateModal)
  // with the spec's fields + endpoint; kind:"route" navigates to href
  // (used by tabs where create lives elsewhere — Files = upload via
  // Workspace, Charts = designer on top of an open data file). Tabs
  // without a createSpec (memberships, org) hide the button entirely.
  // Const refs for the button + modal are captured at the top of the
  // function (next to `nav` / `navBody`) to avoid TDZ on the first
  // activate() call from the boot path.

  function syncCreateButton(tab) {
    const spec = LIST_VIEWS[tab.key]?.createSpec || null;
    activeCreateSpec = spec;
    if (!createBtn) return;
    if (!spec) {
      createBtn.hidden = true;
      return;
    }
    createBtn.hidden = false;
    if (createBtnLabel) createBtnLabel.textContent = spec.label || "New";
    if (createBtnIcon) {
      // Reset to a single class (always carry `bi`) then add the spec icon.
      createBtnIcon.className = "bi " + (spec.icon || "bi-plus-lg");
    }
    createBtn.title = spec.label || "Create";
  }

  createBtn?.addEventListener("click", () => {
    const spec = activeCreateSpec;
    if (!spec) return;
    if (spec.kind === "route" && spec.href) {
      location.hash = spec.href;
      return;
    }
    if (spec.kind === "modal") openCreateModal(spec);
  });

  // Field types supported by the generic create-modal:
  //   text / email (default)   simple <input>
  //   textarea                  multi-line <textarea>
  //   select                    <select> with options[] or optionsFn(state).
  //                             options items can be {value, label} or a
  //                             plain string (used as both).
  //   entity-picker             search-as-you-type pulling from an endpoint
  //                             (fixed `endpoint` or `endpointFn(state)`).
  //                             Result rows render via labelKey + optional
  //                             subKey; on pick the rid (ridKey) lands in
  //                             a hidden input name=<key> so the form
  //                             submit reads it like any other field.
  //
  // Field dependencies: any field can declare `dependsOn: [keys]` —
  // when a listed field changes, the dependent field is re-rendered in
  // place (preserving the rest of the form state). select.optionsFn
  // and entity-picker.endpointFn receive the current form state, so a
  // role's options can switch by scope, or a picker's endpoint by scope.

  const PICKER_ID = (key) => "rp-home-create-pick-" + key;
  const FIELD_ID  = (key) => "rp-home-create-f-"    + key;

  function readFormState() {
    const state = {};
    if (!createFields) return state;
    createFields.querySelectorAll("[data-field-key]").forEach((wrap) => {
      const key = wrap.dataset.fieldKey;
      const valEl = wrap.querySelector('[name="' + cssEsc(key) + '"]');
      state[key] = (valEl?.value || "").trim();
    });
    return state;
  }

  function normalizeOptions(opts) {
    return (opts || []).map((o) =>
      typeof o === "string" ? { value: o, label: o } : o
    );
  }

  function selectHTML(f, state, idAttr) {
    const opts = normalizeOptions(typeof f.optionsFn === "function" ? f.optionsFn(state) : f.options);
    const def  = f.default || (opts[0] && opts[0].value) || "";
    return '<select class="rp-modal-input" id="' + idAttr + '" name="' + esc(f.key) + '">'
      + opts.map((o) =>
          '<option value="' + esc(o.value) + '"' + (o.value === def ? ' selected' : '') + '>'
          + esc(o.label) + '</option>'
        ).join("")
      + '</select>';
  }

  function entityPickerHTML(f, idAttr) {
    // Reuses the .rp-user-picker atom (user-picker.css) — generic by
    // design, the comment in that file invites non-user callers. The
    // hidden input carries the picked rid for the submit; the text
    // input drives the search. A small "x" clear chip resets both.
    return ''
      + '<div class="rp-user-picker">'
      +   '<input type="hidden" name="' + esc(f.key) + '" />'
      +   '<div class="rp-user-picker-wrap">'
      +     '<input id="' + idAttr + '" type="text" autocomplete="off" '
      +       'placeholder="' + esc(f.placeholder || "Search…") + '" '
      +       'data-picker-search="1" />'
      +     '<div class="rp-user-picker-results" id="' + PICKER_ID(f.key) + '" hidden></div>'
      +   '</div>'
      + '</div>';
  }

  function inputHTML(f, idAttr) {
    const req   = f.required ? " required" : "";
    const ac    = f.autocomplete ? ' autocomplete="' + esc(f.autocomplete) + '"' : "";
    const ph    = f.placeholder ? ' placeholder="' + esc(f.placeholder) + '"' : "";
    const type  = f.type || "text";
    if (type === "textarea") {
      return '<textarea class="rp-modal-textarea" id="' + idAttr + '" '
        + 'name="' + esc(f.key) + '" rows="5"' + req + ph + '></textarea>';
    }
    return '<input class="rp-modal-input" id="' + idAttr + '" '
      + 'name="' + esc(f.key) + '" type="' + esc(type) + '"' + req + ac + ph + ' />';
  }

  function fieldHTML(f, state) {
    const idAttr = FIELD_ID(f.key);
    let ctrl;
    if (f.type === "select") {
      ctrl = selectHTML(f, state, idAttr);
    } else if (f.type === "entity-picker") {
      ctrl = entityPickerHTML(f, idAttr);
    } else {
      ctrl = inputHTML(f, idAttr);
    }
    return ''
      + '<div class="rp-modal-field" data-field-key="' + esc(f.key) + '">'
      +   '<label class="rp-modal-label" for="' + idAttr + '">' + esc(f.label) + '</label>'
      +   ctrl
      + '</div>';
  }

  // Re-render one field in place — used when a dependency changes
  // (a select.optionsFn or picker.endpointFn that closes over the
  // changed key). Re-mounts the field's own JS handlers afterwards.
  function rerenderField(spec, key) {
    if (!createFields) return;
    const wrap = createFields.querySelector('[data-field-key="' + cssEsc(key) + '"]');
    const f = (spec.fields || []).find((x) => x.key === key);
    if (!wrap || !f) return;
    const state = readFormState();
    wrap.outerHTML = fieldHTML(f, state);
    mountField(spec, f);
  }

  // Wire the per-field JS handlers — change-cascade for dependencies,
  // picker search/result-click for entity-pickers. Idempotent so a
  // re-render can call it again safely.
  let pickerTimer = null;
  function mountField(spec, f) {
    if (!createFields) return;
    const wrap = createFields.querySelector('[data-field-key="' + cssEsc(f.key) + '"]');
    if (!wrap) return;

    // Change-cascade: any field whose dependsOn list contains f.key
    // re-renders when this field changes.
    const valEl = wrap.querySelector('[name="' + cssEsc(f.key) + '"]');
    if (f.type === "select") {
      valEl?.addEventListener("change", () => {
        (spec.fields || []).forEach((dep) => {
          if (Array.isArray(dep.dependsOn) && dep.dependsOn.includes(f.key)) {
            rerenderField(spec, dep.key);
          }
        });
      });
    }

    if (f.type !== "entity-picker") return;

    // Picker: debounced search → endpoint → render results. Result
    // click sets the hidden rid + displays the picked label in the
    // search input, then closes the dropdown. Outside-click also
    // closes; first-result Enter picks.
    const searchEl  = wrap.querySelector("[data-picker-search]");
    const resultsEl = wrap.querySelector(".rp-user-picker-results");
    const hiddenEl  = wrap.querySelector('input[type="hidden"]');
    if (!searchEl || !resultsEl || !hiddenEl) return;

    const labelKey = f.labelKey || "name";
    const subKey   = f.subKey;
    const ridKey   = f.ridKey   || "redpash_id";
    const searchKey = f.searchKey || "q";

    async function runSearch(q) {
      const state    = readFormState();
      const endpoint = typeof f.endpointFn === "function"
        ? f.endpointFn(state)
        : f.endpoint;
      if (!endpoint) { resultsEl.hidden = true; return; }
      try {
        const data = await api.get(endpoint + "?" + searchKey + "=" + encodeURIComponent(q) + "&size=10");
        const rows = data?.items || data?.rows || [];
        if (!rows.length) {
          resultsEl.innerHTML = '<div class="rt-ac-empty">No matches.</div>';
        } else {
          resultsEl.innerHTML = rows.map((r) => {
            const label = r[labelKey] || r[ridKey] || "—";
            const sub   = subKey ? (r[subKey] || "") : "";
            return '<div class="rp-user-picker-result" '
              + 'data-rid="'   + esc(r[ridKey] || "") + '" '
              + 'data-label="' + esc(label) + '">'
              +   '<span class="rp-user-picker-result-name">' + esc(label) + '</span>'
              +   (sub ? '<span class="rp-user-picker-result-sub">' + esc(sub) + '</span>' : '')
              + '</div>';
          }).join("");
        }
        resultsEl.hidden = false;
      } catch (err) {
        resultsEl.innerHTML = '<div class="rt-ac-empty">Couldn’t search'
          + (err?.status ? " (" + err.status + ")" : "") + '.</div>';
        resultsEl.hidden = false;
      }
    }
    searchEl.addEventListener("input", () => {
      const q = searchEl.value.trim();
      clearTimeout(pickerTimer);
      // Clearing the search input also clears the picked rid so a
      // form re-submission without a re-pick fails validation.
      hiddenEl.value = "";
      if (!q) { resultsEl.hidden = true; resultsEl.innerHTML = ""; return; }
      pickerTimer = setTimeout(() => runSearch(q), 200);
    });
    resultsEl.addEventListener("click", (e) => {
      const item = e.target.closest("[data-rid]");
      if (!item) return;
      hiddenEl.value = item.dataset.rid;
      searchEl.value = item.dataset.label;
      resultsEl.hidden = true;
      resultsEl.innerHTML = "";
    });
  }

  function openCreateModal(spec) {
    if (!createModal || !spec) return;
    if (createTitle) createTitle.textContent = spec.title || spec.label || "Create";
    if (createFields) {
      const initState = {};
      // Seed initial state from each field's default so optionsFn /
      // endpointFn see something coherent on first render.
      (spec.fields || []).forEach((f) => {
        if (f.default !== undefined) initState[f.key] = f.default;
      });
      createFields.innerHTML = (spec.fields || []).map((f) => fieldHTML(f, initState)).join("");
      (spec.fields || []).forEach((f) => mountField(spec, f));
    }
    if (createError) { createError.hidden = true; createError.textContent = ""; }
    if (createSubmit) createSubmit.disabled = false;
    createModal.hidden = false;
    // Focus first interactive field for keyboard-first flow.
    const first = createFields?.querySelector("input, textarea, select");
    setTimeout(() => first?.focus(), 0);
  }
  function closeCreateModal() {
    if (!createModal) return;
    createModal.hidden = true;
  }

  createModal?.addEventListener("click", (e) => {
    if (e.target.closest("[data-modal-dismiss]")) {
      e.preventDefault();
      closeCreateModal();
    }
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && createModal && !createModal.hidden) {
      closeCreateModal();
    }
  });
  // Outside-click closes any open entity-picker dropdowns inside the
  // modal. Scoped via target.closest so a click inside the search
  // input or a result row doesn't trigger the close.
  document.addEventListener("click", (e) => {
    if (!createModal || createModal.hidden) return;
    if (e.target.closest(".rp-user-picker")) return;
    createFields?.querySelectorAll(".rp-user-picker-results").forEach((r) => {
      r.hidden = true;
      r.innerHTML = "";
    });
  });

  createForm?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const spec = activeCreateSpec;
    if (!spec || spec.kind !== "modal") return;
    // Build the POST body — trim each field; empty-and-not-required → omit.
    const body = {};
    let missingRequired = null;
    for (const f of spec.fields || []) {
      const el = createFields?.querySelector('[name="' + cssEsc(f.key) + '"]');
      const v  = (el?.value || "").trim();
      if (!v) {
        if (f.required) { missingRequired = f.label; break; }
        continue;
      }
      body[f.key] = v;
    }
    if (missingRequired) {
      showCreateError(missingRequired + " is required");
      return;
    }
    if (createSubmit) createSubmit.disabled = true;
    try {
      await api.post(spec.endpoint, body);
      closeCreateModal();
      // Refetch the current tab's list so the new row appears. fetchList
      // is closure-scoped to renderListBody; route through activate() on
      // the same tab to trigger a fresh render.
      const activeKey = navBody.querySelector(".rt-tab.active")?.dataset.key;
      if (activeKey) activate(activeKey);
    } catch (err) {
      const msg = err?.body?.message || err?.body?.error || err?.message || "Create failed";
      showCreateError(msg + (err?.status ? " (" + err.status + ")" : ""));
    } finally {
      if (createSubmit) createSubmit.disabled = false;
    }
  });

  function showCreateError(msg) {
    if (!createError) return;
    createError.textContent = msg;
    createError.hidden = false;
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
    const n = parseInt(getPref("rowsPerPageHome") || "", 10);
    return Number.isFinite(n) && n > 0 ? n : 25;
  }

  // Composite strip — `compositeStripHTML` is imported from
  // /scripts/list-page.js (the shared atom both Home + Monitoring
  // use). The local implementation that lived here was consolidated
  // 2026-05-25 per [[feedback-compose-atoms-dont-parallel]].

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
    // visibility; `selected` is the live set of picked rids.
    // `deleteMode` is the single-row-click-to-delete pattern (matches
    // Workspace's `.rt-table.mode-delete` — Em 2026-05-25: "delete
    // alone is not working because rows are clickable here").
    // `editMode` makes cells flagged `editable: true` in spec.columns
    // contenteditable; blur or Enter fires a sparse PATCH against
    // spec.patchEndpoint with { [editKey]: value }. All three modes
    // are mutually exclusive — entering one exits the others so the
    // row-click delegate has unambiguous intent.
    let selectMode = false;
    let deleteMode = false;
    let editMode   = false;
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
      // Delete button stays clickable in both shapes: bulk-delete when
      // selection is non-empty, otherwise toggles delete-mode (click-
      // row-to-delete). Only disabled when selectMode is on AND nothing
      // is selected — then the button has nothing to act on.
      if (delBtn) {
        if (selectMode && selected.size === 0) delBtn.setAttribute("disabled", "");
        else                                    delBtn.removeAttribute("disabled");
        // Armed tint when the bulk-delete action is ready to fire.
        delBtn.classList.toggle("armed", selectMode && selected.size > 0);
      }
    }

    function toggleSelectMode() {
      selectMode = !selectMode;
      selected.clear();
      // Mutually exclusive with deleteMode — exit it if active.
      if (selectMode && deleteMode) toggleDeleteMode(false);
      view.querySelector('.rt-mode[data-mode="select"]')?.classList.toggle("is-active", selectMode);
      decorateSelectMode();
      updateSelChip();
    }

    // Single-row click-to-delete mode. Adds .mode-delete on the table
    // so the CSS hover (red tint via table.css) lights up; the row
    // click delegate below short-circuits navigation when active.
    function toggleDeleteMode(force) {
      deleteMode = force !== undefined ? !!force : !deleteMode;
      // Mutually exclusive with selectMode.
      if (deleteMode && selectMode) {
        selectMode = false;
        selected.clear();
        view.querySelector('.rt-mode[data-mode="select"]')?.classList.remove("is-active");
        decorateSelectMode();
      }
      view.querySelector(".rt-table")?.classList.toggle("mode-delete", deleteMode);
      view.querySelector('.rt-mode[data-mode="delete"]')?.classList.toggle("is-active", deleteMode);
      updateSelChip();
    }

    async function deleteOne(rid) {
      const noun = spec.itemNoun || "item";
      if (!confirm(`Delete this ${noun}? This cannot be undone.`)) return;
      const deleteBase = spec.deleteEndpoint || spec.endpoint;
      try {
        await api.delete(deleteBase + "/" + encodeURIComponent(rid));
        logAction("Deleted " + noun + " " + rid);
        fetchList(spec, chipState);
      } catch (err) {
        console.warn("[home] single-delete failed:", err);
        alert("Delete failed.");
      }
    }

    // ── edit mode ─────────────────────────────────────────────────
    // Cells flagged in spec.columns with `editable: true` + `editKey`
    // become contenteditable while editMode is on. Blur or Enter
    // commits a sparse PATCH against spec.patchEndpoint (defaults to
    // spec.endpoint, same fallback rule as deleteEndpoint).
    function toggleEditMode(force) {
      editMode = force !== undefined ? !!force : !editMode;
      // Mutually exclusive with the other modes.
      if (editMode) {
        if (selectMode) {
          selectMode = false;
          selected.clear();
          view.querySelector('.rt-mode[data-mode="select"]')?.classList.remove("is-active");
          decorateSelectMode();
        }
        if (deleteMode) toggleDeleteMode(false);
      }
      view.querySelector(".rt-table")?.classList.toggle("mode-edit", editMode);
      view.querySelector('.rt-mode[data-mode="edit"]')?.classList.toggle("is-active", editMode);
      decorateEditMode();
      updateSelChip();
    }

    // Apply contenteditable + .editable to the right TDs based on
    // spec.columns. Stripped + re-applied on every fetchList rewrite
    // since tbody.innerHTML rewrites wholesale. Idempotent.
    //
    // 2026-05-31: pre-fix iterated `spec.columns.forEach((col, i) =>
    // tds[i + offset])` which assumes tbody TDs are in spec column
    // order. That holds at the moment of the post-fetchList paint
    // (before _applyColumnOrder reorders them) but NOT once a user has
    // dragged a column to a new position — `tds[i]` is then whichever
    // column ended up at DOM position i, NOT spec.columns[i]. On Users
    // that meant any tab with a custom reorder + edit-mode toggled
    // made the WRONG column editable (e.g. "Joined", a system date,
    // instead of "Job"). Fix: look up each editable col's CURRENT
    // position via the live thead's `data-col-key`, then index tbody at
    // that position. Requires the post-fetchList hook chain to call
    // _applyColumnOrder BEFORE _decorateEditMode so thead and tbody are
    // column-aligned when this runs.
    function decorateEditMode() {
      const tbody = view.querySelector("#rp-home-list-tbody");
      if (!tbody) return;
      // Strip first — clean slate.
      tbody.querySelectorAll("td.editable").forEach((td) => {
        td.classList.remove("editable");
        td.removeAttribute("contenteditable");
        td.removeAttribute("data-edit-key");
      });
      if (!editMode) return;
      const thead = view.querySelector(".rt-table thead tr");
      if (!thead) return;
      // Resolve each editable spec col's CURRENT position from the
      // live thead — survives any drag-reorder of the columns.
      const dataTHs = [...thead.querySelectorAll("th[data-col-key]")];
      const keyToPos = new Map(dataTHs.map((th, i) => [th.dataset.colKey, i]));
      // selectMode adds a leading .rp-list-sel column; offset accordingly.
      const offset = selectMode ? 1 : 0;
      const editableCols = (spec.columns || []).filter(
        (col) => typeof col === "object" && col.editable && col.editKey,
      );
      tbody.querySelectorAll("tr[data-rid]").forEach((tr) => {
        const tds = tr.querySelectorAll("td");
        editableCols.forEach((col) => {
          const pos = keyToPos.get(col.key);
          if (pos === undefined) return;
          const td = tds[pos + offset];
          if (!td) return;
          td.classList.add("editable");
          td.setAttribute("contenteditable", "plaintext-only");
          td.setAttribute("data-edit-key", col.editKey);
        });
      });
    }

    async function saveCellEdit(td, rid) {
      const key = td.dataset.editKey;
      if (!key) return;
      const value = td.textContent.trim();
      // Capture original for revert-on-fail; stored on the cell when it
      // gains focus so we don't need a separate map.
      const original = td.dataset.editOriginal ?? "";
      if (value === original) return; // no-op
      const patchBase = spec.patchEndpoint || spec.endpoint;
      try {
        await api.patch(patchBase + "/" + encodeURIComponent(rid), { [key]: value });
        // Successful — leave the new value in place. Refetch is optional;
        // skipping it preserves the user's edit-mode position + cursor.
        td.dataset.editOriginal = value;
        // Record for undo. Any new edit invalidates the redo stack —
        // standard linear-history behavior.
        editHistory.push({ rid, key, oldValue: original, newValue: value });
        editFuture.length = 0;
        updateUndoRedoButtons();
        logAction("Edited " + key + " of " + rid + " → \"" + value + "\"");
      } catch (err) {
        console.warn("[home] cell-edit failed:", err);
        alert("Edit failed — reverting.");
        td.textContent = original;
      }
    }

    // ── undo / redo ──────────────────────────────────────────────
    // Stacks of edit deltas; each entry is { rid, key, oldValue,
    // newValue }. Undo PATCHes oldValue, redo PATCHes newValue.
    // Per-renderListBody scope — switching tabs resets the history
    // (undo across tabs would be confusing). Delete-undo would need
    // backend soft-delete; deferred until that exists.
    const editHistory = [];
    const editFuture  = [];

    // Session action log — read-only display of every mutation the
    // user has done on this tab. Distinct from editHistory (which is
    // the undo/redo stack); the log also records deletes, undo / redo
    // events, and bulk operations. Powers the history dropdown.
    // Entries: { when: Date, label: string }.
    const actionLog = [];
    function logAction(label) {
      actionLog.push({ when: new Date(), label });
      renderHistoryDropdown();
    }
    function renderHistoryDropdown() {
      const btn = view.querySelector('[data-dd="rp-list-toolbar-history-dd"]');
      const dd  = view.querySelector("#rp-list-toolbar-history-dd");
      if (!btn || !dd) return;
      if (actionLog.length === 0) {
        btn.setAttribute("disabled", "");
        dd.innerHTML = '<div class="rt-dd-item rp-meta">No actions yet</div>';
        return;
      }
      btn.removeAttribute("disabled");
      btn.title = "Session history (" + actionLog.length + ")";
      // Show newest first, cap at 50 entries (older entries can be
      // recovered from /api/events queries via Monitoring if needed).
      const recent = actionLog.slice(-50).reverse();
      dd.innerHTML = recent.map((e) => {
        const t = e.when.toLocaleTimeString();
        return '<div class="rt-dd-item rp-meta">'
          + '<span style="opacity:0.6;margin-right:0.5rem">' + esc(t) + '</span>'
          + esc(e.label)
          + '</div>';
      }).join("");
    }

    function updateUndoRedoButtons() {
      const undoBtn = view.querySelector("#rp-list-toolbar-undo");
      const redoBtn = view.querySelector("#rp-list-toolbar-redo");
      if (undoBtn) {
        if (editHistory.length) {
          undoBtn.removeAttribute("disabled");
          undoBtn.title = "Undo last edit";
        } else {
          undoBtn.setAttribute("disabled", "");
          undoBtn.title = "Nothing to undo";
        }
      }
      if (redoBtn) {
        if (editFuture.length) {
          redoBtn.removeAttribute("disabled");
          redoBtn.title = "Redo";
        } else {
          redoBtn.setAttribute("disabled", "");
          redoBtn.title = "Nothing to redo";
        }
      }
    }

    async function undoLastEdit() {
      if (!editHistory.length) return;
      const entry = editHistory.pop();
      const patchBase = spec.patchEndpoint || spec.endpoint;
      try {
        await api.patch(
          patchBase + "/" + encodeURIComponent(entry.rid),
          { [entry.key]: entry.oldValue }
        );
        editFuture.push(entry);
        updateUndoRedoButtons();
        logAction("Undid edit of " + entry.key + " on " + entry.rid);
        fetchList(spec, chipState);
      } catch (err) {
        console.warn("[home] undo failed:", err);
        // Restore the entry so the user can try again (e.g. the row
        // might have been deleted from another tab — fetchList will
        // surface that on the next refetch).
        editHistory.push(entry);
        updateUndoRedoButtons();
        alert("Undo failed.");
      }
    }

    async function redoLastEdit() {
      if (!editFuture.length) return;
      const entry = editFuture.pop();
      const patchBase = spec.patchEndpoint || spec.endpoint;
      try {
        await api.patch(
          patchBase + "/" + encodeURIComponent(entry.rid),
          { [entry.key]: entry.newValue }
        );
        editHistory.push(entry);
        updateUndoRedoButtons();
        logAction("Redid edit of " + entry.key + " on " + entry.rid);
        fetchList(spec, chipState);
      } catch (err) {
        console.warn("[home] redo failed:", err);
        editFuture.push(entry);
        updateUndoRedoButtons();
        alert("Redo failed.");
      }
    }

    async function bulkDelete() {
      if (!selected.size) return;
      const n = selected.size;
      const noun = spec.itemNoun || "item";
      const plural = spec.itemNounPlural || (noun + "s");
      if (!confirm(`Delete ${n} ${n === 1 ? noun : plural}? This cannot be undone.`)) return;
      const rids = [...selected];
      // Fire all DELETEs in parallel — small N (selection is bounded
      // by page size, default 25). allSettled so partial failures
      // don't block the refetch. `spec.deleteEndpoint` decouples the
      // DELETE path from the list endpoint — Files/Charts list from
      // /admin/* but delete via /files/:rid + /charts/:rid.
      const deleteBase = spec.deleteEndpoint || spec.endpoint;
      const results = await Promise.allSettled(
        rids.map((rid) => api.delete(deleteBase + "/" + encodeURIComponent(rid)))
      );
      const failed = results.filter((r) => r.status === "rejected");
      if (failed.length) {
        console.warn("[home] bulk-delete: " + failed.length + " failed");
      }
      const ok = rids.length - failed.length;
      logAction(
        "Bulk-deleted " + ok + " " + (ok === 1 ? noun : plural)
          + (failed.length ? " (" + failed.length + " failed)" : "")
      );
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
    // Slice D2 — pref override. When the user has saved charts for
    // this Home tab, they REPLACE spec.charts entirely (rendered via
    // renderChart below). Each user spec carries id + title — the
    // composite/extras layout only needs those shape-light fields, so
    // the layout decision still works against the user list.
    const userPref     = getPref("homeCharts") || {};
    const userCharts   = Array.isArray(userPref[tab.key]) && userPref[tab.key].length
                            ? userPref[tab.key]
                            : null;
    const baseCharts   = userCharts
                            ? userCharts.map((c) => ({ id: c.id, title: c.title }))
                            : (spec.charts || []);
    const specCharts      = baseCharts;
    const useComposite    = spec.compositeStrip && specCharts.length >= 2;
    // Composite has 4 chart slots flanking the KPI stats grid.
    // First 4 specCharts go into the composite slots; anything
    // beyond that drops into the standard chartsStrip below.
    const compositeCharts = useComposite ? specCharts.slice(0, 4) : [];
    const extraCharts     = useComposite ? specCharts.slice(4)    : specCharts;

    view.innerHTML = ''
      + headHTML(spec.title, "")
      + (spec.chipRows || []).map((cr) => chipRowHTML(cr, chipState[cr.name])).join("")
      + (useComposite
          ? compositeStripHTML(kpiTiles, compositeCharts) + chartsStripHTML(extraCharts)
          : kpiStripHTML(kpiTiles) + chartsStripHTML(extraCharts))
      + (spec.toolbar ? listToolbarHTML(spec.toolbar) : "")
      + listPanel(spec.columns)
      + '<div class="rt-pager" id="rp-home-list-pager"></div>'
      // Hide/restore recovery host — paintHomeHiddenSection fills this
      // with a <details class="rt-hidden"> when getHomeHidden(tabKey)
      // is non-empty, else stays empty. Same atom set workspace + cases
      // use (rail.css .rt-hidden-* family). Per-tab list per Em's
      // 2026-05-28 placement call (matches workspace's tail-of-rail).
      + '<div class="rp-home-hidden-host" id="rp-home-hidden-host"></div>';

    // Stash the active tab key on the view element so the hide ×
    // delegator (wired once at home() init) can resolve which tab's
    // pref to write. paintHomeHiddenSection also reads this.
    view.dataset.activeTab = tab.key;
    // Append a no-label hide-th to the thead when this tab declares
    // hideMeta — keeps the column count aligned with the per-row
    // hideCellHTML(...) injected at fetch-render time. Skipped when
    // the tab opts out (no hideMeta).
    if (spec.hideMeta) {
      const headRow = view.querySelector(".rt-table thead tr");
      if (headRow) headRow.insertAdjacentHTML(
        "beforeend",
        '<th class="rp-home-hide-th" aria-hidden="true"></th>',
      );
    }
    // Refetch hook for the restore branch of the view-level delegator.
    // Captures spec + chipState by closure so the hidden-recovery click
    // can rerun the same fetch the activate path would.
    refetchActiveList = () => fetchList(spec, chipState);
    paintHomeHiddenSection();

    // Tear down any charts from a prior tab + mount this tab's
    // (if it declares any) against the /stats endpoint. Each tab's
    // charts share one stats fetch — small payload, three viz from
    // the same response. chipState threads through so memberships'
    // ?scope= flips the stats payload alongside the list.
    charts.dispose();
    disposeUserInstances();      // Slice D2 — user-built charts too
    function mountUserCharts(specs) {
      disposeUserInstances();
      specs.forEach((s) => {
        const el = view.querySelector('[id="' + cssEsc(s.id) + '"]');
        if (!el) return;
        renderChart(el, s)
          .then((inst) => { if (inst) userInstances.push(inst); })
          .catch((err) => console.warn("[home] user chart render failed:", s.id, err));
      });
    }
    if (userCharts) {
      mountUserCharts(userCharts);
    } else if (spec.charts && spec.charts.length) {
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
        // stay in sync with the list. User-built charts (Slice D2)
        // re-render in place; kpiX flow uses the controller as before.
        if (userCharts) {
          mountUserCharts(userCharts);
        } else if (spec.charts && spec.charts.length) {
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
      // matches the topbar omnisearch dropdown's debounce. Logged to
      // the session action log so the history dropdown shows what the
      // user searched for (Em 2026-05-25: "lol we forgot search").
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
            if (q) logAction('Searched "' + q + '"');
            else    logAction("Cleared search");
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
        setPref("rowsPerPageHome", item.dataset.rows);
        listPage = 1;
        syncRowsLabel();
        fetchList(spec, chipState);
      });

      // ── columns picker ─────────────────────────────────────────
      // Per-tab persisted set of hidden column keys. Stored under
      // localStorage `rp-cols-hidden-${tab.key}` as a JSON array.
      // applyHiddenColumns hides matching TH (by data-col-key) +
      // every body row's TD at the same column index. decorate runs
      // after every fetchList paint via the view._applyHiddenColumns
      // hook so freshly-rendered rows pick up the hide state.
      // Cache of the last fetched page — feeds the export handlers
       // (they need the raw row data, not the DOM render). Populated
       // in fetchList on success; survives across re-renders.
       let lastRows = [];
       view._setLastRows = (rows) => { lastRows = rows; };

      // Columns picker + reorder + export — shared list-page helper so
      // Home + Monitoring share one implementation (show/hide + drag-
      // reorder columns, CSV/JSON export of the current page). The
      // returned hooks re-apply hidden-column + reorder state after each
      // fetchList paint (wired via _applyHiddenColumns / _applyColumnOrder).
      const { applyHiddenColumns, applyColumnOrder } = wireListColumnsExport(view, {
        columns:    spec.columns || [],
        storageKey: tab.key,
        getRows:    () => lastRows,
        exportName: tab.key,
      });
      view._applyHiddenColumns = applyHiddenColumns;
      view._applyColumnOrder   = applyColumnOrder;

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
        logAction(listSort
          ? "Sorted by " + listSort.col + " " + listSort.dir
          : "Cleared sort");
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
        // Two shapes on click:
        //   - select-mode + selection non-empty → bulkDelete the set
        //   - otherwise                         → toggle deleteMode
        //                                          (click rows one at
        //                                           a time to delete)
        btn.title = "Delete (selected) or click-row-to-delete";
        btn.addEventListener("click", () => {
          if (selectMode && selected.size > 0) bulkDelete();
          else                                  toggleDeleteMode();
        });
      }
    }
    // Edit mode — wired when any column in spec.columns is flagged
    // editable: true. The button enables; click toggles edit-mode +
    // adds contenteditable to the flagged cells via decorateEditMode.
    const hasEditable = (spec.columns || []).some(
      (c) => typeof c === "object" && c.editable
    );
    if (hasEditable) {
      const btn = view.querySelector('.rt-mode[data-mode="edit"]');
      if (btn) {
        btn.removeAttribute("disabled");
        btn.title = "Edit mode (toggle)";
        btn.addEventListener("click", () => toggleEditMode());
      }
      // Undo / redo are scoped to edit history (PATCH old/new values).
      // Buttons stay disabled until the first edit lands; click handlers
      // are always bound. updateUndoRedoButtons enables them when their
      // respective stack is non-empty.
      view.querySelector("#rp-list-toolbar-undo")?.addEventListener("click", undoLastEdit);
      view.querySelector("#rp-list-toolbar-redo")?.addEventListener("click", redoLastEdit);
      updateUndoRedoButtons();
    }

    // Row click — four branches:
    //   editMode   → let the contenteditable cell take focus naturally
    //                (don't navigate or toggle anything)
    //   selectMode → toggle the row's checkbox
    //   deleteMode → confirm + DELETE this single row
    //   otherwise  → navigate via data-href
    // Delegated on the tbody so the binding survives every fetchList
    // re-render (tbody.innerHTML is rewritten wholesale on each fetch).
    view.querySelector("#rp-home-list-tbody")?.addEventListener("click", (e) => {
      if (editMode) {
        // Suppress navigation; let the browser focus the contenteditable.
        return;
      }
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
      if (deleteMode) {
        const tr = e.target.closest("tr[data-rid]");
        if (!tr) return;
        deleteOne(tr.dataset.rid);
        return;
      }
      const tr = e.target.closest("tr[data-href]");
      if (!tr) return;
      location.hash = tr.dataset.href.replace(/^#/, "");
    });

    // Cell-edit handlers — delegated on the tbody so they survive the
    // refetch tbody.innerHTML rewrite. focusin snapshots the original
    // value; keydown traps Enter (commit) + Esc (revert); blur commits.
    const tbodyForEdit = view.querySelector("#rp-home-list-tbody");
    tbodyForEdit?.addEventListener("focusin", (e) => {
      const td = e.target.closest("td.editable[data-edit-key]");
      if (!td) return;
      td.dataset.editOriginal = td.textContent.trim();
    });
    tbodyForEdit?.addEventListener("keydown", (e) => {
      const td = e.target.closest("td.editable[data-edit-key]");
      if (!td) return;
      if (e.key === "Enter") {
        e.preventDefault();
        td.blur();   // triggers focusout → blur → saveCellEdit
      } else if (e.key === "Escape") {
        e.preventDefault();
        td.textContent = td.dataset.editOriginal ?? "";
        td.blur();
      }
    });
    tbodyForEdit?.addEventListener("focusout", (e) => {
      const td = e.target.closest("td.editable[data-edit-key]");
      if (!td) return;
      const tr = td.closest("tr[data-rid]");
      if (!tr) return;
      saveCellEdit(td, tr.dataset.rid);
    });

    // Expose the decorate hooks to fetchList so it re-paints select
    // checkboxes + edit cells after each refetch. Stashed on the view
    // element so fetchList can call them without a closure capture.
    view._decorateSelectMode = decorateSelectMode;
    view._decorateEditMode   = decorateEditMode;

    fetchList(spec, chipState);
  }

  async function fetchList(spec, chipState) {
    setKpi("rp-home-list-total", "…");
    setKpi("rp-home-list-shown", "…");
    setKpi("rp-home-list-page",  String(listPage));
    setKpi("rp-home-list-ms",    "…");
    const tbody = view.querySelector("#rp-home-list-tbody");
    // colCount bumps by 1 when hide-mode is on so the colspan in the
    // Loading / No-rows / error states stays flush with the data rows
    // (which gain a hideCellHTML at fetch-render time).
    const colCount = spec.columns.length + (spec.hideMeta ? 1 : 0);
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
      // Cache the raw rows so the export handlers can serialize them
      // without re-parsing the DOM. Hook is set in renderListBody.
      if (typeof view._setLastRows === "function") view._setLastRows(rows);
      const elapsed = Math.round(performance.now() - t0);
      setKpi("rp-home-list-total", fmtCount(total));
      setKpi("rp-home-list-shown", String(rows.length));
      setKpi("rp-home-list-page",  listPage + " / " + listTotalPages);
      setKpi("rp-home-list-ms",    elapsed + "ms");
      view.querySelector(".rp-shell-head-count").textContent = total + " rows";
      if (tbody) {
        // Invariant 1: filter at render-time, not at fetch-time. The
        // server returned the full page; the hidden set is applied
        // here before tbody-render. The per-row hide × cell is
        // injected just before the row's closing </tr> so spec.row()
        // doesn't need to know about hide/restore.
        const tabKey = view.dataset.activeTab || "";
        const visible = applyHomeHiddenFilter(spec, tabKey, rows);
        tbody.innerHTML = visible.length
          ? visible.map((item) => {
              const html = spec.row(item);
              if (!spec.hideMeta) return html;
              const meta = spec.hideMeta(item);
              if (!meta || !meta.rid) return html;
              const cell = '<td class="rp-home-hide-cell">'
                + '<span class="rt-tab-close rp-home-hide" '
                +   'data-hide-rid="'  + esc(meta.rid)        + '" '
                +   'data-hide-name="' + esc(meta.name || "") + '" '
                +   'data-hide-sub="'  + esc(meta.sub  || "") + '" '
                +   'title="Hide from list"><i class="bi bi-x"></i></span>'
                + '</td>';
              return html.replace(/<\/tr>\s*$/, cell + '</tr>');
            }).join("")
          : '<tr><td colspan="' + colCount + '">No rows.</td></tr>';
      }
      // Re-paint mode-dependent cell decorations after the tbody
      // rewrite. The hooks are set up in renderListBody when the
      // active tab's spec declares the relevant modes; absent on
      // other tabs (no-op).
      //
      // Order matters here:
      //   1. _decorateSelectMode  — inserts the leading .rp-list-sel
      //      sentinel cells so subsequent passes see them as
      //      framing-only columns to preserve.
      //   2. _applyColumnOrder    — reorders data THs and data TDs to
      //      the user's persisted target order. Anchors data inserts
      //      before any trailing sentinel TH (.rp-home-hide-th) so
      //      that stays at the right edge.
      //   3. _applyHiddenColumns  — positionally indexes tbody by TH
      //      position, so thead + tbody must be column-aligned first.
      //   4. _decorateEditMode    — looks up each editable col's
      //      current DOM position via the live thead and tags the
      //      matching tbody TD. Requires thead and tbody to be
      //      column-aligned (which step 2 ensures), otherwise the
      //      `.editable` class lands on the wrong column — pre-2026-
      //      05-31 it tagged whatever column happened to land at the
      //      spec's editable index after the user's drag-reorder
      //      (e.g. "Joined" instead of "Job" on Users).
      if (typeof view._decorateSelectMode === "function") {
        view._decorateSelectMode();
      }
      if (typeof view._applyColumnOrder === "function") {
        view._applyColumnOrder();
      }
      if (typeof view._applyHiddenColumns === "function") {
        view._applyHiddenColumns();
      }
      if (typeof view._decorateEditMode === "function") {
        view._decorateEditMode();
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
  // .rt-mono-pill base + .rt-tone--{low,mid,high} for tone, so the
  // visual vocabulary stays consistent with /monitoring.
  function roleChip(role) {
    const v = String(role || "").toLowerCase();
    const tone = v === "owner" ? "rt-tone--high"
              : v === "admin" || v === "collaborator" ? "rt-tone--mid"
              : v === "member" || v === "viewer" ? "rt-tone--low"
              : "";
    return '<span class="rt-mono-pill ' + tone + '">' + esc(role || "—") + '</span>';
  }
  function stageChip(stage) {
    const v = String(stage || "").toLowerCase();
    const tone = v === "publish" ? "rt-tone--low"
              : v === "design"   ? "rt-tone--mid"
              : v === "clean"    ? "rt-tone--mid"
              : "";
    return '<span class="rt-mono-pill ' + tone + '">' + esc(stage || "—") + '</span>';
  }
  function planChip(plan) {
    const v = String(plan || "").toLowerCase();
    const tone = v === "free" ? "" : "rt-tone--low";
    return '<span class="rt-mono-pill ' + tone + '">' + esc(plan || "—") + '</span>';
  }
  // Cases status — flow: backlog → todo → in_progress → in_review → done.
  // Mid-flow states (in_progress / in_review) get the warmer tone; the
  // terminal `done` gets low (cool/green-ish vibe via the chip token).
  function caseStatusChip(status) {
    const v = String(status || "").toLowerCase();
    const tone = v === "in_progress" || v === "in_review" ? "rt-tone--mid"
              : v === "todo"        ? "rt-tone--low"
              : "";
    return '<span class="rt-mono-pill ' + tone + '">' + esc(status || "—") + '</span>';
  }
  // Cases priority — low / medium / high / critical. Tone scales with
  // urgency; medium gets no tone (it's the default + most rows).
  function priorityChip(priority) {
    const v = String(priority || "").toLowerCase();
    const tone = v === "critical" ? "rt-tone--high"
              : v === "high"     ? "rt-tone--mid"
              : v === "low"      ? "rt-tone--low"
              : "";
    return '<span class="rt-mono-pill ' + tone + '">' + esc(priority || "—") + '</span>';
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

