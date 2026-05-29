// Workspace page — the redtable as a browser, wired to /api.
//
// On mount: load real projects + lazy-load files per group. A file
// click fetches /api/files/:rid (columns) + /api/files/:rid/page
// (?page=N&size=M) and renders. The toolbar (search, sort, select /
// edit / delete, columns dropdown, filter builder) operates on the
// loaded page; column-indexed state (sort keys, filter, cols vis)
// resets per file. Rows-per-page + pager buttons refetch the page
// server-side via PageQuery.
//
// What's still stubbed: server-side filter+sort (still page-local for
// now — that's WS#2), and saving cell-edits / row-deletes back to the
// server (cell / row modes are visual only). Tools panel + refresh
// are wired.

import { api } from "/scripts/api.js";
import { mountTopbar } from "/scripts/topbar.js";
import { mountRailFooterNav } from "/scripts/rail-footer.js";
import { mountRailCollapse, mountRailSeg } from "/scripts/rail-controls.js";
import { mountTools } from "/scripts/tools.js";
import { mountJoins } from "/scripts/joins.js";
import { mountReport } from "/scripts/report.js";
import { attachAutocomplete, mountChipPicker } from "/scripts/autocomplete.js";
import { invalidateFile as invalidateColumnIndex } from "/scripts/column-index.js";
import { mountDesigner } from "/scripts/designer.js";
import { getEngine } from "/scripts/wasm-engine.js";
import { getPref, setPref } from "/scripts/prefs.js";
import { heroStripHTML, createListCharts } from "/scripts/list-page.js";
import { esc, cssEsc } from "/scripts/dom.js";

// Stage labels mirror backend's file_stages view (migration 022,
// 2026-06-05). Renamed from `import|report` to `new|design` — same
// vocabulary home.js uses; keep this in sync.
const STAGE_DOT     = { new: "is-dirty", clean: "is-warn", design: "is-clean", publish: "is-clean" };
const MARK_COLORS   = ["blue", "mauve", "teal", "peach"];
const DATE_DTYPES   = new Set(["date"]);
const DEFAULT_PAGE_SIZE = 25;

