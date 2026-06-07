/* Purpose: see doc for details.
 * Doc: docs/internal/code/frontend/scripts/pages/workspace.md */
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
import { mountRail } from "/scripts/framework/rail.js";
import { mountTools } from "/scripts/tools.js";
import { mountJoins } from "/scripts/joins.js";
import { mountReport } from "/scripts/report.js";
import { attachAutocomplete, mountChipPicker } from "/scripts/autocomplete.js";
import { invalidateFile as invalidateColumnIndex } from "/scripts/column-index.js";
import { getEngine, warmWorkerEngine, workerSort } from "/scripts/wasm-engine.js";
import { getPref, setPref } from "/scripts/prefs.js";
import { heroStripHTML, createListCharts } from "/scripts/list-page.js";
import { createVirtualRows } from "/scripts/virtual-rows.js";
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

  // Warm the wasm engine cache — the user is on the workspace, they're
  // going to do data work, so trigger the lazy fetch now and await
  // later from whichever surface needs it. Fire-and-forget: any load
  // error stays silent until a real call happens (then surfaces there).
  warmWorkerEngine(); // compile the wasm in the worker, where the ops will run

  // ─── element refs ──────────────────────────────────────────────
  // `nav` (#wsNav) becomes the .rp-rail root that mountRail fills; rail DOM
  // queries go through it. The projects→files body, search, chips, footer are
  // all built by mountRail (D0') — no #wsNavBody/#wsGroupList hand-built nodes.
  const nav        = $("#wsNav");
  const table      = $("#wsTable");
  const thead      = table.tHead;
  const tbody      = table.tBodies[0];
  const tableWrap  = table.closest(".rp-table-wrap");  // scroll container for virtual rows
  const tableState = $("#wsTableState");
  const colsDd     = $("#wsColsDd");
  const rowsInfo   = $("#wsRowsInfo");
  const selChip    = $("#wsSelChip");
  const selCount   = $("#wsSelCount");
  const deleteBtn  = app.querySelector('.rp-toolbar-mode[data-mode="delete"]');
  const groupList  = $("#wsGroupList"); // filter-builder condition-group container (NOT the rail)

  // ─── state ─────────────────────────────────────────────────────
  let activeFileRid = null;
  let activeColumns = [];   // ColumnMeta[] for the open file
  let activeSteps   = [];   // ProjectStep[] — drives undo/redo enable
  let activeSummary = null; // FileSummary — drives per-tool context renderers
  // The project the user is currently focused on — independent of which
  // file (if any) is open. Updates on group-head click, on file open
  // (inherits the file's project), and on the initial deep-link expand.
  // Read by activeProjectName so the rail-foot New Project button (and
  // Upload) target the visible project even when the user clicked a group
  // head without opening a file inside it.
  let focusedProjectRid = null;
  let sortKeys      = [];   // [{ col, dir, isDate }] — col is display-column-index (≥3)
  let searchQ       = "";
  let activeFilter  = null; // FilterNode tree (see shared::filter::FilterNode) — null = no filter
  let searchDebounce = null;
  // ─── client engine — sort over the loaded set in WASM, no round-trip ──
  // A data file at/under this row cap loads its full (server-filtered +
  // searched) result set into clientBuffer; SORT + PAGING then run
  // client-side over it via the wasm engine (apply_sort) — instant, no
  // server gesture. Larger files keep the server page path. Filter +
  // search still hit the server (the wasm apply_filter is the FLAT
  // filter_rows step, not the nested query FilterNode, and there's no
  // search wrapper — moving them client-side needs new wasm wrappers, a
  // follow-up). "Gated by capacity, not capability" — see
  // subsystems/wasm-engine.md. Em 2026-06-01.
  // 500k to cover the real-world 400k-row file (CAS_21B43BEC) without a tab
  // freeze: the sort runs in engine.worker.js (off-thread) so at 400k it's a
  // ~2.4 s SPINNER, not a lock. Residual main-thread costs at 400k are janks,
  // not freezes: ~300 ms to JSON.parse the /page response (in api.js) + ~117 ms
  // to structured-clone the buffer to the worker per sort + ~33 ms coerce.
  // (Driving those to ~0 needs a stateful worker that holds the frame + returns
  // only the visible page — the scale-past-500k follow-up.) MUST stay ≤ the
  // server /page size clamp (raised in lockstep to 500_000 in files/mod.rs +
  // data/parse/mod.rs) or the buffer truncates (completeness guard → server mode).
  const CLIENT_ENGINE_ROW_CAP = 500000;
  let clientMode    = false;  // active file is under the cap → client sort/page
  let clientBuffer  = null;   // { cells: string[][], idxs: number[], typed: object[] } | null
  // Rail filter state — both ephemeral per visit (no pref): a deep-link
  // into a project must never be hidden by a stale persisted filter.
  // ownerFilter ∈ {all, personal, shared, company}; railSearchQ matches
  // project AND file names (file-aware). Filtering happens in buildGroups, not DOM.
  let ownerFilter      = "all";
  let railSearchQ      = "";
  let cachedProjects   = []; // last /projects roster — feeds the rail + landing
  // ─── rail data-model (D0' — mountRail re-renders the body from this) ──
  // filesByGroup: projRid → raw file items[] (lazy-loaded on first expand).
  // expanded: which group rids are open (synced from mountRail's group-toggle).
  // uploadGhosts: projRid → in-flight upload placeholders [{tmpId,name,state}].
  const filesByGroup  = new Map();
  const expanded      = new Set();
  const uploadGhosts  = new Map();
  let creatingProject = false;          // New-project in-flight guard
  let toolsCtrl     = null; // mountTools' control surface — refresh() rebuilds the open form / columns view
  let joinsCtrl     = null; // mountJoins' control surface — refresh() re-fetches sibling candidates
  let reportCtrl    = null; // mountReport's control surface — refresh() rebuilds the open builder

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
  let selectedRows  = new Set();  // absolute frame idx of selected rows (current page) — survives row recycling
  let renderColumns = [];         // columns for the active page — read by renderRow
  let measuredRowH  = 38;         // redtable row height; re-measured per render (density-aware)
  let vrows         = null;       // virtual-rows controller for the data grid (created on first renderTable)
  let stepInFlight  = false;

  // The wire-level pref ("10" / "25" / "50" / "100" / "all") into the
  // numeric pageSize the fetch uses.
  function pageSizeFromPref() {
    const n = parseInt(getPref("workspace-rowsPerPage") || "", 10);
    return Number.isFinite(n) && n > 0 ? n : DEFAULT_PAGE_SIZE;
  }

  // ─── rail — the framework mountRail component (D0', the same one
  //     admin-console / sheetwise / database use). The page owns a groups
  //     data-model (cachedProjects + filesByGroup + expanded + uploadGhosts +
  //     the hidden prefs); a re-render is rail.setGroups(buildGroups(),
  //     buildHidden()), never DOM surgery. mountRail builds the head/search/
  //     chips/body/footer + collapse + inline-rename + footer-nav. ──
  // Group-mark colours as CSS tokens (mountRail fills the square via --mark);
  // distinct from MARK_COLORS (the data-c names the landing cards still use).
  const MARK_TOKENS = ["var(--rp-info)", "var(--rp-mauve)", "var(--rp-teal)", "var(--rp-peach)"];
  const railConfig = {
    title: "Projects",
    collapsible: true,
    // File-aware search: re-render immediately on the loaded groups, then load
    // the rest of the groups' file lists so a file name inside a collapsed group
    // also matches (global, not just the expanded projects).
    search: { placeholder: "Search files + projects…", onInput: (q) => {
      railSearchQ = q;
      refreshRail();
      if (q.trim()) ensureAllFilesLoaded().then(refreshRail);
    } },
    chips: [
      { value: "all",      label: "All", active: true },
      { value: "personal", label: "Personal" },
      { value: "shared",   label: "Shared" },
      { value: "company",  label: "Company" },
    ],
    onChip: (v) => {
      ownerFilter = v;
      rail.el.querySelectorAll(".rp-rail-chips .rp-chip").forEach((c) => c.classList.toggle("is-active", c.dataset.chip === v));
      refreshRail();
    },
    overview: { label: "Overview", icon: "bi-grid-1x2-fill", active: false },
    onOverview: () => goToLanding(),
    groups: [],
    // Upload lives in the data toolbar (not the rail foot, per CAS_37B2E1BF/D2);
    // the rail foot is the single New-project create button.
    footer: { create: { label: "New project" }, nav: { active: "", session } },
    on: {
      tab:         (tabId) => { if (!String(tabId).startsWith("__ghost")) { setActiveTab(tabId); loadFile(tabId); } },
      visualize:   (tabId) => { location.hash = "#/dashboard?source=" + encodeURIComponent(tabId); },
      groupToggle: (groupId, collapsed) => {
        if (collapsed) expanded.delete(groupId); else expanded.add(groupId);
        focusedProjectRid = groupId;
        // Invalidate on expand so a collapse→re-expand re-fetches the group's
        // files — external writes (connector / Kafka loader / another tab) must
        // become visible without a full reload (parity with the old gate-clear).
        if (!collapsed) { filesByGroup.delete(groupId); loadFilesForGroup(groupId); }
      },
      groupRename: (groupId, value) => renameProject(groupId, value),
      groupHide:   (groupId) => hideProject(groupId),
      tabRename:   (tabId, value) => renameFile(tabId, value),
      tabHide:     (tabId) => hideFile(tabId),
      restore:     (id, kind) => { unhideOne(kind === "project" ? HIDDEN_PROJECTS_KEY : HIDDEN_FILES_KEY, id); refreshRail(); },
      create:      () => newProject(),
    },
  };
  const rail = mountRail(nav, railConfig);

  // ─── rail data-model → mountRail groups / hidden ──────────────
  function ownershipTokens(p) {
    const t = [p.owner_id === meRid ? "personal" : "shared"];
    if (p.company_id) t.push("company");
    return t;
  }
  // Rail search is file-AWARE: a group shows if its project name matches OR any of
  // its DATA files match. A file-only match shows the group expanded with just the
  // matching files. Mark colour keyed to the unfiltered roster index (stable across
  // filtering). Ownership chip is AND-ed with the query.
  function buildGroups() {
    const q = railSearchQ.trim().toLowerCase();
    const hiddenProjSet = new Set(getHidden(HIDDEN_PROJECTS_KEY).map((x) => x.rid));
    const hiddenFileSet = new Set(getHidden(HIDDEN_FILES_KEY).map((x) => x.rid));
    const colorOf = new Map(cachedProjects.map((p, i) => [p.redpash_id, MARK_TOKENS[i % MARK_TOKENS.length]]));
    return cachedProjects
      .filter((p) => !hiddenProjSet.has(p.redpash_id))
      .map((p) => {
        const id = p.redpash_id;
        if (ownerFilter !== "all" && !ownershipTokens(p).includes(ownerFilter)) return null;
        const nameMatch = !q || (p.name || "").toLowerCase().includes(q);
        // DATA files only — charts/dashboards live on #/dashboard (D2).
        const dataFiles = (filesByGroup.get(id) || [])
          .filter((f) => !hiddenFileSet.has(f.redpash_id) && f.file_type !== "chart" && f.file_type !== "dashboard");
        const matchFiles = q ? dataFiles.filter((f) => (f.display_name || f.filename || "").toLowerCase().includes(q)) : dataFiles;
        if (q && !nameMatch && !matchFiles.length) return null;     // no project- or file-match → hide
        const shown = (q && !nameMatch) ? matchFiles : dataFiles;   // file-only match → show just the hits
        const fileTabs = shown.map((f) => ({
          id: f.redpash_id,
          name: f.display_name || f.filename || "(unnamed)",
          icon: "bi-filetype-csv",
          dot: STAGE_DOT[f.stage] || "is-dirty",
          renamable: true, hidable: true,
          active: f.redpash_id === activeFileRid,
          actions: [{ action: "visualize", cls: "visualize", icon: "bi-bar-chart-line", title: "Visualize — chart this file in the designer" }],
        }));
        // In-flight upload placeholders: state "queued"|"active"|"done"|"failed"
        // (all truthy → the dimmed rp-rail-tab-ghost base; "active" shimmers).
        // A failed ghost carries its error message as the tab title (hover).
        // Hidden during a file-only search (they're not search hits).
        const ghostTabs = (q && !nameMatch) ? [] : (uploadGhosts.get(id) || []).map((g) => ({
          id: g.tmpId, name: g.name, icon: "bi-arrow-up-circle",
          ghost: g.state, busy: g.state === "active", title: g.title || "",
        }));
        return {
          id, name: p.name,
          mark: colorOf.get(id),
          // file_count (roster approximation) until the group's files load,
          // then the real (shown) tab count.
          count: filesByGroup.has(id) ? (fileTabs.length + ghostTabs.length) : (p.file_count || 0),
          collapsed: q ? false : !expanded.has(id),                 // expand matches while searching
          renamable: true, hidable: true,
          tabs: [...fileTabs, ...ghostTabs],
        };
      })
      .filter(Boolean);
  }
  function buildHidden() {
    const hp = getHidden(HIDDEN_PROJECTS_KEY);
    const hf = getHidden(HIDDEN_FILES_KEY);
    const sections = [];
    if (hp.length) sections.push({ title: "Projects", items: hp.map((p) => ({ id: p.rid, kind: "project", name: p.name })) });
    if (hf.length) sections.push({ title: "Files", items: hf.map((f) => ({ id: f.rid, kind: "file", name: f.name, meta: f.project })) });
    return sections;
  }
  function refreshRail() {
    railConfig.overview.active = $("#wsSurface")?.classList.contains("is-landing-mode") || false;
    const groups = buildGroups();
    // When a search/owner filter hides every project (but projects exist), show
    // the "no match" feedback rather than a blank rail (distinct from "no projects").
    let emptyText = "";
    if (!groups.length && cachedProjects.length) {
      const q = railSearchQ.trim();
      emptyText = q ? "No files or projects match “" + q + "”." : "No projects in this filter.";
    }
    rail.setGroups(groups, buildHidden(), emptyText);
  }
  // Lightweight active-tab highlight (avoids a full setGroups on each open).
  function setActiveTab(rid) {
    nav.querySelectorAll(".rp-rail-tab.active").forEach((t) => t.classList.remove("active"));
    if (rid) nav.querySelector('.rp-rail-tab[data-tab-id="' + cssEsc(rid) + '"]')?.classList.add("active");
  }
  function activeProjectRid() {
    return focusedProjectRid
      || cachedProjects.find((p) => p.is_default)?.redpash_id
      || cachedProjects[0]?.redpash_id || null;
  }

  // ─── rail mutations (the on{} handlers) ───────────────────────
  async function renameProject(rid, value) {
    const next = (value || "").trim();
    if (!next) return;
    try {
      const updated = await api.patch("/projects/" + encodeURIComponent(rid), { name: next });
      const p = cachedProjects.find((x) => x.redpash_id === rid);
      if (p) p.name = updated?.name || next; // canonical (server may normalise)
    } catch { /* leave the optimistic inline value; next loadProjects corrects */ }
    refreshRail(); // re-render → new name + derived mark initials
  }
  async function renameFile(rid, value) {
    const next = (value || "").trim();
    if (!next) return;
    try {
      const updated = await api.patch("/files/" + encodeURIComponent(rid), { display_name: next });
      const canonical = updated?.summary?.display_name || updated?.display_name || next;
      for (const items of filesByGroup.values()) {
        const f = items.find((x) => x.redpash_id === rid);
        if (f) { f.display_name = canonical; break; }
      }
    } catch { /* keep optimistic value */ }
    fileEnvelopeCache.delete(rid); // summary stale → loadFile refetches
    refreshRail();
  }
  function hideProject(rid) {
    const p = cachedProjects.find((x) => x.redpash_id === rid);
    hideOne(HIDDEN_PROJECTS_KEY, { rid, name: p?.name || rid });
    if (focusedProjectRid === rid) focusedProjectRid = null;
    refreshRail();
  }
  function hideFile(rid) {
    let entry = { rid, name: rid };
    for (const p of cachedProjects) {
      const f = (filesByGroup.get(p.redpash_id) || []).find((x) => x.redpash_id === rid);
      if (f) { entry = { rid, name: f.display_name || f.filename || rid, project: p.name }; break; }
    }
    hideOne(HIDDEN_FILES_KEY, entry);
    if (activeFileRid === rid) {
      // The open file just left the rail — blank the surface back to the prompt.
      activeFileRid = null; activeColumns = []; activeSteps = [];
      rowIndices = []; totalPages = 1; renderPager(); syncToolbar();
      setTableState("Open a file from the rail to see its data.");
      rowsInfo.textContent = "No file open.";
    }
    refreshRail();
  }
  async function newProject() {
    if (creatingProject) return;
    creatingProject = true;
    try {
      const created = await api.post("/projects", { name: "Untitled project" });
      const newRid = created?.redpash_id;
      if (newRid) { focusedProjectRid = newRid; expanded.add(newRid); }
      await loadProjects();
      if (newRid) nav.querySelector('.rp-rail-group[data-group-id="' + cssEsc(newRid) + '"]')
        ?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    } catch (err) {
      console.warn("[rail] + New project failed:", err);
    } finally { creatingProject = false; }
  }

  // Landing click → open that project. Both the recent cards (row 2)
  // and the projects-table rows (row 3) carry data-rid. Delegated; the
  // container persists across renderLanding rebuilds.
  $("#wsLanding")?.addEventListener("click", (e) => {
    // Landing Upload CTA — the data toolbar (where Upload also lives) is hidden
    // in landing mode, so the empty/overview surface carries its own trigger
    // for the same hidden #wsUploadInput (CAS_37B2E1BF).
    if (e.target.closest("#wsLandingUpload")) { $("#wsUploadInput")?.click(); return; }
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
    const targetRid  = activeProjectRid();
    const targetName = activeProjectName();
    const total = files.length;
    const labelEl = uploadBtn.querySelector("span");
    const originalLabel = labelEl?.textContent;

    uploadBtn.disabled = true;
    uploadBtn.classList.add("is-busy");

    // Ghost placeholder tabs in the target group's data-model — expanded so
    // the user sees them appear. Sequential upload: one "active" (shimmering)
    // at a time. mountRail renders the ghost state from each tab's `ghost`.
    const ghosts = files.map((f, i) => ({ tmpId: "__ghost_" + i + "_" + f.name, name: f.name, state: "queued", title: "" }));
    if (targetRid) {
      expanded.add(targetRid);
      uploadGhosts.set(targetRid, ghosts);
      if (!filesByGroup.has(targetRid)) await loadFilesForGroup(targetRid);
      else refreshRail();
    }

    let succeeded  = 0;
    let lastEnv    = null;
    const failures = [];

    for (let i = 0; i < total; i++) {
      const file = files[i];
      ghosts[i].state = "active"; refreshRail();
      if (labelEl) {
        labelEl.textContent = total === 1
          ? "Uploading…"
          : "Uploading " + (i + 1) + " of " + total + "…";
      }
      const fd = new FormData();
      fd.append("file", file);
      if (targetName) fd.append("project_name", targetName);
      try {
        // FormData → api.js skips JSON encoding (sees the instance type).
        const env = await api.post("/files/upload", fd);
        if (!env?.summary?.redpash_id) {
          throw new Error("upload succeeded but the server returned no file id");
        }
        lastEnv = env;
        succeeded++;
        ghosts[i].state = "done"; refreshRail();
      } catch (err) {
        const msg = err?.body?.message || err?.body?.error || err?.message || "upload failed";
        failures.push({ name: file.name, msg, status: err?.status });
        ghosts[i].state = "failed"; ghosts[i].title = msg; refreshRail();
      }
    }

    // Reload the target group's real files + open the last success. Failed
    // ghosts LINGER ~6s (with their hover tooltip) so the user can read the
    // cause; the rest are dropped now.
    const failed = ghosts.filter((g) => g.state === "failed");
    if (targetRid) {
      filesByGroup.delete(targetRid);
      if (failed.length) uploadGhosts.set(targetRid, failed); else uploadGhosts.delete(targetRid);
    }
    if (lastEnv) {
      // openNewFile re-fetches the roster (so a brand-new project appears),
      // reloads the group, opens the file + highlights it.
      await openNewFile(lastEnv.summary.redpash_id, lastEnv.summary.project_redpash_id || targetRid);
    } else if (targetRid) {
      await loadFilesForGroup(targetRid);
    }
    if (failed.length && targetRid) {
      setTimeout(() => {
        if (uploadGhosts.get(targetRid) === failed) { uploadGhosts.delete(targetRid); refreshRail(); }
      }, 6000);
    }

    // Status line summary — same three shapes as before (all-failed / mixed /
    // all-succeeded-but-multi). Single-file success leaves loadFile's status.
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

  // The focused project's NAME (upload target via ?project_name=). Resolved
  // from the data-model (cachedProjects), not the DOM. Returns null → the
  // server falls back to the user's default project.
  function activeProjectName() {
    const rid = activeProjectRid();
    return cachedProjects.find((p) => p.redpash_id === rid)?.name || null;
  }

  // ─── rail — load projects + deep-link (one-time) ───────────────
  // #/workspace?project=&file= deep-link (Home links here). A chart rid
  // (CHT_) belongs to #/dashboard now (D2) → hand off before building.
  (async () => {
    const params  = new URLSearchParams(location.hash.split("?")[1] || "");
    const wantRid  = params.get("project");
    const wantFile = params.get("file");
    if (wantFile && wantFile.startsWith("CHT_")) { location.hash = "#/dashboard"; return; }
    if (wantRid) focusedProjectRid = wantRid;
    await loadProjects();
    if (wantFile) {
      activeFileRid = null; await loadFile(wantFile); setActiveTab(wantFile);
    } else if (wantRid) {
      // ?project= without ?file= → open that project's first DATA file (parity
      // with the old auto-open); fall back to the landing if it has none.
      const first = (filesByGroup.get(wantRid) || []).find(
        (f) => f.file_type !== "chart" && f.file_type !== "dashboard");
      if (first) { activeFileRid = null; await loadFile(first.redpash_id); setActiveTab(first.redpash_id); }
      else showLanding();
    } else if (!activeFileRid) {
      showLanding();
    }
  })();

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
    let data;
    try {
      data = await api.get("/projects");
    } catch (err) {
      rail.setGroups([], []);
      rowsInfo.textContent = "Couldn’t load projects" + (err.status ? " (" + err.status + ")" : "") + ".";
      return;
    }
    cachedProjects = data?.items || [];
    // Focus the deep-linked/kept project, else the default/first; expand it.
    // Refresh-safe: only seeds focus when unset, so a rename/hide/create
    // re-render keeps the current focus.
    if (!focusedProjectRid) {
      const def = cachedProjects.find((p) => p.is_default) || cachedProjects[0];
      focusedProjectRid = def?.redpash_id || null;
    }
    if (focusedProjectRid) expanded.add(focusedProjectRid);
    refreshRail();
    if (focusedProjectRid) await loadFilesForGroup(focusedProjectRid);
  }

  // ─── landing surface — the default overview (no file open) ─────
  // The second surface mode alongside the data redtable: .is-landing-mode
  // on #wsSurface (workspace.css) hides the toolbar / body / pager and
  // shows #wsLanding. The Workspace twin of the Cases board — recent
  // projects + a stats strip. Opening any file (rail click or a landing
  // card) calls hideLanding() and takes over the surface.
  // The pinned "Overview" pseudo-tab is mountRail's `overview` config (rendered
  // by setGroups). setLandingTabActive lightly toggles its active class (+ keeps
  // railConfig.overview.active in sync so a setGroups re-render paints it right).
  function setLandingTabActive(on) {
    railConfig.overview.active = on;
    const ov = nav.querySelector(".rp-rail-overview .rp-rail-tab");
    if (on) nav.querySelectorAll(".rp-rail-tab.active").forEach((t) => t.classList.remove("active"));
    ov?.classList.toggle("active", on);
  }
  // Explicit return-to-overview (the Overview rail click). Drops the
  // open file so re-clicking its tab re-opens it (loadFile early-returns
  // on the same rid), then shows the landing.
  function goToLanding() {
    activeFileRid = null;
    showLanding();
  }
  function showLanding() {
    $("#wsSurface").classList.add("is-landing-mode");
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
      : '<p class="rp-empty">No projects yet — use the Upload button to add your first data file.</p>';
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
      +   '<div class="ws-landing-section-head">'
      +     '<h3 class="ws-landing-section-title">Recent projects</h3>'
      +     '<button class="rp-btn-icon rp-btn-icon--glass" id="wsLandingUpload" type="button" title="Upload a data file into the active project">'
      +       '<i class="bi bi-upload"></i><span>Upload</span></button>'
      +   '</div>'
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
    if (!projects.length) return '<p class="rp-empty ws-landing-table-empty">No projects.</p>';
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
    return '<table class="rp-redtable rp-table">'
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
      +   '<span class="rp-rail-group-mark" data-c="' + color + '">' + esc(initials) + '</span>'
      +   '<span class="ws-landing-card-body">'
      +     '<span class="ws-landing-card-name">' + esc(p.name || "(untitled)") + '</span>'
      +     '<span class="ws-landing-card-meta">' + files + ' file' + (files === 1 ? "" : "s")
      +       ' · ' + esc(stage) + '</span>'
      +   '</span>'
      +   '<span class="rp-rail-tab-dot ' + dot + '" title="' + esc(stage) + '"></span>'
      + '</button>';
  }
  // Landing card → open the project: expand its rail group, load files,
  // open the first one (which hides the landing). Empty project keeps the
  // landing up but reflects the focus + an empty table prompt.
  async function openProjectFromLanding(rid) {
    focusedProjectRid = rid;
    expanded.add(rid);
    await loadFilesForGroup(rid);
    // Open the project's first DATA file, or keep the landing with an empty
    // prompt. filesByGroup holds the raw items; pick the first non-chart/-dash.
    const first = (filesByGroup.get(rid) || []).find(
      (f) => f.file_type !== "chart" && f.file_type !== "dashboard");
    if (first) {
      activeFileRid = null;
      await loadFile(first.redpash_id);
      setActiveTab(first.redpash_id);
    } else {
      hideLanding();
      activeFileRid = null;
      setTableState("This project has no files yet — upload one from the rail.");
      rowsInfo.textContent = "No file open.";
    }
  }

  // Lazy-load a group's files (DATA files + any in-flight upload ghosts share
  // the data-model) on first expand + idle-prewarm their envelopes, then
  // re-render the rail. buildGroups does the data-only filter + tab shaping.
  async function loadFilesForGroup(rid) {
    if (!rid || filesByGroup.has(rid)) return;
    try {
      const data = await api.get("/projects/" + encodeURIComponent(rid) + "/files");
      const items = data?.items || [];
      filesByGroup.set(rid, items);
      prewarmGroupFiles(items);
    } catch { filesByGroup.set(rid, []); }
    refreshRail();
  }

  // Rail search is GLOBAL — to match files inside not-yet-expanded groups, load
  // every group's file list once (concurrently). No prewarm here (we only need
  // names to match); the per-group lazy-load still prewarms on real expand.
  async function ensureAllFilesLoaded() {
    const pending = cachedProjects.filter((p) => !filesByGroup.has(p.redpash_id));
    if (!pending.length) return;
    await Promise.all(pending.map(async (p) => {
      const rid = p.redpash_id;
      try {
        const data = await api.get("/projects/" + encodeURIComponent(rid) + "/files");
        filesByGroup.set(rid, data?.items || []);
      } catch { filesByGroup.set(rid, []); }
    }));
  }

  // Open a freshly-created file (upload result / join output): re-fetch the
  // project roster (so a BRAND-NEW project — e.g. first upload into an empty
  // workspace, server find-or-create — actually appears in cachedProjects),
  // focus + expand that project, then open the file + highlight its tab.
  // Shared by upload + the Joins panel.
  async function openNewFile(newRid, projRid) {
    if (projRid) {
      filesByGroup.delete(projRid);   // force the group's files to re-list
      focusedProjectRid = projRid;
      expanded.add(projRid);
    }
    await loadProjects();             // re-fetch roster (+ reloads the focused group)
    activeFileRid = null;
    await loadFile(newRid);
    setActiveTab(newRid);
  }

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

  async function loadFile(rid) {
    if (!rid || rid === activeFileRid) return;
    // Charting left Workspace (Slice D): a chart rid (CHT_ prefix) opens on
    // the standalone #/dashboard page, not a dead designer surface here.
    // Caught before any surface mutation so a stray click just navigates.
    if (rid.startsWith("CHT_")) { location.hash = "#/dashboard"; return; }
    hideLanding();   // opening any file leaves the overview surface
    activeFileRid = rid;
    // Reset all per-file state — column-indexed knobs only make sense
    // against the columns we're about to fetch.
    sortKeys = []; activeFilter = null; searchQ = "";
    clientMode = false; clientBuffer = null;
    currentPage = 1;
    $("#wsRowSearch").value = "";
    $("#wsFilterToggle").classList.remove("has-filter");
    setTableState("Loading…");
    rowsInfo.textContent = "Loading…";
    try {
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
      // A FIL_-prefixed row whose file_type is chart/dashboard (a
      // deep-link or a stored rid that resolves to one) also belongs to
      // #/dashboard — hand off rather than render a dead surface. The rail
      // filters these out (buildGroups), so this only fires for an external
      // #/workspace?file=… deep-link to a chart/dashboard.
      const fileType = envelope?.summary?.file_type;
      if (fileType === "chart" || fileType === "dashboard") {
        activeFileRid = null;
        location.hash = "#/dashboard";
        return;
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
      rebuildColsDropdown(activeColumns);
      rebuildFilterCols(activeColumns);
      // Data-file panels — Tools (cleaning + joins) + Report builder.
      toolsCtrl?.refresh();
      // workspace-joinsAutoDetect (default "1") gates the auto-refresh of
      // the sibling-join candidates on every file open. Joins detection is
      // expensive on large projects (one POST /joins per open) — off lets
      // the user trigger via the Joins tab when they actually need it.
      if (getPref("workspace-joinsAutoDetect") !== "0") {
        joinsCtrl?.refresh();
      }
      reportCtrl?.refresh();
      // Capacity gate: small files render through the client engine (full
      // set buffered, sort/page client-side); big files keep the server
      // page path.
      clientMode = (envelope?.summary?.row_count || 0) <= CLIENT_ENGINE_ROW_CAP;
      if (clientMode) await refreshClientBuffer();
      else            await fetchAndRender();
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
    // clientMode: the filtered/searched set may have changed (filter,
    // search, step) — re-pull the full set into the buffer. SORT + paging
    // gestures bypass this and call clientRender() directly (no fetch).
    try { await (clientMode ? refreshClientBuffer() : fetchAndRender()); }
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

  // ─── client engine — full-set buffer + client-side sort/page ─────
  // coerceCell: a /page cell arrives as a STRING (the endpoint stringifies
  // every value). Coerce to the column's STORAGE dtype so the wasm engine
  // — which infers a column's type from the JSON value — sorts numerics
  // numerically, matching the server (which sorts the parsed frame by
  // storage dtype). Date/string stay strings → lexical (ISO / YYYY-MM-DD
  // sorts correctly; other date formats are a typed-date follow-up).
  function coerceCell(v, col) {
    if (v == null || v === "") return null;
    const dt = col && col.dtype;
    if (dt === "int" || dt === "float") { const n = Number(v); return Number.isNaN(n) ? v : n; }
    if (dt === "bool") return v === "true" || v === "1";
    return v;
  }

  // refreshClientBuffer: pull the ENTIRE current result set (server
  // applies filter + search; NO `sorts` param — sort is client-side now),
  // coerce it once into a typed buffer, then render. Called on open and
  // whenever the filtered/searched set changes (filter, search, step).
  async function refreshClientBuffer() {
    if (!activeFileRid) return;
    const params = new URLSearchParams();
    params.set("page", "1");
    params.set("size", String(CLIENT_ENGINE_ROW_CAP + 1)); // whole file (≤ cap)
    if (searchQ) params.set("q", searchQ);
    if (activeFilter) params.set("filters", JSON.stringify(activeFilter));
    // DATA-ENDPOINT-ACK: caller-checks-file_type — refreshClientBuffer
    // only runs when clientMode is set, and clientMode is set only in
    // loadFile's data (CSV) branch after the file_type switch, so
    // activeFileRid points at a data file here (same as fetchAndRender).
    const pageData = await api.get(
      "/files/" + encodeURIComponent(activeFileRid) + "/page?" + params.toString());
    const cells = pageData?.rows || [];
    const total = pageData?.total ?? cells.length;
    // CORRECTNESS GUARD (Em 2026-06-01): the client engine may only
    // sort/page a COMPLETE buffer. If the server clamped the fetch below
    // the full result-set size (cap > the /page size clamp, or the set
    // exceeds the cap), sorting the buffer would silently order a
    // TRUNCATED subset → a wrong global sort. Refuse: drop to server-mode
    // (sorts the full frame) instead. Makes a partial sort impossible
    // regardless of how CLIENT_ENGINE_ROW_CAP is set vs the server clamp.
    if (total > cells.length) {
      clientMode = false;
      clientBuffer = null;
      await fetchAndRender();
      return;
    }
    const idxs  = pageData?.row_indices || cells.map((_, i) => i);
    // Coerce ONCE; each typed row carries __p = its buffer position so a
    // sort's output order maps back to the original (uncoerced) string
    // cells — display never drifts from the coercion.
    const typed = cells.map((row, p) => {
      const o = { __p: p };
      activeColumns.forEach((c, ci) => { o[c.name] = coerceCell(row[ci], c); });
      return o;
    });
    clientBuffer = { cells, idxs, typed, ms: pageData?.ms };
    await clientRender();
  }

  // clientRender: sort the buffer via the wasm engine (stacked single-
  // column sorts, least-significant key first — the wrapper sorts one
  // column at a time; multi-key relies on a stable sort), then render the
  // WHOLE buffer through the row-virtualizer. No server round-trip, and —
  // crucially — NO pagination: the buffer holds the entire file (≤ cap),
  // and createVirtualRows windows the DOM (~40 <tr>, not N), so the user
  // scrolls the full file smoothly, "everything loaded" (Em's Ubuntu-22
  // snappiness; the 25-row page window was the regression). Engine failure
  // falls back to buffer order so a sort gesture never blanks the grid.
  async function clientRender() {
    if (!clientBuffer) return;
    const { cells, idxs, typed } = clientBuffer;
    let order = typed.map((_, i) => i);
    if (sortKeys.length) {
      // Display-col index (≥3) → engine column name; drop keys whose column is gone.
      const specs = sortKeys
        .map((k) => { const meta = activeColumns[k.col - 3]; return meta ? { col: meta.name, desc: k.dir < 0 } : null; })
        .filter(Boolean);
      if (specs.length) {
        // Cue: the worker sort is async (≤~1.2 s at the 200k cap); the table
        // stays live so show progress in the row-count line (replaced with the
        // real count when clientRender finishes below).
        rowsInfo.textContent = "sorting…";
        try {
          // Off the main thread (engine.worker.js): the sort over the full
          // buffer never freezes the tab, and only the ~N-int permutation
          // crosses back, not the re-serialized rows.
          order = await workerSort(typed, specs);
        } catch (_err) {
          // Fallback 1 — main-thread engine: correct, but may freeze a big buffer
          // (only hit if the worker is unavailable/crashed).
          try {
            const eng = await getEngine();
            let rows = typed;
            for (let k = specs.length - 1; k >= 0; k--) {
              rows = JSON.parse(eng.apply_sort(JSON.stringify(rows), specs[k].col, specs[k].desc));
            }
            order = rows.map((r) => r.__p);
          } catch (_err2) { /* Fallback 2 — keep buffer order: a sort gesture never blanks the grid */ }
        }
      }
    }
    const total = order.length;
    // Render every row — the virtualizer windows it. No page slice.
    currentPage = 1; totalPages = 1;
    rowIndices = order.map((p) => idxs[p]);
    renderTable(activeColumns, order.map((p) => cells[p]));
    syncSortHeaders();
    rowsInfo.textContent = (total === 0 ? "0 rows" : total.toLocaleString() + " rows (all loaded)")
      + " · wasm" + (clientBuffer.ms != null ? " · " + clientBuffer.ms + " ms" : "");
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
    const groups = Array.from(groupList.querySelectorAll(".rp-group-card"))
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

  // One row → its <tr> markup. Reads live state (selection Set + the
  // table's mode class) so recycled rows always paint correctly — the
  // virtualizer remounts rows on scroll, so per-row state can't live on
  // the DOM. Byte-identical to the old inline markup otherwise.
  function renderRow(row, i) {
    const absIdx  = rowIndices[i];
    const idxAttr = absIdx != null ? ' data-idx="' + absIdx + '"' : "";
    const sel     = absIdx != null && selectedRows.has(absIdx);
    const ce      = table.classList.contains("mode-edit") ? ' contenteditable="true"' : "";
    return '<tr' + idxAttr + (sel ? ' class="is-selected"' : "") + '>'
      + '<td class="col-chk"><input type="checkbox" class="rp-redtable-chk"' + (sel ? " checked" : "") + ' /></td>'
      + '<td class="col-n col-rownum">' + (i + 1) + '</td>'
      + renderColumns.map((c, ci) => {
          const v = row[ci];
          const cls = v == null ? 'cell-muted editable' : 'editable';
          return '<td class="' + cls + '" data-col="' + esc(c.name) + '"' + ce + '>'
            + esc(v == null ? "—" : v) + '</td>';
        }).join("")
      + '</tr>';
  }

  function renderTable(columns, rows) {
    renderColumns = columns;
    selectedRows.clear();   // selection is per-page; a fresh render starts clean
    thead.innerHTML = '<tr>'
      + '<th class="col-chk"><input type="checkbox" class="rp-redtable-chk" id="wsSelectAll" /></th>'
      + '<th class="col-rownum">#</th>'
      + columns.map((c, i) =>
          '<th class="sortable" data-sort="' + (i + 3) + '"'
          + (DATE_DTYPES.has(c.semantic_dtype) ? ' data-type="date"' : '')
          + '>' + esc(c.name) + ' <i class="bi bi-chevron-expand sort"></i></th>'
        ).join("")
      + '</tr>';
    // Windowed render: only the rows near the viewport are mounted, so a
    // 1000-row page (or a 100k-row file) holds ~40 <tr>, not 1000. Created
    // once, reused across pages/files.
    if (!vrows) {
      vrows = createVirtualRows({
        scroller:   tableWrap,
        tbody,
        rowHeight:  measuredRowH,
        renderRow,
        // don't recycle while a cell is mid-edit (would drop the edit)
        pauseWhile: () => tbody.contains(document.activeElement)
                       && document.activeElement.isContentEditable,
      });
    }
    vrows.setRows(rows);
    // Correct the row-height estimate from the first real row — adapts to
    // the active density (compact/cozy/comfortable) without hard-coding.
    const firstReal = tbody.querySelector("tr:not(.rp-vrow-spacer)");
    if (firstReal) {
      const h = firstReal.getBoundingClientRect().height;
      if (h > 0 && Math.abs(h - vrows.rowHeight) > 0.5) { measuredRowH = h; vrows.remeasure(h); }
    }
    syncSel();
  }

  function setTableState(msg) {
    // State message — when no body is current (loading, error, no file).
    if (msg) {
      tableState.textContent = msg;
      tableState.hidden = false;
      table.hidden = true;
    } else {
      tableState.hidden = true;
      table.hidden = false;
    }
  }

  // ─── columns dropdown — rebuilt per file ───────────────────────
  function rebuildColsDropdown(columns) {
    colsDd.innerHTML = columns.map((c, i) =>
      '<label class="rp-menu-item"><input type="checkbox" class="rp-redtable-chk" data-col="'
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
      return '<input class="rp-pred-val" type="hidden" />';
    }
    if (kind === "number") {
      return '<input class="rp-pred-val" type="number" step="any" placeholder="value" />';
    }
    if (kind === "date") {
      return '<input class="rp-pred-val" type="date" placeholder="YYYY-MM-DD" />';
    }
    if (kind === "list") {
      return '<input class="rp-pred-val" type="text" placeholder="a, b, c (comma-separated)" />';
    }
    if (kind === "range-number") {
      return '<span class="rp-pred-range">'
        + '<input class="rp-pred-val rp-pred-val-a" type="number" step="any" placeholder="min" />'
        + '<span class="rp-pred-range-sep">to</span>'
        + '<input class="rp-pred-val rp-pred-val-b" type="number" step="any" placeholder="max" />'
        + '</span>';
    }
    if (kind === "range-date") {
      return '<span class="rp-pred-range">'
        + '<input class="rp-pred-val rp-pred-val-a" type="date" />'
        + '<span class="rp-pred-range-sep">to</span>'
        + '<input class="rp-pred-val rp-pred-val-b" type="date" />'
        + '</span>';
    }
    return '<input class="rp-pred-val" type="text" placeholder="value" />';
  }

  function predRow() {
    const firstCol  = filterCols[0];
    const firstMeta = firstCol?.[2];
    const ops       = opsForColumn(firstMeta);
    const firstOp   = ops[0]?.[0] || "eq";
    const d = document.createElement("div");
    d.className = "rp-pred";
    d.innerHTML =
      '<select class="rp-pred-col">'
      + filterCols.map((c) => '<option value="' + c[0] + '">' + esc(c[1]) + "</option>").join("")
      + "</select>"
      + '<select class="rp-pred-op">'
      + opSelectHTML(firstMeta, firstOp)
      + "</select>"
      + '<span class="rp-pred-val-slot">' + valueInputHTML(firstOp, firstMeta) + '</span>'
      + '<button class="rp-pred-del" type="button" title="Remove condition"><i class="bi bi-x"></i></button>';
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
    const opSel = pred.querySelector(".rp-pred-op");
    const op = opSel?.value || "eq";
    const slot = pred.querySelector(".rp-pred-val-slot");
    if (!slot) return;
    const ctx = {
      fileRid: () => activeFileRid,
      colName: () => {
        const colSel = pred.querySelector(".rp-pred-col");
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
      const input = slot.querySelector(".rp-pred-val");
      if (input && input.type !== "hidden") attachAutocomplete(input, ctx);
    }
    // Other ops (numeric / date / between / null) — no wiring; the
    // input shape from valueInputHTML is the right primitive.
  }
  function groupCard() {
    const card = document.createElement("div");
    card.className = "rp-group-card";
    card.innerHTML =
      '<div class="rp-group-card-head">'
      + '<div class="rp-seg rp-group-card-combo">'
      + '<button type="button" class="is-active" data-combo="AND">AND</button>'
      + '<button type="button" data-combo="OR">OR</button>'
      + "</div>"
      + '<button class="rp-group-card-del" type="button" title="Remove group"><i class="bi bi-trash3"></i></button>'
      + "</div>"
      + '<div class="rp-pred-list"></div>'
      + '<button class="rp-btn-icon rp-btn-icon--glass rp-btn-icon--block rp-add-pred" type="button">'
      + '<i class="bi bi-plus-lg"></i> Add condition</button>';
    card.querySelector(".rp-pred-list").appendChild(predRow());
    return card;
  }
  function renderSeps() {
    groupList.querySelectorAll(".rp-group-sep").forEach((s) => s.remove());
    const cards = Array.from(groupList.querySelectorAll(".rp-group-card"));
    cards.slice(0, -1).forEach((card) => {
      const sep = document.createElement("div");
      sep.className = "rp-group-sep";
      sep.innerHTML = '<button type="button">' + groupCombo + "</button>";
      card.after(sep);
    });
  }
  function addGroup() { groupList.appendChild(groupCard()); renderSeps(); }

  $("#wsAddGroup").addEventListener("click", () => { if (filterCols.length) addGroup(); });

  groupList.addEventListener("click", (e) => {
    if (e.target.closest(".rp-pred-del")) { e.target.closest(".rp-pred").remove(); return; }
    if (e.target.closest(".rp-add-pred")) {
      e.target.closest(".rp-group-card").querySelector(".rp-pred-list").appendChild(predRow());
      return;
    }
    if (e.target.closest(".rp-group-card-del")) {
      if (groupList.querySelectorAll(".rp-group-card").length > 1)
        e.target.closest(".rp-group-card").remove();
      renderSeps();
      return;
    }
    const gcBtn = e.target.closest(".rp-group-card-combo button");
    if (gcBtn) {
      gcBtn.parentElement.querySelectorAll("button").forEach((b) => b.classList.remove("is-active"));
      gcBtn.classList.add("is-active");
      return;
    }
    if (e.target.closest(".rp-group-sep button")) {
      groupCombo = groupCombo === "AND" ? "OR" : "AND";
      groupList.querySelectorAll(".rp-group-sep button").forEach((b) => { b.textContent = groupCombo; });
    }
  });
  groupList.addEventListener("change", (e) => {
    const pred = e.target.closest(".rp-pred");
    if (!pred) return;
    // Column changed → dtype may have changed → rebuild the op
    // dropdown (drop ops that don't apply) + the value slot. Keep
    // the currently-selected op if still valid; otherwise default
    // to the first op of the new dtype.
    if (e.target.classList.contains("rp-pred-col")) {
      const meta = filterColMeta(e.target.value);
      const opSel = pred.querySelector(".rp-pred-op");
      const ops = opsForColumn(meta);
      const wantOp = ops.find((o) => o[0] === opSel.value)?.[0] || ops[0]?.[0] || "eq";
      opSel.innerHTML = opSelectHTML(meta, wantOp);
      const slot = pred.querySelector(".rp-pred-val-slot");
      slot._chipCtrl = null;
      slot.innerHTML = valueInputHTML(wantOp, meta);
      wireValueSlot(pred);
      return;
    }
    // Op changed → swap the value-input slot if the value-kind
    // shifted (text → number, single → range, etc.).
    if (e.target.classList.contains("rp-pred-op")) {
      const meta = filterColMeta(pred.querySelector(".rp-pred-col").value);
      const slot = pred.querySelector(".rp-pred-val-slot");
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
      combo: card.querySelector(".rp-group-card-combo .is-active").dataset.combo,
      preds: Array.from(card.querySelectorAll(".rp-pred")).map(readPred),
    };
  }
  // Read a predicate row → a normalized intermediate shape. Range ops
  // (between) emit `val: [a, b]`; list ops (in/not_in) emit `val:
  // string[]` from the chip-picker's selected set; everything else
  // emits a single string. Empty / whitespace-only values pass through
  // unchanged — predToLeaf is the validator that drops incomplete
  // predicates.
  function readPred(p) {
    const op = p.querySelector(".rp-pred-op").value;
    const col = +p.querySelector(".rp-pred-col").value;
    if (op === "between") {
      const a = p.querySelector(".rp-pred-val-a")?.value.trim() || "";
      const b = p.querySelector(".rp-pred-val-b")?.value.trim() || "";
      return { col, op, val: [a, b] };
    }
    if (op === "in" || op === "not_in") {
      const slot = p.querySelector(".rp-pred-val-slot");
      const chips = slot?._chipCtrl?.values() || [];
      // Fall back to comma-split if the chip-picker isn't mounted
      // (e.g. user typed in plain input and op flipped to in/not_in
      // before the picker rendered). Defensive — shouldn't normally
      // hit since wireValueSlot mounts the picker synchronously.
      if (chips.length > 0) return { col, op, val: chips };
      const raw = p.querySelector(".rp-pred-val")?.value.trim() || "";
      return { col, op, val: raw };
    }
    return { col, op, val: p.querySelector(".rp-pred-val")?.value.trim() || "" };
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

  // ─── sort ─────────────────────────────────────────────────────
  // Shift-click extends the sort, plain click replaces. In clientMode
  // (file ≤ CLIENT_ENGINE_ROW_CAP) the sort runs in the wasm engine over
  // the buffered set — no server round-trip (clientRender). Over the cap
  // it still rides the server page query (fetchAndRender's `sorts`).
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
    // clientMode: re-sort the buffer in wasm — no server round-trip.
    if (clientMode) clientRender(); else refetchPage();
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
  // Selection lives in `selectedRows` (absolute frame indices), not on the
  // DOM — the virtualizer recycles rows, so only the ~window of checkboxes
  // is ever mounted. select-all spans the whole current page's rows.
  function syncSel() {
    const selectAll = thead.querySelector("#wsSelectAll");
    const n = selectedRows.size;
    const pageCount = rowIndices.filter((x) => x != null).length;
    selCount.textContent = n;
    selChip.classList.toggle("show", n > 0);
    if (selectAll) {
      selectAll.checked = n > 0 && n === pageCount;
      selectAll.indeterminate = n > 0 && n < pageCount;
    }
    const armed = table.classList.contains("mode-select") && n > 0;
    deleteBtn.classList.toggle("armed", armed);
    deleteBtn.title = armed ? "Delete " + n + " selected" : "Delete mode";
  }
  thead.addEventListener("change", (e) => {
    if (e.target.id !== "wsSelectAll") return;
    selectedRows.clear();
    if (e.target.checked) for (const idx of rowIndices) if (idx != null) selectedRows.add(idx);
    vrows?.refresh();   // re-render the window so every visible check reflects the Set
    syncSel();
  });
  tbody.addEventListener("change", (e) => {
    if (!e.target.classList.contains("rp-redtable-chk")) return;
    const tr = e.target.closest("tr");
    const idx = parseInt(tr?.dataset.idx, 10);
    if (!Number.isFinite(idx)) return;
    if (e.target.checked) selectedRows.add(idx); else selectedRows.delete(idx);
    tr.classList.toggle("is-selected", e.target.checked);  // row is on-screen — no full refresh
    syncSel();
  });
  selChip.addEventListener("click", () => {
    selectedRows.clear();
    vrows?.refresh();
    syncSel();
  });

  // ─── edit / select / delete modes — wired to the step engine ───
  // Cell edits and row deletes hit POST /api/files/:rid/steps with
  // kind=set_cell|drop_rows. The step engine returns the updated frame;
  // we refetchPage() to pick it up (preserves sort/filter/page state,
  // unlike loadFile which would reset). Single-flight: stepInFlight
  // gates concurrent step posts to avoid out-of-order writes.
  const modeBtns = $$(".rp-toolbar-mode");
  function setMode(btn) {
    const turnOn = !btn.classList.contains("is-active");
    modeBtns.forEach((b) => b.classList.remove("is-active"));
    table.classList.remove("mode-edit", "mode-select", "mode-delete");
    selectedRows.clear();
    if (turnOn) {
      btn.classList.add("is-active");
      table.classList.add("mode-" + btn.dataset.mode);
    }
    // re-render the window: contenteditable (edit mode) + cleared checks
    // are applied by renderRow against the new mode class.
    vrows?.refresh();
    syncSel();
  }
  modeBtns.forEach((b) => b.addEventListener("click", () => {
    if (b.dataset.mode === "delete"
        && table.classList.contains("mode-select")
        && selectedRows.size) {
      applyStep("drop_rows", { indices: [...selectedRows] });
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
    const item = e.target.closest(".rp-menu-item");
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
      body.innerHTML = '<p class="rp-empty rp-step-state">Open a file to see its step history.</p>';
      return;
    }
    if (!activeSteps.length) {
      body.innerHTML = '<p class="rp-empty rp-step-state">No steps applied yet.</p>';
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
      + '<div class="rp-step' + (undone ? ' is-undone' : '') + '">'
      +   '<span class="rp-step-ord">' + (step.ordinal != null ? step.ordinal : "—") + '</span>'
      +   '<span class="rp-step-body">'
      +     '<span class="rp-step-kind">' + esc(step.kind || "—") + '</span>'
      +     (params ? '<span class="rp-step-params">' + esc(params) + '</span>' : '')
      +   '</span>'
      +   '<span class="rp-step-time">' + fmtRelTime(step.created_at) + '</span>'
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
    panel.querySelector(".rp-panel-close").addEventListener("click", () => set(false));
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
    $(p.panel).querySelector(".rp-panel-close").addEventListener("click", () => {
      $(p.panel).classList.remove("open");
      $(p.btn).classList.remove("is-active");
    });
  });

  // ─── tools panel — Clean tab (parameterised, one factory + 15 configs) ─
  // The Tools panel now hosts two tabs via .rp-panel-tabs in the head
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
    onApplied: (res) => {
      if (!activeFileRid) return;
      const rid = activeFileRid;
      invalidateColumnIndex(rid);
      // The /steps response IS the rebuilt envelope (new columns / steps
      // / summary). Seed the cache with it so the loadFile re-run below
      // renders the post-step SCHEMA, not the stale pre-step columns — a
      // column-changing step (snake_case_columns, replace_in_names,
      // split_column, drop_columns) otherwise left the main-table headers
      // stale. Mirrors applyStep's fileEnvelopeCache.set.
      if (res) fileEnvelopeCache.set(rid, res);
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
        if (newFileRid) openNewFile(newFileRid, projectRid);
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
        if (el.classList.contains("rp-panel-tab")
            || el.classList.contains("rp-panel-tab-foot")) {
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
      } else if (el.classList.contains("rp-panel-tab")) {
        el.hidden = !match;
        el.classList.toggle("is-active", match);
      }
    });
  }

  // New project — POST /api/projects + focus/expand the new group — lives in
  // newProject() (above), wired to the rail-foot create button via mountRail's
  // on.create. The hover pencil opens mountRail's inline rename → on.groupRename.

  // ─── refresh — re-fetch the project rail + the open file ──────
  // Drop ALL cached group files so the rail re-queries /projects/:rid/files
  // (picks up external writes), re-render the project list from /api/projects,
  // then re-load the open file (if any) to pick up server-side changes.
  $("#wsRefresh").addEventListener("click", (e) => {
    const i = e.currentTarget.querySelector("i");
    i.classList.remove("rp-toolbar-spin", "is-spinning");
    void i.offsetWidth;
    i.classList.add("rp-toolbar-spin", "is-spinning");
    filesByGroup.clear();          // force every expanded group to re-fetch
    loadProjects();
    if (activeFileRid) {
      const rid = activeFileRid;
      activeFileRid = null;        // force loadFile to re-run
      loadFile(rid);
    }
  });

  // ─── row numbers toggle — initial state from prefs, persists on click ─
  const rownumBtn = $("#wsRownum");
  const rownumOnAtMount = getPref("workspace-showRowNumbers") !== "0";
  rownumBtn.classList.toggle("is-active", rownumOnAtMount);
  table.classList.toggle("no-rownum", !rownumOnAtMount);
  rownumBtn.addEventListener("click", (e) => {
    const on = e.currentTarget.classList.toggle("is-active");
    table.classList.toggle("no-rownum", !on);
    setPref("workspace-showRowNumbers", on ? "1" : "0");
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
    const item = e.target.closest(".rp-menu-item");
    if (!item) return;
    const raw = item.dataset.rows;
    setPref("workspace-rowsPerPage", raw);
    pageSize = parseInt(raw, 10) || DEFAULT_PAGE_SIZE;
    currentPage = 1;
    syncRowsDropdown();
    // clientMode: re-slice the buffer at the new page size — no fetch.
    if (clientMode) clientRender(); else refetchPage();
  });
  function syncRowsDropdown() {
    const raw = getPref("workspace-rowsPerPage");
    $("#wsRowsDd").querySelectorAll(".rp-menu-item").forEach((i) => {
      i.classList.remove("selected");
      const t = i.querySelector(".tick");
      if (t) t.remove();
    });
    const sel = $("#wsRowsDd").querySelector('.rp-menu-item[data-rows="' + raw + '"]')
      || $("#wsRowsDd").querySelector('.rp-menu-item[data-rows="' + DEFAULT_PAGE_SIZE + '"]');
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
        if (i - prev > 1) out.push('<span class="rp-pg-gap">…</span>');
        out.push(pgBtn(String(i), i, i === p, false));
        prev = i;
      }
    }
    out.push(pgBtn("›", p + 1, false, p === last));
    pagesEl.innerHTML = out.join("");
  }
  function pgBtn(label, page, active, disabled) {
    return '<button class="rp-pg' + (active ? " active" : "") + '" type="button"'
      + (disabled ? " disabled" : ' data-page="' + page + '"') + ">" + label + "</button>";
  }
  pagesEl.addEventListener("click", (e) => {
    const btn = e.target.closest(".rp-pg[data-page]");
    if (!btn) return;
    const target = parseInt(btn.dataset.page, 10);
    if (!Number.isFinite(target) || target < 1 || target > totalPages || target === currentPage) return;
    currentPage = target;
    // clientMode: re-slice the buffer client-side — no server round-trip.
    if (clientMode) clientRender(); else refetchPage();
  });

}