export default function workspace(app, { session }) {
  const $  = (s) => app.querySelector(s);
  const $$ = (s) => Array.from(app.querySelectorAll(s));

  // Caller identity — drives the Personal/Shared ownership split in the
  // rail filter (owner_id === me ⇒ personal, else shared).
  const meRid = session?.redpash_id || "";

  mountTopbar($("#rp-topbar"), { active: "workspace", session });
  mountRailFooterNav($(".rt-nav-foot"), { active: "", session });

  // Warm the wasm engine cache — the user is on the workspace, they're
  // going to do data work, so trigger the lazy fetch now and await
  // later from whichever surface needs it. Fire-and-forget: any load
  // error stays silent until a real call happens (then surfaces there).
  getEngine().catch(() => { /* lazy-loader error path; ignored on warm-up */ });

  // ─── element refs ──────────────────────────────────────────────
  const nav        = $("#wsNav");
  const navBody    = $("#wsNavBody");
  const table      = $("#wsTable");
  const thead      = table.tHead;
  const tbody      = table.tBodies[0];
  const tableState = $("#wsTableState");
  const colsDd     = $("#wsColsDd");
  const rowsInfo   = $("#wsRowsInfo");
  const selChip    = $("#wsSelChip");
  const selCount   = $("#wsSelCount");
  const deleteBtn  = app.querySelector('.rt-mode[data-mode="delete"]');
  const groupList  = $("#wsGroupList");

  // ─── state ─────────────────────────────────────────────────────
  let activeFileRid = null;
  let activeColumns = [];   // ColumnMeta[] for the open file
  let activeSteps   = [];   // ProjectStep[] — drives undo/redo enable
  let activeSummary = null; // FileSummary — drives per-tool context renderers
  // The project the user is currently focused on — independent of which
  // file (if any) is open. Updates on group-head click, on file open
  // (inherits the file's project), and on the initial deep-link expand.
  // Read by activeProjectRid / activeProjectName so the rail-foot
  // buttons (Upload, New chart, New dashboard, + New project) target
  // the visible project even when the user clicked a group head
  // without opening a file inside it.
  let focusedProjectRid = null;
  let groupColorIdx = 0;
  let sortKeys      = [];   // [{ col, dir, isDate }] — col is display-column-index (≥3)
  let searchQ       = "";
  let activeFilter  = null; // FilterNode tree (see shared::filter::FilterNode) — null = no filter
  let searchDebounce = null;
  // Rail filter state — both ephemeral per visit (no pref): a deep-link
  // into a project must never be hidden by a stale persisted filter.
  // ownerFilter ∈ {all, personal, shared, company}; railSearchQ matches
  // project names. applyRailFilters toggles group visibility on change.
  let ownerFilter      = "all";
  let railSearchQ      = "";
  let railSearchDebounce = null;
  let cachedProjects   = []; // last /projects roster — feeds the landing surface
  let toolsCtrl     = null; // mountTools' control surface — refresh() rebuilds the open form / columns view
  let joinsCtrl     = null; // mountJoins' control surface — refresh() re-fetches sibling candidates
  let reportCtrl    = null; // mountReport's control surface — refresh() rebuilds the open builder
  let designerCtrl  = null; // mountDesigner — load(chart) when a chart-typed file opens
  let sourceCache   = { rid: null, columns: [] }; // last data file the user opened — drives "+ New chart" + designer source
  // Project's data files (file_type ∉ {chart, dashboard}), as
  // [{rid, name}] — feeds the designer's source-file dropdown so a tile
  // can be re-pointed at any data file in the same project. Refreshed
  // (ensureProjectSourceFiles) whenever a chart/dashboard/data file
  // opens; the designer reads it synchronously via getSourceFiles.
  let projectSourceFiles = { projRid: null, files: [] };

  // Per-rid envelope cache — populated by prewarmGroupFiles after a
  // project group's file list renders (idle-time background fetches)
  // and consulted by loadFile so subsequent clicks are instant. The
  // entry shape matches GET /api/files/:rid: { summary, columns, steps }.
  // Refreshed on every loadFile call so steps/columns reflect the latest
  // server state even when the user's been mutating the file mid-session.
  // Charts (CHT_-prefix) skip the prewarm — they go through /api/charts
  // which has a different shape; their cost is already lower (no /page
  // round-trip), and prewarming a chart spec is wasted bandwidth.
  const fileEnvelopeCache = new Map();

  // Filter ops — canonical FilterOp on the wire (shared::filter::FilterOp).
  // OP_SPECS drives three things at render time:
  //   1. Which ops show in the dropdown for a given column's dtype.
  //   2. How the dropdown groups them (<optgroup> labels match `group`).
  //   3. What value control(s) the predicate row renders (text / number /
  //      date / two-input range / comma-separated list / no value).
  // The dropdown stores the wire op directly in <option value>, so there's
  // no UI-key → wire-op indirection — predToLeaf reads .value as-is.
  const STR_DTYPES_FILTER  = ["string", "empty"];
  const NUM_DTYPES_FILTER  = ["int", "float"];
  const DATE_DTYPES_FILTER = ["date"];
  const ALL_DTYPES_FILTER  = ["string", "int", "float", "date", "bool", "empty"];
  const ORDERED_DTYPES     = ["int", "float", "date"];   // ops that need an ordering
  const OP_SPECS = [
    // [wire-op, label, group, applicable-dtypes, value-kind]
    ["eq",           "is",                "Equality",   ALL_DTYPES_FILTER, "text"],
    ["neq",          "is not",            "Equality",   ALL_DTYPES_FILTER, "text"],
    ["contains",     "contains",          "Text",       STR_DTYPES_FILTER, "text"],
    ["not_contains", "does not contain",  "Text",       STR_DTYPES_FILTER, "text"],
    ["starts_with",  "starts with",       "Text",       STR_DTYPES_FILTER, "text"],
    ["ends_with",    "ends with",         "Text",       STR_DTYPES_FILTER, "text"],
    ["gt",           "> greater than",    "Comparison", NUM_DTYPES_FILTER, "number"],
    ["gte",          "≥ at least",        "Comparison", NUM_DTYPES_FILTER, "number"],
    ["lt",           "< less than",       "Comparison", NUM_DTYPES_FILTER, "number"],
    ["lte",          "≤ at most",         "Comparison", NUM_DTYPES_FILTER, "number"],
    ["between",      "between",           "Range",      ORDERED_DTYPES,    "range"],
    ["before",       "before",            "Range",      DATE_DTYPES_FILTER, "date"],
    ["after",        "after",             "Range",      DATE_DTYPES_FILTER, "date"],
    ["in",           "in (any of)",       "Set",        ALL_DTYPES_FILTER, "list"],
    ["not_in",       "not in",            "Set",        ALL_DTYPES_FILTER, "list"],
    ["is_null",      "is empty",          "Presence",   ALL_DTYPES_FILTER, "none"],
    ["not_null",     "is not empty",      "Presence",   ALL_DTYPES_FILTER, "none"],
  ];
  const OP_BY_WIRE = Object.fromEntries(OP_SPECS.map((s) => [s[0], { label: s[1], group: s[2], dtypes: s[3], value: s[4] }]));
  // Ops that don't carry a value (server ignores .value for these).
  const NULL_OPS = new Set(["is_null", "not_null"]);
  // value-kind for a (op, column) combo — used to pick the right input
  // for `between` (numeric vs date) and date-typed eq/neq (uses a
  // calendar picker rather than free text).
  function valueKindFor(op, meta) {
    const spec = OP_BY_WIRE[op];
    if (!spec) return "text";
    if (spec.value === "range") return DATE_DTYPES_FILTER.includes(colDtype(meta)) ? "range-date" : "range-number";
    if (spec.value === "text" && DATE_DTYPES_FILTER.includes(colDtype(meta))) return "date";
    return spec.value;
  }
  // Storage dtype with the empty-as-string promotion `data::stats` does
  // for un-typed columns. `semantic_dtype` is the user-promised type;
  // fall back to storage `dtype` for older rows.
  function colDtype(meta) {
    if (!meta) return "string";
    return meta.semantic_dtype || meta.dtype || "string";
  }
  // The ops applicable to a column — used both at render and at every
  // column-change to re-shape the op <select>.
  function opsForColumn(meta) {
    const dtype = colDtype(meta);
    return OP_SPECS.filter((s) => s[3].includes(dtype));
  }
  let groupCombo    = "AND";
  let filterCols    = [];   // [[colIndex, name], ...] for the filter builder
  let currentPage   = 1;    // 1-indexed page (matches Page<T>.page on the wire)
  let pageSize      = pageSizeFromPref();
  let totalPages    = 1;    // last response's Page<T>.pages — drives the pager render
  let rowIndices    = [];   // absolute row idx in the underlying frame, per displayed row
  let stepInFlight  = false;

  // The wire-level pref ("10" / "25" / "50" / "100" / "all") into the
  // numeric pageSize the fetch uses.
  function pageSizeFromPref() {
    const n = parseInt(getPref("rowsPerPageWorkspace") || "", 10);
    return Number.isFinite(n) && n > 0 ? n : DEFAULT_PAGE_SIZE;
  }

  // ─── rail — collapse + view switcher (shared rail-controls) ────
  mountRailCollapse(nav, $("#wsNavCollapse"));

  // View switcher (Data ↔ Dashboards) — the active view is a data
  // attribute on the rail; CSS hides the file rows that don't belong
  // (no refetch — every project group already renders all its file
  // kinds). fireOnMount so the filter attr applies on load. The
  // returned `set` is used after create flows (upload → data, new
  // dashboard → dashboards) so a freshly-created row isn't hidden by
  // the current filter.
  const railViewSeg = mountRailSeg($("#wsRailView"), {
    pref:        "workspaceRailView",
    fallback:    "data",
    fireOnMount: true,
    onChange:    (view) => { nav.dataset.railView = view; },
  });
  const setRailView = (view) => railViewSeg.set(view);

  // ─── rail filter — project-name search + ownership pills ───────
  // Both are pure visibility filters (applyRailFilters); they never
  // refetch or touch the data source. Search is debounced; the pills
  // are single-select with an "All" reset. Mirrors the Cases rail
  // filter so the two data-item rails align.
  const railSearchInput = $("#wsRailSearch");
  railSearchInput?.addEventListener("input", () => {
    clearTimeout(railSearchDebounce);
    railSearchDebounce = setTimeout(() => {
      railSearchQ = railSearchInput.value;
      applyRailFilters();
    }, 150);
  });
  const ownerFilterEl = $("#wsOwnerFilter");
  ownerFilterEl?.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-owner]");
    if (!btn || btn.dataset.owner === ownerFilter) return;
    ownerFilter = btn.dataset.owner;
    ownerFilterEl.querySelectorAll(".rp-chip").forEach((b) =>
      b.classList.toggle("is-active", b === btn));
    applyRailFilters();
  });

  // Landing click → open that project. Both the recent cards (row 2)
  // and the projects-table rows (row 3) carry data-rid. Delegated; the
  // container persists across renderLanding rebuilds.
  $("#wsLanding")?.addEventListener("click", (e) => {
    const item = e.target.closest(".ws-landing-card, .ws-landing-row");
    if (item?.dataset.rid) openProjectFromLanding(item.dataset.rid);
  });

  // ─── upload — POST /api/files/upload (multipart), N at a time ──
  // Files picked from #wsUploadInput → uploaded sequentially into the
  // project of the currently-active file (or default when nothing's
  // open). Sequential (not parallel) so the user sees per-file progress
  // ("Uploading 2 of 5…") and the server doesn't get a request burst.
  // After the batch finishes, refresh the rail once + auto-open the
  // last successful upload (most-recent = natural focus). Individual
  // failures don't abort the batch — they're collected and reported
  // at the end alongside the success count.
  const uploadInput = $("#wsUploadInput");
  const uploadBtn   = $("#wsUpload");
  uploadBtn.addEventListener("click", () => uploadInput.click());
  uploadInput.addEventListener("change", async (e) => {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;
    await doUpload(files);
    uploadInput.value = "";  // reset so re-picking the same file fires change
  });

  async function doUpload(files) {
    const targetProject = activeProjectName();
    const total = files.length;
    const labelEl = uploadBtn.querySelector("span");
    const originalLabel = labelEl?.textContent;

    uploadBtn.disabled = true;
    uploadBtn.classList.add("is-busy");

    // Ghost tabs land in whichever group the upload will hit — focused
    // project if set, else the default group. Expanded + loaded so the
    // user actually sees them appear. Sequential processing means one
    // ghost is "active" (shimmering) at a time; the rest sit waiting.
    const ghostGroup = await ensureUploadGhostGroup();
    const ghosts = files.map((f) => createGhostTab(ghostGroup, f.name));

    let succeeded   = 0;
    let lastEnv     = null;
    const failures  = [];

    for (let i = 0; i < total; i++) {
      const file = files[i];
      const ghost = ghosts[i];
      ghost?.classList.add("rt-tab-ghost-active");
      if (labelEl) {
        labelEl.textContent = total === 1
          ? "Uploading…"
          : "Uploading " + (i + 1) + " of " + total + "…";
      }
      const fd = new FormData();
      fd.append("file", file);
      if (targetProject) fd.append("project_name", targetProject);
      try {
        // FormData → api.js skips JSON encoding (sees the instance type).
        const env = await api.post("/files/upload", fd);
        if (!env?.summary?.redpash_id) {
          throw new Error("upload succeeded but the server returned no file id");
        }
        lastEnv = env;
        succeeded++;
        // Briefly flash success before the rail refresh wipes the ghost.
        ghost?.classList.remove("rt-tab-ghost-active");
        ghost?.classList.add("rt-tab-ghost-done");
      } catch (err) {
        const msg = err?.body?.message || err?.body?.error || err?.message || "upload failed";
        failures.push({ name: file.name, msg, status: err?.status });
        if (ghost) {
          ghost.classList.remove("rt-tab-ghost-active");
          ghost.classList.add("rt-tab-ghost-failed");
          ghost.setAttribute("title", msg);
          // Linger long enough for the user to read the cause, then go.
          setTimeout(() => ghost.remove(), 6000);
        }
      }
    }

    // Rail-side refresh: once at the end, opening the last successful
    // upload. Skips when every file failed (nothing to open).
    if (lastEnv) {
      const newRid  = lastEnv.summary.redpash_id;
      const projRid = lastEnv.summary.project_redpash_id;
      // Uploads are data files — surface the rail's Data view so the
      // freshly-uploaded row isn't hidden behind the Dashboards filter.
      setRailView("data");
      await refreshAndOpen(newRid, projRid);
    }

    // Status line summary — leans on rowsInfo since the upload toast
    // path is via the workspace footer status text. Three shapes:
    // all-failed / mixed / all-succeeded-but-multi. Single-file +
    // single-success leaves the file-opened status alone (loadFile
    // sets rowsInfo to the active file's "X rows · Y cols" string).
    if (failures.length && succeeded === 0) {
      const first = failures[0];
      rowsInfo.textContent = total === 1
        ? first.msg + (first.status ? " (" + first.status + ")" : "")
        : "All " + total + " uploads failed — first: " + first.name + " · " + first.msg;
    } else if (failures.length) {
      rowsInfo.textContent = "Uploaded " + succeeded + " of " + total
        + "; failed: " + failures.map((f) => f.name).join(", ");
    } else if (total > 1) {
      rowsInfo.textContent = "Uploaded " + total + " files.";
    }

    uploadBtn.disabled = false;
    uploadBtn.classList.remove("is-busy");
    if (labelEl && originalLabel) labelEl.textContent = originalLabel;
  }

  // The .rt-group node for the user's current project focus, or null.
  // Prefers the explicit focusedProjectRid (set on group-head click +
  // file-open) over the active-file's parent group. Both rail-foot
  // resolvers (activeProjectName for upload, activeProjectRid for
  // dashboard / chart / new-project) read from this so they target
  // the visible project even when no file is open inside it.
  function focusedProjectGroup() {
    if (focusedProjectRid) {
      const g = navBody.querySelector('.rt-group[data-rid="' + cssEsc(focusedProjectRid) + '"]');
      if (g) return g;
    }
    // Fall back to the active-file's group when focus hasn't been
    // explicitly set (e.g. brand-new session before any group click).
    const activeTab = navBody.querySelector(".rt-tab.active");
    if (activeTab) return activeTab.closest(".rt-group");
    return null;
  }

  // The project name of the focused project (or active file's project
  // when focus is unset). Sent as ?project_name= so uploads route to
  // the visible project (find-or-create). Returns null when there's
  // no project context → server uses the user's default project.
  function activeProjectName() {
    return focusedProjectGroup()?.querySelector(".rt-group-name")?.textContent?.trim() || null;
  }

  // Resolve the rail group the upload will land in (focused project,
  // or the default group as fallback) and make sure it's expanded +
  // its file body is loaded. Ghost tabs go inside `.rt-group-body`, so
  // a collapsed/empty body means the user wouldn't actually see them.
  async function ensureUploadGhostGroup() {
    const group = focusedProjectGroup()
      || navBody.querySelector('.rt-group[data-default="1"]')
      || navBody.querySelector('.rt-group');
    if (!group) return null;
    if (!group.classList.contains("expanded")) {
      group.classList.add("expanded");
      await loadFilesForGroup(group);
    }
    return group;
  }

  // Insert a placeholder tab into a group's body for an in-flight
  // upload. The ghost shows the filename + a spinner; CSS classes
  // (`rt-tab-ghost-active` / `done` / `failed`) drive the state
  // animation. Returns the node so doUpload can flip its state per
  // outcome; null when no group was resolvable (caller no-ops).
  function createGhostTab(group, filename) {
    if (!group) return null;
    const body = group.querySelector(".rt-group-body");
    if (!body) return null;
    // "No files yet" placeholder gets replaced — the ghost IS a file
    // (from the user's perspective) and the empty-state caption would
    // contradict that.
    const emptyState = body.querySelector(".rt-nav-state");
    if (emptyState) emptyState.remove();
    const ghost = document.createElement("div");
    ghost.className = "rt-tab rt-tab-ghost";
    ghost.setAttribute("aria-busy", "true");
    ghost.innerHTML = '<i class="bi bi-arrow-up-circle rt-tab-icon"></i>'
      + '<span class="rt-tab-name">' + esc(filename) + '</span>'
      + '<span class="rt-tab-spinner" aria-hidden="true"></span>';
    body.appendChild(ghost);
    return ghost;
  }

  async function refreshAndOpen(newRid, projRid) {
    // Claim activeFileRid up front so loadProjects' default-group
    // auto-open (gated on `!activeFileRid`) skips — otherwise it
    // would race against our target file and the table could flicker
    // through the wrong content first.
    activeFileRid = newRid;
    await loadProjects();
    const group = projRid && navBody.querySelector('.rt-group[data-rid="' + cssEsc(projRid) + '"]');
    if (!group) { activeFileRid = null; loadFile(newRid); return; }
    group.classList.add("expanded");
    await loadFilesForGroup(group);
    const newTab = group.querySelector('.rt-tab[data-rid="' + cssEsc(newRid) + '"]');
    if (newTab) {
      navBody.querySelectorAll(".rt-tab.active").forEach((t) => t.classList.remove("active"));
      newTab.classList.add("active");
    }
    activeFileRid = null;  // clear so loadFile's "same-rid" early-return doesn't fire
    loadFile(newRid);
  }

  // ─── rail — load projects + lazy files ─────────────────────────
  loadProjects();

  // Rail hide/restore — per-user, persisted via `user_preferences`
  // (unregistered prefs path; `setPref` does the PATCH /api/me/prefs
  // write-through, `getPref` reads the cached value). Each list is
  // [{rid, name, project?}] so the recovery UI can label entries
  // without re-fetching the server-side metadata. Hiding a project
  // implicitly hides its files (the group disappears); restoring a
  // project brings back its files minus any individually-hidden ones.
  const HIDDEN_PROJECTS_KEY = "rail_hidden_projects";
  const HIDDEN_FILES_KEY    = "rail_hidden_files";

  function getHidden(key) {
    const list = getPref(key);
    return Array.isArray(list) ? list : [];
  }
  function hideOne(key, entry) {
    const list = getHidden(key);
    if (list.some((x) => x.rid === entry.rid)) return;
    list.push(entry);
    setPref(key, list);
  }
  function unhideOne(key, rid) {
    setPref(key, getHidden(key).filter((x) => x.rid !== rid));
  }

  async function loadProjects() {
    try {
      const data = await api.get("/projects");
      cachedProjects = data?.items || [];
      renderRail(cachedProjects);
    } catch (err) {
      navBody.setAttribute("aria-busy", "false");
      navBody.innerHTML = '<div class="rt-nav-state">Couldn’t load projects'
        + (err.status ? " (" + err.status + ")" : "") + ".</div>";
    }
  }

  function renderRail(items) {
    navBody.setAttribute("aria-busy", "false");
    const hiddenProjects = getHidden(HIDDEN_PROJECTS_KEY);
    const hiddenFiles    = getHidden(HIDDEN_FILES_KEY);
    const hiddenProjSet  = new Set(hiddenProjects.map((x) => x.rid));
    const visible        = items.filter((p) => !hiddenProjSet.has(p.redpash_id));
    if (!visible.length && !hiddenProjects.length && !hiddenFiles.length) {
      navBody.innerHTML = '<div class="rt-nav-state">No projects yet.</div>';
      // No projects + no file open → land on the (empty) overview rather
      // than the bare "open a file" table prompt, so a brand-new user
      // gets the upload nudge.
      if (!activeFileRid) showLanding();
      return;
    }
    let html = landingTabHTML() + visible.map(projectGroup).join("");
    if (hiddenProjects.length || hiddenFiles.length) {
      html += renderHiddenSection(hiddenProjects, hiddenFiles);
    }
    navBody.innerHTML = html;
    // Deep-link via #/workspace?project=<rid>&file=<rid>. A deep-link
    // (project and/or file) auto-opens into the surface — Home uses it
    // to land the user on a specific chart/csv. A BARE #/workspace lands
    // on the overview (showLanding) instead of auto-opening a file, so
    // the rail expands the default project for context but the main area
    // shows the landing — the Workspace twin of the Cases board.
    const params   = new URLSearchParams(location.hash.split("?")[1] || "");
    const wantRid  = params.get("project");
    const wantFile = params.get("file");
    const hasDeepLink = !!(wantRid || wantFile);
    const first = (wantRid && navBody.querySelector('.rt-group[data-rid="' + cssEsc(wantRid) + '"]'))
               || navBody.querySelector('.rt-group[data-default="1"]')
               || navBody.querySelector(".rt-group");
    if (first) {
      // data-autoopen (deep-link only) is the auto-open trigger now —
      // distinct from data-default (the is_default project), so a bare
      // load expands the default group's rail without opening a file.
      // A file deep-link stashes the wanted rid for loadFilesForGroup.
      if (hasDeepLink) first.dataset.autoopen = "1";
      if (wantFile) first.dataset.wantFile = wantFile;
      first.classList.add("expanded");
      // Seed project focus with the deep-link / default / first group so
      // a brand-new session targets the visible project without needing
      // a head-click first.
      if (!focusedProjectRid) focusedProjectRid = first.dataset.rid || null;
      loadFilesForGroup(first);
    }
    // Bare load (no deep-link, nothing already open) → the landing.
    if (!hasDeepLink && !activeFileRid) showLanding();
    // Apply the active rail filters to the freshly-rendered groups —
    // re-renders (hide/restore, deep-link) re-assert the current search
    // + ownership selection without a refetch.
    applyRailFilters();
  }

  // Render-time visibility filter over the project groups — toggles
  // each group's `hidden` (cheap, preserves expand + loaded files) by
  // ANDing the ownership pill against the name search. The hidden
  // recovery <details> + an injected empty-state are left untouched
  // (they aren't .rt-group). Never touches the data source.
  function applyRailFilters() {
    const q = railSearchQ.trim().toLowerCase();
    const groups = navBody.querySelectorAll(".rt-group");
    let anyVisible = false;
    groups.forEach((g) => {
      const tokens   = (g.dataset.ownership || "").split(/\s+/).filter(Boolean);
      const ownerOk  = ownerFilter === "all" || tokens.includes(ownerFilter);
      const name     = (g.querySelector(".rt-group-name")?.textContent || "").toLowerCase();
      const searchOk = !q || name.includes(q);
      const show     = ownerOk && searchOk;
      g.hidden = !show;
      if (show) anyVisible = true;
    });
    // Empty-state — only when projects exist but the filter hides them all.
    let empty = navBody.querySelector("#wsRailNoMatch");
    const needEmpty = groups.length > 0 && !anyVisible;
    if (needEmpty && !empty) {
      empty = document.createElement("div");
      empty.id = "wsRailNoMatch";
      empty.className = "rt-nav-state";
      navBody.appendChild(empty);
    }
    if (empty) {
      empty.textContent = q ? "No projects match “" + railSearchQ.trim() + "”."
                            : "No projects in this filter.";
      empty.hidden = !needEmpty;
    }
  }

  // ─── landing surface — the default overview (no file open) ─────
  // A third surface mode alongside data + designer: .is-landing-mode on
  // #wsSurface (workspace.css) hides the toolbars / body / pager and
  // shows #wsLanding. The Workspace twin of the Cases board — recent
  // projects + a stats strip. Opening any file (rail click or a landing
  // card) calls hideLanding() and takes over the surface.
  // Pinned "Overview" rail entry — the Workspace twin of Cases' Board
  // pseudo-tab. Active reflects the current surface mode so a rail
  // rebuild paints it correctly.
  function landingTabHTML() {
    const active = $("#wsSurface")?.classList.contains("is-landing-mode") ? " active" : "";
    return '<button class="rt-tab rt-rail-pinned' + active + '" type="button" data-rail-landing>'
      +   '<i class="rt-tab-icon bi bi-grid-1x2-fill"></i>'
      +   '<span class="rt-tab-name">Overview</span>'
      + '</button>';
  }
  function setLandingTabActive(on) {
    const tab = navBody.querySelector("[data-rail-landing]");
    if (on) navBody.querySelectorAll(".rt-tab.active").forEach((t) => t.classList.remove("active"));
    tab?.classList.toggle("active", on);
  }
  // Explicit return-to-overview (the Overview rail click). Drops the
  // open file so re-clicking its tab re-opens it (loadFile early-returns
  // on the same rid), then shows the landing.
  function goToLanding() {
    activeFileRid = null;
    showLanding();
  }
  function showLanding() {
    const surface = $("#wsSurface");
    surface.classList.remove("is-designer-mode");
    surface.classList.add("is-landing-mode");
    renderLanding();
    setLandingTabActive(true);
  }
  function hideLanding() {
    $("#wsSurface").classList.remove("is-landing-mode");
    setLandingTabActive(false);
  }
  // Hero charts (Em 2026-05-29) — by-stage donut + avg-cleanness gauge,
  // derived client-side from the projects roster already in hand (no
  // refetch) via the shared createListCharts pipeline.
  const WS_OV_CHARTS = [
    { id: "rp-ws-ov-stage", title: "By stage", kind: "donut",
      data: (s) => (s.items || []).reduce((a, p) => {
        const k = p.stage || "new"; a[k] = (a[k] || 0) + 1; return a;
      }, {}) },
    { id: "rp-ws-ov-clean", title: "Avg cleanness", kind: "gauge",
      data: (s) => {
        const xs = (s.items || []).map((p) => p.cleanness_pct).filter((v) => v != null);
        return xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : 0;
      }, opts: { max: 100, unit: "%" } },
  ];
  const landingCharts = createListCharts($("#wsLanding"), { logPrefix: "ws-ov" });

  // The landing is a 3-row overview (a variation of the Home/Monitoring
  // layout): row 1 = hero (stage donut + cleanness gauge flanking a 2×2
  // stats grid), row 2 = recent-projects cards, row 3 = a projects table
  // that flex-fills + scrolls. Stats span ALL projects — hiding is
  // cosmetic rail declutter, not a data cut (see hide-is-display-not-
  // access); the recent grid + table respect the declutter (exclude
  // hidden projects) since they're nav shortcuts.
  function renderLanding() {
    const landing = $("#wsLanding");
    if (!landing) return;
    const projects = cachedProjects || [];
    const totalFiles  = projects.reduce((a, p) => a + (p.file_count || 0), 0);
    const sharedCount = projects.filter((p) => p.owner_id !== meRid).length;
    const cleanVals   = projects.map((p) => p.cleanness_pct).filter((v) => v != null);
    const avgClean    = cleanVals.length
      ? Math.round(cleanVals.reduce((a, b) => a + b, 0) / cleanVals.length) + "%"
      : "—";
    const hiddenSet = new Set(getHidden(HIDDEN_PROJECTS_KEY).map((x) => x.rid));
    const visible   = projects.filter((p) => !hiddenSet.has(p.redpash_id));
    const recent = visible.slice()
      .sort((a, b) => String(b.updated_at || "").localeCompare(String(a.updated_at || "")))
      .slice(0, 8);
    const cards = recent.length
      ? recent.map(landingCard).join("")
      : '<p class="rt-empty">No projects yet — upload a file from the rail to get started.</p>';
    landing.innerHTML = ''
      + '<div class="rp-overview__hero">'
      +   heroStripHTML(
            [ { label: "Projects",      value: projects.length },
              { label: "Files",         value: totalFiles      },
              { label: "Shared",        value: sharedCount     },
              { label: "Avg cleanness", value: avgClean        } ],
            WS_OV_CHARTS)
      + '</div>'
      + '<section class="ws-landing-section rp-overview__mid">'
      +   '<h3 class="ws-landing-section-title">Recent projects</h3>'
      +   '<div class="ws-landing-grid">' + cards + '</div>'
      + '</section>'
      + '<div class="rp-overview__table">' + wsProjectsTableHTML(visible) + '</div>';
    // Charts mount from data in hand; rAF resize so they pick up the
    // real container size after the surface flips to landing mode.
    landingCharts.dispose();
    landingCharts.mountData({ charts: WS_OV_CHARTS }, { items: projects });
    requestAnimationFrame(() => landingCharts.resize());
  }
  function wsProjectsTableHTML(projects) {
    if (!projects.length) return '<p class="rt-empty ws-landing-table-empty">No projects.</p>';
    const sorted = projects.slice()
      .sort((a, b) => String(b.updated_at || "").localeCompare(String(a.updated_at || "")));
    const body = sorted.map((p) => {
      const clean = p.cleanness_pct != null ? Math.round(p.cleanness_pct) + "%" : "—";
      return '<tr class="ws-landing-row" data-rid="' + esc(p.redpash_id) + '">'
        + '<td>' + esc(p.name || "(untitled)") + '</td>'
        + '<td class="is-num">' + (p.file_count || 0) + '</td>'
        + '<td>' + esc(p.stage || "new") + '</td>'
        + '<td class="is-num">' + clean + '</td>'
        + '<td>' + (p.owner_id === meRid ? "Personal" : "Shared") + '</td>'
        + '</tr>';
    }).join("");
    return '<table class="rt-table">'
      + '<thead><tr><th>Project</th><th>Files</th><th>Stage</th>'
      +   '<th>Cleanness</th><th>Owner</th></tr></thead>'
      + '<tbody>' + body + '</tbody></table>';
  }
  function landingCard(p, i) {
    const color = MARK_COLORS[i % MARK_COLORS.length];
    const initials = ((p.name || "?").trim().split(/\s+/)
      .map((w) => w[0]).join("") || "?").slice(0, 2).toUpperCase();
    const stage = p.stage || "new";
    const dot   = STAGE_DOT[stage] || "is-dirty";
    const files = p.file_count || 0;
    return '<button class="ws-landing-card" type="button" data-rid="' + esc(p.redpash_id) + '">'
      +   '<span class="rt-group-mark" data-c="' + color + '">' + esc(initials) + '</span>'
      +   '<span class="ws-landing-card-body">'
      +     '<span class="ws-landing-card-name">' + esc(p.name || "(untitled)") + '</span>'
      +     '<span class="ws-landing-card-meta">' + files + ' file' + (files === 1 ? "" : "s")
      +       ' · ' + esc(stage) + '</span>'
      +   '</span>'
      +   '<span class="rt-tab-dot ' + dot + '" title="' + esc(stage) + '"></span>'
      + '</button>';
  }
  // Landing card → open the project: expand its rail group, load files,
  // open the first one (which hides the landing). Empty project keeps the
  // landing up but reflects the focus + an empty table prompt.
  async function openProjectFromLanding(rid) {
    const group = navBody.querySelector('.rt-group[data-rid="' + cssEsc(rid) + '"]');
    if (!group) return;
    focusedProjectRid = rid;
    group.classList.add("expanded");
    await loadFilesForGroup(group);
    const firstTab = group.querySelector(".rt-tab");
    if (firstTab) {
      navBody.querySelectorAll(".rt-tab.active").forEach((t) => t.classList.remove("active"));
      firstTab.classList.add("active");
      loadFile(firstTab.dataset.rid);
    } else {
      hideLanding();
      activeFileRid = null;
      setTableState("This project has no files yet — upload one from the rail.");
      rowsInfo.textContent = "No file open.";
    }
  }

  function projectGroup(p) {
    const c = MARK_COLORS[(groupColorIdx++) % MARK_COLORS.length];
    const initials = ((p.name || "?").trim().split(/\s+/)
      .map((w) => w[0]).join("") || "?").slice(0, 2).toUpperCase();
    // Ownership tokens for the rail filter (space-separated, matched by
    // applyRailFilters). owner_id === me ⇒ personal, else shared; a
    // company_id adds the orthogonal "company" token. Baked in at render
    // so filtering is a pure DOM-visibility toggle (no refetch).
    const ownership = [p.owner_id === meRid ? "personal" : "shared"];
    if (p.company_id) ownership.push("company");
    return '<div class="rt-group" data-rid="' + esc(p.redpash_id) + '"'
      + ' data-ownership="' + ownership.join(" ") + '"'
      + (p.is_default ? ' data-default="1"' : '') + '>'
      +   '<button class="rt-group-head" type="button">'
      +     '<i class="bi bi-chevron-down rt-group-caret"></i>'
      +     '<span class="rt-group-mark" data-c="' + c + '">' + esc(initials) + '</span>'
      +     '<span class="rt-group-name">' + esc(p.name) + '</span>'
      +     '<span class="rt-group-rename" title="Rename project"><i class="bi bi-pencil"></i></span>'
      +     '<span class="rt-group-hide" title="Hide from rail"><i class="bi bi-x"></i></span>'
      +     '<span class="rt-group-count">' + (p.file_count || 0) + '</span>'
      +   '</button>'
      +   '<div class="rt-group-body" aria-busy="false"></div>'
      + '</div>';
  }

  // Inline rename for a project's rail entry. Swaps `.rt-group-name` to
  // contenteditable, selects all, listens for Enter (commit) / Esc
  // (cancel) / blur (commit). Empty or unchanged values cancel silently;
  // PATCH failures revert. Bubble-suppression on mousedown/click keeps
  // the parent `.rt-group-head` button from toggling expand while the
  // user clicks inside the editable text.
  function enterProjectRename(group, span) {
    const rid = group.dataset.rid;
    const original = span.textContent;
    let commit = true;

    span.setAttribute("contenteditable", "plaintext-only");
    span.classList.add("rt-group-name-editing");

    const range = document.createRange();
    range.selectNodeContents(span);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    span.focus();

    const suppress = (e) => e.stopPropagation();
    const onKey = (e) => {
      e.stopPropagation();
      if (e.key === "Enter") { e.preventDefault(); commit = true;  span.blur(); }
      else if (e.key === "Escape") { e.preventDefault(); commit = false; span.blur(); }
    };
    const onBlur = async () => {
      span.removeEventListener("keydown", onKey);
      span.removeEventListener("mousedown", suppress);
      span.removeEventListener("click", suppress);
      span.removeAttribute("contenteditable");
      span.classList.remove("rt-group-name-editing");

      const next = (span.textContent || "").trim();
      if (!commit || !next || next === original) {
        span.textContent = original;
        return;
      }
      span.textContent = next;
      try {
        const updated = await api.patch("/projects/" + encodeURIComponent(rid), { name: next });
        // Server may normalize (trim, truncate). Reflect the canonical value.
        if (updated?.name && updated.name !== next) span.textContent = updated.name;
        // Initials are derived from the name — refresh the mark too.
        const mark = group.querySelector(".rt-group-mark");
        if (mark) {
          const init = ((updated?.name || next).trim().split(/\s+/)
            .map((w) => w[0]).join("") || "?").slice(0, 2).toUpperCase();
          mark.textContent = init;
        }
      } catch {
        span.textContent = original;
      }
    };

    span.addEventListener("keydown", onKey);
    span.addEventListener("mousedown", suppress);
    span.addEventListener("click", suppress);
    span.addEventListener("blur", onBlur, { once: true });
  }

  // Inline rename for a file's rail tab. Same contenteditable swap +
  // Enter/Esc/blur lifecycle as enterProjectRename, with two
  // differences: (1) PATCH /api/files/:rid {display_name} instead of
  // /api/projects/:rid {name}, (2) the parent button is the .rt-tab
  // which also triggers loadFile on plain click — the bubble-
  // suppression on mousedown/click prevents the file from being
  // re-opened while the user clicks inside the editable text.
  function enterFileRename(tab, span) {
    const rid = tab.dataset.rid;
    const original = span.textContent;
    let commit = true;

    span.setAttribute("contenteditable", "plaintext-only");
    span.classList.add("rt-tab-name-editing");

    const range = document.createRange();
    range.selectNodeContents(span);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    span.focus();

    const suppress = (e) => e.stopPropagation();
    const onKey = (e) => {
      e.stopPropagation();
      if (e.key === "Enter")       { e.preventDefault(); commit = true;  span.blur(); }
      else if (e.key === "Escape") { e.preventDefault(); commit = false; span.blur(); }
    };
    const onBlur = async () => {
      span.removeEventListener("keydown", onKey);
      span.removeEventListener("mousedown", suppress);
      span.removeEventListener("click", suppress);
      span.removeAttribute("contenteditable");
      span.classList.remove("rt-tab-name-editing");

      const next = (span.textContent || "").trim();
      if (!commit || !next || next === original) {
        span.textContent = original;
        return;
      }
      span.textContent = next;
      try {
        const updated = await api.patch("/files/" + encodeURIComponent(rid), { display_name: next });
        // Server may normalise (trim, strip extension). Reflect the
        // canonical value so the rail stays accurate.
        const canonical = updated?.summary?.display_name || updated?.display_name;
        if (canonical && canonical !== next) span.textContent = canonical;
        // Display name change → cached envelope summary is stale.
        // Drop the entry; next loadFile refetches the fresh summary
        // (also covers any server-side fields that may have shifted).
        fileEnvelopeCache.delete(rid);
      } catch {
        span.textContent = original;
      }
    };

    span.addEventListener("keydown", onKey);
    span.addEventListener("mousedown", suppress);
    span.addEventListener("click", suppress);
    span.addEventListener("blur", onBlur, { once: true });
  }

  async function loadFilesForGroup(group) {
    if (group.dataset.filesLoaded === "1") return;
    const body = group.querySelector(".rt-group-body");
    const rid  = group.dataset.rid;
    body.setAttribute("aria-busy", "true");
    body.innerHTML = '<div class="rt-nav-state">Loading files…</div>';
    try {
      const data = await api.get("/projects/" + encodeURIComponent(rid) + "/files");
      renderFiles(body, data?.items || []);
      group.dataset.filesLoaded = "1";
      // Idle-time envelope prewarm — fetch each non-chart file's
      // /api/files/:rid in the background so a click on the tab
      // renders from cache instead of waiting for the round-trip.
      // requestIdleCallback (with setTimeout fallback) keeps it off
      // the main thread; missed fetches are swallowed (best-effort).
      prewarmGroupFiles(data?.items || []);
      // Deep-link auto-open. If a deep-linked file rid is stashed on the
      // group (?file=<rid>), pick that tab; otherwise the first. Gated on
      // data-autoopen (set only for deep-links) — a bare load expands the
      // default project here but lands on the overview, not a file.
      if (!activeFileRid && group.dataset.autoopen === "1") {
        const wantFile = group.dataset.wantFile;
        const tab = (wantFile && body.querySelector('.rt-tab[data-rid="' + cssEsc(wantFile) + '"]'))
                 || body.querySelector(".rt-tab");
        if (tab) {
          navBody.querySelectorAll(".rt-tab.active").forEach((t) => t.classList.remove("active"));
          tab.classList.add("active");
          loadFile(tab.dataset.rid);
        }
      }
    } catch {
      body.innerHTML = '<div class="rt-nav-state">Couldn’t load files.</div>';
    } finally {
      body.setAttribute("aria-busy", "false");
    }
  }

  function renderFiles(body, items) {
    const hiddenSet = new Set(getHidden(HIDDEN_FILES_KEY).map((x) => x.rid));
    const visible = items.filter((f) => !hiddenSet.has(f.redpash_id));
    if (!visible.length) {
      body.innerHTML = '<div class="rt-nav-state">No files yet.</div>';
      return;
    }
    body.innerHTML = visible.map(fileTab).join("");
  }

  // Recovery section at the rail body's tail — appears only when at
  // least one project or file is hidden. Native <details> for the
  // toggle so we get the open-state animation + a11y for free. Each
  // entry's click hits the navBody delegator (see the .rt-hidden-item
  // branch) which restores the rid via unhideOne + loadProjects.
  function renderHiddenSection(projects, files) {
    const count = projects.length + files.length;
    let body = "";
    if (projects.length) {
      body += '<div class="rt-hidden-section">'
        + '<div class="rt-hidden-title">Projects</div>'
        + projects.map((p) =>
            '<button class="rt-hidden-item" type="button"'
            + ' data-kind="project" data-rid="' + esc(p.rid) + '">'
            +   '<span class="rt-hidden-name">' + esc(p.name) + '</span>'
            +   '<i class="bi bi-arrow-counterclockwise rt-hidden-restore" title="Restore"></i>'
            + '</button>').join("")
        + '</div>';
    }
    if (files.length) {
      body += '<div class="rt-hidden-section">'
        + '<div class="rt-hidden-title">Files</div>'
        + files.map((f) =>
            '<button class="rt-hidden-item" type="button"'
            + ' data-kind="file" data-rid="' + esc(f.rid) + '">'
            +   '<span class="rt-hidden-name">' + esc(f.name)
            +     (f.project
                    ? ' <span class="rt-hidden-meta">· ' + esc(f.project) + '</span>'
                    : "")
            +   '</span>'
            +   '<i class="bi bi-arrow-counterclockwise rt-hidden-restore" title="Restore"></i>'
            + '</button>').join("")
        + '</div>';
    }
    return '<details class="rt-hidden">'
      +   '<summary class="rt-hidden-summary">'
      +     '<i class="bi bi-eye-slash"></i> Hidden (' + count + ')'
      +   '</summary>'
      +   '<div class="rt-hidden-body">' + body + '</div>'
      + '</details>';
  }

  function fileTab(f) {
    const dot = STAGE_DOT[f.stage] || "is-dirty";
    const name = f.display_name || f.filename || "(unnamed)";
    // Icon per file_type — Designer-bound rows (chart, dashboard)
    // get distinct glyphs so the rail reads at a glance.
    const icon = f.file_type === "chart"     ? "bi-bar-chart-line"
              : f.file_type === "dashboard"  ? "bi-grid-1x2"
              :                                 "bi-filetype-csv";
    // Which rail view this file belongs to. The view toggle (rail head)
    // hides the rows whose kind isn't the active view: charts (reports)
    // + dashboards under "dashboards", everything else under "data".
    const viewKind = f.file_type === "chart"     ? "report"
                  : f.file_type === "dashboard"  ? "dashboard"
                  :                                 "data";
    return '<button class="rt-tab" type="button" data-view-kind="' + viewKind + '" data-rid="' + esc(f.redpash_id) + '">'
      +   '<i class="bi ' + icon + ' rt-tab-icon"></i>'
      +   '<span class="rt-tab-name">' + esc(name) + '</span>'
      +   '<span class="rt-tab-rename" title="Rename file"><i class="bi bi-pencil"></i></span>'
      +   '<span class="rt-tab-dot ' + dot + '" title="' + esc(f.stage || "") + '"></span>'
      +   '<span class="rt-tab-close" title="Close"><i class="bi bi-x"></i></span>'
      + '</button>';
  }

  // ─── rail body — expand groups, switch / close tabs ────────────
  navBody.addEventListener("click", async (e) => {
    // Rename pencil short-circuits the head toggle. The pencil lives
    // inside the head button, so its click bubbles here too — catch it
    // first and bail before the expand/collapse branch runs.
    const renameBtn = e.target.closest(".rt-group-rename");
    if (renameBtn) {
      const group = renameBtn.closest(".rt-group");
      const nameSpan = group?.querySelector(".rt-group-name");
      if (group && nameSpan) enterProjectRename(group, nameSpan);
      return;
    }
    // Project hide × — adds the project rid to rail_hidden_projects
    // pref, re-renders the rail. Same hover-affordance pattern as the
    // rename pencil; same short-circuit before the head-toggle branch.
    const hideBtn = e.target.closest(".rt-group-hide");
    if (hideBtn) {
      const group = hideBtn.closest(".rt-group");
      const rid   = group?.dataset.rid;
      const name  = group?.querySelector(".rt-group-name")?.textContent?.trim();
      if (rid && name) {
        hideOne(HIDDEN_PROJECTS_KEY, { rid, name });
        if (focusedProjectRid === rid) focusedProjectRid = null;
        await loadProjects();
      }
      return;
    }
    // File rename pencil — same pattern as the project rename pencil,
    // short-circuits before the tab-click branch so the pencil click
    // doesn't trigger loadFile. PATCH /api/files/:rid is the wire.
    const tabRenameBtn = e.target.closest(".rt-tab-rename");
    if (tabRenameBtn) {
      const tab = tabRenameBtn.closest(".rt-tab");
      const nameSpan = tab?.querySelector(".rt-tab-name");
      if (tab && nameSpan) enterFileRename(tab, nameSpan);
      return;
    }
    // Hidden-section item — click anywhere on a hidden entry restores
    // it (removes from the pref + re-renders). The restore icon is
    // visual only; the whole button is the click target.
    const hiddenItem = e.target.closest(".rt-hidden-item");
    if (hiddenItem) {
      const kind = hiddenItem.dataset.kind;
      const rid  = hiddenItem.dataset.rid;
      if (rid) {
        unhideOne(kind === "project" ? HIDDEN_PROJECTS_KEY : HIDDEN_FILES_KEY, rid);
        await loadProjects();
      }
      return;
    }
    // Pinned "Overview" entry — return to the landing surface. Caught
    // before the generic .rt-tab branch (it's a .rt-tab too, minus a rid).
    if (e.target.closest("[data-rail-landing]")) {
      goToLanding();
      return;
    }
    const head = e.target.closest(".rt-group-head");
    if (head) {
      const group = head.closest(".rt-group");
      // Group head click = explicit "I'm focused on this project"
      // signal. Update even when collapsing — collapse is a UI tweak,
      // the user is still in this project.
      focusedProjectRid = group.dataset.rid || null;
      const wasExpanded = group.classList.contains("expanded");
      group.classList.toggle("expanded");
      if (!wasExpanded) loadFilesForGroup(group);
      return;
    }
    if (e.target.closest(".rt-tab-close")) {
      const tab = e.target.closest(".rt-tab");
      const closingActive = tab.dataset.rid === activeFileRid;
      // Persist the hide via the rail_hidden_files pref so the tab
      // stays gone across reloads. The Hidden (N) recovery section
      // at the rail tail brings it back on click. project name is
      // captured at hide-time so the recovery UI can label the
      // entry without re-fetching.
      const rid     = tab.dataset.rid;
      const name    = tab.querySelector(".rt-tab-name")?.textContent?.trim() || rid;
      const group   = tab.closest(".rt-group");
      const project = group?.querySelector(".rt-group-name")?.textContent?.trim() || null;
      if (rid) hideOne(HIDDEN_FILES_KEY, { rid, name, project });
      tab.remove();
      // Show the new Hidden (N) section / refresh its count without
      // a full reload — cheap re-render of just the rail body.
      loadProjects();
      if (closingActive) {
        // The file backing the table just disappeared — clear state so
        // loadFile(rid) can re-open the same rid later, and blank the
        // surface back to the "open a file" prompt.
        activeFileRid = null;
        activeColumns = [];
        activeSteps = [];
        rowIndices = [];
        totalPages = 1;
        renderPager();
        syncToolbar();
        setTableState("Open a file from the rail to see its data.");
        rowsInfo.textContent = "No file open.";
      }
      return;
    }
    const tab = e.target.closest(".rt-tab");
    if (tab) {
      navBody.querySelectorAll(".rt-tab.active").forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");
      // Clicking a tab = "I'm focused on this file's project" — update
      // even when loadFile() no-ops (rid already active), so the rail-
      // foot buttons retarget back to A after a sidetrip through B.
      const tabGroup = tab.closest(".rt-group");
      if (tabGroup) focusedProjectRid = tabGroup.dataset.rid || focusedProjectRid;
      loadFile(tab.dataset.rid);
    }
  });

  // ─── table — load a file's columns + page ──────────────────────
  // Three-helper split: loadFile resets per-file state and fetches
  // columns; refetchPage preserves column-indexed state and re-renders
  // the table body; fetchAndRender does the wire call + render shared
  // by both.
  // Background prefetch of /files/:rid envelopes for every non-chart
  // file in a freshly-rendered group. Scheduled via requestIdleCallback
  // (falls back to setTimeout on browsers without it). Already-cached
  // rids skip the fetch — repeated group expands are cheap. Hidden
  // files in the rail-hidden pref still get prewarmed (they're hidden,
  // not removed from the project) so an unhide-then-click is also fast.
  function prewarmGroupFiles(items) {
    if (!Array.isArray(items) || !items.length) return;
    const targets = items.filter((f) => {
      const id = f?.redpash_id;
      if (!id || id.startsWith("CHT_")) return false;   // charts use a different endpoint
      return !fileEnvelopeCache.has(id);
    });
    if (!targets.length) return;
    const schedule = typeof window !== "undefined" && typeof window.requestIdleCallback === "function"
      ? window.requestIdleCallback.bind(window)
      : (cb) => setTimeout(cb, 200);
    schedule(() => {
      for (const f of targets) {
        const id = f.redpash_id;
        // Race-skip: another caller may have just populated the cache
        // (loadFile fires on tab click before idle fires for big lists).
        if (fileEnvelopeCache.has(id)) continue;
        api.get("/files/" + encodeURIComponent(id))
          .then((env) => { if (env) fileEnvelopeCache.set(id, env); })
          .catch(() => { /* prewarm is best-effort */ });
      }
    });
  }

  // Wrap a chart row as a synthetic single-widget dashboard so the
  // dashboard designer canvas can render it. `redpash_id: null` flags
  // this wrapper to designer.addChartWidget (skips the PUT/dashboards
  // round-trip) and to the workspace Add-chart click handler (skips
  // the navigate-away fallback that would replace the open chart).
  function chartAsDashboard(chart) {
    if (!chart) return null;
    return {
      redpash_id: null,
      project_redpash_id: chart.project_redpash_id || null,
      title: chart.title || "Untitled chart",
      description: null,
      folder: null,
      spec: {
        template_id: "",
        widgets: [{
          slot: "w1",
          kind: "chart",
          spec: { chart_id: chart.redpash_id },
        }],
      },
    };
  }

  async function loadFile(rid) {
    if (!rid || rid === activeFileRid) return;
    hideLanding();   // opening any file leaves the overview surface
    activeFileRid = rid;
    // Reset all per-file state — column-indexed knobs only make sense
    // against the columns we're about to fetch.
    sortKeys = []; activeFilter = null; searchQ = "";
    currentPage = 1;
    $("#wsRowSearch").value = "";
    $("#wsFilterToggle").classList.remove("has-filter");
    setTableState("Loading…");
    rowsInfo.textContent = "Loading…";
    try {
      // Charts and data files take different load paths. Rid prefix
      // disambiguates without a probe call — CHT_* is a chart row in
      // project_files; FIL_* is a data file. The /files/:rid endpoint
      // 500s on chart rids (no row/column metadata), so we MUST not
      // hit it for charts.
      if (rid.startsWith("CHT_")) {
        const chart = await api.get("/charts/" + encodeURIComponent(rid));
        await ensureSourceCache(chart?.source_file_id);
        await ensureProjectSourceFiles(chart?.project_redpash_id);
        enterDesignerMode(chart?.title || "Untitled chart");
        // Em 2026-05-28: "keep only the view where 'Add chart' doesn't
        // remove the current chart, but where we can add many charts on
        // the canvas". The dashboard canvas IS that view — single-chart
        // files render here too, wrapped as a synthetic 1-widget
        // dashboard. The wrapper has no redpash_id; designer.js + the
        // Add-chart click handler below recognise that and skip the
        // dashboard-PUT path (which would 404 against a synthetic rid).
        designerCtrl?.load({ type: "dashboard", dashboard: chartAsDashboard(chart) });
        // Opening a chart inherits its project as the focus.
        if (chart?.project_redpash_id) focusedProjectRid = chart.project_redpash_id;
        rowsInfo.textContent = "Chart · " + (chart?.title || "untitled");
        totalPages = 1;
        renderPager();
        return;
      }

      // Cache-first read. Envelope was already fetched by
      // prewarmGroupFiles when the file's project group expanded,
      // so the typical click on a tab in an open group is a
      // cache hit and renders instantly. Cache miss → fetch and
      // populate the entry. The cache stays fresh because every
      // loadFile re-fetches when not cached, and mutations update
      // the cached entry inline (see invalidateFileCache below).
      let envelope = fileEnvelopeCache.get(rid);
      if (!envelope) {
        envelope = await api.get("/files/" + encodeURIComponent(rid));
        if (envelope) fileEnvelopeCache.set(rid, envelope);
      }
      activeColumns = envelope?.columns || [];
      activeSteps   = envelope?.steps   || [];
      activeSummary = envelope?.summary || null;
      // Opening a data file inherits its project as the focus, so the
      // rail-foot buttons target the file's project on the next click.
      if (envelope?.summary?.project_redpash_id) {
        focusedProjectRid = envelope.summary.project_redpash_id;
      }
      syncToolbar();
      // Defensive fallback for legacy CHT_-prefix mistakes or future
      // file_types that route through the same designer path.
      const fileType = envelope?.summary?.file_type;
      if (fileType === "chart") {
        // Defensive fallback — shouldn't normally hit since the
        // CHT_ branch returns above, but legacy/wrong-prefixed rids
        // could land here.
        const chart = await api.get("/charts/" + encodeURIComponent(rid));
        await ensureSourceCache(chart?.source_file_id);
        await ensureProjectSourceFiles(chart?.project_redpash_id || envelope?.summary?.project_redpash_id);
        enterDesignerMode(chart?.title || envelope?.summary?.display_name || "Untitled chart");
        // Same synthetic-dashboard wrapping as the CHT_ branch above.
        designerCtrl?.load({ type: "dashboard", dashboard: chartAsDashboard(chart) });
        rowsInfo.textContent = "Chart · " + (chart?.title || envelope?.summary?.display_name || "untitled");
        totalPages = 1;
        renderPager();
      } else if (fileType === "dashboard") {
        // Dashboards = FIL_-prefix project_files rows with
        // file_type='dashboard'. Spec carries widgets[] each
        // referencing a chart by id. Designer fetches each in
        // parallel and renders the multi-tile canvas.
        const dashboard = await api.get("/dashboards/" + encodeURIComponent(rid));
        await ensureProjectSourceFiles(dashboard?.project_redpash_id || envelope?.summary?.project_redpash_id);
        enterDesignerMode(dashboard?.title || envelope?.summary?.display_name || "Untitled dashboard", "dashboard");
        designerCtrl?.load({ type: "dashboard", dashboard });
        rowsInfo.textContent = "Dashboard · " + (dashboard?.title || envelope?.summary?.display_name || "untitled");
        totalPages = 1;
        renderPager();
      } else {
        rebuildColsDropdown(activeColumns);
        rebuildFilterCols(activeColumns);
        // Cache the open data file so the designer's Add-chart (from a
        // dashboard) has an immediate source to chart against.
        sourceCache = { rid, columns: activeColumns };
        // Tear down any open designer (user navigated from chart to data).
        designerCtrl?.load(null);
        exitDesignerMode();
        // Data-file-only panels — Tools (cleaning + joins) and Report
        // builder operate on rows/columns/steps that don't exist for
        // chart/dashboard rids. Firing these before the file_type
        // switch caused joinsCtrl.refresh() to 400 against the
        // not_a_data_file guard when a dashboard loaded — they now
        // run only on the CSV branch.
        toolsCtrl?.refresh();
        joinsCtrl?.refresh();
        reportCtrl?.refresh();
        await fetchAndRender();
      }
    } catch (err) {
      setTableState("Couldn’t load file" + (err.status ? " (" + err.status + ")" : "") + ".");
      rowsInfo.textContent = "Error.";
    }
  }

  // Re-fetch the current file's current page without resetting state.
  // Triggered by pager clicks + rows-per-page changes.
  async function refetchPage() {
    if (!activeFileRid) return;
    rowsInfo.textContent = "Loading…";
    try { await fetchAndRender(); }
    catch (err) {
      setTableState("Couldn’t load page" + (err.status ? " (" + err.status + ")" : "") + ".");
      rowsInfo.textContent = "Error.";
    }
  }

  async function fetchAndRender() {
    const params = new URLSearchParams();
    params.set("page", String(currentPage));
    params.set("size", String(pageSize));
    if (searchQ) params.set("q", searchQ);
    const sorts = buildSortsParam();
    if (sorts && sorts.length) params.set("sorts", JSON.stringify(sorts));
    if (activeFilter) params.set("filters", JSON.stringify(activeFilter));
    // DATA-ENDPOINT-ACK: caller-checks-file_type — refetchPage is only
    // called from the CSV branch of loadFile (and from sites it gates
    // like applyStep). activeFileRid points at a CSV here.
    const pageData = await api.get(
      "/files/" + encodeURIComponent(activeFileRid) + "/page?" + params.toString());
    // Server clamps page; trust its echo so the pager reflects reality.
    currentPage = pageData?.page || 1;
    totalPages  = pageData?.pages || 1;
    rowIndices  = pageData?.row_indices || [];
    renderTable(activeColumns, pageData?.rows || []);
    syncSortHeaders();
    const shown = pageData?.rows?.length || 0;
    const total = pageData?.total || 0;
    const from  = total === 0 ? 0 : (currentPage - 1) * pageSize + 1;
    const to    = Math.min(from + shown - 1, total);
    rowsInfo.textContent = (total === 0 ? "0 rows" : from + "–" + to + " of " + total + " rows")
      + " · " + (pageData?.ms != null ? pageData.ms + " ms" : "—");
    renderPager();
    setTableState(null);
  }

  // ─── server-query builders ────────────────────────────────────
  // sortKeys carries display-column-indexes (≥3, after the chk + #
  // columns); the server needs column names. Translate via
  // activeColumns; drop any key whose column has been removed.
  function buildSortsParam() {
    return sortKeys
      .map((k) => {
        const meta = activeColumns[k.col - 3];
        return meta ? { col: meta.name, dir: k.dir > 0 ? "asc" : "desc" } : null;
      })
      .filter(Boolean);
  }

  // Walk the filter builder UI, return a FilterNode tree (or null when
  // there's no actionable predicate). One group = one FilterGroup;
  // multiple groups wrapped under the outer combo as a top-level
  // FilterGroup. Single group with no outer wrapping: hand the inner
  // group out directly (saves a level of nesting on the wire).
  function buildFilterNode() {
    const groups = Array.from(groupList.querySelectorAll(".rt-group-card"))
      .map(readGroup);
    const groupNodes = groups
      .map((g) => ({
        op: g.combo.toLowerCase(),
        children: g.preds.map(predToLeaf).filter(Boolean),
      }))
      .filter((g) => g.children.length > 0);
    if (groupNodes.length === 0) return null;
    if (groupNodes.length === 1) return groupNodes[0];
    return { op: groupCombo.toLowerCase(), children: groupNodes };
  }

  // Per-op value coercion before sending to the server. Single source of
  // truth lives on OP_BY_WIRE[.value]; that resolves to a value-kind
  // ("text" / "number" / "date" / "list" / "range-*" / "none") and we
  // shape the wire payload accordingly. Returns null when the predicate
  // is incomplete (e.g. between with one empty side) — buildFilterNode
  // drops null leaves, so a half-filled row doesn't poison the request.
  function predToLeaf(p) {
    const meta = activeColumns[p.col - 3];
    if (!meta) return null;
    const spec = OP_BY_WIRE[p.op];
    if (!spec) return null;
    const op = p.op;
    if (NULL_OPS.has(op)) return { col: meta.name, op };

    // Between → [min, max], typed per column dtype.
    if (op === "between") {
      const [a, b] = Array.isArray(p.val) ? p.val : ["", ""];
      if (a === "" || b === "") return null;
      const isDateCol = DATE_DTYPES_FILTER.includes(colDtype(meta));
      const value = isDateCol ? [a, b] : [Number(a), Number(b)];
      // Reject when number parsing failed — Number("abc") = NaN sneaks
      // through; the engine would 400 on NaN anyway, fail fast.
      if (!isDateCol && (Number.isNaN(value[0]) || Number.isNaN(value[1]))) return null;
      return { col: meta.name, op, value };
    }

    // In / not_in → array of values. readPred emits either:
    //   string[] when the chip-picker is mounted (the v1 UX)
    //   string   from a comma-separated fallback (defensive path)
    if (op === "in" || op === "not_in") {
      const items = Array.isArray(p.val)
        ? p.val.map((s) => String(s).trim()).filter(Boolean)
        : String(p.val || "").split(",").map((s) => s.trim()).filter(Boolean);
      if (!items.length) return null;
      const isNumCol = NUM_DTYPES_FILTER.includes(colDtype(meta));
      const value = isNumCol ? items.map(Number) : items;
      if (isNumCol && value.some(Number.isNaN)) return null;
      return { col: meta.name, op, value };
    }

    // Numeric comparison ops — coerce to number.
    if (["gt", "gte", "lt", "lte"].includes(op)) {
      if (p.val === "") return null;
      const n = Number(p.val);
      if (Number.isNaN(n)) return null;
      return { col: meta.name, op, value: n };
    }

    // Everything else (eq, neq, contains, before/after, …) takes a
    // string value as-is. Empty string drops the predicate.
    if (p.val === "") return null;
    return { col: meta.name, op, value: p.val };
  }

  function renderTable(columns, rows) {
    thead.innerHTML = '<tr>'
      + '<th class="col-chk"><input type="checkbox" class="rt-chk" id="wsSelectAll" /></th>'
      + '<th class="col-rownum">#</th>'
      + columns.map((c, i) =>
          '<th class="sortable" data-sort="' + (i + 3) + '"'
          + (DATE_DTYPES.has(c.semantic_dtype) ? ' data-type="date"' : '')
          + '>' + esc(c.name) + ' <i class="bi bi-chevron-expand sort"></i></th>'
        ).join("")
      + '</tr>';
    tbody.innerHTML = rows.map((row, i) => {
      const absIdx = rowIndices[i];
      const idxAttr = absIdx != null ? ' data-idx="' + absIdx + '"' : "";
      return '<tr' + idxAttr + '>'
        + '<td class="col-chk"><input type="checkbox" class="rt-chk" /></td>'
        + '<td class="col-n col-rownum">' + (i + 1) + '</td>'
        + columns.map((c, ci) => {
            const v = row[ci];
            const cls = v == null ? 'cell-muted editable' : 'editable';
            return '<td class="' + cls + '" data-col="' + esc(c.name) + '">'
              + esc(v == null ? "—" : v) + '</td>';
          }).join("")
        + '</tr>';
    }).join("");
    syncSel();
  }

  function setTableState(msg) {
    // State message — when no body is current (loading, error, no file).
    const designer = document.getElementById("wsDesigner");
    if (msg) {
      tableState.textContent = msg;
      tableState.hidden = false;
      table.hidden = true;
      if (designer) designer.hidden = true;
    } else {
      tableState.hidden = true;
      table.hidden = false;
      if (designer) designer.hidden = true;
    }
  }

  // ─── columns dropdown — rebuilt per file ───────────────────────
  function rebuildColsDropdown(columns) {
    colsDd.innerHTML = columns.map((c, i) =>
      '<label class="rt-dd-item"><input type="checkbox" class="rt-chk" data-col="'
      + (i + 3) + '" checked /> ' + esc(c.name) + '</label>'
    ).join("");
  }
  // Cols-toggle is delegated to the dropdown — survives rebuilds.
  colsDd.addEventListener("change", (e) => {
    const chk = e.target.closest("input[data-col]");
    if (!chk) return;
    const n = chk.dataset.col;
    const show = chk.checked ? "" : "none";
    table.querySelectorAll("thead th:nth-child(" + n + "), tbody td:nth-child(" + n + ")")
      .forEach((c) => { c.style.display = show; });
  });

  // ─── filter builder — COLS dynamic per file ────────────────────
  // OP_SPECS above is the single source of truth for ops; predRow() and
  // the col-change handler below project it through opsForColumn().

  function rebuildFilterCols(columns) {
    // Keep (colIndex, name, meta) so opsForColumn() can dtype-filter
    // the op dropdown without re-resolving activeColumns on every render.
    filterCols = columns.map((c, i) => [i + 3, c.name, c]);
    groupList.innerHTML = "";
    groupCombo = "AND";
    activeFilter = null;
    if (filterCols.length) addGroup();
    // Server-side filter (WS#2) — no client-side refresh() needed here;
    // loadFile awaits fetchAndRender() right after this call which
    // sends the fresh (empty) filter set to the server.
  }

  // Op <select> innerHTML for the given column meta. <optgroup> labels
  // come straight from OP_SPECS[2]; ops are filtered by dtype.
  function opSelectHTML(meta, selected) {
    const ops = opsForColumn(meta);
    const groups = {};
    ops.forEach((o) => { (groups[o[2]] = groups[o[2]] || []).push(o); });
    return Object.keys(groups).map((g) =>
      '<optgroup label="' + esc(g) + '">'
      + groups[g].map((o) =>
          '<option value="' + o[0] + '"' + (o[0] === selected ? ' selected' : '') + '>' + esc(o[1]) + '</option>'
        ).join("")
      + '</optgroup>'
    ).join("");
  }

  // Value-input HTML for an (op, column) pair. Six shapes:
  //   none       — hidden (presence ops)
  //   text       — single text input
  //   number     — single numeric input
  //   date       — single date picker
  //   list       — single text input, comma-separated parsed by predToLeaf
  //   range-*    — two inputs side-by-side, parsed as [min, max]
  function valueInputHTML(op, meta) {
    const kind = valueKindFor(op, meta);
    if (kind === "none") {
      return '<input class="rt-pred-val" type="hidden" />';
    }
    if (kind === "number") {
      return '<input class="rt-pred-val" type="number" step="any" placeholder="value" />';
    }
    if (kind === "date") {
      return '<input class="rt-pred-val" type="date" placeholder="YYYY-MM-DD" />';
    }
    if (kind === "list") {
      return '<input class="rt-pred-val" type="text" placeholder="a, b, c (comma-separated)" />';
    }
    if (kind === "range-number") {
      return '<span class="rt-pred-range">'
        + '<input class="rt-pred-val rt-pred-val-a" type="number" step="any" placeholder="min" />'
        + '<span class="rt-pred-range-sep">to</span>'
        + '<input class="rt-pred-val rt-pred-val-b" type="number" step="any" placeholder="max" />'
        + '</span>';
    }
    if (kind === "range-date") {
      return '<span class="rt-pred-range">'
        + '<input class="rt-pred-val rt-pred-val-a" type="date" />'
        + '<span class="rt-pred-range-sep">to</span>'
        + '<input class="rt-pred-val rt-pred-val-b" type="date" />'
        + '</span>';
    }
    return '<input class="rt-pred-val" type="text" placeholder="value" />';
  }

  function predRow() {
    const firstCol  = filterCols[0];
    const firstMeta = firstCol?.[2];
    const ops       = opsForColumn(firstMeta);
    const firstOp   = ops[0]?.[0] || "eq";
    const d = document.createElement("div");
    d.className = "rt-pred";
    d.innerHTML =
      '<select class="rt-pred-col">'
      + filterCols.map((c) => '<option value="' + c[0] + '">' + esc(c[1]) + "</option>").join("")
      + "</select>"
      + '<select class="rt-pred-op">'
      + opSelectHTML(firstMeta, firstOp)
      + "</select>"
      + '<span class="rt-pred-val-slot">' + valueInputHTML(firstOp, firstMeta) + '</span>'
      + '<button class="rt-pred-del" type="button" title="Remove condition"><i class="bi bi-x"></i></button>';
    // Wire the value-input slot — autocomplete for single-value ops,
    // chip-picker for in/not_in. No-op for numeric/date/between/null
    // ops (free input is right; nothing to suggest).
    wireValueSlot(d);
    return d;
  }

  // Autocomplete / chip-picker wiring against column-index. Reads the
  // current op + col from the predicate's dropdowns (so ctx.colName
  // re-resolves dynamically when the user switches columns).
  // Single-value text ops get attachAutocomplete on the input; list
  // ops (in/not_in) get mountChipPicker on the slot.
  const SINGLE_VALUE_AC_OPS = new Set(["eq", "neq", "contains", "not_contains", "starts_with", "ends_with"]);
  const LIST_OPS            = new Set(["in", "not_in"]);
  function wireValueSlot(pred) {
    const opSel = pred.querySelector(".rt-pred-op");
    const op = opSel?.value || "eq";
    const slot = pred.querySelector(".rt-pred-val-slot");
    if (!slot) return;
    const ctx = {
      fileRid: () => activeFileRid,
      colName: () => {
        const colSel = pred.querySelector(".rt-pred-col");
        const idx = Number(colSel?.value);
        return filterCols.find((c) => c[0] === idx)?.[1] || null;
      },
    };
    if (LIST_OPS.has(op)) {
      // Chip-picker replaces the slot's content with the chip-list +
      // add-input. Stash the controller on the slot so readPred can
      // pull `.values()` out.
      slot._chipCtrl = mountChipPicker(slot, ctx);
      return;
    }
    if (SINGLE_VALUE_AC_OPS.has(op)) {
      const input = slot.querySelector(".rt-pred-val");
      if (input && input.type !== "hidden") attachAutocomplete(input, ctx);
    }
    // Other ops (numeric / date / between / null) — no wiring; the
    // input shape from valueInputHTML is the right primitive.
  }
  function groupCard() {
    const card = document.createElement("div");
    card.className = "rt-group-card";
    card.innerHTML =
      '<div class="rt-group-card-head">'
      + '<div class="rt-seg rt-group-card-combo">'
      + '<button type="button" class="is-active" data-combo="AND">AND</button>'
      + '<button type="button" data-combo="OR">OR</button>'
      + "</div>"
      + '<button class="rt-group-card-del" type="button" title="Remove group"><i class="bi bi-trash3"></i></button>'
      + "</div>"
      + '<div class="rt-pred-list"></div>'
      + '<button class="rt-btn rt-btn--glass rt-btn--block rt-add-pred" type="button">'
      + '<i class="bi bi-plus-lg"></i> Add condition</button>';
    card.querySelector(".rt-pred-list").appendChild(predRow());
    return card;
  }
  function renderSeps() {
    groupList.querySelectorAll(".rt-group-sep").forEach((s) => s.remove());
    const cards = Array.from(groupList.querySelectorAll(".rt-group-card"));
    cards.slice(0, -1).forEach((card) => {
      const sep = document.createElement("div");
      sep.className = "rt-group-sep";
      sep.innerHTML = '<button type="button">' + groupCombo + "</button>";
      card.after(sep);
    });
  }
  function addGroup() { groupList.appendChild(groupCard()); renderSeps(); }

  $("#wsAddGroup").addEventListener("click", () => { if (filterCols.length) addGroup(); });

  groupList.addEventListener("click", (e) => {
    if (e.target.closest(".rt-pred-del")) { e.target.closest(".rt-pred").remove(); return; }
    if (e.target.closest(".rt-add-pred")) {
      e.target.closest(".rt-group-card").querySelector(".rt-pred-list").appendChild(predRow());
      return;
    }
    if (e.target.closest(".rt-group-card-del")) {
      if (groupList.querySelectorAll(".rt-group-card").length > 1)
        e.target.closest(".rt-group-card").remove();
      renderSeps();
      return;
    }
    const gcBtn = e.target.closest(".rt-group-card-combo button");
    if (gcBtn) {
      gcBtn.parentElement.querySelectorAll("button").forEach((b) => b.classList.remove("is-active"));
      gcBtn.classList.add("is-active");
      return;
    }
    if (e.target.closest(".rt-group-sep button")) {
      groupCombo = groupCombo === "AND" ? "OR" : "AND";
      groupList.querySelectorAll(".rt-group-sep button").forEach((b) => { b.textContent = groupCombo; });
    }
  });
  groupList.addEventListener("change", (e) => {
    const pred = e.target.closest(".rt-pred");
    if (!pred) return;
    // Column changed → dtype may have changed → rebuild the op
    // dropdown (drop ops that don't apply) + the value slot. Keep
    // the currently-selected op if still valid; otherwise default
    // to the first op of the new dtype.
    if (e.target.classList.contains("rt-pred-col")) {
      const meta = filterColMeta(e.target.value);
      const opSel = pred.querySelector(".rt-pred-op");
      const ops = opsForColumn(meta);
      const wantOp = ops.find((o) => o[0] === opSel.value)?.[0] || ops[0]?.[0] || "eq";
      opSel.innerHTML = opSelectHTML(meta, wantOp);
      const slot = pred.querySelector(".rt-pred-val-slot");
      slot._chipCtrl = null;
      slot.innerHTML = valueInputHTML(wantOp, meta);
      wireValueSlot(pred);
      return;
    }
    // Op changed → swap the value-input slot if the value-kind
    // shifted (text → number, single → range, etc.).
    if (e.target.classList.contains("rt-pred-op")) {
      const meta = filterColMeta(pred.querySelector(".rt-pred-col").value);
      const slot = pred.querySelector(".rt-pred-val-slot");
      slot._chipCtrl = null;
      slot.innerHTML = valueInputHTML(e.target.value, meta);
      wireValueSlot(pred);
    }
  });

  // colIndex (the <select> value, a stringified number) → ColumnMeta.
  // filterCols carries [idx, name, meta] tuples; we lookup by index.
  function filterColMeta(idxValue) {
    const idx = Number(idxValue);
    return filterCols.find((c) => c[0] === idx)?.[2];
  }
  function readGroup(card) {
    return {
      combo: card.querySelector(".rt-group-card-combo .is-active").dataset.combo,
      preds: Array.from(card.querySelectorAll(".rt-pred")).map(readPred),
    };
  }
  // Read a predicate row → a normalized intermediate shape. Range ops
  // (between) emit `val: [a, b]`; list ops (in/not_in) emit `val:
  // string[]` from the chip-picker's selected set; everything else
  // emits a single string. Empty / whitespace-only values pass through
  // unchanged — predToLeaf is the validator that drops incomplete
  // predicates.
  function readPred(p) {
    const op = p.querySelector(".rt-pred-op").value;
    const col = +p.querySelector(".rt-pred-col").value;
    if (op === "between") {
      const a = p.querySelector(".rt-pred-val-a")?.value.trim() || "";
      const b = p.querySelector(".rt-pred-val-b")?.value.trim() || "";
      return { col, op, val: [a, b] };
    }
    if (op === "in" || op === "not_in") {
      const slot = p.querySelector(".rt-pred-val-slot");
      const chips = slot?._chipCtrl?.values() || [];
      // Fall back to comma-split if the chip-picker isn't mounted
      // (e.g. user typed in plain input and op flipped to in/not_in
      // before the picker rendered). Defensive — shouldn't normally
      // hit since wireValueSlot mounts the picker synchronously.
      if (chips.length > 0) return { col, op, val: chips };
      const raw = p.querySelector(".rt-pred-val")?.value.trim() || "";
      return { col, op, val: raw };
    }
    return { col, op, val: p.querySelector(".rt-pred-val")?.value.trim() || "" };
  }
  $("#wsApplyFilter").addEventListener("click", () => {
    activeFilter = buildFilterNode();
    $("#wsFilterToggle").classList.toggle("has-filter", activeFilter != null);
    currentPage = 1;
    refetchPage();
  });
  $("#wsClearFilter").addEventListener("click", () => {
    groupList.innerHTML = "";
    groupCombo = "AND";
    if (filterCols.length) addGroup();
    activeFilter = null;
    $("#wsFilterToggle").classList.remove("has-filter");
    currentPage = 1;
    refetchPage();
  });

  // ─── search — debounced, server-side via PageQuery.q ─────────
  // Page-local string match used to live here (passSearch over rendered
  // rows); deleted along with passFilter/applySort. The boundary doc
  // forbids JS data-engine code long-term — search now ships through
  // the same Page<T> wire as filter + sort.
  $("#wsRowSearch").addEventListener("input", (e) => {
    const next = e.target.value.trim();
    if (next === searchQ) return;
    searchQ = next;
    if (searchDebounce) clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => {
      currentPage = 1;
      refetchPage();
    }, 250);
  });

  // ─── sort — server-side via PageQuery.sorts ──────────────────
  // Shift-click extends the sort, plain click replaces. Same gesture
  // as before; the difference is the refetch.
  thead.addEventListener("click", (e) => {
    const th = e.target.closest("th.sortable");
    if (!th) return;
    const col = +th.dataset.sort, isDate = th.dataset.type === "date";
    const key = sortKeys.find((k) => k.col === col);
    if (e.shiftKey) {
      if (key) key.dir *= -1;
      else sortKeys.push({ col, dir: 1, isDate });
    } else if (sortKeys.length === 1 && sortKeys[0].col === col) {
      sortKeys[0].dir *= -1;
    } else {
      sortKeys = [{ col, dir: 1, isDate }];
    }
    refetchPage();
  });

  // Paint sort-direction chevrons + multi-key order numbers on the
  // header. Called from fetchAndRender after each (re)render — the
  // header is rebuilt by renderTable, so the indicators reapply.
  function syncSortHeaders() {
    table.querySelectorAll("th.sortable").forEach((h) => {
      const idx = sortKeys.findIndex((k) => k.col === +h.dataset.sort);
      const ic  = h.querySelector(".sort");
      let ord = h.querySelector(".sort-ord");
      h.classList.toggle("sorted", idx !== -1);
      if (idx === -1) {
        if (ic) ic.className = "bi sort bi-chevron-expand";
        if (ord) ord.remove();
      } else {
        if (ic) ic.className = "bi sort " + (sortKeys[idx].dir > 0 ? "bi-chevron-up" : "bi-chevron-down");
        if (sortKeys.length > 1) {
          if (!ord) { ord = document.createElement("sup"); ord.className = "sort-ord"; h.appendChild(ord); }
          ord.textContent = idx + 1;
        } else if (ord) { ord.remove(); }
      }
    });
  }

  // ─── selection ─────────────────────────────────────────────────
  const rowChecks = () => Array.from(tbody.querySelectorAll(".rt-chk"));
  function syncSel() {
    const selectAll = thead.querySelector("#wsSelectAll");
    const checked = rowChecks().filter((c) => c.checked);
    rowChecks().forEach((c) => c.closest("tr").classList.toggle("is-selected", c.checked));
    selCount.textContent = checked.length;
    selChip.classList.toggle("show", checked.length > 0);
    if (selectAll) {
      selectAll.checked = checked.length > 0 && checked.length === rowChecks().length;
      selectAll.indeterminate = checked.length > 0 && checked.length < rowChecks().length;
    }
    const armed = table.classList.contains("mode-select") && checked.length > 0;
    deleteBtn.classList.toggle("armed", armed);
    deleteBtn.title = armed ? "Delete " + checked.length + " selected" : "Delete mode";
  }
  thead.addEventListener("change", (e) => {
    if (e.target.id === "wsSelectAll") {
      rowChecks().forEach((c) => { c.checked = e.target.checked; });
      syncSel();
    }
  });
  tbody.addEventListener("change", (e) => {
    if (e.target.classList.contains("rt-chk")) syncSel();
  });
  selChip.addEventListener("click", () => {
    rowChecks().forEach((c) => { c.checked = false; });
    syncSel();
  });

  // ─── edit / select / delete modes — wired to the step engine ───
  // Cell edits and row deletes hit POST /api/files/:rid/steps with
  // kind=set_cell|drop_rows. The step engine returns the updated frame;
  // we refetchPage() to pick it up (preserves sort/filter/page state,
  // unlike loadFile which would reset). Single-flight: stepInFlight
  // gates concurrent step posts to avoid out-of-order writes.
  const modeBtns = $$(".rt-mode");
  function setMode(btn) {
    const turnOn = !btn.classList.contains("is-active");
    modeBtns.forEach((b) => b.classList.remove("is-active"));
    table.classList.remove("mode-edit", "mode-select", "mode-delete");
    tbody.querySelectorAll("td.editable").forEach((td) => td.removeAttribute("contenteditable"));
    rowChecks().forEach((c) => { c.checked = false; });
    syncSel();
    if (turnOn) {
      btn.classList.add("is-active");
      table.classList.add("mode-" + btn.dataset.mode);
      if (btn.dataset.mode === "edit")
        tbody.querySelectorAll("td.editable").forEach((td) => td.setAttribute("contenteditable", "true"));
    }
  }
  modeBtns.forEach((b) => b.addEventListener("click", () => {
    if (b.dataset.mode === "delete"
        && table.classList.contains("mode-select")
        && rowChecks().some((c) => c.checked)) {
      const indices = rowChecks().filter((c) => c.checked)
        .map((c) => parseInt(c.closest("tr")?.dataset.idx, 10))
        .filter((n) => Number.isFinite(n));
      if (indices.length) applyStep("drop_rows", { indices });
      return;
    }
    setMode(b);
  }));
  tbody.addEventListener("click", (e) => {
    if (!table.classList.contains("mode-delete")) return;
    const tr = e.target.closest("tr");
    if (!tr) return;
    const idx = parseInt(tr.dataset.idx, 10);
    if (Number.isFinite(idx)) applyStep("drop_rows", { indices: [idx] });
  });
  tbody.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && e.target.isContentEditable) {
      e.preventDefault();
      e.target.blur();
    }
  });

  // Cell-edit save — snapshot the value on focus, diff on blur, fire
  // set_cell only when changed. The "—" placeholder for nulls is also
  // the empty signal back to the server (params.value: "" → null).
  tbody.addEventListener("focusin", (e) => {
    const td = e.target.closest("td.editable[contenteditable=\"true\"]");
    if (td) td.dataset.original = td.textContent;
  });
  tbody.addEventListener("focusout", (e) => {
    const td = e.target.closest("td.editable[contenteditable=\"true\"]");
    if (!td) return;
    const original = td.dataset.original ?? "";
    const next = td.textContent;
    if (next === original) { delete td.dataset.original; return; }
    const tr  = td.closest("tr");
    const idx = parseInt(tr?.dataset.idx, 10);
    const column = td.dataset.col;
    if (!Number.isFinite(idx) || !column) return;
    // "—" is the rendered placeholder for null — treat it as a clear.
    const wireValue = (next === "" || next === "—") ? null : next;
    applyStep("set_cell", { row: idx, column, value: wireValue }, () => {
      td.textContent = original;  // revert on error
    });
    delete td.dataset.original;
  });

  // Single-flight POST → refetchPage on success, revert + status on error.
  // Errors land in rowsInfo (the bottom-left status text) so the table
  // stays visible — setTableState would blank it. The /steps response is
  // a StepResult (FileEnvelope + per-step metrics); we consume the
  // envelope bits to keep activeColumns + activeSteps in sync without
  // a second round-trip.
  async function applyStep(kind, params, onError) {
    if (!activeFileRid || stepInFlight) return;
    stepInFlight = true;
    rowsInfo.textContent = "Saving…";
    try {
      // DATA-ENDPOINT-ACK: caller-checks-file_type — applyStep is only
      // reachable from the cleaning toolbar, which is rendered in the
      // CSV branch of loadFile (see 6f1b70c). activeFileRid points at
      // a CSV by the time we get here.
      const res = await api.post("/files/" + encodeURIComponent(activeFileRid) + "/steps", { kind, params });
      if (res?.columns) activeColumns = res.columns;
      if (res?.steps)   activeSteps   = res.steps;
      // Server returned the rebuilt envelope — refresh the prefetch
      // cache so a tab-switch-and-return reads the post-mutation state.
      if (res) fileEnvelopeCache.set(activeFileRid, res);
      // Step landed → cached distinct values are stale for this file.
      invalidateColumnIndex(activeFileRid);
      syncToolbar();
      await refetchPage();
    } catch (err) {
      const msg = err?.body?.message || err?.body?.error || err?.message || "Save failed";
      rowsInfo.textContent = msg + (err?.status ? " (" + err.status + ")" : "");
      onError?.(err);
    } finally {
      stepInFlight = false;
    }
  }

  // ─── undo / redo / export — toolbar history actions ───────────
  // Undo/redo POST endpoints return the rebuilt FileEnvelope; consume
  // it to keep the toolbar enable state in sync, then refetchPage to
  // reflect the new frame. Export bypasses api.js — the response is
  // a binary stream; the browser handles the download via a click on
  // a hidden <a download>.
  const undoBtn   = $("#wsUndo");
  const redoBtn   = $("#wsRedo");
  const exportBtn = $("#wsExport");
  const exportDd  = $("#wsExportDd");

  async function doUndoRedo(action) {
    if (!activeFileRid || stepInFlight) return;
    stepInFlight = true;
    rowsInfo.textContent = action === "undo" ? "Undoing…" : "Redoing…";
    try {
      const env = await api.post("/files/" + encodeURIComponent(activeFileRid) + "/" + action);
      if (env?.columns) activeColumns = env.columns;
      if (env?.steps)   activeSteps   = env.steps;
      // Same cache-refresh rationale as applyStep above.
      if (env) fileEnvelopeCache.set(activeFileRid, env);
      // Undo/redo replays the step stack → cached distinct values are
      // stale (a re-applied or rewound delete-row, fill-null, etc.).
      invalidateColumnIndex(activeFileRid);
      syncToolbar();
      await refetchPage();
    } catch (err) {
      const msg = err?.body?.message || err?.body?.error || err?.message || (action + " failed");
      rowsInfo.textContent = msg + (err?.status ? " (" + err.status + ")" : "");
    } finally {
      stepInFlight = false;
    }
  }
  undoBtn.addEventListener("click", () => doUndoRedo("undo"));
  redoBtn.addEventListener("click", () => doUndoRedo("redo"));

  exportDd.addEventListener("click", (e) => {
    const item = e.target.closest(".rt-dd-item");
    if (!item || !activeFileRid) return;
    const fmt = item.dataset.fmt || "csv";
    // Hidden <a download> triggers the browser's download flow; the
    // server's Content-Disposition: attachment owns the filename.
    const a = document.createElement("a");
    a.href = "/api/files/" + encodeURIComponent(activeFileRid)
           + "/export?format=" + encodeURIComponent(fmt);
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    exportDd.classList.remove("open");
  });

  // Paint enable/disable on the three history-toolbar buttons based
  // on the current envelope state. Undo/redo derive from activeSteps;
  // export is enabled whenever a file is open. Repaints the history
  // panel body on each call so the side panel stays current after
  // every apply/undo/redo.
  function syncToolbar() {
    const canUndo = activeSteps.some((s) => s.applied);
    const canRedo = activeSteps.some((s) => !s.applied);
    undoBtn.disabled   = !canUndo;
    redoBtn.disabled   = !canRedo;
    exportBtn.disabled = !activeFileRid;
    renderHistory();
  }

  // ─── history panel — rendered list of activeSteps ─────────────
  // Applied steps render solid; undone steps (sitting on the redo
  // stack) get .is-undone for the dim opacity. Each row carries the
  // ordinal, kind, a 3-key params summary, and a relative timestamp.
  function renderHistory() {
    const body = $("#wsHistoryBody");
    if (!body) return;
    if (!activeFileRid) {
      body.innerHTML = '<p class="rt-empty rt-step-state">Open a file to see its step history.</p>';
      return;
    }
    if (!activeSteps.length) {
      body.innerHTML = '<p class="rt-empty rt-step-state">No steps applied yet.</p>';
      return;
    }
    // Server returns steps in ordinal order; show newest first so the
    // most-recent action is at the top of the panel.
    const ordered = activeSteps.slice().sort((a, b) => (b.ordinal || 0) - (a.ordinal || 0));
    body.innerHTML = ordered.map(renderStep).join("");
  }
  function renderStep(step) {
    const undone = step.applied === false;
    const params = fmtStepParams(step.params);
    return ''
      + '<div class="rt-step' + (undone ? ' is-undone' : '') + '">'
      +   '<span class="rt-step-ord">' + (step.ordinal != null ? step.ordinal : "—") + '</span>'
      +   '<span class="rt-step-body">'
      +     '<span class="rt-step-kind">' + esc(step.kind || "—") + '</span>'
      +     (params ? '<span class="rt-step-params">' + esc(params) + '</span>' : '')
      +   '</span>'
      +   '<span class="rt-step-time">' + fmtRelTime(step.created_at) + '</span>'
      + '</div>';
  }
  // Short summary of step.params — first three key=value pairs, each
  // value JSON-stringified and clipped to 30 chars. Good enough for a
  // glance at the side panel; full inspection is the file's step log.
  function fmtStepParams(params) {
    if (!params || typeof params !== "object") return "";
    try {
      return Object.entries(params).slice(0, 3)
        .map(([k, v]) => {
          const s = typeof v === "string" ? v : JSON.stringify(v);
          return k + "=" + (s && s.length > 30 ? s.slice(0, 30) + "…" : s);
        })
        .join(", ");
    } catch { return ""; }
  }
  function fmtRelTime(iso) {
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return "";
    const s = Math.round((Date.now() - t) / 1000);
    if (s < 60)         return s + "s";
    const m = Math.round(s / 60);
    if (m < 60)         return m + "m";
    const h = Math.round(m / 60);
    if (h < 24)         return h + "h";
    const d = Math.round(h / 24);
    return d + "d";
  }

  // ─── side panels ───────────────────────────────────────────────
  // Filter is left-side (its own real estate). History + Tools both
  // slide from the right and share the same surface — opening one
  // closes the other so they don't overlap.
  function bindPanel(btnSel, panelSel) {
    const btn = $(btnSel), panel = $(panelSel);
    const set = (open) => {
      panel.classList.toggle("open", open);
      btn.classList.toggle("is-active", open);
    };
    btn.addEventListener("click", () => set(!panel.classList.contains("open")));
    panel.querySelector(".rt-panel-close").addEventListener("click", () => set(false));
  }
  bindPanel("#wsFilterToggle", "#wsFilterPanel");

  // Right-side mutual exclusion — clicking one closes the other.
  const RIGHT_PANELS = [
    { btn: "#wsHistoryToggle", panel: "#wsHistoryPanel" },
    { btn: "#wsToolsToggle",   panel: "#wsToolsPanel"   },
  ];
  function toggleRightPanel(target) {
    const wasOpen = $(target.panel).classList.contains("open");
    RIGHT_PANELS.forEach((p) => {
      $(p.panel).classList.remove("open");
      $(p.btn).classList.remove("is-active");
    });
    if (!wasOpen) {
      $(target.panel).classList.add("open");
      $(target.btn).classList.add("is-active");
    }
  }
  RIGHT_PANELS.forEach((p) => {
    $(p.btn).addEventListener("click", () => toggleRightPanel(p));
    $(p.panel).querySelector(".rt-panel-close").addEventListener("click", () => {
      $(p.panel).classList.remove("open");
      $(p.btn).classList.remove("is-active");
    });
  });

  // ─── tools panel — Clean tab (parameterised, one factory + 15 configs) ─
  // The Tools panel now hosts two tabs via .rt-panel-tabs in the head
  // (same atom as the filter panel's Filter|Report split — see panel.css
  // L720-L753). Clean = the cleaning columns-redtable (this mount); Joins
  // = sibling-file join picker (mounted just below, also eagerly).
  toolsCtrl = mountTools($("#wsToolsCleanBody"), {
    fileRid: () => activeFileRid,
    columns: () => activeColumns,
    summary: () => activeSummary,  // FileSummary — per-tool context reads
    // After a step lands, the server returned a fresh envelope. The
    // simplest path: re-run loadFile on the same rid (it would normally
    // no-op since the rid is unchanged, so null the cached rid first).
    // Same trick the Refresh button uses.
    // Also invalidate the column-index cache for this file — the step
    // may have changed rows or schema, so cached distinct values are
    // stale.
    onApplied: () => {
      if (!activeFileRid) return;
      const rid = activeFileRid;
      invalidateColumnIndex(rid);
      activeFileRid = null;
      loadFile(rid);
    },
  });

  // ─── tools panel — Joins tab ───────────────────────────────────
  // Mounted eagerly (like Clean above), so loadFile()'s
  // joinsCtrl.refresh() preloads the sibling-join candidates on every
  // file open — same readiness as the Clean tab + Filter panel. With no
  // file open it renders the "open a file" placeholder (no API call).
  // (Previously lazy-mounted on first tab activate; Em asked for tab
  // parity 2026-05-29 — the picker should be ready when the tab opens.)
  const joinsBody = $("#wsToolsJoinsBody");
  if (joinsBody) {
    joinsCtrl = mountJoins(joinsBody, {
      fileRid:      () => activeFileRid,
      activeFilter: () => activeFilter,
      // POST /joins returned a fresh FileEnvelope for the new join file;
      // refresh the rail + open it so the user sees the result at once.
      onApplied: ({ newFileRid, projectRid }) => {
        if (newFileRid) refreshAndOpen(newFileRid, projectRid);
      },
    });
  }

  // ─── report builder — second tab in the filter panel ──────────
  // Edits a ReportSpec and previews it via POST /api/group/preview.
  // The builder lives in the filter panel's Report tab; the sample
  // subtotals table renders inline below the builder so the user
  // sees the result without losing the source-data table.
  //
  // Every binding here is null-guarded — when a partial is served
  // from a stale cache (without the new IDs), we don't want mount()
  // to throw and bring the whole page down via the router's error
  // shell, which then breaks the queued loadProjects continuation.
  const reportBody = $("#wsReportBody");
  if (reportBody) {
    reportCtrl = mountReport(reportBody, {
      fileRid: () => activeFileRid,
      columns: () => activeColumns,
      setStatus: (text, kind) => {
        console[(kind === "err" ? "warn" : "log")]("[report]", text);
      },
    });
  }
  const filterTabs = $("#wsFilterTabs");
  if (filterTabs) {
    filterTabs.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-tab]");
      if (!btn) return;
      setFilterPanelTab(btn.dataset.tab);
    });
  }
  // Filter / Report tab switcher in the panel head. The panel widens
  // to 500px when Report is active so the builder + sample preview
  // table have room; back to 250px on Filter.
  function setFilterPanelTab(tab) {
    const panel = $("#wsFilterPanel");
    if (!panel) return;
    panel.querySelectorAll("[data-tab]").forEach((el) => {
      const match = el.dataset.tab === tab;
      if (el.tagName === "BUTTON" && el.parentElement?.id === "wsFilterTabs") {
        el.classList.toggle("is-active", match);
      } else {
        el.hidden = !match;
        if (el.classList.contains("rt-panel-tab")
            || el.classList.contains("rt-panel-tab-foot")) {
          el.classList.toggle("is-active", match);
        }
      }
    });
    panel.classList.toggle("has-report", tab === "report");
    if (tab === "report") reportCtrl?.refresh();
  }
  $("#wsApplyReport")?.addEventListener("click", (e) => reportCtrl?.apply(e.currentTarget));
  $("#wsClearReport")?.addEventListener("click", () => reportCtrl?.clear());

  // Clean / Joins tab switcher in the Tools panel head — same atom +
  // selector shape as setFilterPanelTab above. Both tabs are mounted
  // eagerly at setup, so switching only toggles visibility.
  const toolsTabs = $("#wsToolsTabs");
  if (toolsTabs) {
    toolsTabs.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-tab]");
      if (!btn) return;
      setToolsPanelTab(btn.dataset.tab);
    });
  }
  function setToolsPanelTab(tab) {
    const panel = $("#wsToolsPanel");
    if (!panel) return;
    panel.querySelectorAll("[data-tab]").forEach((el) => {
      const match = el.dataset.tab === tab;
      if (el.tagName === "BUTTON" && el.parentElement?.id === "wsToolsTabs") {
        el.classList.toggle("is-active", match);
      } else if (el.classList.contains("rt-panel-tab")) {
        el.hidden = !match;
        el.classList.toggle("is-active", match);
      }
    });
  }

  // ─── designer — canvas + accordion config ─────────────────────
  // Mounts a no-op container at boot; load(chart) lights it up when
  // a chart-typed file is opened in loadFile. Single-tile for now
  // (the opened CHT_); dashboard files (multi-tile, new file_type)
  // are Phase 2. Source data lives on sourceCache (populated when
  // the user visits a data file); designer.js reads it for the
  // Data section + future live-preview from source.
  const designerEl = $("#wsDesigner");
  if (designerEl) {
    designerCtrl = mountDesigner(designerEl, {
      getSource: () => sourceCache,
      // The project's data files [{rid, name}] for the per-tile source
      // dropdown. Refreshed when a chart/dashboard/data file opens.
      getSourceFiles: () => projectSourceFiles.files,
      // Fires after a per-tile chart save (PUT /charts), a whole-
      // dashboard save (PUT /dashboards), or a chart delete (null).
      // Refresh the rail on delete so the dropped CHT_ row disappears;
      // update the status line + designer title on a save.
      onSaved:   (saved) => {
        if (!saved) {
          rowsInfo.textContent = "Chart deleted.";
          loadProjects();
          return;
        }
        rowsInfo.textContent = "Saved · " + (saved.title || "untitled");
        const titleSpan = $("#wsDesignerTitle")?.querySelector("span");
        if (titleSpan) titleSpan.textContent = saved.title || "Untitled";
        // A chart save may have changed the rail's stage dot; refresh.
        loadProjects();
      },
      // ds-config-save pressed while the canvas is a synthetic
      // chart-only wrapper (no real DSH_ to write to). Soft hint
      // instead of a 404 — promoting a chart to a real dashboard is
      // the separate follow-up step.
      onDashboardSaveUnavailable: () => {
        rowsInfo.textContent = "Open or create a dashboard to save a multi-chart layout — a single chart saves via its own tile.";
      },
    });
  }
  // Designer toolbar — config-panel toggle (hides/shows the accordion
  // when the user wants more canvas space).
  $("#wsDesignerCfgToggle")?.addEventListener("click", (e) => {
    const designer = $("#wsDesigner");
    if (!designer) return;
    const wasOpen = !designer.classList.contains("ds-config-hidden");
    designer.classList.toggle("ds-config-hidden", wasOpen);
    e.currentTarget.classList.toggle("is-active", !wasOpen);
    designerCtrl?.resize();
  });

  // Reset data-file state + swap the surface into designer mode.
  // mode = "chart" | "dashboard" — drives the toolbar title icon
  // (chart-bar vs grid) so the user knows which kind of file is open.
  // `data-designer-kind` is hardcoded to "dashboard" regardless of
  // mode — Em 2026-05-28: "I want only data-designer-kind='dashboard'
  // whenever user clicks on chart file or dashboard file". The
  // dashboard surface treatment covers both scenarios (a chart is a
  // single-widget dashboard); future CSS / JS that branches on the
  // attribute gets one canonical value to read.
  function enterDesignerMode(title, mode) {
    activeColumns = [];
    activeSteps   = [];
    activeSummary = null;
    syncToolbar();
    // Don't refresh the Tools / Report panels here: they're data-file
    // surfaces (hidden in designer mode via .is-designer-mode CSS), and
    // refreshing the Report builder fires a /group/preview against the
    // open CHT_/dashboard rid — which 400s with not_a_data_file. They
    // get refreshed against real columns when a data file is next opened
    // (the CSV branch of loadFile). Entering designer mode just hides
    // them.
    $("#wsSurface").classList.add("is-designer-mode");
    $("#wsSurface").dataset.designerKind = "dashboard";
    const titleSpan = $("#wsDesignerTitle")?.querySelector("span");
    if (titleSpan) titleSpan.textContent = title || "Untitled";
    const titleIcon = $("#wsDesignerTitle")?.querySelector("i");
    if (titleIcon) {
      titleIcon.className = mode === "dashboard"
        ? "bi bi-grid-1x2"
        : "bi bi-bar-chart-line";
    }
    $("#wsTable").hidden  = true;
    $("#wsTableState").hidden = true;
    $("#wsDesigner").hidden = false;
  }
  function exitDesignerMode() {
    $("#wsSurface").classList.remove("is-designer-mode");
    delete $("#wsSurface").dataset.designerKind;
    $("#wsDesigner").hidden = true;
    $("#wsTable").hidden = false;
  }

  // Ensure sourceCache holds the chart's source data file. Fetches
  // /files/:rid for the source if the user opened the chart directly
  // without visiting the source first.
  async function ensureSourceCache(sourceRid) {
    if (!sourceRid) return;
    if (sourceCache.rid === sourceRid && sourceCache.columns.length) return;
    try {
      const env = await api.get("/files/" + encodeURIComponent(sourceRid));
      sourceCache = { rid: sourceRid, columns: env?.columns || [] };
    } catch {
      // Best-effort — designer surfaces "source file unavailable" if
      // it can't fetch. Don't block chart load.
    }
  }

  // Populate projectSourceFiles with the project's data files (the ones
  // a chart can source from — charts/dashboards excluded). Cached per
  // project rid; the designer reads it synchronously via getSourceFiles
  // to fill the source-file dropdown. Best-effort — a failed fetch
  // leaves the dropdown degraded to the static current-source line.
  async function ensureProjectSourceFiles(projRid) {
    if (!projRid) return;
    try {
      const list = await api.get("/projects/" + encodeURIComponent(projRid) + "/files");
      const files = (list?.items || [])
        .filter((f) => f.file_type !== "chart" && f.file_type !== "dashboard")
        .map((f) => ({ rid: f.redpash_id, name: f.display_name || f.filename || f.redpash_id }));
      projectSourceFiles = { projRid, files };
    } catch {
      // leave the previous cache in place
    }
  }

  // Chart creation moved entirely into the dashboard view (Em
  // 2026-05-28): the rail-foot "New chart" button + its
  // createChartFromSource helper + syncNewChartButton enable-state
  // logic were removed. Charts are now created via the designer
  // toolbar's Add-chart button (#wsDesignerAddChart), which appends
  // a chart widget to the open dashboard's canvas. sourceCache still
  // feeds that path (it's set when a data file is opened) — the
  // designer reads it to source the new chart.

  // Designer-toolbar Add chart — appends a new chart as a widget to
  // the open dashboard canvas (no navigation, new tile mounts in place).
  //
  // Context recap after the 2026-05-28 unification (Em: "keep only
  // the view where Add chart doesn't remove the current chart"):
  //   - Real dashboard file (DSH_) open → dashRid is the DSH_ rid;
  //     designer.addChartWidget PUTs the new spec + mounts the tile.
  //   - Chart file (CHT_) open via the synthetic dashboard wrapper →
  //     dashRid is null. We surface a soft prompt instead of the old
  //     "create + navigate away" fallback (which Em flagged as
  //     removing the current chart). Promoting a chart-file to a real
  //     dashboard is a follow-up step.
  $("#wsDesignerAddChart")?.addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    const dashRid = designerCtrl?.getOpenDashboardRid?.();
    if (!dashRid) {
      rowsInfo.textContent = "Add chart needs a dashboard — open or create one to add more charts on this canvas.";
      return;
    }
    btn.disabled = true;
    try {
      // Resolve a source data file. Preference order:
      //   1. sourceCache (most recently opened data file).
      //   2. First non-chart / non-dashboard file in the dashboard's
      //      own project (covers "user opened the dashboard cold").
      const dashboard = designerCtrl.getOpenDashboard?.();
      const projRid   = dashboard?.project_redpash_id;
      let src = sourceCache;
      if (!src.rid && projRid) {
        const list = await api.get("/projects/" + encodeURIComponent(projRid) + "/files");
        const dataFile = (list?.items || []).find((f) =>
          f.file_type !== "chart" && f.file_type !== "dashboard");
        if (dataFile) {
          const env = await api.get("/files/" + encodeURIComponent(dataFile.redpash_id));
          src = sourceCache = { rid: dataFile.redpash_id, columns: env?.columns || [] };
        }
      }
      if (!src.rid) {
        rowsInfo.textContent = "Add chart: this project has no data file to chart yet — upload one first.";
        return;
      }
      const firstCol = src.columns[0]?.name || "";
      const chart = await api.post("/charts", {
        source_file_id: src.rid,
        title:          "Untitled chart",
        spec: { kind: "bar", group_by: firstCol, agg_col: "*", agg_fn: "count", title: "" },
      });
      // Hand off to the designer — it appends a widget to the open
      // dashboard's spec, PUTs, and mounts the tile.
      await designerCtrl?.addChartWidget?.(chart);
      // Refresh the rail so the new CHT_ row appears alongside.
      await loadProjects();
    } catch (err) {
      console.warn("[designer] addChart failed:", err);
      rowsInfo.textContent = "Add chart failed: " + (err?.body?.message || err?.message || "see console");
    } finally {
      btn.disabled = false;
    }
  });

  // + New dashboard rail button — POST /api/dashboards in the focused
  // project (group-head-clicked OR the active file's group); last-ditch
  // falls back to the first rendered group so a brand-new session with
  // a default project still routes correctly. Auto-opens the new dash.
  function activeProjectRid() {
    return focusedProjectGroup()?.dataset?.rid
        || navBody.querySelector(".rt-group")?.dataset?.rid
        || null;
  }
  $("#wsNewDashboard")?.addEventListener("click", async (e) => {
    const projRid = activeProjectRid();
    if (!projRid) {
      console.warn("[designer] + New dashboard: no active project");
      return;
    }
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      const created = await api.post("/dashboards", {
        project_redpash_id: projRid,
        title:              "Untitled dashboard",
        spec:               { template_id: "free", widgets: [] },
      });
      const newRid = created?.redpash_id;
      // A dashboard lives in the rail's Dashboards view — switch to it
      // so the new row is visible (it'd be hidden under the Data view).
      setRailView("dashboards");
      await loadProjects();
      if (newRid) {
        activeFileRid = null;
        await loadFile(newRid);
      }
    } catch (err) {
      console.warn("[designer] + New dashboard failed:", err);
    } finally {
      btn.disabled = false;
    }
  });

  // ─── new project — POST /api/projects + expand the new group ──
  // No prompt — the project lands with a placeholder name + an empty
  // file list. The hover pencil on the group head opens inline rename
  // (see enterProjectRename above); the Objects page exposes the same
  // PATCH for batch edits.
  $("#wsNewProject")?.addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      const created = await api.post("/projects", { name: "Untitled project" });
      const newRid = created?.redpash_id;
      await loadProjects();
      if (newRid) {
        // The rail allows multiple groups expanded at once — adding
        // .expanded here doesn't fight the deep-link path that already
        // opened the previously-active group. Scroll the new group
        // into view so the user sees where it landed.
        const group = navBody.querySelector('.rt-group[data-rid="' + cssEsc(newRid) + '"]');
        if (group) {
          group.classList.add("expanded");
          loadFilesForGroup(group);
          group.scrollIntoView({ block: "nearest", behavior: "smooth" });
        }
        // Seed focus to the new project — the next Upload / New chart /
        // New dashboard click should target it, even though no file
        // inside it is open yet (it's empty).
        focusedProjectRid = newRid;
      }
    } catch (err) {
      console.warn("[rail] + New project failed:", err);
    } finally {
      btn.disabled = false;
    }
  });

  // ─── refresh — re-fetch the project rail + the open file ──────
  // The rail is lazy by group; we drop the group-loaded marker so the
  // next expand re-fetches files, and re-render the project list from
  // /api/projects. Then re-load the open file (if any) to pick up any
  // server-side changes.
  $("#wsRefresh").addEventListener("click", (e) => {
    const i = e.currentTarget.querySelector("i");
    i.classList.remove("rt-spinning");
    void i.offsetWidth;
    i.classList.add("rt-spinning");
    loadProjects();
    if (activeFileRid) {
      const rid = activeFileRid;
      activeFileRid = null;        // force loadFile to re-run
      loadFile(rid);
    }
  });

  // ─── row numbers toggle — initial state from prefs, persists on click ─
  const rownumBtn = $("#wsRownum");
  const rownumOnAtMount = getPref("showRowNumbers") !== "0";
  rownumBtn.classList.toggle("is-active", rownumOnAtMount);
  table.classList.toggle("no-rownum", !rownumOnAtMount);
  rownumBtn.addEventListener("click", (e) => {
    const on = e.currentTarget.classList.toggle("is-active");
    table.classList.toggle("no-rownum", !on);
    setPref("showRowNumbers", on ? "1" : "0");
  });

  // Dropdown toggles (rows-per-page, columns) handled centrally
  // by /scripts/dropdown.js — bindDropdown() at app boot in main.js.

  // Rows-per-page — setPref persists through prefs.js (server PATCH +
  // local cache + the unified rp-pref-rowsPerPageWorkspace key). Home
  // + Monitoring keep their own per-page rows-per-page prefs; this
  // surface is workspace-scoped so the tight editing size doesn't
  // pollute the wider browse sizes on those pages.
  syncRowsDropdown();
  $("#wsRowsDd").addEventListener("click", (e) => {
    const item = e.target.closest(".rt-dd-item");
    if (!item) return;
    const raw = item.dataset.rows;
    setPref("rowsPerPageWorkspace", raw);
    pageSize = parseInt(raw, 10) || DEFAULT_PAGE_SIZE;
    currentPage = 1;
    syncRowsDropdown();
    refetchPage();
  });
  function syncRowsDropdown() {
    const raw = getPref("rowsPerPageWorkspace");
    $("#wsRowsDd").querySelectorAll(".rt-dd-item").forEach((i) => {
      i.classList.remove("selected");
      const t = i.querySelector(".tick");
      if (t) t.remove();
    });
    const sel = $("#wsRowsDd").querySelector('.rt-dd-item[data-rows="' + raw + '"]')
      || $("#wsRowsDd").querySelector('.rt-dd-item[data-rows="' + DEFAULT_PAGE_SIZE + '"]');
    if (sel) {
      sel.classList.add("selected");
      sel.insertAdjacentHTML("beforeend", ' <i class="bi bi-check2 tick"></i>');
    }
    $("#wsRowsLabel").textContent = raw + " rows";
  }
  $("#wsColsDd").addEventListener("click", (e) => e.stopPropagation());

  // ─── pager — prev / numbers / ellipsis / next ──────────────────
  // Compact window: always show 1 and last; show current ±1; collapse
  // the rest with gaps. Disabled prev/next render as <button disabled>
  // so the CSS :disabled selector handles them.
  const pagesEl = $("#wsPages");
  function renderPager() {
    if (!activeFileRid || totalPages < 1) { pagesEl.innerHTML = ""; return; }
    const p = currentPage, last = totalPages;
    const out = [];
    out.push(pgBtn("‹", p - 1, false, p === 1));
    if (last <= 7) {
      for (let i = 1; i <= last; i++) out.push(pgBtn(String(i), i, i === p, false));
    } else {
      const want = new Set([1, last, p, p - 1, p + 1]);
      let prev = 0;
      for (let i = 1; i <= last; i++) {
        if (!want.has(i)) continue;
        if (i - prev > 1) out.push('<span class="rt-pg-gap">…</span>');
        out.push(pgBtn(String(i), i, i === p, false));
        prev = i;
      }
    }
    out.push(pgBtn("›", p + 1, false, p === last));
    pagesEl.innerHTML = out.join("");
  }
  function pgBtn(label, page, active, disabled) {
    return '<button class="rt-pg' + (active ? " active" : "") + '" type="button"'
      + (disabled ? " disabled" : ' data-page="' + page + '"') + ">" + label + "</button>";
  }
  pagesEl.addEventListener("click", (e) => {
    const btn = e.target.closest(".rt-pg[data-page]");
    if (!btn) return;
    const target = parseInt(btn.dataset.page, 10);
    if (!Number.isFinite(target) || target < 1 || target > totalPages || target === currentPage) return;
    currentPage = target;
    refetchPage();
  });

}
