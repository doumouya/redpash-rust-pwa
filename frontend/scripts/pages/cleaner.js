// Cleaner page — standalone redtable-pro workspace.
//
// Phase 1 (this slice):
//   • Parses ?file=FIL_… from the URL hash.
//   • Fetches /api/files/:rid for summary + columns + steps.
//   • Fetches the rest of the files in the same project for the tabs.
//   • Paints header chrome (title · project meta · status badge · overall
//     cleanness bar · undo / redo / save / export disabled states).
//   • Builds the tabs row (Overview + one tab per file).
//   • Loads the first page via /api/files/:rid/page and renders rows in
//     the redtable body.
//
// Phase 2+ (not in this slice):
//   • Tool modals — clones from a per-tool template, populates with
//     active-file columns, POSTs /api/files/:rid/steps on Apply.
//   • Filter / search / column-order panels (lift from existing
//     scripts/cleaner/filters + scripts/redtable).
//   • Edit / select / delete inline modes on the tbody.
//   • Live wrapped-row + mixed-date detectors.
//   • Joins panel for multi-file projects.
//
// What's kept client-side per the user's direction:
//   tabs, edit mode, select mode, delete mode, refresh
// What runs server-side:
//   every step kind (rename, dedup, fill, drop_columns, snake_case,
//   replace_text, format_dates, etc.) via /api/files/:rid/steps
//   — the existing tool modules under scripts/cleaner/tools/ already
//   POST to those endpoints; Phase 2 splices them into the new chrome.

import { api } from "/scripts/api.js";
import { toast } from "/scripts/ui/toast.js";

// Page-scoped state. Reset on every mount() so navigation in / out of
// the cleaner doesn't leak previous-file data.
let STATE = {
  rid:         null,                  // active file RID from URL
  summary:     null,                  // FileSummary for active file
  columns:     [],                    // ColumnMeta[] for active file
  steps:       [],                    // ProjectStep[] history
  project:     null,                  // { redpash_id, name, status, … }
  files:       [],                    // every file in the project
  page:        1,                     // current page index
  pageSize:    25,                    // rows per page (matches the dd default)
  pageData:    null,                  // last { rows, total, … } response
  q:           "",                    // toolbar search query
  selected:    new Set(),             // page-relative row indices ticked in select mode
  filterOpen:  false,                 // funnel side-panel open/closed
  // Chained column sort — primary first, remaining keys break ties.
  // Empty array → no sort header sent → backend uses the frame's
  // natural order. PageQuery accepts a JSON `sorts` param that
  // overrides the legacy single-column `sort/dir` pair.
  sorts:       [],
  // Per-file toolbar prefs, keyed by file rid. Holds the user's
  // pageSize / sorts / q / mode / page so switching tabs doesn't
  // leak one file's choices into another's. Snapshot on leave +
  // rehydrate on enter happens inside cleanerActivateTab. Memory-
  // only (no localStorage); defaults below kick in for never-visited
  // tabs.
  filePrefs:   new Map(),
  // Chain-link toggle in the toolbar: when true, search query and
  // rows-per-page stick across file tabs (useful for "find this ID
  // across related files" or "give me 50 rows everywhere"). When
  // false (default), they're per-tab via filePrefs. Mode + sort +
  // page index are ALWAYS per-tab regardless — mode is data-mutation
  // risky and sort is schema-dependent. Persisted to
  // prefs.cleaner_link_toolbar.
  linkToolbar: false,
  // Per-user "tabs I've closed" set — keyed by file RID. Persisted to
  // `prefs.cleaner_hidden_files` via rpSavePref. Mirrors objTabs on the
  // Objects page: hides crowded file tabs on big projects (17+ files)
  // without deleting the files themselves; cleanerShowFileTab puts a
  // tab back from the "+" dropdown.
  hiddenFiles: new Set(),
  // Leading "#" row-number column on the file-view CSV table. Per-file
  // (snapshotted via filePrefs on tab switch); first-tab default comes
  // from prefs.cleaner_show_row_nums.
  showRowNums:   false,
  // Toolbar group that exposes "new report / new dashboard from this
  // file" actions. Global pref (not per-file), persisted to
  // prefs.cleaner_show_open_links. Default ON — matches Objects's
  // analogous #obj-rowopen-btn.
  showOpenLinks: true,
  // CSV column names hidden by the user via the Columns dropdown. Set
  // on switch from filePrefs[rid].hiddenCols; mutated by cleanerToggleCol.
  hiddenCols:    new Set(),
  // { colName: px } per-file column widths set via the .rp-rt-col-resize
  // drag handles. Snapshotted into filePrefs[rid].colWidths on tab
  // switch + restored on enter, so column layout is sticky per file.
  colWidths:     {},

  // ── Project tabs (panel-header level) ────────────────────────────
  // The cleaner now keeps multiple PROJECTS open simultaneously, the
  // same way the Objects page keeps multiple entity-kind tabs open.
  // Switching tabs snapshots the leaving project's full STATE slice
  // into `projectSnapshots[pid]` and restores the entering project's
  // slice (or does a fresh fetch on first visit). Inactive projects
  // hold no live fetches — switching back replays from snapshot.
  //
  //   openProjects     — ordered list of PRJ_… ids the user has open
  //                      as tabs. Persisted to prefs.cleaner_open_projects;
  //                      auto-grows whenever the user navigates to a new
  //                      project via URL.
  //   projectMeta      — pid → minimal { redpash_id, name, status, … }
  //                      for tab labels. Hydrated from /api/projects on
  //                      mount; refreshed lazily when a project is
  //                      switched into.
  //   projectSnapshots — pid → captured STATE slice (rid / files /
  //                      filePrefs / page / sorts / hiddenCols / …).
  //                      In-memory only; refresh of the page drops
  //                      session state — the URL + openProjects list
  //                      restore the structure on the next mount.
  //   activeProjectId  — which project the user is currently viewing.
  //                      Matches the ?project= URL param.
  openProjects:     [],
  projectMeta:      new Map(),
  projectSnapshots: new Map(),
  activeProjectId:  null,

  // Per-file named filter store. Shape:
  //   { [file_rid]: [{ name, combinator, predicates }, …] }
  // Persisted to prefs.cleaner_saved_filters via rpSavePref. The floppy
  // button in the filter panel writes here; the Saved-settings modal
  // surfaces them as click-to-load chips per file.
  savedFilters: {},
};

export default async function mount(root, ctx) {
  // Prerelease (Phase 2): the partial is now a thin shell that data-includes
  // a tree of sub-partials. Wait for the fragment loader to finish before
  // querying the DOM, otherwise every querySelector below sees an empty
  // mount point. include.js exposes the recursive walker as window.rpInclude.
  if (typeof window.rpInclude === "function") {
    try { await window.rpInclude(root); }
    catch (err) { console.warn("[cleaner] rpInclude failed", err); }
  }

  // Phase 3 wiring — when the sandbox markup is on screen (no
  // #cleaner-title), branch into mountSandbox(). The legacy mount path
  // below stays intact for the historical cleaner.live.html, so a
  // future revert just swaps the partial file.
  const sandboxStrip = root.querySelector(".rp-rt-proj-tabs-inner");
  if (sandboxStrip) {
    await mountSandbox(root, ctx, sandboxStrip);
    return;
  }

  // Cleaner URL forms — both supported:
  //   #/cleaner?file=FIL_…    open that file directly
  //   #/cleaner?project=PRJ_… open the project, land on its first file
  // When both are present, ?file= wins. The home page links into
  // either form depending on what the user clicked (project row vs.
  // file row).
  const q          = new URLSearchParams(location.hash.split("?")[1] ?? "");
  const fileRid    = q.get("file");
  const projectRid = q.get("project");
  if (!fileRid && !projectRid) {
    root.querySelector("#cleaner-title").textContent = "No file selected";
    toast.error("Cleaner needs ?project=PRJ_… or ?file=FIL_… in the URL");
    return;
  }

  // Fresh overview state on every mount — OV is module-level, so
  // without this a previous cleaner session's selection / mode / search
  // would leak into the next one. hiddenCols is the exception: it's a
  // user layout preference, restored from localStorage so the column
  // choice persists across sessions.
  OV = {
    mode: null, selected: new Set(), q: "", sorts: [],
    hiddenCols: _ovLoadHiddenCols(),
    colOrder:   _ovLoadColOrder(),
    colWidths:  _ovLoadColWidths(),
  };

  // Hidden file tabs — restore the user's "tabs I've closed" set from
  // server prefs. Flat list of file RIDs (file RIDs are globally unique,
  // so no per-project keying needed — a hidden RID just won't match in
  // a different project). Persisted via rpSavePref on every show/hide.
  const savedHidden = ctx?.session?.prefs?.cleaner_hidden_files;
  STATE.hiddenFiles = new Set(Array.isArray(savedHidden) ? savedHidden : []);

  // Toolbar-link toggle — drives whether search + rows-per-page
  // stick across file tabs. Pref persisted server-side; mount-time
  // hydration sets STATE.linkToolbar before the toggle button is
  // rendered, so the active class reflects the user's last choice.
  STATE.linkToolbar = ctx?.session?.prefs?.cleaner_link_toolbar === true;

  // Defaults for the per-file toolbar prefs we surface in the cleaner
  // toolbar (row numbers + open-links group). Per-file tabs hydrate
  // their own values via _loadFilePrefs; these are the values used
  // before the first file-tab snapshot lands.
  STATE.showRowNums   = ctx?.session?.prefs?.cleaner_show_row_nums   === true;
  STATE.showOpenLinks = ctx?.session?.prefs?.cleaner_show_open_links !== false;
  STATE.hiddenCols    = new Set();

  // Saved named filters — keyed by file rid. Each value is an array of
  // { name, combinator, predicates }. Pulled from prefs on mount; live
  // mutations land via cleanerSaveFilter / cleanerDeleteSavedFilter,
  // both of which call rpSavePref to persist.
  const sf = ctx?.session?.prefs?.cleaner_saved_filters;
  STATE.savedFilters = (sf && typeof sf === "object" && !Array.isArray(sf)) ? { ...sf } : {};

  // Learned sentinel values — the user-extension of the backend's
  // built-in SENTINELS list. The Fix-invalid modal scans every file
  // for these in addition to the canonical set, so once a user has
  // taught the app that "???" / "----" / "#####" are junk in *their*
  // data, future files pick those up automatically.
  // Stored canonical (trimmed + lowercased) — the scan match is
  // case-insensitive, so storing variants would just bloat the set.
  const savedLearned = ctx?.session?.prefs?.learned_sentinels;
  STATE.learnedSentinels = new Set(
    Array.isArray(savedLearned)
      ? savedLearned.map((s) => String(s).trim().toLowerCase()).filter(Boolean)
      : [],
  );
  // Global sentinel set — values that ≥2 users have flagged as junk
  // (server-side `global_sentinels` view, returned at /api/me boot).
  // Joins the scan vocabulary alongside the user's personal additions,
  // so a new user gets the benefit of everyone else's prior teaching
  // on day one. Sharing is opt-in — see `share_sentinels` consent flow.
  const savedGlobal = ctx?.session?.global_sentinels;
  STATE.globalSentinels = new Set(
    Array.isArray(savedGlobal)
      ? savedGlobal.map((s) => String(s).trim().toLowerCase()).filter(Boolean)
      : [],
  );
  // Sharing consent — tri-state: true (consented), false (declined),
  // null (not yet asked → consent dialog fires on the first ad-hoc
  // Apply). Cached in STATE so module-level renderers can read it.
  STATE.shareSentinels = ctx?.session?.prefs?.share_sentinels ?? null;

  // Inline-onclick globals — defined first so the inline handlers in
  // the partial don't fire before the closure exists.
  _wireGlobals(root);

  // Sticky cols-dropdown hover — one-time bind for every .rp-rt-cols-wrap
  // in the toolbar so the panel survives the gap between trigger and
  // dropdown. Library CSS-only :hover is unreliable here (see comment
  // on _bindColsDdHover).
  _bindColsDdHover(root);

  try {
    // Two landing modes:
    //   • ?file=FIL_…  → open that file, populate STATE.summary + columns
    //                    + steps, paint the file table.
    //   • ?project=PRJ_… (only) → land on the project Overview pane.
    //     Don't auto-pick the first file (the user opened the project,
    //     not a specific file; the Overview is what they want).
    //     STATE.rid stays null until they click a file tab.
    const projectOnly = !fileRid && !!projectRid;

    let resolvedRid = fileRid;
    let preFetchedFiles = null;
    let projectIdForList = null;

    if (projectOnly) {
      // Project landing → fetch the project's files; no file detail.
      const filesRes = await api.get(`/projects/${encodeURIComponent(projectRid)}/files`);
      preFetchedFiles  = filesRes.items ?? [];
      projectIdForList = projectRid;
      if (!preFetchedFiles.length) {
        root.querySelector("#cleaner-title").textContent = "Empty project";
        toast.info("This project has no files yet. Upload one from /home.");
        // Still paint the project chrome + empty Overview.
      }
      STATE.rid     = null;
      STATE.summary = null;
      STATE.columns = [];
      STATE.steps   = [];
    } else {
      // File landing — original flow.
      STATE.rid = resolvedRid;
      const detail = await api.get(`/files/${encodeURIComponent(resolvedRid)}`);
      STATE.summary    = detail.summary;
      STATE.columns    = detail.columns ?? [];
      STATE.steps      = detail.steps ?? [];
      projectIdForList = detail.summary.project_redpash_id;
    }

    // Project meta + sibling files (the file path already has the list
    // in `preFetchedFiles` if it had to fetch them; here we cover both).
    const [projects, files] = await Promise.all([
      api.get("/projects").catch(() => ({ items: [] })),
      preFetchedFiles
        ? Promise.resolve({ items: preFetchedFiles })
        : api.get(`/projects/${encodeURIComponent(projectIdForList)}/files`)
            .catch(() => ({ items: [] })),
    ]);
    STATE.project = projects.items?.find(
      (p) => p.redpash_id === projectIdForList,
    ) ?? null;
    STATE.files = files.items ?? [];

    // ── Project-tab hydration ────────────────────────────────────
    // Cache every project's meta for the tab strip's "+" picker AND
    // for label lookups when restoring a snapshot. Then merge the
    // saved open-tabs pref with the current pid so a direct URL nav
    // always opens its target as a tab (the user is by definition
    // working in that project right now).
    for (const p of (projects.items ?? [])) {
      if (p?.redpash_id) STATE.projectMeta.set(p.redpash_id, p);
    }
    const knownPids   = new Set(STATE.projectMeta.keys());
    const savedOpen   = ctx?.session?.prefs?.cleaner_open_projects;
    let openList      = Array.isArray(savedOpen)
      ? savedOpen.filter((pid) => knownPids.has(pid))
      : [];
    if (projectIdForList && !openList.includes(projectIdForList)) {
      openList.push(projectIdForList);
    }
    if (!openList.length && knownPids.size) {
      // Brand-new user with no saved set — fall back to the project
      // they're currently looking at (or, if neither URL nor pref
      // resolved one, the first project in their account).
      openList = [projectIdForList ?? [...knownPids][0]];
    }
    STATE.openProjects    = openList;
    STATE.activeProjectId = projectIdForList ?? openList[0] ?? null;
    // Persist back if the URL landing grew the saved set.
    if (JSON.stringify(savedOpen ?? []) !== JSON.stringify(openList)) {
      window.rpSavePref?.("cleaner_open_projects", openList);
    }
    _renderProjectTabs(root);

    // Paint static chrome from the data we just gathered.
    _renderTitle(root);
    _renderHeaderMeta(root);
    _renderOverallCleanness(root);
    _renderTabs(root);
    _renderHistoryButtons(root);
    _renderAppliedList(root);
    _renderDtypeList(root);
    _renderEncodingPicker(root);
    // Async fetch — fire-and-forget; paints into #cleaner-join-body
    // when the response lands. Skipped when no active file or <2 files.
    _renderJoinsPanel(root).catch(() => {});

    if (projectOnly) {
      // Land on Overview — cleanerActivateTab("") flips the Overview
      // tab active + calls _renderOverview. No _loadPage (no active file).
      window.cleanerActivateTab("");
    } else {
      // First load — paint the columns dropdown + sync the toolbar
      // additions before the body lands (so the user sees the row-num
      // toggle / open-link toggle in their saved state on first frame).
      _syncToolbarToState(root);
      window.cleanerBuildColsDropdown?.();
      // Load the first page of rows into the body.
      await _loadPage(root);
    }

  } catch (err) {
    toast.error(`Couldn't open file: ${err.body?.error ?? err.message}`);
    root.querySelector("#cleaner-title").textContent = "File not found";
  }
}

// One-shot animation helper for the filter-panel buttons. Reflow +
// animationend removal lets repeat clicks re-fire the same keyframes.
function _rpAnimOnce(el, cls) {
  if (!el) return;
  el.classList.remove(cls);
  void el.offsetWidth;
  el.classList.add(cls);
  el.addEventListener("animationend", () => el.classList.remove(cls), { once: true });
}

// ── Per-file toolbar prefs (snapshot + restore on tab switch) ────
// Each file tab keeps its own rows-per-page, search query, sort
// chain, mode, and current page index. Without this, changing any
// of those on one tab silently leaks into every other open tab.
// Memory-only — defaults below apply for never-visited tabs.
const _OV_DEFAULT_PAGE_SIZE = 25;
// Hard cap on rows-per-page. Salesforce caps at 2k for reference;
// 5k × ~17 cols ≈ 85k DOM nodes which browsers handle fine even
// when select-mode unhides the per-row checkbox column. Going much
// higher (the old "All rows" pinned to 100k) hangs the browser on
// mode flips because every row's `<td>` has to re-layout.
const _PAGE_SIZE_MAX = 5000;
function _clampPageSize(n) {
  if (n === "all") return _PAGE_SIZE_MAX;            // legacy "all" → cap
  const num = Number(n);
  if (!Number.isFinite(num) || num <= 0) return _OV_DEFAULT_PAGE_SIZE;
  return Math.min(num, _PAGE_SIZE_MAX);
}

// ── Page cache (per-file, LRU) ────────────────────────────────────
// Caches the last N page responses keyed by every parameter that
// distinguishes a request. Tab-switching back and forth re-uses the
// cached payload instead of re-fetching — at 5k rows the cache hit
// is the difference between an instant tab switch and a 3 s wait.
// Invalidated when steps mutate the file's frame (see _invalidatePageCache).
const _PAGE_CACHE_MAX = 12;
const _pageCache = new Map();   // key → { rows, total, all_count, … }
// Per-file applied-steps count we last observed. _loadPage compares
// the current count against this to detect "the file changed since
// the cached pages were fetched" and invalidates that file's cache.
const _fileStepsRev = new Map(); // rid → applied-count integer
function _pageCacheKey(rid, page, size, sorts, q) {
  return `${rid}:${page}:${size}:${JSON.stringify(sorts || [])}:${q || ""}`;
}
function _pageCacheGet(key) {
  if (!_pageCache.has(key)) return null;
  // LRU: re-insert moves the entry to the end of the iteration order.
  const v = _pageCache.get(key);
  _pageCache.delete(key); _pageCache.set(key, v);
  return v;
}
function _pageCachePut(key, value) {
  if (_pageCache.has(key)) _pageCache.delete(key);
  _pageCache.set(key, value);
  while (_pageCache.size > _PAGE_CACHE_MAX) {
    // Drop oldest (first iter entry).
    const oldest = _pageCache.keys().next().value;
    _pageCache.delete(oldest);
  }
}
// Drop every cached page for a given file. Called whenever a step
// is applied / undone / redone — the underlying frame changed, so
// the cached rows are now stale.
function _invalidatePageCache(rid) {
  if (!rid) return;
  for (const key of [..._pageCache.keys()]) {
    if (key.startsWith(`${rid}:`)) _pageCache.delete(key);
  }
}
function _saveFilePrefs(rid) {
  if (!rid) return;
  // When linkToolbar is ON, search + rows-per-page are toolbar-global;
  // don't snapshot them per-file (so they don't get pinned to a stale
  // value if the user later toggles linkToolbar off).
  const existing = STATE.filePrefs.get(rid) || {};
  STATE.filePrefs.set(rid, {
    // Sync-aware fields: when linkToolbar is on, snapshot the EXISTING
    // (pre-toggle) value so the per-file slot doesn't pin a stale state
    // that would re-apply if the user later turns sync off. These are
    // schema-agnostic display prefs (search, rows-per-page, row-nums) —
    // sharing them across tabs is genuinely useful.
    pageSize:    STATE.linkToolbar ? existing.pageSize    : STATE.pageSize,
    q:           STATE.linkToolbar ? existing.q           : STATE.q,
    showRowNums: STATE.linkToolbar ? existing.showRowNums : !!STATE.showRowNums,
    // Always per-file: page index (different totals), mode (data-mutation
    // risky), sort + hidden cols + col widths (schema-dependent — column
    // names differ across files, so syncing them would either error or
    // produce nonsensical layouts).
    page:       STATE.page,
    sorts:      Array.isArray(STATE.sorts) ? STATE.sorts.map((k) => ({ ...k })) : [],
    mode:       _currentPanelMode(),
    hiddenCols: [...(STATE.hiddenCols ?? [])],
    colWidths:  { ...(STATE.colWidths ?? {}) },
  });
}
function _loadFilePrefs(root, rid) {
  const p = STATE.filePrefs.get(rid) || {};
  // Linked fields keep their current STATE value (toolbar-global);
  // unlinked fields hydrate from the per-file snapshot or fall back
  // to defaults for never-visited tabs.
  if (!STATE.linkToolbar) {
    STATE.pageSize = Number(p.pageSize) > 0 ? Number(p.pageSize) : _OV_DEFAULT_PAGE_SIZE;
    STATE.q        = typeof p.q === "string" ? p.q : "";
    // Row-numbers — sync-gated like pageSize/q. When sync is on, leave
    // STATE.showRowNums alone (it's the toolbar-global value); only when
    // sync is off do we rehydrate the per-file snapshot.
    if (typeof p.showRowNums === "boolean") STATE.showRowNums = p.showRowNums;
  }
  STATE.page     = Number(p.page)     > 0 ? Number(p.page)     : 1;
  STATE.sorts    = Array.isArray(p.sorts) ? p.sorts.map((k) => ({ ...k })) : [];
  // Schema-dependent layout — always per-file regardless of sync, since
  // column names differ across files (hiding "Email" on one file doesn't
  // translate to another). New tab → empty set / no widths.
  STATE.hiddenCols = new Set(Array.isArray(p.hiddenCols) ? p.hiddenCols : []);
  STATE.colWidths  = (p.colWidths && typeof p.colWidths === "object") ? { ...p.colWidths } : {};
  // Re-paint the toolbar widgets so the user sees the rehydrated
  // values, not the previous tab's.
  _syncToolbarToState(root);
  _applyPanelMode(root, p.mode || null);
  // The columns dropdown depends on STATE.columns (loaded by the
  // file-detail fetch in the caller) AND on the freshly-hydrated
  // hiddenCols set. Rebuild the checkbox list so ticked-state matches.
  if (typeof window.cleanerBuildColsDropdown === "function") {
    window.cleanerBuildColsDropdown();
  }
}

// ── Per-project snapshot / restore ──────────────────────────────
// The panel-header project tabs let the user keep multiple PROJECTS
// open at once. Switching projects snapshots the leaving project's
// full STATE slice into `projectSnapshots[pid]` and restores the
// entering project's slice (or does a fresh fetch on first visit).
// Inactive projects hold no live fetches — switching back replays
// from snapshot for an instant feel.
//
// Fields captured per snapshot:
//   project / files / project-files chrome (overview)
//   rid + summary + columns + steps + pageData (active file)
//   page / pageSize / q / sorts / mode (active file toolbar)
//   filePrefs (per-file prefs WITHIN this project)
//   hiddenFiles (closed file tabs WITHIN this project)
//   showRowNums / hiddenCols / colWidths (active file STATE-level)
//   ov (Overview session state — mode / selected / q / sorts; the
//       layout fields colOrder / hiddenCols / colWidths are
//       localStorage-keyed globally, not snapshotted)
function _saveProjectSnapshot(pid) {
  if (!pid) return;
  // hiddenFiles is intentionally NOT snapshotted — it lives globally
  // across projects (file rids are unique system-wide; one flat Set
  // covers every project's closed-tabs choices). Saving per-project
  // snapshots of it caused stale restores: closing F1 in project A,
  // switching to B, closing G in B, switching back to A would restore
  // A's snapshot {F1} and drop G silently. Source of truth is
  // STATE.hiddenFiles in memory + prefs.cleaner_hidden_files on disk.
  STATE.projectSnapshots.set(pid, {
    project:    STATE.project,
    files:      STATE.files,
    // Active-file slice
    rid:         STATE.rid,
    summary:     STATE.summary,
    columns:     STATE.columns,
    steps:       STATE.steps,
    pageData:    STATE.pageData,
    page:        STATE.page,
    pageSize:    STATE.pageSize,
    q:           STATE.q,
    sorts:       STATE.sorts.map((k) => ({ ...k })),
    selected:    new Set(STATE.selected),
    // Per-file map AND active-file STATE-level mirrors of its prefs
    filePrefs:   new Map(STATE.filePrefs),
    showRowNums: STATE.showRowNums,
    hiddenCols:  new Set(STATE.hiddenCols),
    colWidths:   { ...STATE.colWidths },
    // Overview session state — layout fields stay localStorage-global
    ov: {
      mode:     OV.mode,
      selected: new Set(OV.selected),
      q:        OV.q,
      sorts:    OV.sorts.map((k) => ({ ...k })),
    },
  });
}

// Restore STATE from a saved snapshot. Returns true on success, false
// when there's nothing cached (caller falls back to _fetchProjectFresh).
function _loadProjectSnapshot(pid) {
  if (!pid) return false;
  const s = STATE.projectSnapshots.get(pid);
  if (!s) return false;
  STATE.project     = s.project ?? null;
  STATE.files       = Array.isArray(s.files) ? s.files : [];
  // hiddenFiles is global — see _saveProjectSnapshot comment. Leave
  // STATE.hiddenFiles alone here; it's already loaded from prefs at
  // mount time and kept current by cleanerHideFileTab /
  // cleanerShowFileTab. Restoring per-project would drop recent
  // additions made while a different project was active.
  STATE.rid         = s.rid ?? null;
  STATE.summary     = s.summary ?? null;
  STATE.columns     = Array.isArray(s.columns) ? s.columns : [];
  STATE.steps       = Array.isArray(s.steps)   ? s.steps   : [];
  STATE.pageData    = s.pageData ?? null;
  STATE.page        = Number(s.page) > 0 ? Number(s.page) : 1;
  STATE.pageSize    = Number(s.pageSize) > 0 ? Number(s.pageSize) : _OV_DEFAULT_PAGE_SIZE;
  STATE.q           = typeof s.q === "string" ? s.q : "";
  STATE.sorts       = Array.isArray(s.sorts) ? s.sorts.map((k) => ({ ...k })) : [];
  STATE.selected    = s.selected instanceof Set ? new Set(s.selected) : new Set();
  STATE.filePrefs   = s.filePrefs instanceof Map ? new Map(s.filePrefs) : new Map();
  STATE.showRowNums = !!s.showRowNums;
  STATE.hiddenCols  = s.hiddenCols instanceof Set ? new Set(s.hiddenCols) : new Set();
  STATE.colWidths   = (s.colWidths && typeof s.colWidths === "object") ? { ...s.colWidths } : {};
  OV.mode     = s.ov?.mode ?? null;
  OV.selected = s.ov?.selected instanceof Set ? new Set(s.ov.selected) : new Set();
  OV.q        = typeof s.ov?.q === "string" ? s.ov.q : "";
  OV.sorts    = Array.isArray(s.ov?.sorts) ? s.ov.sorts.map((k) => ({ ...k })) : [];
  return true;
}

// First-visit / never-snapshotted project: do the mount-style fetch
// pair (projects list + this project's files), populate STATE, then
// (if a file was requested) fetch its detail. Returns the resolved
// active-file rid, or null when the user landed on the overview.
async function _fetchProjectFresh(pid, opts = {}) {
  const { fileRid = null } = opts;
  // Files list first — also used to pick the default active file when
  // the URL was a bare ?project=.
  const filesRes = await api.get(`/projects/${encodeURIComponent(pid)}/files`)
    .catch(() => ({ items: [] }));
  STATE.files = filesRes.items ?? [];
  // Preserve the cross-project hidden-files set — file rids are globally
  // unique so the same Set works across projects, and clobbering it
  // here would wipe what mountSandbox just loaded from prefs (the user's
  // closed-tabs choices would silently revert on every project switch
  // or page refresh). Default to empty only when nothing's there yet.
  if (!(STATE.hiddenFiles instanceof Set)) STATE.hiddenFiles = new Set();
  STATE.filePrefs   = new Map();
  STATE.selected    = new Set();
  STATE.page        = 1;
  STATE.pageSize    = _OV_DEFAULT_PAGE_SIZE;
  STATE.q           = "";
  STATE.sorts       = [];
  STATE.hiddenCols  = new Set();
  STATE.colWidths   = {};
  STATE.pageData    = null;
  // Project meta — pulled fresh so the badge picks up server-side
  // status / stage changes since the last cleaner visit. Falls back
  // to the cached projectMeta entry if /projects refused.
  const projects = await api.get("/projects").catch(() => ({ items: [] }));
  STATE.project = (projects.items ?? []).find((p) => p.redpash_id === pid)
                 ?? STATE.projectMeta.get(pid) ?? null;
  // File detail — only when the caller asked for a specific file (or
  // a single-file project is the natural landing). Overview-landing
  // leaves rid null + columns empty (matches the project-only flow
  // in mount()).
  if (fileRid) {
    try {
      const detail = await api.get(`/files/${encodeURIComponent(fileRid)}`);
      STATE.rid     = fileRid;
      STATE.summary = detail.summary;
      STATE.columns = detail.columns ?? [];
      STATE.steps   = detail.steps   ?? [];
    } catch {
      STATE.rid = null; STATE.summary = null; STATE.columns = []; STATE.steps = [];
    }
  } else {
    STATE.rid = null; STATE.summary = null; STATE.columns = []; STATE.steps = [];
  }
  // Cache the meta for the tab strip even if /projects returned this
  // project — keeps the label stable through later renames.
  if (STATE.project) STATE.projectMeta.set(pid, STATE.project);
  return STATE.rid;
}

// Read the panel's current mode out of its rp-rt-mode-* class.
function _currentPanelMode() {
  const panel = document.querySelector(".rp-rt-panel--cleaner");
  if (!panel) return null;
  for (const m of ["edit", "select", "delete"]) {
    if (panel.classList.contains(`rp-rt-mode-${m}`)) return m;
  }
  return null;
}
// Flip the panel's rp-rt-mode-* class + the matching mode icon
// button's is-active / aria-pressed state to `mode` (or none).
function _applyPanelMode(root, mode) {
  const panel = root.querySelector(".rp-rt-panel--cleaner");
  if (!panel) return;
  panel.classList.remove("rp-rt-mode-edit", "rp-rt-mode-select", "rp-rt-mode-delete");
  root.querySelectorAll('[data-cleaner-view="file"].rp-rt-toolbar .rp-rt-icon-btn[data-rt-mode]')
    .forEach((b) => {
      const on = b.dataset.rtMode === mode;
      b.classList.toggle("is-active", on);
      b.setAttribute("aria-pressed", on ? "true" : "false");
    });
  if (mode) panel.classList.add(`rp-rt-mode-${mode}`);
}
// Push STATE.pageSize / STATE.q into the toolbar DOM (rows label +
// dd-selected checkmark + search input value). Called after
// _loadFilePrefs so the visible toolbar matches the restored state.
// Label format mirrors what rtSetRows writes: ≥5000 reads as "5k",
// everything else as the raw count.
function _syncToolbarToState(root) {
  const size = STATE.pageSize;
  const lbl  = root.querySelector("[data-rt-rows-label]");
  if (lbl) lbl.textContent = size >= 5000 ? "5k" : String(size);
  const dd = lbl?.closest(".rp-rt-dd-wrap");
  dd?.querySelectorAll(".rp-rt-dd-item").forEach((i) => {
    // Match the dropdown item that starts with the active size's
    // numeric prefix ("10", "25", "5k", …).
    const want = size >= 5000 ? "5k" : String(size);
    i.classList.toggle("rp-rt-dd-selected",
      i.textContent.trim().toLowerCase().startsWith(want));
  });
  const search = root.querySelector('[data-cleaner-view="file"] .rp-rt-search');
  if (search) search.value = STATE.q || "";

  // Row-numbers toggle — accent-tint matches the Objects-page button.
  // (Synced-glow flasher lives below.)
  const rnBtn = root.querySelector("#cleaner-rownum-btn");
  if (rnBtn) rnBtn.classList.toggle("rp-rt-rownum-active", !!STATE.showRowNums);

  // Open-links toggle + the two gated action buttons. The CSS gates
  // visibility via `cleaner-hide-open-links` on the panel, so the
  // buttons themselves stay in the DOM (anchor semantics for new-tab).
  const rlBtn = root.querySelector("#cleaner-rowopen-btn");
  if (rlBtn) {
    rlBtn.classList.toggle("is-active", !!STATE.showOpenLinks);
    rlBtn.setAttribute("aria-pressed", STATE.showOpenLinks ? "true" : "false");
  }
  const panel = root.querySelector('.rp-rt-panel[data-cleaner-view="file"], .rp-rt-panel');
  panel?.classList.toggle("cleaner-hide-open-links", !STATE.showOpenLinks);
}

// Brief accent pulse on every toolbar control governed by the chain-
// link toggle — search box, rows-per-page pill, row-numbers button. Same
// reflow-trick the Objects-page `_objFlashSaved` uses so the animation
// restarts on every toggle even when the class is already present.
function _cleanerFlashSynced(root) {
  const targets = [
    root.querySelector('[data-cleaner-view="file"] .rp-rt-search'),
    root.querySelector("[data-rt-rows-label]")?.closest(".rp-rt-pill-btn"),
    root.querySelector("#cleaner-rownum-btn"),
  ].filter(Boolean);
  for (const el of targets) {
    el.classList.remove("cleaner-synced-glow");
    void el.offsetWidth;            // reflow → restart one-shot animation
    el.classList.add("cleaner-synced-glow");
  }
}

// ── Render: title + meta ─────────────────────────────────────────────
function _renderTitle(root) {
  const ttl = root.querySelector("#cleaner-title");
  if (!ttl) return;
  // Header always shows the project context; appends the active file
  // only when one is open (STATE.rid set). When the user returns to
  // the Overview tab, STATE.rid is null again — the previous file's
  // name is dropped instead of lingering (matches the user's mental
  // model: "no file open, no file name").
  //
  // Icons swap the "Project:" / "File:" prose for bi-folder2-open and
  // bi-file-earmark-text — same icons the Objects-page tab strip uses
  // for those kinds, so a user who learned the iconography there picks
  // it up here free.
  const projName = STATE.project?.name ?? "—";
  const s = STATE.summary ?? {};
  const fileName = STATE.rid ? (s.display_name ?? s.filename ?? "—") : null;
  const proj = `<i class="bi bi-folder2-open bi-sm" aria-label="Project"></i> ${_escHtml(projName)}`;
  const file = fileName
    ? ` <span class="rp-rt-title-sep">—</span> <i class="bi bi-file-earmark-text bi-sm" aria-label="File"></i> ${_escHtml(fileName)}`
    : "";
  ttl.innerHTML = `${proj}${file}`;
}

function _renderHeaderMeta(root) {
  const meta = root.querySelector("#cleaner-proj-meta");
  if (!meta) return;
  const projName = STATE.project?.name ?? "—";
  const n        = STATE.files.length;
  meta.textContent = `${projName} · ${n} file${n !== 1 ? "s" : ""}`;
}

function _renderOverallCleanness(root) {
  const fill = root.querySelector("#cleaner-overall-fill");
  const pctE = root.querySelector("#cleaner-overall-pct");
  if (!fill || !pctE) return;

  // Use the project's cleanness_pct if available; fall back to the
  // active file's cleanness when the project hasn't computed an
  // aggregate yet. Library threshold mirror: ≥90 green / ≥70 yellow / red.
  const raw = STATE.project?.cleanness_pct ?? STATE.summary?.cleanness_pct;
  if (raw == null || isNaN(raw)) {
    fill.style.width = "0%";
    fill.style.background = "var(--muted)";
    pctE.textContent = "—";
    pctE.style.color = "var(--muted)";
    return;
  }
  const pct = Math.max(0, Math.min(100, raw));
  const color = pct >= 90 ? "var(--green)" : pct >= 70 ? "var(--yellow)" : "var(--red)";
  fill.style.width      = `${pct}%`;
  fill.style.background = color;
  pctE.textContent      = `${Math.round(pct)}%`;
  pctE.style.color      = color;
}

// ── Render: tabs (Overview + 1 per file) ─────────────────────────────
// Project-tab strip — paints one tab per pid in STATE.openProjects at
// the panel-header level. Active tab carries the redtable .active class
// + an accent border. Each tab has an × close button (suppressed when
// only one tab remains — closing the last would orphan the page). A
// trailing "+" pops a picker dropdown of every NOT-yet-open project
// the user owns. Idempotent — safe to call from any render entry.
function _renderProjectTabs(root) {
  const strip = root.querySelector("#cleaner-proj-tabs-list");
  if (!strip) return;
  const ids   = Array.isArray(STATE.openProjects) ? STATE.openProjects : [];
  const last  = ids.length <= 1;
  const html  = ids.map((pid) => {
    const meta   = STATE.projectMeta.get(pid) ?? STATE.projectSnapshots.get(pid)?.project;
    const name   = meta?.name ?? pid;
    const active = pid === STATE.activeProjectId;
    return `<button class="rp-rt-proj-tab${active ? " active" : ""}"
                    data-pid="${_escAttr(pid)}"
                    title="${_escAttr(name)}"
                    onclick="cleanerSwitchProject('${_escAttr(pid)}')">
      <i class="bi bi-folder2-open"></i>
      <span class="rp-rt-proj-tab-name">${_escHtml(name)}</span>
      ${last ? "" : `<span class="rp-rt-proj-tab-x" title="Close project tab"
                           onclick="event.stopPropagation();cleanerCloseProject('${_escAttr(pid)}')"
        ><i class="bi bi-x"></i></span>`}
    </button>`;
  }).join("");
  // The "+" trigger is a no-fetch CSS-hover dropdown listing every
  // project NOT already open. Built fresh on each render so newly
  // created projects appear without a reload.
  const knownPids = new Set(ids);
  const candidates = [...STATE.projectMeta.values()]
    .filter((p) => p && !knownPids.has(p.redpash_id))
    .sort((a, b) => (a.name ?? "").localeCompare(b.name ?? ""));
  const picker = candidates.length
    ? candidates.map((p) => `<div class="rp-rt-proj-add-item"
                                  onclick="cleanerOpenProject('${_escAttr(p.redpash_id)}')">
        <i class="bi bi-folder2-open"></i> ${_escHtml(p.name ?? p.redpash_id)}
      </div>`).join("")
    : `<div class="rp-rt-proj-add-empty">All your projects are already open.</div>`;
  const add = `<div class="rp-rt-proj-add-wrap">
      <button class="rp-rt-proj-add" type="button" aria-label="Open another project" title="Open another project"
              onclick="event.stopPropagation()">
        <i class="bi bi-plus-lg"></i>
      </button>
      <div class="rp-rt-proj-add-menu">
        <div class="rp-rt-proj-add-hdr">Open another project</div>
        ${picker}
      </div>
    </div>`;
  strip.innerHTML = html + add;
  // Sticky-hover bind for the + picker — same 180ms grace timer the
  // library cols-dd uses. The wrap is recreated on every render, so
  // re-bind every time (no dataset guard needed — fresh elements have
  // no stale listeners).
  _bindProjAddHover(strip);
}

// Keeps the + project-picker dropdown open across the gap between the
// trigger and the panel. Pure CSS :hover propagation through an
// absolutely-positioned menu is unreliable (same reason the library's
// .rp-rt-cols-dd needs JS help — see _bindColsDdHover).
function _bindProjAddHover(strip) {
  const wrap = strip.querySelector(".rp-rt-proj-add-wrap");
  const menu = wrap?.querySelector(".rp-rt-proj-add-menu");
  if (!wrap || !menu) return;
  let closeTimer = null;
  const open  = () => {
    if (closeTimer) { clearTimeout(closeTimer); closeTimer = null; }
    menu.classList.add("open");
  };
  const close = () => {
    closeTimer = setTimeout(() => { menu.classList.remove("open"); closeTimer = null; }, 180);
  };
  wrap.addEventListener("mouseenter", open);
  wrap.addEventListener("mouseleave", close);
  menu.addEventListener("mouseenter", open);
  menu.addEventListener("mouseleave", close);
}

function _renderTabs(root) {
  const list = root.querySelector("#cleaner-tabs-list");
  if (!list) return;

  // The Overview tab is "active" whenever the overview pane is showing
  // — `#page-cleaner.overview-active` is the source of truth. This
  // keeps the tab highlighted across overview re-renders triggered by
  // delete / edit / refresh, which all call _renderTabs.
  const inOverview = root.querySelector("#page-cleaner")?.classList.contains("overview-active");
  const ov = `
    <button class="rp-rtp-tab ${inOverview ? "active" : ""}"
            data-file-id=""
            onclick="cleanerActivateTab('')">
      <i class="bi bi-folder2-open"></i>
      <span class="rp-rtp-tab-name">Overview</span>
    </button>`;

  // Split files: visible ones get rendered as tabs; hidden ones populate
  // the "+" dropdown so the user can put them back. The hidden set
  // survives across mounts via prefs.cleaner_hidden_files.
  const visibleFiles = STATE.files.filter((f) => !STATE.hiddenFiles.has(f.redpash_id));
  const hiddenFiles  = STATE.files.filter((f) =>  STATE.hiddenFiles.has(f.redpash_id));

  const tabs = visibleFiles.map((f) => {
    const isActive = f.redpash_id === STATE.rid;
    // Tab dot color hints at file cleanness (matches the demo).
    const pct = f.cleanness_pct;
    let dotCls = "";
    if (pct != null) dotCls = pct >= 90 ? "ok" : pct >= 70 ? "warn" : "bad";
    const dot = dotCls ? `<span class="rp-rtp-tab-dot ${dotCls}"></span>` : "";
    const name = _escHtml(f.display_name ?? f.filename ?? "");
    const rid  = _escAttr(f.redpash_id);
    // The × is hidden until tab-hover / active and stops propagating
    // its click so closing doesn't also activate the tab.
    return `
      <button class="rp-rtp-tab ${isActive ? "active" : ""}"
              data-file-id="${rid}"
              onclick="cleanerActivateTab('${rid}')">
        ${dot}
        <i class="bi bi-file-earmark-spreadsheet"></i>
        <span class="rp-rtp-tab-name">${name}</span>
        <span class="rp-rtp-tab-x" role="button"
              onclick="event.stopPropagation(); cleanerHideFileTab('${rid}')"
              title="Hide this tab (won't delete the file)">
          <i class="bi bi-x"></i>
        </span>
      </button>`;
  }).join("");

  // "+" add-back control — disabled when nothing is hidden. Dropdown is
  // a sibling so it can escape the tab strip's overflow if needed.
  const addItems = hiddenFiles.map((f) => {
    const name = _escHtml(f.display_name ?? f.filename ?? "");
    return `<button class="rp-rtp-tab-add-item"
                    onclick="cleanerShowFileTab('${_escAttr(f.redpash_id)}')">
      <i class="bi bi-file-earmark-spreadsheet"></i> ${name}
    </button>`;
  }).join("") || `<div class="rp-rtp-tab-add-empty">All file tabs are visible.</div>`;
  const add = `
    <span class="rp-rtp-tab-add-wrap">
      <button class="rp-rtp-tab-add" ${hiddenFiles.length ? "" : "disabled"}
              onclick="cleanerToggleAddMenu(this)"
              title="${hiddenFiles.length
                ? `Show a hidden file tab (${hiddenFiles.length} hidden)`
                : "All file tabs are visible"}">
        <i class="bi bi-plus"></i>
      </button>
      <div class="rp-rtp-tab-add-menu" hidden>${addItems}</div>
    </span>`;

  list.innerHTML = ov + tabs + add;
}

// ── Render: undo / redo / save state ──────────────────────────────────
function _renderHistoryButtons(root) {
  const undoBtn = root.querySelector("#cleaner-undo");
  const redoBtn = root.querySelector("#cleaner-redo");
  const saveBtn = root.querySelector("#cleaner-save");
  // Backend's ProjectStep uses a boolean `applied` (true = currently
  // in the cursor, false = undone and waiting to redo). The frontend
  // earlier read a non-existent `s.status` field; both counts were
  // always 0 → undo + redo were permanently disabled.
  const applied = STATE.steps.filter((s) => s.applied === true).length;
  const undone  = STATE.steps.filter((s) => s.applied === false).length;
  if (undoBtn) undoBtn.disabled = applied === 0;
  if (redoBtn) redoBtn.disabled = undone  === 0;
  // Save (snapshot) is always available once a file is open — the
  // user might want a clean checkpoint at any point, even before
  // applying any steps.
  if (saveBtn) saveBtn.disabled = !STATE.rid;
}

// ── Render: encoding picker ──────────────────────────────────────────
function _renderEncodingPicker(root) {
  const sel  = root.querySelector("#cleaner-encoding-select");
  const now  = root.querySelector("#cleaner-encoding-now");
  if (!sel) return;
  const enc  = (STATE.summary?.encoding ?? "").toLowerCase();
  const opts = Array.from(sel.options).map((o) => o.value.toLowerCase());
  sel.value = opts.includes(enc) ? enc : "";
  if (now) now.textContent = enc ? `detected: ${enc}` : "";
}

// ── Render: paged rows ────────────────────────────────────────────────
async function _loadPage(root) {
  // Leaving overview mode → drop the overview-active class so CSS
  // flips visibility back to the file-view chrome (toolbar + body
  // tagged data-cleaner-view="file"). Idempotent.
  root.querySelector("#page-cleaner")?.classList.remove("overview-active");

  const thead = root.querySelector("[data-rt-thead]");
  const tbody = root.querySelector("[data-rt-tbody]");
  if (!thead || !tbody) return;

  // Auto-invalidate the page cache for this file whenever its step
  // revision changes (a step was applied / undone / redone since the
  // last load). We track per-file step counts in _fileStepsRev; if
  // the current STATE.steps length differs, drop all cached pages
  // for this rid before consulting the cache. This avoids having to
  // call _invalidatePageCache from every step-apply call site.
  const stepsRev = (STATE.steps || []).filter((s) => s.applied === true).length;
  if (_fileStepsRev.get(STATE.rid) !== stepsRev) {
    _invalidatePageCache(STATE.rid);
    _fileStepsRev.set(STATE.rid, stepsRev);
  }

  // Cache lookup — if we've already fetched this exact (rid, page,
  // size, sorts, q) combo since the last step mutation, reuse it so
  // tab-switches feel instant instead of paying a 3s round-trip on a
  // 5k-row page.
  const cacheKey = _pageCacheKey(STATE.rid, STATE.page, STATE.pageSize, STATE.sorts, STATE.q);
  let res = _pageCacheGet(cacheKey);

  if (!res) {
    tbody.innerHTML = `<tr><td style="text-align:center;color:var(--muted);padding:1rem">Loading…</td></tr>`;

    const params = new URLSearchParams();
    params.set("page", String(STATE.page));
    params.set("size", String(STATE.pageSize));
    if (STATE.q) params.set("q", STATE.q);
    if (STATE.sorts?.length) {
      params.set("sorts", JSON.stringify(STATE.sorts));
    }

    try {
      res = await api.get(`/files/${encodeURIComponent(STATE.rid)}/page?${params.toString()}`);
      _pageCachePut(cacheKey, res);
    } catch (err) {
      tbody.innerHTML = `<tr><td style="text-align:center;color:var(--red);padding:1rem">Couldn't load page: ${_escHtml(err.body?.error ?? err.message)}</td></tr>`;
      return;
    }
  }
  STATE.pageData = res;

  // Header — column names from the file detail (already fetched).
  // Mode-aware extras: a leading checkbox column (select-mode) and a
  // trailing trash column (delete-mode). Both are always emitted but
  // hidden by CSS unless the matching mode class is on the panel —
  // avoids a body re-render every time the user flips a toggle.
  //
  // Data-column TH elements are also `draggable` so the user can
  // reorder columns by drag. The drop handler POSTs `filter_columns`
  // with the new order (which Polars's `select(refs)` honours), so
  // reorder is an undoable step like any other.
  const sortRank = new Map(
    (STATE.sorts || []).map((k, i) => [k.col, { dir: k.dir, rank: i + 1 }]),
  );
  const showRanks = sortRank.size > 1;
  const hidden    = STATE.hiddenCols ?? new Set();
  const withNum   = !!STATE.showRowNums;
  thead.innerHTML = `<tr>
    <th data-mode-col="select" style="width:1.5rem">
      <input type="checkbox" id="cleaner-sel-all" onchange="cleanerSelectAll(this.checked)" />
    </th>
    ${withNum ? `<th class="rp-rt-rownum-th">#</th>` : ""}
    ${STATE.columns.map((c) => {
      if (hidden.has(c.name)) return "";
      const entry = sortRank.get(c.name);
      const cls   = `rp-rt-th-sortable${entry ? " rp-rt-sort-th" : ""}`;
      const arrow = entry
        ? ` <i class="bi bi-arrow-${entry.dir === "desc" ? "down" : "up"} rp-rt-sort-ico rp-rt-sort-active"></i>${showRanks ? `<span class="rp-rt-sort-rank">${entry.rank}</span>` : ""}`
        : ` <i class="bi bi-arrow-down-up rp-rt-sort-ico"></i>`;
      // Persisted width (per-file via filePrefs[rid].colWidths) — applied
      // inline; the trailing .rp-rt-col-resize span is the drag handle
      // _clInitColResize wires on every render.
      const w = STATE.colWidths?.[c.name];
      const wStyle = (Number.isFinite(w) && w >= 48)
        ? ` style="width:${w}px;min-width:${w}px"`
        : "";
      return `<th draggable="true" class="${cls}" data-col="${_escAttr(c.name)}"${wStyle}
        onclick="cleanerSortBy('${_escAttr(c.name)}', event)"
        ondragstart="cleanerColDragStart(event)"
        ondragover="cleanerColDragOver(event)"
        ondragleave="cleanerColDragLeave(event)"
        ondrop="cleanerColDrop(event)"
        ondragend="cleanerColDragEnd(event)">${_escHtml(c.name)}${arrow}<span class="rp-rt-col-resize" onclick="event.stopPropagation()" draggable="false"></span></th>`;
    }).join("")}
    <th data-mode-col="delete" style="width:1.75rem"></th>
  </tr>`;

  // Wire resize handles on the freshly-painted thead. ctx writes into
  // STATE.colWidths + persists via _saveFilePrefs so the layout survives
  // tab switches AND in-session re-renders (page change, sort, search,
  // hide/show, row-numbers toggle).
  _clInitColResize(thead, {
    set(name, w) {
      STATE.colWidths = STATE.colWidths || {};
      STATE.colWidths[name] = w;
      if (STATE.rid) _saveFilePrefs(STATE.rid);
    },
  });

  // Reset the page-relative selection — indices only make sense within
  // a single page since the server may return a different slice next
  // time (sort, search, page bump).
  STATE.selected.clear();
  _renderSelectionChip(root);

  const rows = res.rows ?? [];
  if (!rows.length) {
    // +1 select, +1 delete, +1 row-num (when on), minus hidden data cols
    const visibleData = STATE.columns.filter((c) => !hidden.has(c.name)).length;
    const span = visibleData + 2 + (withNum ? 1 : 0);
    tbody.innerHTML = `<tr><td colspan="${span}" style="text-align:center;color:var(--muted);padding:1rem">No rows.</td></tr>`;
  } else {
    // data-ri holds the page-relative row index — used by the select /
    // delete handlers AND, when delete-mode commits, mapped to the
    // ABSOLUTE row index via (page-1)*pageSize+ri before being sent to
    // /steps drop_rows.
    const startNum = (STATE.page - 1) * STATE.pageSize + 1;
    tbody.innerHTML = rows.map((row, ri) =>
      `<tr data-ri="${ri}">
        <td data-mode-col="select"><input type="checkbox" class="rp-rt-row-chk" data-ri="${ri}" onchange="cleanerRowSelect(this)" /></td>
        ${withNum ? `<td class="rp-rt-rownum-td">${(startNum + ri).toLocaleString()}</td>` : ""}
        ${row.map((c, ci) => {
          const name = STATE.columns[ci]?.name ?? "";
          if (hidden.has(name)) return "";
          return `<td data-col="${_escAttr(name)}" data-ri="${ri}" ondblclick="cleanerCellEdit(this)">${_escHtml(c ?? "")}</td>`;
        }).join("")}
        <td data-mode-col="delete"><button type="button" class="rp-rt-row-del" title="Drop this row" onclick="cleanerRowDelete(${ri})"><i class="bi bi-trash3"></i></button></td>
      </tr>`
    ).join("");
  }

  // Reveal / hide the wrapped-CSV banner based on the current page
   // sample. Cheap heuristic; the Rust step verifies + re-parses.
  _renderWrappedBanner(root);

  // Paging summary line.
  const total  = res.total ?? rows.length;
  const start  = total === 0 ? 0 : (STATE.page - 1) * STATE.pageSize + 1;
  const end    = Math.min(STATE.page * STATE.pageSize, total);
  const infoEl = root.querySelector("[data-rt-rows-info]");
  if (infoEl) infoEl.textContent = total === 0 ? "0 rows" : `${start.toLocaleString()}–${end.toLocaleString()} of ${total.toLocaleString()}`;

  // Page nav — populates the [data-rt-pages] slot. Smart window
  // (Django-style): [1 … cur-1 cur cur+1 … last] so we don't render
  // 1000+ buttons for a 100k-row file at 10 rows/page.
  _renderPaging(root, res.pages ?? 1);
}

// Render the page navigator into [data-rt-pages]. Hidden when only
// one page; otherwise: ← prev, page-number buttons (smart window),
// → next. cleanerSetPage(n) is the click target — validates the
// requested page + reloads.
function _renderPaging(root, totalPages) {
  // [data-rt-pages] is a panel-level slot (shared between file +
  // overview chrome). Overview is client-side paginated so we never
  // paint into it from there — _renderPaging is only called from
  // _loadPage which is file-view only.
  const slot = root.querySelector("[data-rt-pages]");
  if (!slot) return;
  if (totalPages <= 1) { slot.innerHTML = ""; return; }
  const cur = Math.max(1, Math.min(totalPages, STATE.page || 1));
  const nums = _smartPageNums(cur, totalPages);
  const prevDisabled = cur === 1 ? "disabled" : "";
  const nextDisabled = cur === totalPages ? "disabled" : "";
  const buttons = nums.map((p) => {
    if (p === "…") return `<span class="rp-rt-pg rp-rt-pg-gap">…</span>`;
    const cls = `rp-rt-pg${p === cur ? " on" : ""}`;
    return `<button class="${cls}" onclick="cleanerSetPage(${p})">${p}</button>`;
  }).join("");
  slot.innerHTML = `
    <button class="rp-rt-pg" ${prevDisabled} onclick="cleanerSetPage(${cur - 1})" title="Previous page">
      <i class="bi bi-chevron-left"></i>
    </button>
    ${buttons}
    <button class="rp-rt-pg" ${nextDisabled} onclick="cleanerSetPage(${cur + 1})" title="Next page">
      <i class="bi bi-chevron-right"></i>
    </button>`;
}

// Mirrors the demo's _s2PageNums: total ≤ 7 → list everything; else
// [1, …, cur-1, cur, cur+1, …, last] with literal "…" sentinels.
// ── Columns dropdown hover ────────────────────────────────────────
// Ported from objects.js `_bindColsDdHover`. Pure CSS :hover propagation
// through the wide, absolutely-positioned .rp-rt-cols-dd panel is
// unreliable: as soon as the cursor crosses the gap between the trigger
// and the panel, hover detaches and the panel fades. Bind an explicit
// open/close pair with a 180ms grace timer — the panel's own mouseenter
// cancels the timer, so moving the cursor onto the panel keeps it open.
// dataset flag guards against double-bind on router re-mount.
function _bindColsDdHover(root) {
  root.querySelectorAll(".rp-rt-cols-wrap").forEach((wrap) => {
    if (wrap.dataset.ddHoverBound) return;
    wrap.dataset.ddHoverBound = "1";
    const dd = wrap.querySelector(".rp-rt-cols-dd");
    if (!dd) return;
    let closeTimer = null;
    const open  = () => {
      if (closeTimer) { clearTimeout(closeTimer); closeTimer = null; }
      dd.classList.add("open");
    };
    const close = () => {
      closeTimer = setTimeout(() => { dd.classList.remove("open"); closeTimer = null; }, 180);
    };
    wrap.addEventListener("mouseenter", open);
    wrap.addEventListener("mouseleave", close);
    dd.addEventListener("mouseenter", open);
    dd.addEventListener("mouseleave", close);
  });
}

function _smartPageNums(cur, total) {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
  const out = [1];
  if (cur > 3) out.push("…");
  for (let p = Math.max(2, cur - 1); p <= Math.min(total - 1, cur + 1); p++) out.push(p);
  if (cur < total - 2) out.push("…");
  out.push(total);
  return out;
}

// ── Column resize ─────────────────────────────────────────────────
// Ported from objects.js _objColResize*; same drag mechanic as that
// page, but parametrised via a `ctx` object so the Overview table
// and the per-file CSV table can each persist widths into their own
// store (OV.colWidths → localStorage for Overview, STATE.colWidths
// → filePrefs[rid].colWidths for the file view).
//
// Wiring: each .rp-rt-col-resize span (emitted inside data-col TH
// cells) is the absolute-positioned grab handle the library already
// styles. mousedown captures startX + startW; mousemove pushes the
// new width into the th's inline style; mouseup commits to the ctx
// store and triggers a persist callback so the layout survives the
// next render.
let _clColResize = null;

function _clInitColResize(thead, ctx) {
  thead.querySelectorAll(".rp-rt-col-resize").forEach((h) => {
    h.addEventListener("mousedown", (e) => _clColResizeDown(e, ctx));
  });
}
function _clColResizeDown(e, ctx) {
  // stopPropagation so the handle drag doesn't kick off the column-
  // reorder dragstart on the parent <th> (objColDrag* / cleanerColDrag*).
  e.preventDefault();
  e.stopPropagation();
  const handle = e.currentTarget;
  const th     = handle.closest("th");
  if (!th) return;
  _clColResize = {
    th, handle, ctx,
    key:    th.dataset.col,
    startX: e.clientX,
    startW: th.offsetWidth,
  };
  handle.classList.add("rp-rt-resizing");
  document.body.classList.add("rp-rt-col-resizing");
  document.addEventListener("mousemove", _clColResizeMove);
  document.addEventListener("mouseup",   _clColResizeUp);
}
function _clColResizeMove(e) {
  if (!_clColResize) return;
  // Min 48px so columns can't be dragged into oblivion.
  const w = Math.max(48, _clColResize.startW + e.clientX - _clColResize.startX);
  _clColResize.th.style.width    = `${w}px`;
  _clColResize.th.style.minWidth = `${w}px`;
}
function _clColResizeUp() {
  if (_clColResize) {
    const { th, handle, ctx, key } = _clColResize;
    if (ctx && key) ctx.set(key, th.offsetWidth);
    handle.classList.remove("rp-rt-resizing");
    _clColResize = null;
  }
  document.body.classList.remove("rp-rt-col-resizing");
  document.removeEventListener("mousemove", _clColResizeMove);
  document.removeEventListener("mouseup",   _clColResizeUp);
}

// ── Inline-onclick globals ────────────────────────────────────────────
function _wireGlobals(root) {
  // Header chrome
  window.cleanerBack    = () => { location.hash = "#/objects"; };

  // Export — GET /:rid/export streams the current view (post
  // step-replay) as a CSV with a Content-Disposition filename. We
  // fetch-as-blob rather than navigating the browser to the URL so a
  // failure surfaces as a toast instead of a blank tab, and so the
  // session cookie rides along (credentials: "include"). The blob is
  // handed to a transient <a download> click, then the object URL is
  // revoked to free memory.
  window.cleanerExport = async () => {
    if (!STATE.rid) { toast.error("Open a file first."); return; }
    const btn = root.querySelector("#cleaner-export");
    btn?.classList.add("is-spinning");
    try {
      const res = await fetch(
        `/api/files/${encodeURIComponent(STATE.rid)}/export`,
        { credentials: "include" },
      );
      if (!res.ok) {
        let msg = `HTTP ${res.status}`;
        try { msg = (await res.json()).error ?? msg; } catch {}
        throw new Error(msg);
      }
      // Pull the server-suggested filename out of Content-Disposition;
      // fall back to the in-memory summary name if the header is
      // missing or unparseable.
      const cd = res.headers.get("Content-Disposition") ?? "";
      const m  = /filename="?([^"]+)"?/.exec(cd);
      const stem = (STATE.summary?.display_name ?? STATE.summary?.filename ?? "export")
        .replace(/\.csv$/i, "");
      const name = m?.[1] ?? `${stem}.csv`;

      const blob = await res.blob();
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement("a");
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast.success(`Exported ${name}`);
    } catch (err) {
      toast.error(`Export failed: ${err.message ?? err}`);
    } finally {
      btn?.classList.remove("is-spinning");
    }
  };

  // Add a new file to the ACTIVE project. The + button programmatically
  // clicks a hidden <input type="file"> (we create one on demand);
  // user picks a file → we POST it through /api/files/upload with the
  // `project_name` field set to STATE.project.name. The backend's
  // `ensure_named_project` finds the existing project by (owner, name)
  // rather than creating a duplicate. Then we refresh the tab strip +
  // jump to the newly-uploaded file.
  window.cleanerAddFile = () => {
    if (!STATE.project) { toast.error("No project loaded."); return; }
    let inp = root.querySelector("#cleaner-add-file-input");
    if (!inp) {
      inp = document.createElement("input");
      inp.type = "file";
      inp.id   = "cleaner-add-file-input";
      inp.accept = ".csv,.tsv,.txt,.xlsx,.xls,.xlsm,.xlsb,.ods";
      inp.multiple = true;   // multi-select — mirrors the Objects upload modal
      inp.style.display = "none";
      inp.onchange = async () => {
        const files = [...(inp.files ?? [])];
        inp.value = "";   // allow re-picking the same file(s) later
        if (!files.length) return;

        // Sequential upload — one POST per file, same as the Objects
        // upload-modal addFiles loop. Each success toasts its filename;
        // a failure stops the run and reports how far we got.
        let lastEnv = null, done = 0;
        for (const file of files) {
          const form = new FormData();
          form.append("file", file);
          form.append("project_name", STATE.project.name ?? "");
          try {
            const res = await fetch("/api/files/upload", {
              method: "POST", body: form, credentials: "include",
            });
            if (!res.ok) throw new Error((await res.json()).error ?? `HTTP ${res.status}`);
            lastEnv = await res.json();
            done++;
          } catch (err) {
            toast.error(`Stopped after ${done} — ${file.name}: ${err.message ?? err}`);
            break;
          }
        }
        if (!done) return;

        // Refresh the sibling-files list + tabs once at the end so the
        // strip rebuilds with every new file at once.
        const lst = await api.get(`/projects/${encodeURIComponent(STATE.project.redpash_id)}/files`).catch(() => null);
        if (lst?.items) STATE.files = lst.items;
        _renderHeaderMeta(root);
        _renderTabs(root);

        toast.success(`Added ${done} file${done !== 1 ? "s" : ""}`);

        // Navigate into the LAST uploaded file (matches the
        // home page's single-upload auto-nav for the 1-file case, and
        // is the most-recent-thing-I-touched for multi-file).
        if (lastEnv?.summary?.redpash_id) {
          window.cleanerActivateTab(lastEnv.summary.redpash_id);
        }
      };
      root.appendChild(inp);
    }
    inp.click();
  };

  // Save snapshot — POST /:rid/snapshot creates a new project file
  // with the current view as its content. Default name = filename
  // stem + "_cleaned.csv". Returns a FileEnvelope for the NEW file;
  // we jump to it so the user is editing the snapshot, not the
  // original (preserving the original's full step history).
  window.cleanerSave = async () => {
    if (!STATE.summary) return;
    const stem = (STATE.summary.display_name ?? STATE.summary.filename ?? "file")
      .replace(/\.[^.]+$/, "");
    const defaultName = `${stem}_cleaned.csv`;
    const name = prompt("Save current view as a new file:", defaultName);
    if (!name || !name.trim()) return;
    try {
      const env = await api.post(
        `/files/${encodeURIComponent(STATE.rid)}/snapshot`,
        { name: name.trim() },
      );
      toast.success(`Saved ${env.summary.filename}`);
      location.hash = `#/cleaner?file=${encodeURIComponent(env.summary.redpash_id)}`;
    } catch (err) {
      toast.error(`Save failed: ${err.body?.error ?? err.message}`);
    }
  };

  // Undo / redo — backend POSTs return the same FileEnvelope as add_step,
  // so the post-call refresh is identical to cleanerApplyTool.
  const _afterHistory = async (envelope, label) => {
    STATE.summary = envelope.summary;
    STATE.columns = envelope.columns ?? [];
    STATE.steps   = envelope.steps   ?? [];
    // Keep the tab strip in sync — cleanness_pct may have moved.
    const idx = STATE.files.findIndex((f) => f.redpash_id === STATE.rid);
    if (idx >= 0) STATE.files[idx] = envelope.summary;
    _renderTitle(root);
    _renderHeaderMeta(root);
    _renderOverallCleanness(root);
    _renderHistoryButtons(root);
    _renderAppliedList(root);
      _renderDtypeList(root);
    _renderTabs(root);
    await _loadPage(root);
    toast.success(label);
  };
  window.cleanerUndo = async () => {
    try {
      const env = await api.post(`/files/${encodeURIComponent(STATE.rid)}/undo`, {});
      await _afterHistory(env, "Undone");
    } catch (err) {
      toast.error(`Undo failed: ${err.body?.error ?? err.message}`);
    }
  };
  window.cleanerRedo = async () => {
    try {
      const env = await api.post(`/files/${encodeURIComponent(STATE.rid)}/redo`, {});
      await _afterHistory(env, "Redone");
    } catch (err) {
      toast.error(`Redo failed: ${err.body?.error ?? err.message}`);
    }
  };

  // Tab switching — kept client-side per user direction. Mirrors the
  // Django pattern in clarna-django/static/js/cleaner.js
  // `_cleanerActivateTab`: history.replaceState + targeted re-fetch
  // INSTEAD of a hash change (which would trigger the router and
  // re-mount the whole partial). Result: switching between files is
  // just one /api/files/:rid round-trip + a re-paint of the affected
  // slots, no partial swap, no /api/projects refetch.
  // Persist STATE.hiddenFiles to the user's account prefs. Same pattern
  // as objects.js _persistObjTabs — fire-and-forget, the in-memory set
  // is already authoritative for this session.
  const _persistHidden = () => {
    window.rpSavePref?.("cleaner_hidden_files", [...STATE.hiddenFiles]);
  };

  // Full sandbox strip repaint. Kept for recovery / debug use, but
  // NOT called from the live close/open/switch handlers anymore: the
  // sandbox helpers (spDeleteTab / spAddProjectTab / spActivateTab)
  // own the animated DOM transitions on click, and a full repaint
  // mid-transition would wipe the .is-removing / .is-entering classes
  // before the CSS animation completed. Live handlers now run STATE
  // + persistence only; the sandbox helpers wired into the tab markup
  // handle visual updates. mountSandbox does the only initial render.
  const _repaintSandboxStrips = () => {
    const activeFile = STATE.files.find((f) => f.redpash_id === STATE.rid) || null;
    if (typeof _renderSandboxFileTabs === "function") {
      _renderSandboxFileTabs(root, STATE.files, activeFile);
    }
    const pstrip = root.querySelector(".rp-rt-proj-tabs-inner");
    if (pstrip && typeof _renderSandboxProjectTabs === "function") {
      const projsByPid = new Map();
      if (STATE.project) projsByPid.set(STATE.project.redpash_id, STATE.project);
      if (STATE.projectMeta) {
        for (const [k, v] of STATE.projectMeta.entries()) projsByPid.set(k, v);
      }
      _renderSandboxProjectTabs(pstrip, projsByPid, STATE.openProjects, STATE.activeProjectId);
    }
  };
  // Expose for debug / explicit recovery (e.g. after a malformed STATE
  // mutation). Not used in the normal click flows.
  window.__cleanerRepaintSandboxStrips = _repaintSandboxStrips;

  // × on a file tab — hide it (keep the file in the project). If the
  // hidden tab was active, fall back to the next visible file, else
  // overview. The "+" dropdown then surfaces the hidden file so the
  // user can put it back.
  window.cleanerHideFileTab = (fid) => {
    if (!fid) return;
    STATE.hiddenFiles.add(fid);
    _persistHidden();
    if (STATE.rid === fid) {
      const nextVisible = STATE.files.find((f) =>
        f.redpash_id !== fid && !STATE.hiddenFiles.has(f.redpash_id));
      const target = nextVisible?.redpash_id ?? "";
      // Re-render before activating so the activate path sees the new
      // tab strip. cleanerActivateTab("") routes to Overview.
      _renderTabs(root);
      window.cleanerActivateTab(target);
    } else {
      _renderTabs(root);
    }
  };

  // "+" menu item — put a hidden file tab back. Close the menu first so
  // the re-render doesn't leave a stale popover.
  window.cleanerShowFileTab = (fid) => {
    if (!fid) return;
    STATE.hiddenFiles.delete(fid);
    _persistHidden();
    root.querySelectorAll(".rp-rtp-tab-add-menu").forEach((m) => m.hidden = true);
    _renderTabs(root);
  };

  // Toggle the "+" dropdown. Menu is position:fixed (so it escapes
  // .rp-rtp-tabs' overflow-y:hidden clip), so we anchor it to the
  // button's bounding rect at click time. Falls off the right edge?
  // Shift left so it stays in the viewport.
  window.cleanerToggleAddMenu = (btn) => {
    const menu = btn.parentElement?.querySelector(".rp-rtp-tab-add-menu");
    if (!menu) return;
    const wasOpen = !menu.hidden;
    root.querySelectorAll(".rp-rtp-tab-add-menu").forEach((m) => m.hidden = true);
    if (wasOpen) return;
    const r = btn.getBoundingClientRect();
    menu.style.top  = `${r.bottom + 4}px`;
    menu.hidden = false;
    // Now that the menu is in the flow, clamp its left edge so it
    // doesn't spill off-viewport.
    const w = menu.offsetWidth;
    let left = r.left;
    if (left + w > window.innerWidth - 8) left = window.innerWidth - w - 8;
    if (left < 8) left = 8;
    menu.style.left = `${left}px`;
  };
  // Outside-click dismisses the add-menu.
  root.addEventListener("click", (e) => {
    if (e.target.closest(".rp-rtp-tab-add-wrap")) return;
    root.querySelectorAll(".rp-rtp-tab-add-menu").forEach((m) => m.hidden = true);
  });

  // ── Project tabs (panel-header level) ────────────────────────────
  // Switch the active project — snapshots the leaving project's full
  // STATE slice, then either restores the entering project's snapshot
  // (instant) or does a fresh fetch on first visit. Updates the URL
  // via replaceState so a refresh lands on the same project.
  window.cleanerSwitchProject = async (pid) => {
    if (!pid || pid === STATE.activeProjectId) return;
    if (STATE.activeProjectId) _saveProjectSnapshot(STATE.activeProjectId);
    STATE.activeProjectId = pid;
    history.replaceState(null, "", `#/cleaner?project=${encodeURIComponent(pid)}`);
    if (!_loadProjectSnapshot(pid)) {
      // First visit — full fetch. Default landing is the project Overview
      // (rid=null); the user picks a file from the tab strip afterwards.
      await _fetchProjectFresh(pid, { fileRid: null });
    }
    // Repaint everything that depends on the project switch. The
    // sandbox strips do NOT get a full repaint here — spActivateTab
    // (fired by the tab's onclick) already flipped the active class.
    // A full repaint would wipe any in-flight .is-entering animation
    // from a picker-driven spAddProjectTab. Chrome below targets the
    // header/title/cleanness widget — separate from the strips.
    _renderProjectTabs(root);
    _renderTitle(root);
    _renderHeaderMeta(root);
    _renderOverallCleanness(root);
    _renderHistoryButtons(root);
    _renderEncodingPicker(root);
    _renderTabs(root);
    if (STATE.rid) {
      await _loadPage(root);
      _syncToolbarToState(root);
      window.cleanerBuildColsDropdown?.();
    } else {
      // No active file → land on the project's overview pane.
      window.cleanerActivateTab?.("");
    }
  };
  // Open another project from the picker dropdown. Appends to
  // openProjects, persists the pref, then switches to it. No-op
  // if the project is already open.
  window.cleanerOpenProject = async (pid) => {
    if (!pid) return;
    if (!STATE.openProjects.includes(pid)) {
      STATE.openProjects.push(pid);
      window.rpSavePref?.("cleaner_open_projects", STATE.openProjects);
    }
    // Hide the add-menu in case it's still open from the click.
    root.querySelectorAll(".rp-rt-proj-add-menu").forEach((m) => m.hidden = true);
    await window.cleanerSwitchProject(pid);
  };
  // Close a project tab. Drops it from openProjects + persists. If the
  // user closed the active tab, switch to a neighbour (next, else
  // previous). If they closed the only tab the page would orphan —
  // the × button is suppressed in that case via _renderProjectTabs.
  window.cleanerCloseProject = async (pid) => {
    if (!pid || STATE.openProjects.length <= 1) return;
    const i = STATE.openProjects.indexOf(pid);
    if (i < 0) return;
    STATE.openProjects.splice(i, 1);
    // Drop the snapshot — releases the cached files / pageData.
    STATE.projectSnapshots.delete(pid);
    window.rpSavePref?.("cleaner_open_projects", STATE.openProjects);
    if (pid === STATE.activeProjectId) {
      const next = STATE.openProjects[i] ?? STATE.openProjects[i - 1];
      STATE.activeProjectId = null;   // force switchProject to refetch / restore
      await window.cleanerSwitchProject(next);
    } else {
      _renderProjectTabs(root);
      // Note: no sandbox strip repaint — the × on the tab was already
      // handled by spDeleteTab (animated DOM remove). This handler
      // only owns STATE + persistence.
    }
  };

  window.cleanerActivateTab = async (fid) => {
    if (!fid) {
      // Overview — project-level view that REPLACES the table body
      // with a per-file summary. The tools panel + toolbar stay
      // visible but stop targeting an active file. The Rust /api
      // didn't change for this; we paint from STATE.files which is
      // already in memory.
      root.querySelectorAll("#cleaner-tabs-list .rp-rtp-tab").forEach((t) => {
        t.classList.toggle("active", t.dataset.fileId === "");
      });
      try {
        history.replaceState(null, "", `#/cleaner?project=${encodeURIComponent(STATE.project?.redpash_id ?? "")}`);
      } catch {}
      // Snapshot the leaving file's toolbar prefs so re-opening it
      // from Overview later restores its pageSize / search / sorts /
      // mode / page.
      if (STATE.rid) _saveFilePrefs(STATE.rid);
      // Drop ALL file-specific state so the chrome that's still
      // visible in overview mode (header title + undo/redo/save +
      // Data Types + Applied + Encoding picker) doesn't keep painting
      // the previously-open file. Without this, e.g. undo stays
      // enabled and the Tools-panel Data Types list still shows that
      // file's columns — both confusing in a no-file-active context.
      STATE.rid     = null;
      STATE.summary = null;
      STATE.columns = [];
      STATE.steps   = [];
      STATE.page    = 1;
      _renderTitle(root);
      _renderHistoryButtons(root);
      _renderAppliedList(root);
      _renderDtypeList(root);
      _renderEncodingPicker(root);
      _renderOverview(root);
      return;
    }
    if (fid === STATE.rid) return;

    // Snapshot the leaving tab's toolbar prefs into filePrefs so
    // re-entering this file later restores its pageSize / search /
    // sorts / mode / page index. Without this, every per-tab toolbar
    // choice would leak across tabs.
    if (STATE.rid) _saveFilePrefs(STATE.rid);

    // If the target was × -closed in the tab strip, opening it from
    // elsewhere (e.g. Overview row click) is an explicit intent to view
    // it — un-hide and re-render the strip so the tab pops back.
    if (STATE.hiddenFiles?.has(fid)) {
      STATE.hiddenFiles.delete(fid);
      window.rpSavePref?.("cleaner_hidden_files", [...STATE.hiddenFiles]);
      _renderTabs(root);
    }

    // Optimistic UI: flip the .active class before the fetch lands so
    // the click feels instant. Django uses the same approach.
    root.querySelectorAll("#cleaner-tabs-list .rp-rtp-tab").forEach((t) => {
      t.classList.toggle("active", t.dataset.fileId === fid);
    });

    // Coming from Overview → drop overview-active so CSS swaps the
    // visible chrome block back to the file-view one. _renderOverview
    // added it on the way in.
    root.querySelector("#page-cleaner")?.classList.remove("overview-active");

    // Update the URL hash WITHOUT firing hashchange so the router
    // doesn't intercept and re-mount. replaceState (not pushState)
    // because re-clicking a sibling tab shouldn't pollute the back
    // stack with every step.
    try {
      history.replaceState(null, "", `#/cleaner?file=${encodeURIComponent(fid)}`);
    } catch {}

    // Fetch just the new file's detail. Project + files lineup didn't
    // change, so we leave STATE.project / STATE.files alone.
    let detail;
    try {
      detail = await api.get(`/files/${encodeURIComponent(fid)}`);
    } catch (err) {
      toast.error(`Couldn't open file: ${err.body?.error ?? err.message}`);
      // Roll the active class back onto the previous tab.
      root.querySelectorAll("#cleaner-tabs-list .rp-rtp-tab").forEach((t) => {
        t.classList.toggle("active", t.dataset.fileId === STATE.rid);
      });
      return;
    }

    STATE.rid     = fid;
    STATE.summary = detail.summary;
    STATE.columns = detail.columns ?? [];
    STATE.steps   = detail.steps ?? [];
    // Rehydrate toolbar prefs from the per-file snapshot (defaults
    // for never-visited tabs). _loadFilePrefs sets STATE.pageSize /
    // page / q / sorts and re-applies them to the toolbar DOM
    // (rows-per-page label + dropdown checkmark, search input value,
    // mode button is-active state).
    _loadFilePrefs(root, fid);

    // Re-paint just the slots that depend on the active file. Tabs
    // already flipped above; project meta + status + cleanness aggregate
    // are project-scope and don't move when switching files.
    _renderTitle(root);
    _renderHistoryButtons(root);
    _renderAppliedList(root);
      _renderDtypeList(root);
    _renderEncodingPicker(root);
    _renderOverallCleanness(root);  // cleanness uses summary as fallback when project agg is null
    _renderJoinsPanel(root).catch(() => {});  // async, paints when ready
    await _loadPage(root);
  };

  // Tools panel toggle — class flip for now; Phase 2 wires the modals.
  window.toggleCleanerTools = () => {
    const panel = root.querySelector("#cleaner-tools-panel");
    if (!panel) return;
    panel.classList.toggle("open");
  };

  // Collapse / expand a tools-panel section. Ported from the demo's
  // toggleToolSect — flips `.open` on both the header and the next
  // sibling (the body). Library CSS does the rest: chevron rotates
  // -90° when the header loses `.open`, body display flips between
  // none and flex via `.rp-rtp-tool-sect-body.open`.
  window.cleanerToggleToolSect = (header) => {
    if (!header) return;
    header.classList.toggle("open");
    const body = header.nextElementSibling;
    if (body && body.classList.contains("rp-rtp-tool-sect-body")) {
      body.classList.toggle("open");
    }
  };

  // ─── Overview redtable handlers (isolated from the file table) ────
  // Everything below reads/writes the `OV` state object and the
  // `#cleaner-overview` DOM ONLY. None of it touches STATE.selected or
  // the `.rp-rt-panel--cleaner` mode classes — so operating on the
  // overview list never leaks into a file tab's redtable.

  // Mode toggle — mutually exclusive. The mode lives on OV.mode and is
  // mirrored to a data-attr on `.ov-rt` that the CSS reads to show /
  // hide the leading checkbox + trailing trash columns and the
  // edit-mode hover cue. Re-renders the overview to repaint the
  // toolbar's active states.
  window.ovToggleMode = (mode) => {
    OV.mode = OV.mode === mode ? null : mode;
    // Leaving select-mode clears ticks so a stale selection can't
    // carry into the next select-mode entry or a bulk delete.
    if (OV.mode !== "select") OV.selected.clear();
    _renderOverview(root);
  };

  // Client-side search — STATE.files is small, so no fetch. Debounced
  // lightly so typing doesn't re-render on every keystroke.
  let _ovSearchTimer = null;
  window.ovSearch = (input) => {
    clearTimeout(_ovSearchTimer);
    const val = input.value ?? "";
    _ovSearchTimer = setTimeout(() => {
      OV.q = val;
      _renderOverview(root);
      // Restore focus + caret — _renderOverview rebuilt the input.
      const fresh = root.querySelector("#cleaner-ov-toolbar .rp-rt-search");
      if (fresh) { fresh.focus(); fresh.setSelectionRange(val.length, val.length); }
    }, 180);
  };

  // Column-header click → mutate the chain. Plain click replaces the
  // chain with [{col, asc}] (or flips dir if it's the sole key);
  // shift-click appends / flips / drops. Mirrors objSortBy and
  // cleanerSortBy so the three sortable redtables share one UX.
  window.ovSortBy = (col, ev) => {
    if (!col) return;
    if (!Array.isArray(OV.sorts)) OV.sorts = [];
    const shift = !!(ev && ev.shiftKey);
    const alt   = !!(ev && ev.altKey);
    const idx   = OV.sorts.findIndex((k) => k.col === col);
    if (shift) {
      if (idx >= 0) {
        if (alt) OV.sorts.splice(idx, 1);
        else     OV.sorts[idx].dir = OV.sorts[idx].dir === "asc" ? "desc" : "asc";
      } else {
        OV.sorts.push({ col, dir: "asc" });
      }
    } else {
      if (OV.sorts.length === 1 && OV.sorts[0].col === col) {
        OV.sorts[0].dir = OV.sorts[0].dir === "asc" ? "desc" : "asc";
      } else {
        OV.sorts = [{ col, dir: "asc" }];
      }
    }
    _renderOverview(root);
  };

  // Column drag-to-reorder — mirrors the file-table's cleanerColDrag*
  // pattern but mutates OV.colOrder (per-user UI pref) instead of
  // POSTing a filter_columns step. Drop on a column = "insert source
  // before target" (matches Mac Finder + Excel + the file table).
  let _ovDragCol = null;
  window.ovColDragStart = (e) => {
    const th = e.currentTarget;
    _ovDragCol = th?.dataset?.col || null;
    if (_ovDragCol) {
      e.dataTransfer.effectAllowed = "move";
      // Firefox refuses to fire dragover unless some data is set.
      try { e.dataTransfer.setData("text/plain", _ovDragCol); } catch {}
      th.classList.add("rp-rt-th-drag");
    }
  };
  window.ovColDragOver = (e) => {
    if (!_ovDragCol) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    const th = e.currentTarget;
    if (th && th.dataset.col !== _ovDragCol) th.classList.add("rp-rt-th-drop");
  };
  window.ovColDragLeave = (e) => {
    e.currentTarget?.classList.remove("rp-rt-th-drop");
  };
  window.ovColDragEnd = () => {
    root.querySelectorAll("#cleaner-ov-table thead th.rp-rt-th-drag, #cleaner-ov-table thead th.rp-rt-th-drop")
      .forEach((t) => t.classList.remove("rp-rt-th-drag", "rp-rt-th-drop"));
    _ovDragCol = null;
  };
  window.ovColDrop = (e) => {
    e.preventDefault();
    const targetTh = e.currentTarget;
    const target   = targetTh?.dataset?.col;
    const source   = _ovDragCol;
    window.ovColDragEnd();
    if (!source || !target || source === target) return;
    // Splice the source key out, re-find target's new index, insert
    // source before it. Matches the file-table reorder semantics.
    const from = OV.colOrder.indexOf(source);
    if (from < 0) return;
    OV.colOrder.splice(from, 1);
    const insertAt = OV.colOrder.indexOf(target);
    if (insertAt < 0) return;
    OV.colOrder.splice(insertAt, 0, source);
    _ovSaveColOrder();
    _renderOverview(root);
  };

  window.ovRowSelect = (chk) => {
    const rid = chk.dataset.rid;
    if (chk.checked) OV.selected.add(rid);
    else             OV.selected.delete(rid);
    chk.closest("tr")?.classList.toggle("rp-rt-row-sel", chk.checked);
    _renderOvSelectionChip(root);
  };

  window.ovSelectAll = (on) => {
    OV.selected.clear();
    root.querySelectorAll(".ov-rt-table tbody .ov-row-chk").forEach((cb) => {
      cb.checked = on;
      cb.closest("tr")?.classList.toggle("rp-rt-row-sel", on);
      if (on) OV.selected.add(cb.dataset.rid);
    });
    _renderOvSelectionChip(root);
  };

  window.ovClearSelection = () => {
    OV.selected.clear();
    root.querySelectorAll(".ov-rt-table tbody .ov-row-chk").forEach((cb) => {
      cb.checked = false;
      cb.closest("tr")?.classList.remove("rp-rt-row-sel");
    });
    const head = root.querySelector("#ov-sel-all");
    if (head) { head.checked = false; head.indeterminate = false; }
    _renderOvSelectionChip(root);
  };

  // Delete one file. After the DELETE lands we drop it from STATE.files,
  // the tab strip, and OV.selected, then re-render both the overview
  // and the tabs. If the deleted file happened to be the active one,
  // STATE.rid is repointed at the first survivor (or null) so a later
  // tab click doesn't 404.
  const _afterFileDeleted = (rid) => {
    STATE.files = (STATE.files ?? []).filter((f) => f.redpash_id !== rid);
    OV.selected.delete(rid);
    if (STATE.rid === rid) {
      STATE.rid     = STATE.files[0]?.redpash_id ?? null;
      STATE.summary = null;
    }
    _renderTabs(root);
    _renderHeaderMeta(root);
    _renderOverview(root);
  };

  window.ovRowDelete = async (rid) => {
    const f = (STATE.files ?? []).find((x) => x.redpash_id === rid);
    const label = f?.display_name ?? f?.filename ?? rid;
    if (!confirm(`Delete "${label}"? This removes its cleaning history and any reports built from it.`)) return;
    try {
      await api.delete(`/files/${encodeURIComponent(rid)}`);
      _afterFileDeleted(rid);
      toast.success(`Deleted ${label}`);
    } catch (err) {
      toast.error(`Delete failed: ${err.body?.error ?? err.message}`);
    }
  };

  window.ovBulkDelete = async () => {
    const ids = [...OV.selected];
    if (!ids.length) return;
    if (!confirm(`Delete ${ids.length} file${ids.length !== 1 ? "s" : ""}? This removes their cleaning history and any reports built from them.`)) return;
    // Sequential — keeps the error story simple and the file count is
    // small. A failure stops the run and reports how far we got.
    let done = 0;
    for (const rid of ids) {
      try {
        await api.delete(`/files/${encodeURIComponent(rid)}`);
        STATE.files = (STATE.files ?? []).filter((f) => f.redpash_id !== rid);
        OV.selected.delete(rid);
        if (STATE.rid === rid) { STATE.rid = null; STATE.summary = null; }
        done++;
      } catch (err) {
        _renderTabs(root); _renderHeaderMeta(root); _renderOverview(root);
        toast.error(`Stopped after ${done} — ${err.body?.error ?? err.message}`);
        return;
      }
    }
    if (STATE.rid == null) STATE.rid = STATE.files[0]?.redpash_id ?? null;
    _renderTabs(root); _renderHeaderMeta(root); _renderOverview(root);
    toast.success(`Deleted ${done} file${done !== 1 ? "s" : ""}`);
  };

  // Inline name edit — only fires in edit mode. Swaps the cell text
  // for an input; on commit PATCHes display_name. The icon prefix is
  // re-added on re-render.
  window.ovCellEdit = (td) => {
    if (OV.mode !== "edit") return;
    if (td.querySelector("input")) return;
    const rid = td.dataset.rid;
    const f   = (STATE.files ?? []).find((x) => x.redpash_id === rid);
    if (!f) return;
    const oldVal = f.display_name ?? f.filename ?? "";
    const inp = document.createElement("input");
    inp.className = "rp-rt-cell-input";
    inp.value = oldVal;
    inp.autocomplete = "off";
    inp.spellcheck = false;
    td.innerHTML = "";
    td.appendChild(inp);
    inp.focus();
    inp.select();
    let done = false;
    const commit = async () => {
      if (done) return;
      done = true;
      const newVal = inp.value.trim();
      if (!newVal || newVal === oldVal) { _renderOverview(root); return; }
      try {
        const updated = await api.patch(`/files/${encodeURIComponent(rid)}`, { display_name: newVal });
        const idx = STATE.files.findIndex((x) => x.redpash_id === rid);
        if (idx >= 0) STATE.files[idx] = updated;
        _renderTabs(root);
        _renderOverview(root);
        toast.success(`Renamed to ${updated.display_name ?? updated.filename}`);
      } catch (err) {
        _renderOverview(root);
        toast.error(`Rename failed: ${err.body?.error ?? err.message}`);
      }
    };
    inp.addEventListener("blur", commit);
    inp.addEventListener("keydown", (e) => {
      if (e.key === "Enter")  { e.preventDefault(); inp.blur(); }
      if (e.key === "Escape") { done = true; _renderOverview(root); }
    });
  };

  // Score files — compute (or recompute) the cleanness score for every
  // file in the project. New uploads get a score automatically; this
  // backfills legacy files that predate scoring and refreshes any that
  // drifted. Sequential POSTs keep the error story simple; the file
  // count per project is small.
  // Overview row click → switch the active file tab in-place. Disabled
  // in select/delete/edit modes (those own the click affordance) and
  // when the click bubbled from an interactive child (checkbox, button,
  // input). The leading select / trailing delete <td>s also
  // stop-propagation in the markup as a belt-and-braces guard.
  window._ovRowClick = (e, rid) => {
    if (!rid) return;
    if (OV.mode === "select" || OV.mode === "delete" || OV.mode === "edit") return;
    if (e.target.closest("input, button, a, select, .rp-rt-row-del")) return;
    window.cleanerActivateTab(rid);
  };

  window.ovScoreFiles = async () => {
    const files = STATE.files ?? [];
    if (!files.length) { toast.info("No files to score."); return; }
    const btn = root.querySelector("#ov-score-btn");
    if (btn) { btn.disabled = true; btn.classList.add("is-spinning"); }
    let done = 0;
    for (const f of files) {
      try {
        const summary = await api.post(`/files/${encodeURIComponent(f.redpash_id)}/cleanness`, {});
        const idx = STATE.files.findIndex((x) => x.redpash_id === f.redpash_id);
        if (idx >= 0) STATE.files[idx] = summary;
        done++;
      } catch (err) {
        if (btn) { btn.disabled = false; btn.classList.remove("is-spinning"); }
        _renderTabs(root); _renderOverview(root);
        toast.error(`Stopped after ${done} — ${err.body?.error ?? err.message}`);
        return;
      }
    }
    _renderTabs(root);       // tab dots read cleanness_pct
    _renderOverview(root);
    toast.success(`Scored ${done} file${done !== 1 ? "s" : ""}`);
  };

  // Column-visibility picker. Toggling a checkbox flips the key in
  // OV.hiddenCols, persists to localStorage, and re-renders. The picker
  // dropdown open/close is a pure class flip.
  window.ovToggleColumn = (key, checked) => {
    if (checked) OV.hiddenCols.delete(key);
    else         OV.hiddenCols.add(key);
    _ovSaveHiddenCols();
    _renderOverview(root);
    // Re-open the dropdown — _renderOverview rebuilt it closed, but the
    // user is mid-adjustment and likely wants to toggle more.
    const dd = root.querySelector(".ov-colpick-dd");
    if (dd) dd.hidden = false;
  };
  window.ovToggleColPicker = (btn) => {
    const dd = btn.parentElement?.querySelector(".ov-colpick-dd");
    if (dd) dd.hidden = !dd.hidden;
  };
  // Close the column picker on any click outside it. Guarded by a
  // window flag so re-mounting the cleaner doesn't stack listeners.
  if (!window._ovColPickWired) {
    window._ovColPickWired = true;
    document.addEventListener("click", (e) => {
      if (e.target.closest(".ov-colpick")) return;
      document.querySelectorAll(".ov-colpick-dd:not([hidden])")
        .forEach((dd) => { dd.hidden = true; });
    });
  }

  // Refresh — re-fetch the project's file list from the server.
  window.ovRefresh = async () => {
    const pid = STATE.project?.redpash_id;
    if (!pid) return;
    try {
      const res = await api.get(`/projects/${encodeURIComponent(pid)}/files`);
      STATE.files = res.items ?? [];
      _renderTabs(root);
      _renderHeaderMeta(root);
      _renderOverview(root);
    } catch (err) {
      toast.error(`Refresh failed: ${err.body?.error ?? err.message}`);
    }
  };
  // ─── Tool open / apply ─────────────────────────────────────────
  // Single open / apply pair covers every modal. Per-tool population
  // (column selects, checklists, sub-line text, special previews) sits
  // in _populateToolModal; per-tool Apply param-reading sits in the
  // big switch inside cleanerApplyTool. Both keyed off the same tool
  // id used in the partial markup (tool-rename, tool-snake, …).
  // Tool modals open ANCHORED to the button the user clicked rather than
  // centered. Mirrors the Django pattern: the table stays visible (overlay
  // is transparent — see styles/pages/cleaner.css `#page-cleaner .modal-overlay`)
  // and the modal floats next to its trigger so the user keeps spatial
  // context. The button reference comes through the inline onclick as
  // `cleanerOpenTool('tool-…', this)`.
  window.cleanerOpenTool = (toolId, btn) => {
    if (!STATE.summary) { toast.error("Open a file first."); return; }
    _populateToolModal(toolId);
    window.openModal(toolId);
    _positionToolModal(toolId, btn);
  };

  // tool-invalid — scope dropdown (all-columns vs single-column) shows
  // / hides the column picker. Mode dropdown (null vs custom) shows /
  // hides the custom-value input. Both live on the modal as `hidden`
  // siblings to keep the layout stable without animating.
  window.cleanerToolInvalidScope = (sel) => {
    const modal = sel.closest(".modal-overlay");
    const field = modal?.querySelector("[data-tool-invalid-col-field]");
    if (field) field.hidden = sel.value !== "one";
  };
  window.cleanerToolInvalidMode = (sel) => {
    const modal = sel.closest(".modal-overlay");
    const field = modal?.querySelector("[data-tool-invalid-value-field]");
    if (field) field.hidden = sel.value !== "custom";
  };
  // "All" / "None" header buttons on the sentinel checklist.
  window.cleanerToolInvalidSelectAll = (on) => {
    const modal = document.getElementById("modal-tool-invalid");
    modal?.querySelectorAll("[data-tool-sentinel]").forEach((c) => { c.checked = !!on; });
  };

  // Add a user-typed sentinel to the modal's ad-hoc set + re-scan so
  // the new value (if it's actually in the file) appears in the
  // checklist with its real count and column hits. On Apply, any
  // ad-hoc value that's still ticked is persisted to
  // prefs.learned_sentinels so future scans pick it up automatically.
  window.cleanerToolInvalidAddExtra = async (inputEl) => {
    if (!inputEl) return;
    const raw = String(inputEl.value || "");
    const canon = raw.trim().toLowerCase();
    if (!canon) return;
    const modal = inputEl.closest(".modal-overlay");
    if (!modal) return;
    inputEl.value = "";
    if (_toolInvalidAdhoc.has(canon) || STATE.learnedSentinels?.has(canon)) {
      // Already in the scan; no-op the re-scan but flash the existing
      // row so the user sees their value is being looked at.
      const existing = modal.querySelector(`[data-tool-sentinel="${CSS.escape(raw.trim())}"]`);
      if (existing) {
        existing.checked = true;
        const lbl = existing.closest("label");
        if (lbl) { lbl.style.transition = "background .2s"; lbl.style.background = "color-mix(in srgb,var(--accent) 12%,transparent)"; setTimeout(() => { lbl.style.background = ""; }, 600); }
      }
      return;
    }
    _toolInvalidAdhoc.add(canon);
    await _refreshSentinelList(modal, { preserve: true });
    // If the re-scan didn't surface the value, the canonical key
    // wasn't in the file — drop it from the ad-hoc set so the next
    // scan doesn't keep paying for it, and tell the user.
    const surfaced = modal.querySelector(`[data-tool-sentinel]`)
      && [...modal.querySelectorAll("[data-tool-sentinel]")]
            .some((c) => c.dataset.toolSentinel.trim().toLowerCase() === canon);
    if (!surfaced) {
      _toolInvalidAdhoc.delete(canon);
      toast.info(`No cells matched "${raw.trim()}" in this file.`);
    }
  };

  // Direct cast from the Data Types panel — no modal, just `cast` with
  // the suggested dtype. Posted to /steps; the response refresh mirrors
  // cleanerApplyTool's path. A cast on a dirty column may null some
  // cells (Polars' cast is non-strict on string sources, except date
  // which goes through parse_date_flex) — that surfaces the dirt to
  // the user, who can then apply remove_text / replace_text first.
  // POST the cast step + refresh chrome. Used by both the no-prompt
  // path (zero-null cast) and the modal's "Apply cast" button.
  const _applyCastStep = async (column, dtype) => {
    try {
      const res = await api.post(
        `/files/${encodeURIComponent(STATE.rid)}/steps`,
        { kind: "cast", params: { column, dtype } },
      );
      STATE.summary = res.summary;
      STATE.columns = res.columns ?? [];
      STATE.steps   = res.steps   ?? [];
      const idx = STATE.files.findIndex((f) => f.redpash_id === STATE.rid);
      if (idx >= 0) STATE.files[idx] = res.summary;
      _renderTitle(root);
      _renderHeaderMeta(root);
      _renderOverallCleanness(root);
      _renderHistoryButtons(root);
      _renderAppliedList(root);
      _renderDtypeList(root);
      _renderTabs(root);
      await _loadPage(root);
      toast.success(`cast · ${column} → ${dtype}`);
    } catch (err) {
      toast.error(`Cast failed: ${err.body?.error ?? err.message}`);
    }
  };

  window.cleanerCastColumn = async (column, dtype) => {
    if (!STATE.summary || !column || !dtype) return;
    // Dry-run first — count rows that would silently become null (e.g.
    // casting a date column with one `"2023"` cell). When the count is
    // zero, apply silently. When non-zero, open the cast-confirm
    // modal — populated with the column + dtype + sample bad values
    // — so the user has to confirm before data goes away.
    let preview;
    try {
      preview = await api.post(
        `/files/${encodeURIComponent(STATE.rid)}/cast-preview`,
        { column, dtype },
      );
    } catch (err) {
      toast.error(`Couldn't preview cast: ${err.body?.error ?? err.message}`);
      return;
    }
    if (!preview || (preview.would_null ?? 0) === 0) {
      await _applyCastStep(column, dtype);
      return;
    }
    // Populate + open the cast-confirm modal.
    const titleEl   = root.querySelector("#cast-confirm-title");
    const subEl     = root.querySelector("#cast-confirm-sub");
    const samplesEl = root.querySelector("#cast-confirm-samples");
    const applyBtn  = root.querySelector("#cast-confirm-apply");
    if (titleEl)   titleEl.textContent = `Confirm cast — ${preview.would_null} value${preview.would_null !== 1 ? "s" : ""} will become null`;
    if (subEl)     subEl.textContent   = `Casting "${column}" to ${dtype} sets ${preview.would_null} of ${preview.total} cell${preview.total !== 1 ? "s" : ""} to null.`;
    if (samplesEl) {
      const lines = (preview.samples ?? []).map((s) => `  • ${s}`).join("\n");
      const more  = preview.would_null > (preview.samples?.length ?? 0)
        ? `\n  …and ${preview.would_null - preview.samples.length} more` : "";
      samplesEl.textContent = `${lines}${more}` || "(no samples)";
    }
    if (applyBtn) {
      // Replace the onclick each time so a stale (column, dtype) pair
      // from a previous open can't fire when the user clicks Apply.
      applyBtn.onclick = async () => {
        window.closeModal("cast-confirm");
        await _applyCastStep(column, dtype);
      };
    }
    window.openModal("cast-confirm");
  };

  // Dismiss a cast suggestion — user is saying "this column is text on
  // purpose, stop pestering me". Per-file localStorage; the dismiss
  // survives reloads but doesn't bleed to other files (CODE_POSTAL in
  // file A doesn't dismiss CODE_POSTAL in file B).
  window.cleanerSkipCast = (column) => {
    if (!STATE.rid || !column) return;
    const set = _dtypeSkipLoad(STATE.rid);
    set.add(column);
    _dtypeSkipSave(STATE.rid, set);
    _renderDtypeList(root);
  };
  // Inverse — put a dismissed column back in the suggestion stream.
  window.cleanerRevertSkipCast = (column) => {
    if (!STATE.rid || !column) return;
    const set = _dtypeSkipLoad(STATE.rid);
    set.delete(column);
    _dtypeSkipSave(STATE.rid, set);
    _renderDtypeList(root);
  };

  window.cleanerApplyTool = async (toolId) => {
    if (!STATE.summary) return;

    // First-time consent gate for the fix-invalid tool. If the user is
    // about to push a custom (non-built-in, non-already-learned)
    // sentinel AND we've never asked whether they want to share their
    // additions, open the consent modal and wait for their choice
    // before letting the apply continue. The choice is sticky
    // (prefs.share_sentinels) — we never ask again.
    if (toolId === "tool-invalid" && STATE.shareSentinels == null) {
      const modal  = document.getElementById("modal-tool-invalid");
      const picked = [...(modal?.querySelectorAll("[data-tool-sentinel]:checked") ?? [])]
        .map((c) => c.dataset.toolSentinel);
      const newToUser = picked.find((s) => {
        const canon = String(s).trim().toLowerCase();
        return canon
          && !SENTINELS_BUILTIN.has(canon)
          && !STATE.learnedSentinels.has(canon);
      });
      if (newToUser) {
        const choice = await _askSentinelConsent(newToUser);
        if (choice === "cancel") return;   // user backed out — do nothing
        STATE.shareSentinels = (choice === "accept");
        // Persist the consent choice immediately so a refresh keeps it.
        // PATCH lands BEFORE the step apply, so the server-side
        // submission recorder in patch_me will see the right flag when
        // the learned_sentinels PATCH lands a moment later (inside
        // _readToolPayload below).
        try {
          await api.patch("/me", { prefs: { share_sentinels: STATE.shareSentinels } });
        } catch (err) {
          toast.error(`Couldn't save sharing choice: ${err.body?.error ?? err.message}`);
          // Roll back so the next pick re-prompts rather than silently
          // applying a half-saved decision.
          STATE.shareSentinels = null;
          return;
        }
      }
    }

    const payload = _readToolPayload(toolId);
    if (!payload) return;   // validator already toasted

    // Close the modal optimistically. If the apply fails we'll surface
    // the error in a toast; the user keeps the form values via the DOM
    // since we haven't reset them.
    window.closeModal(toolId);

    try {
      const res = await api.post(
        `/files/${encodeURIComponent(STATE.rid)}/steps`,
        payload,
      );
      // Backend returns the new summary + columns + steps after replay.
      STATE.summary = res.summary;
      STATE.columns = res.columns ?? [];
      STATE.steps   = res.steps   ?? [];
      // Keep the tab strip's view of the active file in sync — the dot
      // color reads off cleanness_pct, and a step often nudges that.
      const idx = STATE.files.findIndex((f) => f.redpash_id === STATE.rid);
      if (idx >= 0) STATE.files[idx] = res.summary;
      _renderTitle(root);
      _renderHeaderMeta(root);
      _renderOverallCleanness(root);
      _renderHistoryButtons(root);
      _renderAppliedList(root);
      _renderDtypeList(root);
      _renderTabs(root);
      await _loadPage(root);

      const op = res.last_op ?? {};
      const delta = op.rows_after != null && op.rows_before != null
        ? (op.rows_after - op.rows_before) : null;
      const note = delta != null && delta !== 0
        ? `${delta > 0 ? "+" : ""}${delta.toLocaleString()} rows`
        : (op.cells_changed != null ? `${op.cells_changed.toLocaleString()} cells` : "applied");
      toast.success(`${payload.kind} · ${note}`);
    } catch (err) {
      toast.error(`Apply failed: ${err.body?.error ?? err.message}`);
    }
  };

  // Dedup mode change — re-render the duplicate count + samples for the
  // newly chosen strategy. Phase 2.1 fully populates this; for now it
  // just refreshes the dedup detection against the new key.
  window.cleanerDedupModeChanged = () => _refreshDedupPreview(root);

  // Unwrap-CSV — the banner appears when _detectWrappedCsv() flags
  // the active file. Opening the modal paints a Before/After preview
  // (raw single-column text + the parsed re-split columns) so the
  // user can sanity-check before clicking Apply. The Apply POSTs a
  // single `unwrap_csv` step; Rust handles the re-parse.
  window.openUnwrapCsvModal = () => {
    if (!STATE.summary) return;
    const m = document.getElementById("modal-unwrap-csv");
    if (!m) return;
    // Subtitle — filename · row count.
    const sub = m.querySelector("#unwrap-csv-sub");
    if (sub) sub.textContent = `${STATE.summary.display_name ?? STATE.summary.filename ?? "—"} · ${(STATE.summary.row_count ?? 0).toLocaleString()} rows`;

    // Before: dump the raw single-column preview lines. We use the
    // already-loaded page data so this is a same-frame operation
    // (no extra fetch).
    const before = m.querySelector("#unwrap-csv-before");
    const rows   = STATE.pageData?.rows ?? [];
    if (before) {
      const header = STATE.columns[0]?.name ?? "";
      const lines  = [header, ...rows.slice(0, 8).map((r) => r[0] ?? "")];
      before.textContent = lines.join("\n");
    }

    // After: re-split each preview row on common separators (`,` then
    // `;` then `\t`) and render as a small table. The Rust side will
    // do the real parse — this is just a hint so the user can see the
    // shape they'll get.
    const afterTbl = m.querySelector("#unwrap-csv-after-table");
    if (afterTbl) {
      const sample = rows.slice(0, 5).map((r) => r[0] ?? "");
      const sep    = _guessSeparator(sample);
      const parsed = sample.map((line) => _splitCsvLine(line, sep));
      const ncols  = Math.max(0, ...parsed.map((p) => p.length));
      const hdrLine = STATE.columns[0]?.name ?? "";
      const hdrCells = _splitCsvLine(hdrLine, sep).slice(0, ncols);
      afterTbl.innerHTML = `
        <thead><tr>${
          Array.from({ length: ncols }, (_, i) =>
            `<th style="padding:0.25rem 0.4rem;text-align:left;color:var(--muted);font-weight:600">${_escHtml(hdrCells[i] ?? `col_${i+1}`)}</th>`
          ).join("")
        }</tr></thead>
        <tbody>${parsed.map((p) =>
          `<tr>${Array.from({ length: ncols }, (_, i) =>
            `<td style="padding:0.2rem 0.4rem">${_escHtml(p[i] ?? "")}</td>`
          ).join("")}</tr>`
        ).join("")}</tbody>`;
    }
    window.openModal("unwrap-csv");
  };

  window.applyUnwrapCsv = async () => {
    if (!STATE.rid) return;
    window.closeModal("unwrap-csv");
    try {
      const res = await api.post(
        `/files/${encodeURIComponent(STATE.rid)}/steps`,
        { kind: "unwrap_csv", params: {} },
      );
      STATE.summary = res.summary;
      STATE.columns = res.columns ?? [];
      STATE.steps   = res.steps   ?? [];
      const idx = STATE.files.findIndex((f) => f.redpash_id === STATE.rid);
      if (idx >= 0) STATE.files[idx] = res.summary;
      _renderTitle(root);
      _renderHeaderMeta(root);
      _renderOverallCleanness(root);
      _renderHistoryButtons(root);
      _renderAppliedList(root);
      _renderDtypeList(root);
      _renderTabs(root);
      await _loadPage(root);
      toast.success(`Unwrapped — ${STATE.columns.length} columns detected`);
    } catch (err) {
      toast.error(`Unwrap failed: ${err.body?.error ?? err.message}`);
    }
  };

  // Encoding override — POST /:rid/encoding re-parses the stored bytes
  // through TextDecoder(value) and refreshes the file.
  //
  // The backend requires a specific codec label (encoding_rs::for_label);
  // the dropdown's "Auto-detect" option is a no-op for that endpoint
  // because detection only runs on upload. If the user lands on the
  // wrong codec and sees mojibake (Chinese-looking glyphs in the
  // table — that's how UTF-16 / Latin-1 bytes look when decoded the
  // wrong way) they pick the originally-detected codec from the
  // dropdown again to restore the right rendering.
  window.setCleanerEncoding = async (val) => {
    if (!STATE.rid) return;
    if (!val) {
      // Empty value would 400 server-side; explain instead.
      toast.info("Pick a specific codec — auto-detect runs only on upload.");
      _renderEncodingPicker(root);  // bounce the select back to the active value
      return;
    }
    try {
      const env = await api.post(
        `/files/${encodeURIComponent(STATE.rid)}/encoding`,
        { encoding: val },
      );
      STATE.summary = env.summary;
      STATE.columns = env.columns ?? [];
      STATE.steps   = env.steps   ?? [];
      _renderTitle(root);
      _renderHeaderMeta(root);
      _renderEncodingPicker(root);
      await _loadPage(root);
      toast.success(`Encoding → ${val}. If accents look wrong, pick another codec.`);
    } catch (err) {
      toast.error(`Encoding failed: ${err.body?.error ?? err.message}`);
    }
  };

  // ── Filter panel ─────────────────────────────────────────────────
  // Funnel toggle → slide the side panel in/out + flip the button
  // active state. Predicates collected from the panel POST as a
  // single `filter_rows` step.
  window.rtToggleFilter = () => {
    const panel = root.querySelector("#cleaner-filter-panel");
    const btn   = root.querySelector(".rp-rt-toolbar .rp-rt-icon-btn"); // first one is the funnel
    if (!panel) return;
    STATE.filterOpen = !panel.classList.contains("open");
    panel.classList.toggle("open", STATE.filterOpen);
    if (btn) btn.classList.toggle("is-active", STATE.filterOpen);
    if (STATE.filterOpen) _ensureFilterRow(root);
  };

  // Add an empty predicate row. Building a row is delegated to
  // _appendFilterRow so the inline "+" button and the lazy "create
  // first row on panel open" code path share the same shape.
  window.cleanerAddFilterRow = () => {
    _appendFilterRow(root);
    _refreshFilterApplyState(root);
  };
  // Eraser: wipes the panel draft AND surgically un-applies every
  // filter_rows step on the active file via POST /:rid/clear-filters.
  // Single round-trip; the backend flips applied=false for every
  // matching step regardless of position, so a filter buried under
  // later operations (filter_columns, renames, …) still clears. The
  // returned FileEnvelope replaces STATE.steps so the cache-invalidate
  // tied to applied-count picks up the change on the next _loadPage.
  window.cleanerClearFilterDraft = async (btn) => {
    _rpAnimOnce(btn ?? root.querySelector(".rp-rt-icon-btn[onclick*='cleanerClearFilterDraft']"),
                "rp-rt-anim-wipe");
    const box = root.querySelector("#cleaner-filter-rows");
    if (box) box.innerHTML = "";
    _ensureFilterRow(root);
    _refreshFilterApplyState(root);

    if (!STATE.rid) return;
    const beforeApplied = (STATE.steps ?? []).filter((s) => s.applied === true && s.kind === "filter_rows").length;
    if (beforeApplied === 0) return;   // nothing to clear; draft wipe was the whole job
    try {
      const env = await api.post(`/files/${encodeURIComponent(STATE.rid)}/clear-filters`, {});
      STATE.summary = env.summary ?? STATE.summary;
      STATE.columns = env.columns ?? STATE.columns;
      STATE.steps   = env.steps   ?? STATE.steps;
      await _loadPage(root);
      _renderHistoryButtons(root);
      _renderAppliedList(root);
      _renderDtypeList(root);
      window.cleanerBuildColsDropdown?.();
      toast.success(`Cleared ${beforeApplied} filter${beforeApplied === 1 ? "" : "s"}.`);
    } catch (err) {
      toast.error(`Clear failed: ${err.body?.error ?? err.message}`);
    }
  };

  // Save filter (floppy) — captures the current panel draft, prompts
  // for a name, and persists into STATE.savedFilters[rid] +
  // prefs.cleaner_saved_filters. Same payload shape Apply uses so
  // loading a saved filter can just splat it back into the panel.
  window.cleanerSaveFilter = async (btn) => {
    _rpAnimOnce(btn ?? root.querySelector(".rp-rt-icon-btn[onclick*='cleanerSaveFilter']"),
                "rp-rt-anim-glow");
    if (!STATE.rid) { toast.info("Open a file first."); return; }
    const draft = _cleanerCollectDraft(root);
    if (!draft.predicates.length) { toast.info("Add at least one predicate to save."); return; }
    const name = (prompt("Name this filter:", `Filter ${(STATE.savedFilters?.[STATE.rid]?.length ?? 0) + 1}`) ?? "").trim();
    if (!name) return;
    STATE.savedFilters[STATE.rid] = STATE.savedFilters[STATE.rid] || [];
    // Replace any existing entry with the same name (idempotent rename = update).
    const list = STATE.savedFilters[STATE.rid];
    const dupIdx = list.findIndex((f) => f.name === name);
    const entry  = { name, combinator: draft.combinator, predicates: draft.predicates };
    if (dupIdx >= 0) list[dupIdx] = entry;
    else             list.push(entry);
    window.rpSavePref?.("cleaner_saved_filters", STATE.savedFilters);
    toast.success(`Saved filter "${name}".`);
  };

  // Load a saved filter into the panel draft + open the panel so the
  // user can review / tweak / Apply. Called from the Saved-settings
  // modal chip click — closes the modal so the user lands on the panel.
  window.cleanerLoadSavedFilter = (rid, idx) => {
    const list = STATE.savedFilters?.[rid];
    const entry = list?.[idx];
    if (!entry) return;
    // If the filter belongs to a different file, switch to that file
    // first — predicates are column-scoped, so loading "Filter X" from
    // file A into file B would reference columns that don't exist.
    const apply = () => {
      _cleanerLoadDraft(root, entry);
      // Open the filter panel so the user sees the loaded predicates.
      const panel = root.querySelector("#cleaner-filter-panel");
      if (panel && !panel.classList.contains("open")) {
        window.rtToggleFilter?.();
      }
      window.closeModal("cleaner-saved");
    };
    if (rid !== STATE.rid) {
      window.cleanerActivateTab(rid).then(apply).catch(() => apply());
    } else {
      apply();
    }
  };
  window.cleanerDeleteSavedFilter = (rid, idx) => {
    const list = STATE.savedFilters?.[rid];
    if (!list || !list[idx]) return;
    const removed = list.splice(idx, 1)[0];
    if (!list.length) delete STATE.savedFilters[rid];
    window.rpSavePref?.("cleaner_saved_filters", STATE.savedFilters);
    // Re-render the modal so the chip disappears immediately.
    if (typeof window.cleanerShowSaved === "function") window.cleanerShowSaved();
    toast.success(`Deleted "${removed.name}".`);
  };

  // Joins: POST /api/files/:rid/joins with the picked column pair.
  // Backend creates a new project_files row (default name
  // {this}__{other}_join.csv) and returns its FileEnvelope. We refetch
  // the project's file list so the new tab appears in the strip, then
  // switch to it. Default join type is inner — matches the backend
  // default; future iterations may surface a join-type picker inline
  // on the candidate row.
  window.cleanerCreateJoin = async (otherRid, thisCol, otherCol, btn) => {
    if (!STATE.rid) return;
    if (btn) { btn.disabled = true; btn.classList.add("is-busy"); }
    let env;
    try {
      env = await api.post(`/files/${encodeURIComponent(STATE.rid)}/joins`, {
        other_file: otherRid,
        this_cols:  [thisCol],
        other_cols: [otherCol],
        join_type:  "inner",
      });
    } catch (err) {
      toast.error(`Join failed: ${err.body?.error ?? err.message}`);
      if (btn) { btn.disabled = false; btn.classList.remove("is-busy"); }
      return;
    }
    const newRid = env?.summary?.redpash_id;
    // Refresh the project file list so the new tab shows up in the
    // strip, then activate it. _afterHistory does similar plumbing
    // for step apply/undo; here we want a fuller refresh because the
    // file count changed.
    const pid = STATE.project?.redpash_id ?? STATE.summary?.project_redpash_id;
    if (pid) {
      const files = await api.get(`/projects/${encodeURIComponent(pid)}/files`).catch(() => null);
      if (files?.items) STATE.files = files.items;
    }
    _renderTabs(root);
    _renderHeaderMeta(root);
    if (newRid) {
      await window.cleanerActivateTab(newRid);
      toast.success(`Joined — ${env?.summary?.display_name ?? newRid}`);
    } else {
      toast.success("Join created.");
    }
  };

  // AND/OR pill — flips .is-active on the clicked button; the value is
  // read at apply time. Matches objSetCombo so the two filter panels
  // share the same vocabulary.
  window.cleanerSetCombo = (btn) => {
    btn.parentElement?.querySelectorAll("button")
       .forEach((b) => b.classList.remove("is-active"));
    btn.classList.add("is-active");
  };

  // Apply — read all predicate rows into the {kind, params} payload,
  // POST, then refresh the whole page like every other step. The Rust
  // side validates op vocabulary and shape; bad payloads come back as
  // a 400 with the error text in the body.
  window.cleanerApplyFilter = async (btn) => {
    _rpAnimOnce(btn ?? root.querySelector("#cleaner-filter-apply"), "rp-rt-anim-pulse");
    if (!STATE.rid) return;
    const box  = root.querySelector("#cleaner-filter-rows");
    const rows = box ? [...box.querySelectorAll(".rp-rt-fb-row")] : [];
    const comboBtn   = root.querySelector("#cleaner-fb-combo button.is-active");
    const combinator = comboBtn ? comboBtn.dataset.combo : "and";
    const predicates = [];
    for (const r of rows) {
      const column = r.querySelector("[data-fb-col]")?.value;
      const op     = r.querySelector("[data-fb-op]")?.value;
      if (!column || !op) continue;
      const pred = { column, op };
      // is_null/not_null have no value; in/not_in expect an array; the
      // rest take a single string the Rust side parses to the right
      // type (numeric / date / string).
      if (op === "is_null" || op === "not_null") {
        predicates.push(pred);
        continue;
      }
      const raw = r.querySelector("[data-fb-val]")?.value ?? "";
      if (op === "in" || op === "not_in") {
        pred.value = raw.split(",").map((s) => s.trim()).filter(Boolean);
        if (!pred.value.length) continue;  // skip empty lists
      } else if (op === "between") {
        // Two comma-separated endpoints. Anything else gets dropped
        // on the floor so a half-filled row doesn't 400 the whole apply.
        const parts = raw.split(",").map((s) => s.trim()).filter(Boolean);
        if (parts.length !== 2) continue;
        pred.value = parts.map((s) => Number(s));
        if (pred.value.some(Number.isNaN)) continue;
      } else if (["gt", "gte", "lt", "lte"].includes(op)) {
        const n = Number(raw);
        if (Number.isNaN(n) || raw === "") continue;
        pred.value = n;
      } else {
        if (raw === "") continue;
        pred.value = raw;
      }
      predicates.push(pred);
    }
    if (!predicates.length) {
      toast.error("Add at least one complete predicate.");
      return;
    }
    try {
      const res = await api.post(
        `/files/${encodeURIComponent(STATE.rid)}/steps`,
        { kind: "filter_rows", params: { combinator, predicates } },
      );
      STATE.summary = res.summary;
      STATE.columns = res.columns ?? [];
      STATE.steps   = res.steps   ?? [];
      const idx = STATE.files.findIndex((f) => f.redpash_id === STATE.rid);
      if (idx >= 0) STATE.files[idx] = res.summary;
      _renderHeaderMeta(root);
      _renderOverallCleanness(root);
      _renderHistoryButtons(root);
      _renderAppliedList(root);
      _renderDtypeList(root);
      _renderTabs(root);
      await _loadPage(root);
      const op = res.last_op ?? {};
      const delta = op.rows_after != null && op.rows_before != null
        ? (op.rows_after - op.rows_before) : null;
      toast.success(`Filter applied · ${delta != null ? `${delta.toLocaleString()} rows` : "ok"}`);
    } catch (err) {
      toast.error(`Filter failed: ${err.body?.error ?? err.message}`);
    }
  };

  // Toolbar search — debounced so we don't fire a /page request on
  // every keystroke. The backend's PageQuery accepts `q` and runs the
  // same case-insensitive substring match the rest of the redtables
  // use, so this works without any new endpoint plumbing.
  let _searchTimer = null;
  window.rtSearch = (input) => {
    clearTimeout(_searchTimer);
    _searchTimer = setTimeout(async () => {
      STATE.q    = (input.value ?? "").trim();
      STATE.page = 1;
      await _loadPage(root);
    }, 200);
  };
  // Three mutually-exclusive inline modes (edit / select / delete). Each
  // flips a `rp-rt-mode-<mode>` class on the cleaner panel that the CSS
  // reads to surface/hide the leading + trailing columns and the
  // dblclick / hover affordances. Mirrors the demo's `toggleS2Mode`
  // pattern, scoped to the cleaner panel rather than the home redtable.
  window.rtToggleMode = (btn, _kind, mode) => {
    const tbar = btn.closest(".rp-rt-toolbar");
    const wasActive = btn.classList.contains("is-active");
    const nowActive = !wasActive;
    // Only one mode active at a time — clear sibling mode buttons.
    tbar?.querySelectorAll(".rp-rt-icon-btn[data-rt-mode]").forEach((b) => {
      b.classList.remove("is-active");
      b.setAttribute("aria-pressed", "false");
    });
    if (nowActive) {
      btn.classList.add("is-active");
      btn.setAttribute("aria-pressed", "true");
    }
    const panel = root.querySelector(".rp-rt-panel--cleaner");
    if (!panel) return;
    panel.classList.remove("rp-rt-mode-edit", "rp-rt-mode-select", "rp-rt-mode-delete");
    if (nowActive) panel.classList.add(`rp-rt-mode-${mode}`);
    // Switching away from select-mode clears the tick state so the next
    // re-entry starts clean (and stale ticks don't leak into bulk-delete).
    if (mode !== "select" || !nowActive) {
      STATE.selected.clear();
      _renderSelectionChip(root);
    }
  };

  // ── Per-row select / delete + bulk delete ─────────────────────────
  // Page-relative indices flow through the handlers; we map to the
  // absolute row index (the one the backend stores) only at /steps
  // POST time, via (page-1)*pageSize + ri.
  const _absoluteIndex = (ri) => (STATE.page - 1) * STATE.pageSize + Number(ri);

  window.cleanerRowSelect = (chk) => {
    const ri = Number(chk.dataset.ri);
    if (chk.checked) STATE.selected.add(ri);
    else             STATE.selected.delete(ri);
    chk.closest("tr")?.classList.toggle("rp-rt-row-sel", chk.checked);
    _renderSelectionChip(root);
  };

  window.cleanerSelectAll = (on) => {
    STATE.selected.clear();
    root.querySelectorAll("tbody .rp-rt-row-chk").forEach((cb) => {
      cb.checked = on;
      const tr = cb.closest("tr");
      tr?.classList.toggle("rp-rt-row-sel", on);
      if (on) STATE.selected.add(Number(cb.dataset.ri));
    });
    _renderSelectionChip(root);
  };

  window.cleanerClearSelection = () => {
    window.cleanerSelectAll(false);
    const head = root.querySelector("#cleaner-sel-all");
    if (head) head.checked = false;
  };

  // Single-row delete. Confirms via a toast-shaped prompt (browser
  // confirm is acceptable here — the action is destructive and the page
  // doesn't have a richer modal helper yet). Issues drop_rows with one
  // absolute index; the step is undoable like any other.
  window.cleanerRowDelete = async (ri) => {
    if (!STATE.rid) return;
    if (!confirm("Drop this row?")) return;
    await _applyDropRows([_absoluteIndex(ri)], "row dropped");
  };

  window.cleanerBulkDelete = async () => {
    if (!STATE.rid || !STATE.selected.size) return;
    const n = STATE.selected.size;
    if (!confirm(`Drop ${n} selected row${n !== 1 ? "s" : ""}?`)) return;
    const indices = [...STATE.selected].map(_absoluteIndex);
    await _applyDropRows(indices, `${n} row${n !== 1 ? "s" : ""} dropped`);
  };

  async function _applyDropRows(indices, label) {
    try {
      const res = await api.post(
        `/files/${encodeURIComponent(STATE.rid)}/steps`,
        { kind: "drop_rows", params: { indices } },
      );
      STATE.summary = res.summary;
      STATE.columns = res.columns ?? [];
      STATE.steps   = res.steps   ?? [];
      const idx = STATE.files.findIndex((f) => f.redpash_id === STATE.rid);
      if (idx >= 0) STATE.files[idx] = res.summary;
      _renderHeaderMeta(root);
      _renderOverallCleanness(root);
      _renderHistoryButtons(root);
      _renderAppliedList(root);
      _renderDtypeList(root);
      _renderTabs(root);
      await _loadPage(root);
      toast.success(label);
    } catch (err) {
      toast.error(`Drop failed: ${err.body?.error ?? err.message}`);
    }
  }

  // ── Column drag-to-reorder ────────────────────────────────────────
  // HTML5 drag-and-drop on the data TH elements. We stash the source
  // column name on the dataTransfer, paint a drop cue on hover, and
  // when the user releases over another TH we POST `filter_columns`
  // with the new full order. The Rust side's `filter_columns` arm
  // re-orders via Polars `select(refs)` which preserves the list
  // order — so reorder is just the existing kind with the existing
  // columns set, in a different order.
  let _dragCol = null;
  window.cleanerColDragStart = (e) => {
    const th = e.currentTarget;
    _dragCol = th?.dataset?.col || null;
    if (_dragCol) {
      e.dataTransfer.effectAllowed = "move";
      // Firefox refuses to fire dragover unless we set some data.
      try { e.dataTransfer.setData("text/plain", _dragCol); } catch {}
      th.classList.add("rp-rt-th-drag");
    }
  };
  window.cleanerColDragOver = (e) => {
    if (!_dragCol) return;
    e.preventDefault();   // required to enable drop
    e.dataTransfer.dropEffect = "move";
    const th = e.currentTarget;
    if (th && th.dataset.col !== _dragCol) th.classList.add("rp-rt-th-drop");
  };
  window.cleanerColDragLeave = (e) => {
    e.currentTarget?.classList.remove("rp-rt-th-drop");
  };
  window.cleanerColDragEnd = () => {
    root.querySelectorAll("thead th.rp-rt-th-drag, thead th.rp-rt-th-drop")
      .forEach((t) => t.classList.remove("rp-rt-th-drag", "rp-rt-th-drop"));
    _dragCol = null;
  };
  window.cleanerColDrop = async (e) => {
    e.preventDefault();
    const targetTh = e.currentTarget;
    const target   = targetTh?.dataset?.col;
    const source   = _dragCol;
    window.cleanerColDragEnd();
    if (!source || !target || source === target) return;
    // Build the new column order: take the existing order, pull
    // `source` out, then insert it BEFORE `target`. "Drop on a column"
    // means "insert here" — matches Mac Finder / Excel column drag.
    const names = STATE.columns.map((c) => c.name);
    const from  = names.indexOf(source);
    const to    = names.indexOf(target);
    if (from < 0 || to < 0) return;
    names.splice(from, 1);
    const insertAt = names.indexOf(target);
    names.splice(insertAt, 0, source);
    try {
      const res = await api.post(
        `/files/${encodeURIComponent(STATE.rid)}/steps`,
        { kind: "filter_columns", params: { cols: names } },
      );
      STATE.summary = res.summary;
      STATE.columns = res.columns ?? [];
      STATE.steps   = res.steps   ?? [];
      const idx = STATE.files.findIndex((f) => f.redpash_id === STATE.rid);
      if (idx >= 0) STATE.files[idx] = res.summary;
      _renderHeaderMeta(root);
      _renderOverallCleanness(root);
      _renderHistoryButtons(root);
      _renderAppliedList(root);
      _renderDtypeList(root);
      _renderTabs(root);
      await _loadPage(root);
      toast.success(`Moved ${source} before ${target}`);
    } catch (err) {
      toast.error(`Reorder failed: ${err.body?.error ?? err.message}`);
    }
  };

  // Column-header click → mutate the sort chain.
  //   • plain click  → replace chain with [{col, asc}], or flip dir
  //                    when col is already the sole sort key.
  //   • shift-click  → append at asc; if col already in the chain,
  //                    flip its dir; alt+shift-click drops it.
  // The chain is serialised as a `sorts` JSON query param on the next
  // /page fetch (PageQuery prefers it over the legacy single-col
  // sort/dir pair). The header is also `draggable` for column
  // reorder — `dragend` fires instead of click after a real drag, so
  // the two don't collide.
  window.cleanerSortBy = (col, ev) => {
    if (!col) return;
    if (!Array.isArray(STATE.sorts)) STATE.sorts = [];
    const shift = !!(ev && ev.shiftKey);
    const alt   = !!(ev && ev.altKey);
    const idx   = STATE.sorts.findIndex((k) => k.col === col);
    if (shift) {
      if (idx >= 0) {
        if (alt) STATE.sorts.splice(idx, 1);
        else     STATE.sorts[idx].dir = STATE.sorts[idx].dir === "asc" ? "desc" : "asc";
      } else {
        STATE.sorts.push({ col, dir: "asc" });
      }
    } else {
      if (STATE.sorts.length === 1 && STATE.sorts[0].col === col) {
        STATE.sorts[0].dir = STATE.sorts[0].dir === "asc" ? "desc" : "asc";
      } else {
        STATE.sorts = [{ col, dir: "asc" }];
      }
    }
    STATE.page = 1;
    _loadPage(root);
  };

  // Cell inline-edit — dblclick swaps a TD for an input. On commit the
  // value is POSTed as a `replace_text` step scoped to that column,
  // where `find` is the original cell value and `replacement` is the
  // new value. Caveats:
  //   • The backend has no per-cell PATCH endpoint, so every other cell
  //     in that column with the SAME value will also flip. Acceptable
  //     for sentinel cleanup ("???" → "") but surprising for unique
  //     values. We surface this in the toast so the user knows.
  //   • For a single-occurrence edit, undo + retry is the recovery
  //     path — the step is undoable like any other.
  window.cleanerCellEdit = (td) => {
    const panel = root.querySelector(".rp-rt-panel--cleaner");
    if (!panel?.classList.contains("rp-rt-mode-edit")) return;
    if (td.querySelector("input")) return;
    const col    = td.dataset.col;
    const oldVal = td.textContent;
    const inp = document.createElement("input");
    inp.className = "rp-rt-cell-input";
    inp.value     = oldVal;
    inp.autocomplete = "off";
    inp.spellcheck   = false;
    td.innerHTML = "";
    td.appendChild(inp);
    inp.focus();
    inp.select();
    let done = false;
    const restore = () => { td.textContent = oldVal; };
    const commit = async () => {
      if (done) return;
      done = true;
      const newVal = inp.value;
      if (newVal === oldVal || !col) { restore(); return; }
      td.textContent = newVal;
      try {
        const res = await api.post(
          `/files/${encodeURIComponent(STATE.rid)}/steps`,
          { kind: "replace_text", params: { column: col, find: oldVal, replacement: newVal } },
        );
        STATE.summary = res.summary;
        STATE.columns = res.columns ?? [];
        STATE.steps   = res.steps   ?? [];
        const idx = STATE.files.findIndex((f) => f.redpash_id === STATE.rid);
        if (idx >= 0) STATE.files[idx] = res.summary;
        _renderHeaderMeta(root);
        _renderOverallCleanness(root);
        _renderHistoryButtons(root);
        _renderAppliedList(root);
      _renderDtypeList(root);
        _renderTabs(root);
        await _loadPage(root);
        const cells = res.last_op?.cells_changed ?? 0;
        toast.success(cells > 1
          ? `Replaced ${cells.toLocaleString()} cells in ${col}`
          : `Updated ${col}`);
      } catch (err) {
        restore();
        toast.error(`Edit failed: ${err.body?.error ?? err.message}`);
      }
    };
    inp.addEventListener("blur", commit);
    inp.addEventListener("keydown", (e) => {
      if (e.key === "Enter")  { e.preventDefault(); inp.blur(); }
      if (e.key === "Escape") { done = true; restore(); }
      if (e.key === "Tab")    { e.preventDefault(); inp.blur(); }
    });
  };
  window.rtRefresh = async (_kind, btn) => {
    btn?.classList.add("is-spinning");
    try { await _loadPage(root); }
    finally { btn?.classList.remove("is-spinning"); }
  };
  window.rtToggleDd = (btn) => {
    const dd = btn.nextElementSibling;
    if (!dd) return;
    document.querySelectorAll(".rp-rt-pill-dd.open").forEach((o) => o.classList.remove("open"));
    dd.classList.toggle("open");
  };
  window.rtSetRows = async (item, _kind, n) => {
    const dd = item.closest(".rp-rt-pill-dd");
    dd?.querySelectorAll(".rp-rt-dd-item").forEach((e) => e.classList.remove("rp-rt-dd-selected"));
    item.classList.add("rp-rt-dd-selected");
    const size = _clampPageSize(n);
    const lbl  = root.querySelector("[data-rt-rows-label]");
    if (lbl) lbl.textContent = size >= 5000 ? "5k" : String(size);
    STATE.pageSize = size;
    STATE.page     = 1;
    dd?.classList.remove("open");
    await _loadPage(root);
  };

  // Jump to a specific page. Bounded against STATE.pageData.pages
  // so stale clicks (e.g. on a [Next] button that was painted
  // before a filter shrunk the result set) can't overshoot.
  window.cleanerSetPage = async (n) => {
    const total = STATE.pageData?.pages ?? 1;
    const next = Math.max(1, Math.min(Number(n) || 1, total));
    if (next === STATE.page) return;
    STATE.page = next;
    await _loadPage(root);
  };

  // Chain-link toolbar — flips STATE.linkToolbar + persists +
  // re-applies the visual state. When ON, search + rows-per-page
  // stick across file tabs (the snapshot/restore helpers skip those
  // fields, so the active values just carry through). When the user
  // flips OFF, every tab from then on is per-tab again — past
  // synchronisation isn't unwound.
  window.cleanerToggleLink = (btn) => {
    STATE.linkToolbar = !STATE.linkToolbar;
    btn.classList.toggle("is-active", STATE.linkToolbar);
    btn.setAttribute("aria-pressed", STATE.linkToolbar ? "true" : "false");
    window.rpSavePref?.("cleaner_link_toolbar", STATE.linkToolbar);
    // Flash the synced controls so the user can SEE which fields the
    // chain-link toggle governs — mirrors the Objects-page "Save view"
    // glow (_objFlashSaved). Fires on both ON and OFF so the toggle
    // change always surfaces the affected set.
    _cleanerFlashSynced(root);
  };
  // Initial paint of the link toggle to match the rehydrated pref.
  const linkBtn = root.querySelector("#cleaner-link-toolbar");
  if (linkBtn) {
    linkBtn.classList.toggle("is-active", STATE.linkToolbar);
    linkBtn.setAttribute("aria-pressed", STATE.linkToolbar ? "true" : "false");
  }

  // ── Toolbar additions ported from the Objects-page Files tab ──────
  // Row-numbers toggle — adds a leading "#" index column. Per-file
  // (snapshotted via _saveFilePrefs); the first-tab default came from
  // prefs.cleaner_show_row_nums at mount time.
  window.cleanerToggleRowNums = (btn) => {
    STATE.showRowNums = !STATE.showRowNums;
    if (btn) btn.classList.toggle("rp-rt-rownum-active", STATE.showRowNums);
    if (STATE.rid) _saveFilePrefs(STATE.rid);
    window.rpSavePref?.("cleaner_show_row_nums", STATE.showRowNums);
    // Cache-only re-render — _loadPage hits the cache and repaints head + body.
    if (STATE.rid) _loadPage(root);
  };

  // Open-links toggle — gates the two action anchors next to it (new
  // report + new dashboard) via a panel class. Global pref (not per-file).
  window.cleanerToggleRowOpen = (btn) => {
    STATE.showOpenLinks = !STATE.showOpenLinks;
    if (btn) {
      btn.classList.toggle("is-active", STATE.showOpenLinks);
      btn.setAttribute("aria-pressed", STATE.showOpenLinks ? "true" : "false");
    }
    const panel = root.querySelector(".rp-rt-panel");
    panel?.classList.toggle("cleaner-hide-open-links", !STATE.showOpenLinks);
    window.rpSavePref?.("cleaner_show_open_links", STATE.showOpenLinks);
  };

  // "Open this file in ..." — single-file analogues of the Objects
  // Files-tab per-row buttons. Bypass the default anchor nav so the
  // browser opens a new tab via window.open (matches the Objects rows).
  window.cleanerNewReportFromFile = (ev) => {
    ev?.preventDefault?.();
    if (!STATE.rid) { toast.info("Open a file first."); return false; }
    window.open(`#/reports?new=1&source=${encodeURIComponent(STATE.rid)}`, "_blank", "noopener");
    return false;
  };
  window.cleanerNewDashboardFromFile = (ev) => {
    ev?.preventDefault?.();
    const pid = STATE.project?.redpash_id ?? STATE.summary?.project_redpash_id;
    if (!pid) { toast.info("Couldn't resolve the project for this file."); return false; }
    window.open(`#/dashboards?new=1&project=${encodeURIComponent(pid)}`, "_blank", "noopener");
    return false;
  };

  // Compute / clear cleanness for the CURRENT file. Mirrors Objects's
  // whole-list bulk handlers but scoped to STATE.rid. Spinner via the
  // .is-spinning class (same convention as #obj-score-btn). On success,
  // refetch the file detail so STATE.summary picks up the new
  // cleanness_pct (badges elsewhere will repaint on their next read).
  window.cleanerScoreThisFile = async (btn) => {
    if (!STATE.rid) { toast.info("Open a file first."); return; }
    btn?.classList.add("is-spinning");
    btn && (btn.disabled = true);
    try {
      const summary = await api.post(`/files/${encodeURIComponent(STATE.rid)}/cleanness`, {});
      if (summary) STATE.summary = summary;
      toast.success("Cleanness computed.");
    } catch (err) {
      toast.error(`Score failed: ${err.body?.error ?? err.message}`);
    } finally {
      btn?.classList.remove("is-spinning");
      btn && (btn.disabled = false);
    }
  };
  window.cleanerClearThisFile = async (btn) => {
    if (!STATE.rid) { toast.info("Open a file first."); return; }
    btn?.classList.add("is-spinning");
    btn && (btn.disabled = true);
    try {
      const summary = await api.delete(`/files/${encodeURIComponent(STATE.rid)}/cleanness`);
      if (summary) STATE.summary = summary;
      toast.success("Cleanness cleared.");
    } catch (err) {
      toast.error(`Clear failed: ${err.body?.error ?? err.message}`);
    } finally {
      btn?.classList.remove("is-spinning");
      btn && (btn.disabled = false);
    }
  };

  // Columns dropdown — paints a checkbox per CSV column reflecting
  // STATE.hiddenCols. Min-1 guard keeps at least one data column on so
  // the table never collapses to a header-only row. Mutations persist
  // per-file via _saveFilePrefs and trigger a cache-only repaint via
  // _loadPage (no fetch — page data is still valid).
  window.cleanerBuildColsDropdown = () => {
    const dd = root.querySelector("#cleaner-cols-dd");
    if (!dd) return;
    const cols = STATE.columns ?? [];
    if (!cols.length) { dd.innerHTML = ""; return; }
    const hidden = STATE.hiddenCols ?? new Set();
    dd.innerHTML = cols.map((c) => {
      const checked = hidden.has(c.name) ? "" : " checked";
      return `<label class="rp-rt-col-item">
        <input type="checkbox" data-cleaner-col="${_escAttr(c.name)}"${checked} />
        ${_escHtml(c.name)}
      </label>`;
    }).join("");
    dd.querySelectorAll("input[data-cleaner-col]").forEach((cb) => {
      cb.addEventListener("change", () => window.cleanerToggleCol(cb));
    });
  };
  window.cleanerToggleCol = (cb) => {
    const name = cb.dataset.cleanerCol;
    if (!name) return;
    const hidden = STATE.hiddenCols ?? (STATE.hiddenCols = new Set());
    const visibleCount = (STATE.columns?.length ?? 0) - hidden.size;
    if (cb.checked) {
      hidden.delete(name);
    } else {
      if (visibleCount <= 1) {
        cb.checked = true;
        toast.info("Keep at least one column visible.");
        return;
      }
      hidden.add(name);
    }
    if (STATE.rid) _saveFilePrefs(STATE.rid);
    if (STATE.rid) _loadPage(root);
  };

  // Saved-settings inspector — read-only modal that lists every open
  // file tab + the toolbar/filter state remembered for it. Builds the
  // body on every open so chips reflect live values (current file's
  // state comes straight from STATE; other tabs come from their
  // filePrefs snapshot). Replicates the Profile-page "Saved tab views"
  // card design (.rp-view-row / .rp-view-chip).
  window.cleanerShowSaved = () => {
    const list = root.querySelector("#cleaner-saved-list");
    if (!list) return;
    // Live values for the active file beat the snapshot — the snapshot
    // only refreshes on tab switch, so it can be one toolbar tweak stale.
    const activeRid = STATE.rid;
    const snapshotFor = (rid) => {
      if (rid && rid === activeRid) {
        return {
          pageSize:    STATE.pageSize,
          q:           STATE.q,
          sorts:       STATE.sorts,
          showRowNums: STATE.showRowNums,
          hiddenCols:  [...(STATE.hiddenCols ?? [])],
          colWidths:   STATE.colWidths ?? {},
          mode:        _currentPanelMode(),
        };
      }
      return STATE.filePrefs.get(rid) || {};
    };
    const sortIcon = (dir) => dir === "desc" ? "bi-arrow-down"
                            : dir === "asc"  ? "bi-arrow-up"
                            : "bi-arrow-down-up";

    // Chip strip mirroring the Objects-page toolbar icons + the saved-
    // view summary on the Profile page so all three surfaces feel like
    // the same vocabulary.
    const chips = (s, totalCols) => {
      const out = [];
      const hidden = Array.isArray(s.hiddenCols) ? s.hiddenCols.length : 0;
      const visible = Math.max(0, (totalCols || 0) - hidden);
      if (totalCols) {
        out.push(`<span class="rp-view-chip" title="${visible} of ${totalCols} columns visible">
          <i class="bi bi-layout-three-columns"></i>${visible}/${totalCols}
        </span>`);
      }
      if (s.pageSize) {
        out.push(`<span class="rp-view-chip" title="${s.pageSize} rows per page">
          <i class="bi bi-stack"></i>${s.pageSize}
        </span>`);
      }
      if (Array.isArray(s.sorts) && s.sorts.length) {
        const f = s.sorts[0];
        const more = s.sorts.length > 1 ? `<sup>+${s.sorts.length - 1}</sup>` : "";
        out.push(`<span class="rp-view-chip" title="Sorted by ${f.col} (${f.dir})${s.sorts.length > 1 ? ` and ${s.sorts.length - 1} more` : ""}">
          <i class="bi ${sortIcon(f.dir)}"></i>${_escHtml(f.col)}${more}
        </span>`);
      }
      if (s.q) {
        out.push(`<span class="rp-view-chip" title="Search query: ${s.q}">
          <i class="bi bi-search"></i>"${_escHtml(s.q.length > 12 ? s.q.slice(0, 12) + "…" : s.q)}"
        </span>`);
      }
      if (s.showRowNums) {
        out.push(`<span class="rp-view-chip" title="Row numbers shown"><i class="bi bi-list-ol"></i></span>`);
      }
      const wCount = s.colWidths ? Object.keys(s.colWidths).length : 0;
      if (wCount) {
        out.push(`<span class="rp-view-chip" title="${wCount} column${wCount === 1 ? "" : "s"} resized">
          <i class="bi bi-arrows-angle-expand"></i>${wCount}
        </span>`);
      }
      return out.length
        ? out.join("")
        : `<span class="rp-view-default">Default view</span>`;
    };

    // One card per visible file tab (hiddenFiles excluded — those are
    // the tabs the user has closed). Files that have never been opened
    // get a "Not opened yet" badge instead of chips since no snapshot
    // exists for them; their tab loads the global defaults on first open.
    const visible = (STATE.files ?? []).filter((f) => !STATE.hiddenFiles.has(f.redpash_id));
    if (!visible.length) {
      list.innerHTML = `<div class="rp-sentinels-empty" style="font-size:0.75rem;color:var(--muted)">No open file tabs.</div>`;
    } else {
      list.innerHTML = visible.map((f) => {
        const rid     = f.redpash_id;
        const isOpen  = STATE.filePrefs.has(rid) || rid === activeRid;
        const isActive = rid === activeRid;
        const s       = snapshotFor(rid);
        // For the active file we know columns exactly (STATE.columns);
        // for snapshotted tabs we don't (no live columns cached), so
        // fall back to the file summary's col_count.
        const totalCols = isActive ? (STATE.columns?.length ?? 0)
                                   : (f.col_count ?? 0);
        const name = f.display_name ?? f.filename ?? rid;
        const body = isOpen
          ? chips(s, totalCols)
          : `<span class="rp-view-default">Not opened yet — defaults will apply</span>`;
        // Saved named filters for this file — chip per filter with
        // click-to-load + × to delete. Loading routes through
        // cleanerLoadSavedFilter which switches tabs if needed.
        const savedList = STATE.savedFilters?.[rid] ?? [];
        const savedRow = savedList.length
          ? `<div class="rp-view-sum rp-view-saved-filters">
              <span class="rp-view-saved-lbl" title="Saved filters">
                <i class="bi bi-funnel-fill"></i>
              </span>
              ${savedList.map((f, i) => `<span class="rp-view-chip rp-view-chip--filter"
                  title="Load &quot;${_escAttr(f.name)}&quot; (${f.predicates?.length ?? 0} predicate${(f.predicates?.length ?? 0) === 1 ? "" : "s"})"
                  onclick="cleanerLoadSavedFilter('${_escAttr(rid)}', ${i})">
                  <i class="bi bi-funnel"></i>${_escHtml(f.name)}
                  <span class="rp-view-chip-x" title="Delete this saved filter"
                        onclick="event.stopPropagation();cleanerDeleteSavedFilter('${_escAttr(rid)}', ${i})">×</span>
                </span>`).join("")}
            </div>`
          : "";
        return `<div class="rp-view-row${isOpen ? " is-set" : ""}" data-rid="${_escAttr(rid)}">
          <div class="rp-view-head">
            <i class="bi bi-file-earmark-text rp-view-icon"></i>
            <span class="rp-view-name">${_escHtml(name)}</span>
            ${isActive ? `<span class="rp-view-rm" style="background:color-mix(in srgb,var(--accent) 16%,transparent);border-color:transparent;cursor:default" title="The tab you're on">Active</span>` : ""}
          </div>
          <div class="rp-view-sum">${body}</div>
          ${savedRow}
        </div>`;
      }).join("");
    }
    window.openModal("cleaner-saved");
  };
}

// Anchor a freshly-opened tool modal to the button that triggered it.
// Mirrors Django's _cleanerPositionModal: prefer the LEFT of the button,
// fall back to the RIGHT if it would clip off the viewport; clamp top so
// the modal never spills below the bottom edge.
//
// Two waits: one rAF so the browser has laid out the modal (we need its
// real offsetWidth/Height), and we re-apply position whenever the modal
// resizes (drop-cols' checklist height jumps after _populateToolModal
// fills it asynchronously on some browsers).
function _positionToolModal(toolId, btn) {
  const overlay = document.getElementById(`modal-${toolId}`);
  const modal   = overlay?.querySelector(".modal");
  if (!modal) return;
  // No anchor (e.g. opening from the inspect→snake chain) → recenter
  // by clearing the inline overrides; the library's flex centering
  // takes over.
  if (!btn) {
    modal.style.position = "";
    modal.style.left     = "";
    modal.style.top      = "";
    modal.style.margin   = "";
    return;
  }
  const rect = btn.getBoundingClientRect();
  const gap  = 12;
  modal.style.position = "fixed";
  modal.style.margin   = "0";
  requestAnimationFrame(() => {
    const vpW = window.innerWidth, vpH = window.innerHeight;
    const mw  = modal.offsetWidth  || 400;
    const mh  = modal.offsetHeight || 300;
    let left = rect.left - mw - gap;
    if (left < gap) left = rect.right + gap;
    left = Math.max(gap, Math.min(left, vpW - mw - gap));
    let top = rect.top;
    if (top + mh > vpH - gap) top = Math.max(gap, vpH - mh - gap);
    modal.style.left = `${left}px`;
    modal.style.top  = `${top}px`;
  });
}

// ── Tool modal: open-time population ─────────────────────────────────
// Fills the shared form-binding slots:
//   [data-tool-cols]       — column <select>
//   [data-tool-checklist]  — column checkbox grid
//   [data-tool-sub]        — subtitle ("filename · N rows")
// Per-tool tweaks (preview tables, dedup mode select) happen after.
function _populateToolModal(toolId) {
  const modal = document.getElementById(`modal-${toolId}`);
  if (!modal) return;

  const subText = `${STATE.summary?.display_name ?? STATE.summary?.filename ?? "—"} · ${(STATE.summary?.row_count ?? 0).toLocaleString()} rows`;
  modal.querySelectorAll("[data-tool-sub]").forEach((el) => { el.textContent = subText; });

  // Column <select>s. Some modals (join columns) carry two; each gets
  // the same option list — Column A defaults to first, Column B to
  // second if available.
  const cols = STATE.columns ?? [];
  modal.querySelectorAll("select[data-tool-cols]").forEach((sel, idx) => {
    sel.innerHTML = cols.map((c, i) =>
      `<option value="${_escAttr(c.name)}">${_escHtml(c.name)}${c.dtype ? ` · ${_escHtml(c.dtype)}` : ""}</option>`
    ).join("");
    if (idx === 1 && cols.length > 1) sel.selectedIndex = 1;
  });

  // Checklist (drop-columns / filter-columns / drop-empty-rows).
  modal.querySelectorAll("[data-tool-checklist]").forEach((box) => {
    box.innerHTML = cols.map((c) => `
      <label style="display:flex;align-items:center;gap:0.5rem;padding:0.25rem 0.375rem;border-radius:0.25rem;cursor:pointer">
        <input type="checkbox" data-tool-col="${_escAttr(c.name)}" />
        <span style="font-size:0.75rem">${_escHtml(c.name)}</span>
        ${c.dtype ? `<small style="color:var(--muted);font-size:0.625rem;margin-left:auto">${_escHtml(c.dtype)}</small>` : ""}
      </label>`).join("");
  });

  // tool-snake preview — show before/after of every column name.
  if (toolId === "tool-snake") {
    const preview = modal.querySelector("[data-tool-snake-preview]");
    if (preview) {
      preview.innerHTML = cols.map((c) => {
        const after = c.name.toLowerCase()
          .replace(/[\s\-.]+/g, "_").replace(/[^a-z0-9_]/g, "")
          .replace(/_+/g, "_").replace(/^_|_$/g, "");
        const changed = after !== c.name;
        return `<div style="display:flex;justify-content:space-between;gap:0.5rem;font-family:'JetBrains Mono','Cascadia Code',monospace;font-size:0.625rem;padding:0.125rem 0">
          <span style="color:${changed ? "var(--muted)" : "var(--text)"}">${_escHtml(c.name)}</span>
          <span style="color:${changed ? "var(--green)" : "var(--muted)"}">${_escHtml(after)}</span>
        </div>`;
      }).join("");
    }
  }

  // tool-dedup — populate mode <select> + refresh preview.
  if (toolId === "tool-dedup") {
    const sel = modal.querySelector("[data-tool-dedup-mode]");
    if (sel) {
      // Full-row mode + one entry per column. The user can dedup on
      // either the whole record or a single key column.
      sel.innerHTML = `<option value="">Full-row equality</option>` +
        cols.map((c) => `<option value="${_escAttr(c.name)}">${_escHtml(c.name)} only</option>`).join("");
    }
    _refreshDedupPreview(document);
  }

  // tool-invalid — reset scope / mode toggles to their hidden defaults,
  // clear the ad-hoc additions from the previous open, and kick off
  // the sentinel scan (with the user's learned set merged in as
  // extras). The checklist paints from the response.
  if (toolId === "tool-invalid") {
    const scopeSel = modal.querySelector("[data-tool-invalid-scope]");
    const colField = modal.querySelector("[data-tool-invalid-col-field]");
    const modeSel  = modal.querySelector("[data-tool-invalid-mode]");
    const valField = modal.querySelector("[data-tool-invalid-value-field]");
    if (scopeSel) scopeSel.value = "all";
    if (colField) colField.hidden = true;
    if (modeSel)  modeSel.value = "null";
    if (valField) valField.hidden = true;
    const valInp = modal.querySelector("[data-tool-value]");
    if (valInp) valInp.value = "";
    const extraInp = modal.querySelector("[data-tool-invalid-extra]");
    if (extraInp) extraInp.value = "";
    _toolInvalidAdhoc = new Set();
    _refreshSentinelList(modal);
  }

  // tool-inspect — read-only column stats rendered into [data-tool-inspect-body].
  // Shows dtype + null % + unique % + sample value per column. The
  // numbers come straight from the file's ColumnMeta (populated by
  // data::dtype::summarize on upload / step apply).
  if (toolId === "tool-inspect") {
    const box = modal.querySelector("[data-tool-inspect-body]");
    if (box) {
      box.innerHTML = `
        <table style="width:100%;border-collapse:collapse;font-size:0.6875rem">
          <thead><tr style="background:var(--over0)">
            <th style="padding:0.375rem 0.5rem;text-align:left;color:var(--muted)">#</th>
            <th style="padding:0.375rem 0.5rem;text-align:left;color:var(--text)">Column</th>
            <th style="padding:0.375rem 0.5rem;text-align:left;color:var(--text)">Type</th>
            <th style="padding:0.375rem 0.5rem;text-align:right;color:var(--text)">Null</th>
            <th style="padding:0.375rem 0.5rem;text-align:right;color:var(--text)">Unique</th>
            <th style="padding:0.375rem 0.5rem;text-align:left;color:var(--text)">Sample</th>
          </tr></thead>
          <tbody>${cols.map((c, i) => {
            const np = c.null_pct;
            const up = c.unique_pct;
            const nullCol   = np == null ? "var(--muted)" : np >= 20 ? "var(--red)" : np >= 5 ? "var(--yellow)" : "var(--green)";
            const uniqCol   = up == null ? "var(--muted)" : "var(--text)";
            const sampleVal = c.sample == null ? "<span style=\"color:var(--muted)\">∅</span>" : _escHtml(String(c.sample).slice(0, 60));
            return `<tr>
              <td style="padding:0.25rem 0.5rem;color:var(--muted)">${i + 1}</td>
              <td style="padding:0.25rem 0.5rem;color:var(--text)">${_escHtml(c.name)}</td>
              <td style="padding:0.25rem 0.5rem;color:var(--sub)">${_escHtml(c.dtype ?? "")}</td>
              <td style="padding:0.25rem 0.5rem;text-align:right;color:${nullCol}">${np != null ? `${np.toFixed(1)}%` : "—"}</td>
              <td style="padding:0.25rem 0.5rem;text-align:right;color:${uniqCol}">${up != null ? `${up.toFixed(1)}%` : "—"}</td>
              <td style="padding:0.25rem 0.5rem;color:var(--sub);max-width:14rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${sampleVal}</td>
            </tr>`;
          }).join("")}</tbody>
        </table>`;
    }
  }
}

// Promise-shaped wrapper around #modal-sentinel-consent. Resolves
// with "accept" (share with everyone), "decline" (just for me), or
// "cancel" (back out of the apply). The three buttons each resolve
// + close the modal exactly once; subsequent clicks are no-ops
// thanks to a one-shot guard. `sampleValue` is shown inside the
// modal copy so the user sees what they just flagged.
function _askSentinelConsent(sampleValue) {
  return new Promise((resolve) => {
    const modal      = document.getElementById("modal-sentinel-consent");
    const sampleEl   = modal?.querySelector("#sentinel-consent-sample");
    const acceptBtn  = modal?.querySelector("#sentinel-consent-accept");
    const declineBtn = modal?.querySelector("#sentinel-consent-decline");
    const cancelBtn  = modal?.querySelector("#sentinel-consent-cancel");
    if (!modal || !acceptBtn || !declineBtn || !cancelBtn) {
      // Markup missing — fail safe by declining so we don't push
      // submissions without consent.
      resolve("decline");
      return;
    }
    if (sampleEl) sampleEl.textContent = sampleValue;
    let answered = false;
    const answer = (choice) => {
      if (answered) return;
      answered = true;
      window.closeModal("sentinel-consent");
      resolve(choice);
    };
    acceptBtn.onclick  = () => answer("accept");
    declineBtn.onclick = () => answer("decline");
    cancelBtn.onclick  = () => answer("cancel");
    window.openModal("sentinel-consent");
  });
}

// Per-modal-session set of ad-hoc sentinels the user typed in the
// "Add a custom value" input. Reset every time the modal is opened
// (see _populateToolModal for "tool-invalid"). These are merged with
// STATE.learnedSentinels when calling /sentinels?extra=…, and on Apply
// any of them that survived (still checked) flow into the persisted
// learned set via rpSavePref.
let _toolInvalidAdhoc = new Set();

// Build the union of (personal-learned ∪ global ∪ ad-hoc) canonical
// sentinels that goes into the /sentinels?extra= query. We dedupe in
// canonical form so a user who learned "n/a" doesn't end up sending
// both that and a fresh "N/A" typo on every scan. Globals are merged
// in so a fresh-from-fixtures user who's never typed anything still
// gets the benefit of the shared vocabulary on first scan.
function _toolInvalidExtras() {
  const out = new Set();
  for (const s of STATE.learnedSentinels ?? []) {
    const c = String(s).trim().toLowerCase();
    if (c) out.add(c);
  }
  for (const s of STATE.globalSentinels ?? []) {
    const c = String(s).trim().toLowerCase();
    if (c) out.add(c);
  }
  for (const s of _toolInvalidAdhoc) {
    const c = String(s).trim().toLowerCase();
    if (c) out.add(c);
  }
  return [...out];
}

// Fetch + render the sentinel checklist for the tool-invalid modal.
// Each row is one distinct cell value found by the backend scan, with
// its total count and the columns it appears in. The checkboxes carry
// the raw value as their data attribute; _readToolPayload reads them
// back into the `sentinels` array sent with the fix_invalid step.
//
// Extras (the user's learned set + this-session ad-hoc additions) are
// passed through ?extra=csv so the scan picks up values the canonical
// SENTINELS list doesn't know about. Realistic sentinels are short
// alphanum / punctuation strings — comma in a sentinel is improbable
// — so CSV-joining is fine; if it ever bites, switch to JSON.
async function _refreshSentinelList(modal, opts = {}) {
  const box = modal.querySelector("[data-tool-invalid-list]");
  if (!box) return;
  const previouslyChecked = new Set(
    [...modal.querySelectorAll("[data-tool-sentinel]:checked")]
      .map((c) => c.dataset.toolSentinel),
  );
  box.innerHTML = `<div style="padding:0.5rem 0.75rem;color:var(--muted);font-size:0.6875rem">Scanning…</div>`;
  const extras = _toolInvalidExtras();
  const qs = extras.length ? `?extra=${encodeURIComponent(extras.join(","))}` : "";
  let res;
  try {
    res = await api.get(`/files/${encodeURIComponent(STATE.rid)}/sentinels${qs}`);
  } catch (err) {
    box.innerHTML = `<div style="padding:0.5rem 0.75rem;color:var(--red);font-size:0.6875rem">Couldn't scan: ${_escHtml(err.body?.error ?? err.message)}</div>`;
    return;
  }
  const items = res?.items ?? [];
  const applyBtn = modal.querySelector("[data-tool-apply]");
  // Surface the "learned set is in use" hint so the user knows their
  // teaching is being applied even when nothing matched in this file.
  const lblEl = modal.querySelector("[data-tool-invalid-learned-count]");
  if (lblEl) {
    const n = (STATE.learnedSentinels?.size ?? 0);
    lblEl.textContent = n > 0 ? `${n} learned value${n === 1 ? "" : "s"} in your scan` : "";
  }
  if (!items.length) {
    const known = (res?.known ?? []).length;
    box.innerHTML = `<div style="padding:0.5rem 0.75rem;color:var(--muted);font-size:0.6875rem">Nothing matched — no known sentinels (out of ${known}) and no learned values found in the file. Type a placeholder you can see in the data below and click Add.</div>`;
    if (applyBtn) applyBtn.disabled = true;
    return;
  }
  if (applyBtn) applyBtn.disabled = false;
  // Sort by count desc is server-side; pre-tick everything on first
  // paint (when previouslyChecked is empty); on a re-scan, preserve
  // the user's existing tick choices and pre-tick newly-surfaced rows
  // so the user doesn't have to re-tick the value they just typed.
  const firstPaint = previouslyChecked.size === 0 && !opts.preserve;
  box.innerHTML = items.map((it, i) => {
    const colsLbl = it.columns.length === 1
      ? `${_escHtml(it.columns[0][0])}`
      : `${it.columns.length} columns`;
    const colsTitle = it.columns.map(([n, c]) => `${n} (${c.toLocaleString()})`).join(" · ");
    const shouldCheck = firstPaint
      ? i < 3
      : (previouslyChecked.has(it.value) || _toolInvalidAdhoc.has(it.value.trim().toLowerCase()));
    const checked = shouldCheck ? " checked" : "";
    // Provenance — distinguishes where the scanner learned this
    // value: built-in (no chip), the user's own learned set
    // ("learned"), the shared vocabulary ("global"), or "submitted /
    // awaiting N user" — a value the user has consented to share
    // but that hasn't yet hit the global threshold (2 distinct users).
    const inPersonal = STATE.learnedSentinels?.has(it.canonical);
    const inGlobal   = STATE.globalSentinels?.has(it.canonical);
    const wantsShare = STATE.shareSentinels === true;
    let badge = "";
    if (!SENTINELS_BUILTIN.has(it.canonical)) {
      if (inGlobal) {
        badge = `<span style="font-size:0.5rem;color:var(--green);background:color-mix(in srgb,var(--green) 14%,transparent);padding:0.05rem 0.35rem;border-radius:0.25rem;margin-left:0.25rem" title="In the global vocabulary (≥2 users have flagged it)">global</span>`;
      } else if (inPersonal && wantsShare) {
        badge = `<span style="font-size:0.5rem;color:var(--sub);background:color-mix(in srgb,var(--sub) 14%,transparent);padding:0.05rem 0.35rem;border-radius:0.25rem;margin-left:0.25rem" title="Submitted — will join the global vocabulary after 1 more user flags it">submitted</span>`;
      } else if (inPersonal) {
        badge = `<span style="font-size:0.5rem;color:var(--accent);background:color-mix(in srgb,var(--accent) 14%,transparent);padding:0.05rem 0.35rem;border-radius:0.25rem;margin-left:0.25rem" title="In your personal learned set (not shared)">learned</span>`;
      }
    }
    return `<label style="display:flex;align-items:center;gap:0.625rem;padding:0.375rem 0.625rem;border-bottom:1px solid var(--over1);cursor:pointer">
      <input type="checkbox" data-tool-sentinel="${_escAttr(it.value)}"${checked} />
      <span style="font-family:'JetBrains Mono','Cascadia Code',monospace;font-size:0.6875rem;background:color-mix(in srgb,var(--yellow) 16%,transparent);color:var(--yellow);padding:0.05rem 0.4rem;border-radius:0.25rem">${_escHtml(it.value)}</span>${badge}
      <span style="font-size:0.6875rem;color:var(--sub)">${it.total.toLocaleString()} cell${it.total === 1 ? "" : "s"}</span>
      <span style="font-size:0.625rem;color:var(--muted);margin-left:auto" title="${_escAttr(colsTitle)}">in ${_escHtml(colsLbl)}</span>
    </label>`;
  }).join("");
}

// Built-in SENTINELS — mirrored from data::stats::SENTINELS so the
// renderer can tag the user's *learned* additions with a small chip,
// distinguishing them from the canonical set. Kept in sync by hand
// (the list rarely changes); a one-row drift just paints a "learned"
// chip on a canonical value, no functional impact.
const SENTINELS_BUILTIN = new Set([
  "n/a", "na", "n.a.", "-", "--", "?", "null", "none", "nan",
  "#n/a", ".", "tbd", "x", "#ref!", "#value!", "unknown", "undefined",
]);

// Read the modal's inputs into a {kind, params} payload for /steps.
// Returns null on validation failure (already toasted).
function _readToolPayload(toolId) {
  const m = document.getElementById(`modal-${toolId}`);
  if (!m) return null;
  const cols = (sel) => Array.from(m.querySelectorAll(`[data-tool-col]:checked`)).map((c) => c.dataset.toolCol);
  const v    = (sel) => m.querySelector(sel)?.value ?? "";

  switch (toolId) {
    case "tool-rename": {
      const from = v("[data-tool-cols]");
      const to   = v("[data-tool-new-name]").trim();
      if (!from) return _vErr("Pick a column.");
      if (!to)   return _vErr("New name cannot be empty.");
      return { kind: "rename_column", params: { from, to } };
    }
    case "tool-snake": {
      return { kind: "snake_case_columns", params: {} };
    }
    case "tool-replacenames": {
      const find    = v("[data-tool-find]");
      const replace = v("[data-tool-replace]");
      if (!find) return _vErr("Find pattern cannot be empty.");
      return { kind: "replace_in_names", params: { find, replace } };
    }
    case "tool-changecase": {
      const column = v("[data-tool-cols]");
      const mode   = v("[data-tool-case-mode]") || "lower";
      if (!column) return _vErr("Pick a column.");
      return { kind: "change_case", params: { column, mode } };
    }
    case "tool-filtersel": {
      // Keep matched columns. Take ticked rows; if the regex field is
      // non-empty, also include any column whose name matches it.
      const ticked = cols();
      const re     = v("[data-tool-regex]").trim();
      const keep   = new Set(ticked);
      if (re) {
        let rx;
        try { rx = new RegExp(re, "i"); }
        catch { return _vErr(`Bad regex: ${re}`); }
        STATE.columns.forEach((c) => { if (rx.test(c.name)) keep.add(c.name); });
      }
      if (keep.size === 0) return _vErr("Tick at least one column or supply a regex.");
      return { kind: "filter_columns", params: { cols: [...keep] } };
    }
    case "tool-dropcols": {
      const drop = cols();
      if (!drop.length) return _vErr("Tick at least one column to drop.");
      return { kind: "drop_columns", params: { cols: drop } };
    }
    case "tool-split": {
      const column = v("[data-tool-cols]");
      const sep    = v("[data-tool-sep]");
      const intoS  = v("[data-tool-into]").trim();
      if (!column) return _vErr("Pick a column.");
      if (!sep)    return _vErr("Separator cannot be empty.");
      if (!intoS)  return _vErr("Name the new columns (comma-separated).");
      const into = intoS.split(",").map((s) => s.trim()).filter(Boolean);
      return { kind: "split_column", params: { column, sep, into } };
    }
    case "tool-joinco": {
      const a   = m.querySelector("[data-tool-col-a]")?.value ?? "";
      const b   = m.querySelector("[data-tool-col-b]")?.value ?? "";
      const sep = v("[data-tool-sep]");
      const into= v("[data-tool-into]").trim();
      if (!a || !b)      return _vErr("Pick two columns.");
      if (a === b)       return _vErr("Pick two different columns.");
      if (!into)         return _vErr("Name the new column.");
      return { kind: "join_columns", params: { a, b, sep, into } };
    }
    case "tool-removetext": {
      const column = v("[data-tool-cols]");
      const find   = v("[data-tool-find]");
      if (!column) return _vErr("Pick a column.");
      if (!find)   return _vErr("Pattern cannot be empty.");
      return { kind: "replace_text", params: { column, find, replacement: "" } };
    }
    case "tool-replacetext": {
      const column      = v("[data-tool-cols]");
      const find        = v("[data-tool-find]");
      const replacement = v("[data-tool-replace]");
      if (!column) return _vErr("Pick a column.");
      if (!find)   return _vErr("Find cannot be empty.");
      return { kind: "replace_text", params: { column, find, replacement } };
    }
    case "tool-fill": {
      const column   = v("[data-tool-cols]");
      const strategy = v("[data-tool-fill-mode]") || "value";
      const value    = v("[data-tool-value]");
      if (!column) return _vErr("Pick a column.");
      const params = { column, strategy };
      if (strategy === "value") params.value = value;
      return { kind: "fill_nulls", params };
    }
    case "tool-invalid": {
      // Picked sentinels — raw cell values from the scan, preserved
      // with their original casing so the SQL match is exact.
      const sentinels = Array.from(m.querySelectorAll(`[data-tool-sentinel]:checked`))
        .map((c) => c.dataset.toolSentinel);
      if (!sentinels.length) return _vErr("Tick at least one sentinel to fix.");
      // Teach the app: any picked value whose canonical form was an
      // ad-hoc addition (not in SENTINELS_BUILTIN and not already
      // learned) gets pushed into prefs.learned_sentinels so the next
      // file the user opens scans for it without them having to retype.
      const toLearn = [];
      for (const s of sentinels) {
        const canon = String(s).trim().toLowerCase();
        if (!canon) continue;
        if (SENTINELS_BUILTIN.has(canon)) continue;
        if (STATE.learnedSentinels?.has(canon)) continue;
        toLearn.push(canon);
      }
      if (toLearn.length) {
        for (const c of toLearn) STATE.learnedSentinels.add(c);
        window.rpSavePref?.("learned_sentinels", [...STATE.learnedSentinels]);
      }
      const scope = v("[data-tool-invalid-scope]") || "all";
      const mode  = v("[data-tool-invalid-mode]")  || "null";
      const params = { sentinels };
      if (scope === "one") {
        const column = v("[data-tool-cols]");
        if (!column) return _vErr("Pick a column.");
        params.columns = [column];
      }
      if (mode === "custom") {
        // Empty custom field still falls back to null — typing nothing
        // is the same as picking "Empty (null)" above, no toast needed.
        const val = v("[data-tool-value]");
        if (val !== "") params.replacement = val;
      }
      return { kind: "fix_invalid", params };
    }
    case "tool-dates": {
      const column        = v("[data-tool-cols]");
      const fmt           = v("[data-tool-date-fmt]") || "%Y-%m-%d";
      const on_incomplete = v("[data-tool-date-incomplete]") || "null";
      if (!column) return _vErr("Pick a column.");
      return { kind: "format_dates", params: { column, fmt, on_incomplete } };
    }
    case "tool-droprows": {
      // Backend takes a list of cols; row is dropped when ALL listed
      // cols are null. Empty list → require every column to be null.
      const checked = cols();
      return { kind: "drop_nulls", params: { cols: checked } };
    }
    case "tool-dedup": {
      // _refreshDedupPreview pre-computed the indices when the modal
      // opened (or when the mode select changed). The Apply button is
      // disabled when indices is empty, so by the time we land here
      // there's something to drop.
      const indices = STATE._dedupIndices ?? [];
      if (!indices.length) return _vErr("No duplicates detected.");
      return { kind: "drop_rows", params: { indices } };
    }
    case "tool-find":
    case "tool-inspect": {
      // Read-only tools; no apply.
      return null;
    }
    default: {
      _vErr(`Unknown tool: ${toolId}`);
      return null;
    }
  }
}

function _vErr(msg) { toast.error(msg); return null; }

// ── Applied history list ─────────────────────────────────────────────
// Data Types panel (#cleaner-dtype-list, "click to cast"). Each column
// renders one row: storage dtype + (when ColumnMeta.semantic_dtype
// disagrees) the sniffed target with a clickable cast affordance.
// Click → POST a `cast` step (`window.cleanerCastColumn`). Columns
// where storage matches semantic, or the column is genuinely string,
// render as a read-only badge — nothing to do.
const _DTYPE_SUGGEST = { int: "int", float: "float", bool: "bool", date: "date" };

// Per-file "user said no, don't suggest" set. Persisted to localStorage
// keyed by file rid so the dismissal sticks across reloads. The Rust
// sniffer's heuristics catch most ID-shaped columns (CODE_POSTAL,
// siren, …) but the user is the ultimate authority — once they
// click ✗ on a suggestion, that column is excluded from future
// suggestions for THIS file. The ↻ revert affordance on a dismissed
// row pulls it back into the suggestion stream.
const _DTYPE_SKIP_KEY = (rid) => `rp-dtype-skip-${rid}`;
function _dtypeSkipLoad(rid) {
  if (!rid) return new Set();
  try {
    const raw = localStorage.getItem(_DTYPE_SKIP_KEY(rid));
    return new Set(raw ? JSON.parse(raw) : []);
  } catch { return new Set(); }
}
function _dtypeSkipSave(rid, set) {
  if (!rid) return;
  try { localStorage.setItem(_DTYPE_SKIP_KEY(rid), JSON.stringify([...set])); } catch {}
}

function _renderDtypeList(root) {
  const box = root.querySelector("#cleaner-dtype-list");
  if (!box) return;
  const cols = STATE.columns ?? [];
  if (!cols.length) {
    box.innerHTML = `<div class="rp-rtp-dtype-empty">Open a file to see column types</div>`;
    return;
  }
  const skip = _dtypeSkipLoad(STATE.rid);
  box.innerHTML = cols.map((c) => {
    const storage = c.dtype ?? "string";
    const target  = (storage === "string" && _DTYPE_SUGGEST[c.semantic_dtype])
      ? _DTYPE_SUGGEST[c.semantic_dtype] : null;
    // Dismissed-but-eligible columns get the "kept as text" affordance
    // — they sit in the read-only ladder visually but carry a ↻
    // revert button so the user can put them back in play.
    if (target && skip.has(c.name)) {
      return `<div class="rp-rtp-dtype-row rp-rtp-dtype-row--kept">
        <span class="rp-rtp-dtype-name">${_escHtml(c.name)}</span>
        <span class="rp-rtp-dtype-storage">kept as text</span>
        <button type="button" class="rp-rtp-dtype-revert"
                onclick="cleanerRevertSkipCast('${_escAttr(c.name)}')"
                title="Show the cast suggestion again">
          <i class="bi bi-arrow-counterclockwise"></i>
        </button>
      </div>`;
    }
    if (target) {
      // Live suggestion: name + storage→target hint + ✓ apply + ✗ dismiss.
      // Apply mirrors the old one-click behaviour; dismiss persists the
      // skip so the next render of this file doesn't re-pester.
      return `<div class="rp-rtp-dtype-row rp-rtp-dtype-row--suggest"
                   title="${_escAttr(c.name)} looks like ${target}">
        <span class="rp-rtp-dtype-name">${_escHtml(c.name)}</span>
        <span class="rp-rtp-dtype-arrow">${_escHtml(storage)} → ${target}</span>
        <button type="button" class="rp-rtp-dtype-confirm"
                onclick="cleanerCastColumn('${_escAttr(c.name)}', '${target}')"
                title="Cast to ${target}">
          <i class="bi bi-check2"></i>
        </button>
        <button type="button" class="rp-rtp-dtype-dismiss"
                onclick="cleanerSkipCast('${_escAttr(c.name)}')"
                title="Keep as text — don't suggest again for this file">
          <i class="bi bi-x"></i>
        </button>
      </div>`;
    }
    // Read-only — storage already matches intent (or it's genuine text).
    return `<div class="rp-rtp-dtype-row">
      <span class="rp-rtp-dtype-name">${_escHtml(c.name)}</span>
      <span class="rp-rtp-dtype-storage">${_escHtml(storage)}</span>
    </div>`;
  }).join("");
  // Side-effect: dtype-list is re-rendered on every STATE.columns change,
  // so this is the right place to keep the filter panel's column
  // dropdowns in sync. Cheap (touches just the open <select>s).
  _syncFilterRowColumns(root);
}

// Reflow the column dropdowns on every existing predicate row to match
// the current STATE.columns. Preserves the user's selection when the
// column still exists; falls back to the first column otherwise. The op
// + value fields are untouched. Called from _renderDtypeList so any
// path that changes columns (file switch, drop/rename/cast steps) keeps
// the filter UI honest without a refresh.
function _syncFilterRowColumns(root) {
  const rows = root.querySelectorAll("#cleaner-filter-rows .rp-rt-fb-row");
  if (!rows.length) return;
  const cols = STATE.columns ?? [];
  const opts = cols.map((c) =>
    `<option value="${_escAttr(c.name)}">${_escHtml(c.name)}${c.dtype ? ` · ${_escHtml(c.dtype)}` : ""}</option>`
  ).join("");
  const names = new Set(cols.map((c) => c.name));
  for (const r of rows) {
    const sel = r.querySelector("[data-fb-col]");
    if (!sel) continue;
    const prev = sel.value;
    sel.innerHTML = opts;
    if (names.has(prev)) sel.value = prev;
  }
  _refreshFilterApplyState(root);
}

function _renderAppliedList(root) {
  const box = root.querySelector("#cleaner-applied-list");
  const cnt = root.querySelector("#cleaner-applied-count");
  if (!box) return;
  const steps = STATE.steps ?? [];
  const applied = steps.filter((s) => s.applied === true);
  if (cnt) cnt.textContent = applied.length ? `(${applied.length})` : "";
  if (!steps.length) {
    box.innerHTML = `<div class="rp-rtp-dtype-empty">No operations yet.</div>`;
    return;
  }
  box.innerHTML = steps.map((s) => {
    const dim = s.applied === false;
    const kind = (s.kind ?? "").replace(/_/g, " ");
    return `<div style="font-size:0.6875rem;padding:0.25rem 0.375rem;border-radius:0.25rem;${dim ? "opacity:0.45;text-decoration:line-through" : ""}">
      <i class="bi bi-dot"></i> ${_escHtml(kind)}
    </div>`;
  }).join("");
}

// ── Joins panel ─────────────────────────────────────────────────────
// GET /api/files/:rid/joins returns auto-detected join candidates
// against the other files in the same project. The panel paints one
// section per other-file with its top column-pair candidates (this_col
// ↔ other_col + similarity score). Click a candidate row to POST
// /joins and land on the newly-created joined file. Fetch is skipped
// when the project has fewer than 2 files (nothing to join against).
async function _renderJoinsPanel(root) {
  const box = root.querySelector("#cleaner-join-body");
  if (!box) return;
  if (!STATE.rid) {
    box.innerHTML = `<div class="rp-rtp-dtype-empty">Open a file to detect joins.</div>`;
    return;
  }
  const fileCount = (STATE.files ?? []).length;
  if (fileCount < 2) {
    box.innerHTML = `<div class="rp-rtp-dtype-empty">Load a project with 2+ files to detect joins.</div>`;
    return;
  }
  box.innerHTML = `<div class="rp-rtp-dtype-empty"><i class="bi bi-arrow-repeat" style="animation:cleaner-score-spin .9s linear infinite;display:inline-block"></i> Detecting joins…</div>`;
  let res;
  try {
    res = await api.get(`/files/${encodeURIComponent(STATE.rid)}/joins`);
  } catch (err) {
    box.innerHTML = `<div class="rp-rtp-dtype-empty" style="color:var(--red)">Detect failed: ${_escHtml(err.body?.error ?? err.message)}</div>`;
    return;
  }
  // Guard against a tab switch landing while the fetch was in flight —
  // STATE.rid may have moved on; don't paint stale results.
  if (!STATE.rid) return;
  const files = res.files ?? [];
  if (!files.length) {
    box.innerHTML = `<div class="rp-rtp-dtype-empty">No matching columns in other files.</div>`;
    return;
  }
  box.innerHTML = files.map((f) => {
    const fid   = _escAttr(f.redpash_id);
    const title = _escHtml(f.title ?? f.redpash_id);
    const items = (f.candidates ?? []).map((c, i) => {
      const score = Math.round((c.score ?? 0) * 100);
      const matches = (c.matches ?? 0).toLocaleString();
      const samples = (c.samples ?? []).slice(0, 3).join(", ");
      return `<button class="rp-rtp-join-item" type="button"
                title="${_escAttr(samples ? "Sample overlaps: " + samples : "")}"
                onclick="cleanerCreateJoin('${fid}', '${_escAttr(c.this_col)}', '${_escAttr(c.other_col)}', this)">
        <span class="rp-rtp-join-cols">
          <span class="rp-rtp-join-col">${_escHtml(c.this_col)}</span>
          <i class="bi bi-arrow-left-right"></i>
          <span class="rp-rtp-join-col">${_escHtml(c.other_col)}</span>
        </span>
        <span class="rp-rtp-join-meta">
          <span class="rp-rtp-join-score" data-score="${score}">${score}%</span>
          <span class="rp-rtp-join-matches">${matches} match${(c.matches ?? 0) === 1 ? "" : "es"}</span>
        </span>
      </button>`;
    }).join("");
    return `<div class="rp-rtp-join-file">
      <div class="rp-rtp-join-file-hdr">
        <i class="bi bi-file-earmark-text"></i> ${title}
      </div>
      <div class="rp-rtp-join-items">${items}</div>
    </div>`;
  }).join("");
}

// ── Dedup preview (lightweight) ──────────────────────────────────────
// Hits /api/files/:rid/dedup with the chosen key and shows total /
// unique counts. Phase 2.1 will add the rich sample preview the demo
// has; this gives the user enough info to know how many rows the
// Remove duplicates click will drop.
async function _refreshDedupPreview(root) {
  const m = document.getElementById("modal-tool-dedup");
  if (!m) return;
  const stats   = m.querySelector("[data-tool-stats]");
  const samples = m.querySelector("[data-tool-dedup-samples]");
  const hint    = m.querySelector("[data-tool-dedup-hint]");
  const apply   = m.querySelector("[data-tool-apply]");
  const key     = m.querySelector("[data-tool-dedup-mode]")?.value ?? "";

  if (stats) stats.innerHTML = `<span class="rp-tm-stat">Detecting…</span>`;
  if (hint)  hint.textContent = key
    ? `Two rows are considered duplicates when they share the same '${key}'.`
    : "Two rows are considered duplicates when every column matches.";
  if (apply) { apply.disabled = true; apply.style.opacity = "0.45"; }

  try {
    const qs = key ? `?by=${encodeURIComponent(key)}` : "";
    const report = await api.get(`/files/${encodeURIComponent(STATE.rid)}/dedup${qs}`);
    STATE._dedupReport = report;  // stash for the apply branch
    STATE._dedupKey    = key;

    // Sample API differs slightly between codepaths — handle both
    // (`rows` is the rich preview shape; `duplicate_rows` is the
    // lightweight count used by the home-page dedup tile).
    const tot      = report.total_rows ?? STATE.summary?.row_count ?? 0;
    const groups   = report.total_groups ?? null;
    const reported = (report.rows?.length) ?? report.duplicate_rows ?? 0;
    // Indices to drop: non-first-of-group rows in the preview. With
    // the by-column strategy the backend groups by that key; with
    // full-row mode it groups by every column.
    const indices  = _dedupIndicesToDrop(report);
    STATE._dedupIndices = indices;

    if (stats) {
      const dup   = indices.length;
      stats.innerHTML = `
        <span class="rp-tm-stat" style="color:${dup ? "var(--yellow)" : "var(--green)"}">${dup.toLocaleString()} duplicate row${dup !== 1 ? "s" : ""}</span>
        ${groups != null ? `<span class="rp-tm-stat">in ${groups.toLocaleString()} group${groups !== 1 ? "s" : ""}</span>` : ""}
        <span class="rp-tm-stat">of ${tot.toLocaleString()}</span>`;
    }
    if (apply) {
      apply.disabled = indices.length === 0;
      apply.style.opacity = indices.length === 0 ? "0.45" : "1";
    }

    // Sample preview — first ~10 duplicate rows so the user can sanity-
    // check before clicking the danger-tinted Remove button.
    if (samples) {
      const sample = (report.rows ?? []).slice(0, 10);
      if (!sample.length) {
        samples.innerHTML = "";
      } else {
        samples.innerHTML = `
          <div class="rp-tm-field-lbl" style="margin-top:0.5rem">Preview (first ${sample.length})</div>
          <div style="max-height:10rem;overflow:auto;border:0.0313rem solid var(--over0);border-radius:0.4375rem">
            <table style="width:100%;font-size:0.625rem;border-collapse:collapse">
              <thead><tr style="background:var(--over0)">
                <th style="padding:0.25rem 0.5rem;text-align:left;color:var(--muted)">#</th>
                ${(report.columns ?? STATE.columns.map((c) => c.name)).map((c) => `<th style="padding:0.25rem 0.5rem;text-align:left;color:var(--text)">${_escHtml(c)}</th>`).join("")}
              </tr></thead>
              <tbody>${sample.map((r) =>
                `<tr><td style="padding:0.25rem 0.5rem;color:var(--muted)">${r.index ?? ""}</td>${
                  (r.cells ?? []).map((c) =>
                    `<td style="padding:0.25rem 0.5rem">${c == null ? "<span style=\"color:var(--muted)\">∅</span>" : _escHtml(c)}</td>`
                  ).join("")
                }</tr>`
              ).join("")}</tbody>
            </table>
          </div>`;
      }
    }
  } catch (err) {
    if (stats) stats.innerHTML = `<span class="rp-tm-stat" style="color:var(--red)">${_escHtml(err.body?.error ?? err.message)}</span>`;
  }
}

// Compute the row indices we'd drop: all non-first members of each
// duplicate group, using the by-column key (or full-row equality
// when no by= was passed). Mirrors the legacy dedup.js logic but
// without rendering a separate dialog — the cleaner modal already
// shows the preview.
function _dedupIndicesToDrop(report) {
  const rows = report.rows ?? [];
  if (!rows.length) return [];
  const colCount = (report.columns ?? []).length;
  const keyIdx = report.by_indices?.length
    ? report.by_indices
    : Array.from({ length: colCount }, (_, i) => i);
  const drop = [];
  let prevKey = null;
  for (const r of rows) {
    const key = keyIdx.map((i) => r.cells?.[i] ?? "").join("");
    if (key === prevKey) drop.push(r.index);
    prevKey = key;
  }
  return drop;
}

// ── Overview pane — isolated files redtable ──────────────────────────
// Renders when the user clicks the Overview tab. It is a SELF-CONTAINED
// redtable — its own toolbar, its own table, and its own state object
// (`OV` below). It deliberately shares NOTHING with the file-tabs'
// table: select/delete/edit-mode here flip classes on the overview's
// own wrapper and write to `OV.selected`, never `STATE.selected` or
// `.rp-rt-panel--cleaner`. So ticking a row here can't tick rows in a
// file tab.
//
// The data source is STATE.files (already in memory — a project has at
// most a few dozen files), so search filters client-side with no
// fetch. Delete hits DELETE /api/files/:rid; inline name/status edits
// hit PATCH /api/files/:rid.
let OV = {
  mode:       null,          // "select" | "delete" | "edit" | null
  selected:   new Set(),     // redpash_ids ticked in select mode
  q:          "",            // client-side search query
  hiddenCols: new Set(),     // OV_COLUMNS keys the user has hidden
  // User's column order — array of OV_COLUMNS keys, possibly a subset
  // when newly-added columns haven't been seen yet (we reconcile in
  // _renderOverview by appending unknown keys). Drag-to-reorder via
  // ovColDrag* mutates this and persists to localStorage. Empty array
  // means "use the schema's default order from OV_COLUMNS".
  colOrder:   [],
  // Chained sort (same shape as Objects.js / cleaner file-table). Empty
  // → schema natural order. Click flips dir on same col, replaces chain
  // on a different col; shift-click appends as a tie-breaker.
  sorts:      [],
  // { colKey: px } — user-resized widths from the .rp-rt-col-resize
  // handle on each TH. Persisted to localStorage on mouseup so the
  // layout sticks across reloads.
  colWidths:  {},
};

// The overview redtable's data columns (between the leading select
// checkbox and the trailing delete trash). `key` drives both the
// column-visibility picker and the per-cell renderer in _ovCell.
const OV_COLUMNS = [
  { key: "name",     label: "Name",     align: "left"  },
  { key: "stage",    label: "Stage",    align: "left"  },
  { key: "rows",     label: "Rows",     align: "right" },
  { key: "cols",     label: "Cols",     align: "right" },
  { key: "clean",    label: "Clean",    align: "right" },
  { key: "size",     label: "Size",     align: "right" },
  { key: "modified", label: "Modified", align: "left"  },
];
const OV_HIDDEN_LS_KEY = "rp-overview-hidden-cols";
const OV_ORDER_LS_KEY  = "rp-overview-col-order";
const OV_WIDTHS_LS_KEY = "rp-overview-col-widths";

function _ovLoadHiddenCols() {
  try {
    const raw = localStorage.getItem(OV_HIDDEN_LS_KEY);
    if (raw) return new Set(JSON.parse(raw));
  } catch {}
  return new Set();
}
function _ovSaveHiddenCols() {
  try { localStorage.setItem(OV_HIDDEN_LS_KEY, JSON.stringify([...OV.hiddenCols])); } catch {}
}

// Per-user column order — saved to localStorage so the layout sticks
// across reloads + SW cache-clears. Validated against OV_COLUMNS on
// load (drops unknown keys); _renderOverview appends any new schema
// keys not present in the saved order so a future column addition
// doesn't get silently hidden.
function _ovLoadColOrder() {
  try {
    const raw = localStorage.getItem(OV_ORDER_LS_KEY);
    if (raw) {
      const arr = JSON.parse(raw);
      const valid = new Set(OV_COLUMNS.map((c) => c.key));
      return Array.isArray(arr) ? arr.filter((k) => valid.has(k)) : [];
    }
  } catch {}
  return [];
}
function _ovSaveColOrder() {
  try { localStorage.setItem(OV_ORDER_LS_KEY, JSON.stringify(OV.colOrder)); } catch {}
}

// User-resized column widths for the Overview redtable — { key: px }.
// Same persistence pattern as colOrder: localStorage so the layout
// survives reloads + SW cache-clears, with a validation pass on load
// that drops unknown keys (so a column removed from the schema doesn't
// leave a dangling width entry that never re-renders).
function _ovLoadColWidths() {
  try {
    const raw = localStorage.getItem(OV_WIDTHS_LS_KEY);
    if (raw) {
      const obj = JSON.parse(raw);
      const valid = new Set(OV_COLUMNS.map((c) => c.key));
      const out = {};
      if (obj && typeof obj === "object") {
        for (const [k, v] of Object.entries(obj)) {
          if (valid.has(k) && Number.isFinite(+v) && +v >= 48) out[k] = +v;
        }
      }
      return out;
    }
  } catch {}
  return {};
}
function _ovSaveColWidths() {
  try { localStorage.setItem(OV_WIDTHS_LS_KEY, JSON.stringify(OV.colWidths)); } catch {}
}

// Sortable value for a column key on a file row. Matches the keys in
// OV_COLUMNS and mirrors what _ovCell renders, but returns the raw
// underlying value so the comparator can do numeric vs. locale-string
// the right way. Modified is sorted on the ISO timestamp string (a
// reverse-locale-compare via numeric:true is good enough for ISO 8601).
function _ovSortValue(key, f) {
  switch (key) {
    case "name":     return (f.display_name ?? f.filename ?? "").toLowerCase();
    case "stage":    return f.stage ?? "";
    case "rows":     return f.row_count ?? null;
    case "cols":     return f.col_count ?? null;
    case "clean":    return f.cleanness_pct ?? null;
    case "size":     return f.file_size_bytes ?? null;
    case "modified": return f.updated_at ?? "";
    default:         return null;
  }
}

// Render one data cell for a given column key + file row.
function _ovCell(key, f) {
  switch (key) {
    case "name": {
      const rid  = _escAttr(f.redpash_id);
      const name = _escHtml(f.display_name ?? f.filename ?? "—");
      return `<td class="ov-cell-name" data-rid="${rid}" data-field="display_name"
                  ondblclick="ovCellEdit(this)" title="Double-click to rename (edit mode)">
                <i class="bi bi-file-earmark-spreadsheet" style="margin-right:0.375rem;color:var(--muted)"></i>${name}
              </td>`;
    }
    case "stage": {
      // Computed pipeline stage (import → clean → report → publish) —
      // derived from steps / reports / dashboards, so read-only.
      const stage  = f.stage ?? "import";
      const stTone = stage === "publish" ? "var(--green)"
                   : stage === "report"  ? "var(--accent)"
                   : stage === "clean"   ? "var(--yellow)"
                   :                       "var(--muted)";
      return `<td class="ov-cell-stage">
                <span class="rp-tag" style="color:${stTone};border-color:${stTone}">${_escHtml(stage)}</span>
              </td>`;
    }
    case "rows": return `<td style="text-align:right">${(f.row_count ?? 0).toLocaleString()}</td>`;
    case "cols": return `<td style="text-align:right">${(f.col_count ?? 0).toLocaleString()}</td>`;
    case "clean": {
      const pct  = f.cleanness_pct;
      const tone = pct == null ? "var(--muted)"
                : pct >= 90    ? "var(--green)"
                : pct >= 70    ? "var(--yellow)"
                :                "var(--red)";
      return `<td style="text-align:right;color:${tone}">${pct != null ? `${Math.round(pct)}%` : "—"}</td>`;
    }
    case "size":     return `<td style="text-align:right;color:var(--muted)">${_fmtBytes(f.file_size_bytes)}</td>`;
    case "modified": return `<td style="color:var(--muted)">${_fmtDate(f.updated_at)}</td>`;
    default:         return `<td></td>`;
  }
}

function _renderOverview(root) {
  // Overview pane is a sibling chrome block (toolbar + body), not a
  // pane inside the file-table's wrap anymore. CSS toggles visibility
  // off the page's `.overview-active` class; we just flip the class +
  // re-paint the two slots.
  root.querySelector("#page-cleaner")?.classList.add("overview-active");
  const tbEl = root.querySelector("#cleaner-ov-toolbar");
  const tblEl = root.querySelector("#cleaner-ov-table");
  if (!tbEl || !tblEl) return;

  const proj  = STATE.project ?? {};
  const q     = OV.q.trim().toLowerCase();
  const files = (STATE.files ?? []).filter((f) => {
    if (!q) return true;
    const hay = `${f.display_name ?? ""} ${f.filename ?? ""} ${f.stage ?? ""}`.toLowerCase();
    return hay.includes(q);
  });

  // Chained sort — same shape as the Objects-page table-sort. Walks
  // OV.sorts in order, first non-zero comparison wins. Nulls always
  // sink. Numeric when both sides parse, locale-string otherwise.
  if (OV.sorts.length) {
    const mult = (dir) => dir === "desc" ? -1 : 1;
    const cmp = (a, b, col, dir) => {
      const av = _ovSortValue(col, a);
      const bv = _ovSortValue(col, b);
      const an = av == null || av === "";
      const bn = bv == null || bv === "";
      if (an && bn) return 0;
      if (an) return 1;
      if (bn) return -1;
      const anum = typeof av === "number" ? av : Number(av);
      const bnum = typeof bv === "number" ? bv : Number(bv);
      if (Number.isFinite(anum) && Number.isFinite(bnum)) return (anum - bnum) * mult(dir);
      return String(av).localeCompare(String(bv), undefined, { sensitivity: "base", numeric: true }) * mult(dir);
    };
    files.sort((a, b) => {
      for (const k of OV.sorts) {
        const c = cmp(a, b, k.col, k.dir);
        if (c !== 0) return c;
      }
      return 0;
    });
  }

  // Reconcile OV.colOrder against the live OV_COLUMNS schema — drops
  // unknown keys (deleted columns) and appends any schema keys not
  // yet in the saved order (so a new schema column shows up at the
  // end instead of silently disappearing). The reconciliation
  // mutates OV.colOrder so it's stable across re-renders.
  {
    const validKeys = new Set(OV_COLUMNS.map((c) => c.key));
    OV.colOrder = OV.colOrder.filter((k) => validKeys.has(k));
    const inOrder = new Set(OV.colOrder);
    for (const c of OV_COLUMNS) {
      if (!inOrder.has(c.key)) OV.colOrder.push(c.key);
    }
  }
  const byKey   = new Map(OV_COLUMNS.map((c) => [c.key, c]));
  const visCols = OV.colOrder.map((k) => byKey.get(k)).filter((c) => c && !OV.hiddenCols.has(c.key));
  const colspan = visCols.length + 2;  // + leading select + trailing delete

  // Build a {col → {dir, rank}} map so each header can render its
  // sort arrow + (when chained) the position pill. Matches the
  // visual vocabulary in objects.js / cleaner file-table headers.
  const sortRank = new Map(OV.sorts.map((k, i) => [k.col, { dir: k.dir, rank: i + 1 }]));
  const showRanks = sortRank.size > 1;
  const headCells = visCols.map((c) => {
    const entry  = sortRank.get(c.key);
    const cls    = `rp-rt-th-sortable${entry ? " rp-rt-sort-th" : ""}`;
    const arrow  = entry
      ? ` <i class="bi bi-arrow-${entry.dir === "desc" ? "down" : "up"} rp-rt-sort-ico rp-rt-sort-active"></i>${showRanks ? `<span class="rp-rt-sort-rank">${entry.rank}</span>` : ""}`
      : ` <i class="bi bi-arrow-down-up rp-rt-sort-ico"></i>`;
    // User-resized width from OV.colWidths — applied inline so the
    // layout survives every re-render. The .rp-rt-col-resize span
    // (library-styled accent line on the TH's right edge) is the
    // drag handle; _clInitColResize wires it after the head HTML lands.
    const w  = OV.colWidths?.[c.key];
    const wStyle = (Number.isFinite(w) && w >= 48)
      ? ` width:${w}px;min-width:${w}px;`
      : "";
    // draggable + data-col + drag handlers mirror the file-table
    // thead (cleanerColDrag*). The Overview persists the new order
    // to localStorage instead of POSTing a `filter_columns` step,
    // since column order is a pure UI preference here, not a
    // data-pipeline step.
    return `<th class="${cls}" style="text-align:${c.align};${wStyle}" data-col="${_escAttr(c.key)}"
                draggable="true"
                onclick="ovSortBy('${_escAttr(c.key)}', event)"
                ondragstart="ovColDragStart(event)"
                ondragover="ovColDragOver(event)"
                ondragleave="ovColDragLeave(event)"
                ondrop="ovColDrop(event)"
                ondragend="ovColDragEnd(event)">${_escHtml(c.label)}${arrow}<span class="rp-rt-col-resize" onclick="event.stopPropagation()" draggable="false"></span></th>`;
  }).join("");

  const rowHtml = files.map((f) => {
    const rid = _escAttr(f.redpash_id);
    const sel = OV.selected.has(f.redpash_id);
    // Row click → switch the active file tab. _ovRowClick skips when
    // the panel is in select/delete/edit mode (those modes own the
    // click affordance — tick, trash, rename) so it doesn't fight
    // with the dblclick-to-rename in the name cell.
    return `
      <tr data-rid="${rid}" class="${sel ? "rp-rt-row-sel" : ""}"
          onclick="_ovRowClick(event, '${rid}')">
        <td data-mode-col="select" onclick="event.stopPropagation()">
          <input type="checkbox" class="ov-row-chk" data-rid="${rid}"
                 ${sel ? "checked" : ""} onchange="ovRowSelect(this)" />
        </td>
        ${visCols.map((c) => _ovCell(c.key, f)).join("")}
        <td data-mode-col="delete" onclick="event.stopPropagation()">
          <button type="button" class="rp-rt-row-del" title="Delete this file"
                  onclick="ovRowDelete('${rid}')"><i class="bi bi-trash3"></i></button>
        </td>
      </tr>`;
  }).join("");

  const emptyRow = files.length === 0
    ? `<tr><td colspan="${colspan}" style="text-align:center;color:var(--muted);padding:2rem">${
        OV.q ? "No files match your search." : "No files in this project yet — use the + button to add one."
      }</td></tr>`
    : "";

  // Column-visibility picker dropdown — one checkbox per OV_COLUMNS
  // entry. Persisted to localStorage so the layout sticks across
  // sessions (and the SW debugging cache-clears the user does).
  const colPickerItems = OV_COLUMNS.map((c) => `
    <label class="ov-colpick-item">
      <input type="checkbox" ${OV.hiddenCols.has(c.key) ? "" : "checked"}
             onchange="ovToggleColumn('${c.key}', this.checked)" />
      <span>${_escHtml(c.label)}</span>
    </label>`).join("");

  // Toolbar — paints into the parent partial's #cleaner-ov-toolbar
  // (already a .rp-rt-toolbar). Uses the library's .rp-rt-search +
  // .rp-rt-icon-btn classes so it reads identical to the file-table
  // toolbar; the only Overview-specific affordances are the column
  // picker dropdown and the score-files spinner button.
  tbEl.innerHTML = `
    <input class="rp-rt-search" type="search" placeholder="Search files…"
           autocomplete="off" value="${_escAttr(OV.q)}"
           oninput="ovSearch(this)" />
    <span class="rp-rt-sel-chip" id="ov-sel-chip" data-has-sel="0"
          onclick="ovClearSelection()" title="Click to clear selection">
      <i class="bi bi-check2-square"></i><span id="ov-sel-count">0 selected</span>
    </span>
    <button class="rp-rt-icon-btn" id="ov-bulk-del" style="display:none;color:var(--red)"
            title="Delete selected files" onclick="ovBulkDelete()">
      <i class="bi bi-trash3"></i>
    </button>
    <!-- Mode cluster — pushed right via margin-left:auto on the first
         button so the toolbar reads search-left / actions-right just
         like the file-table toolbar. -->
    <button class="rp-rt-icon-btn ${OV.mode === "edit" ? "is-active" : ""}"
            style="margin-left:auto"
            title="Edit mode — double-click a name, pick a status"
            onclick="ovToggleMode('edit')"><i class="bi bi-pencil"></i></button>
    <button class="rp-rt-icon-btn ${OV.mode === "delete" ? "is-active" : ""}"
            title="Delete mode" onclick="ovToggleMode('delete')"><i class="bi bi-trash3"></i></button>
    <button class="rp-rt-icon-btn ${OV.mode === "select" ? "is-active" : ""}"
            title="Select mode" onclick="ovToggleMode('select')"><i class="bi bi-check2-square"></i></button>
    <button class="rp-rt-icon-btn" title="Refresh" onclick="ovRefresh()">
      <i class="bi bi-arrow-clockwise"></i>
    </button>
    <button class="rp-rt-icon-btn" id="ov-score-btn"
            title="Compute the cleanness score for every file in this project"
            onclick="ovScoreFiles()">
      <i class="bi bi-magic"></i>
    </button>
    <div class="ov-colpick">
      <button class="rp-rt-icon-btn" title="Show / hide columns"
              onclick="ovToggleColPicker(this)"><i class="bi bi-layout-three-columns"></i></button>
      <div class="ov-colpick-dd" hidden>
        <div class="ov-colpick-hdr">Columns</div>
        ${colPickerItems}
      </div>
    </div>`;

  // Table — paints into the partial's #cleaner-ov-table (already a
  // .rp-rt-table inside a .rp-rt-table-wrap inside a .rp-rt-body).
  tblEl.innerHTML = `
    <thead>
      <tr>
        <th data-mode-col="select" style="width:1.5rem">
          <input type="checkbox" id="ov-sel-all" onchange="ovSelectAll(this.checked)" />
        </th>
        ${headCells}
        <th data-mode-col="delete" style="width:1.75rem"></th>
      </tr>
    </thead>
    <tbody>${rowHtml || emptyRow}</tbody>`;

  // Wire the column-resize handles in the freshly-painted thead. The
  // ctx callback writes to OV.colWidths + persists; the next render
  // reads back the saved width and applies it inline (so resize is
  // sticky across reloads, mode switches, sort changes, etc.).
  const ovThead = tblEl.querySelector("thead");
  if (ovThead) _clInitColResize(ovThead, {
    set(key, w) {
      OV.colWidths = OV.colWidths || {};
      OV.colWidths[key] = w;
      _ovSaveColWidths();
    },
  });

  // Mode-gating reuses the panel's library `rp-rt-mode-*` classes —
  // same path the file-table uses — so a single CSS rule per mode
  // covers both views.
  const panel = root.querySelector(".rp-rt-panel--cleaner");
  if (panel) {
    panel.classList.remove("rp-rt-mode-edit", "rp-rt-mode-select", "rp-rt-mode-delete");
    if (OV.mode) panel.classList.add(`rp-rt-mode-${OV.mode}`);
  }

  _renderOvSelectionChip(root);
}

// Selection chip + bulk-delete visibility for the overview redtable.
// Mirrors _renderSelectionChip but reads OV.selected and is gated on
// the overview being in select-mode (CSS pin in cleaner.css).
function _renderOvSelectionChip(root) {
  const chip = root.querySelector("#ov-sel-chip");
  const cnt  = root.querySelector("#ov-sel-count");
  const del  = root.querySelector("#ov-bulk-del");
  const n    = OV.selected.size;
  if (chip) chip.dataset.hasSel = n > 0 ? "1" : "0";
  if (cnt)  cnt.textContent = `${n} selected`;
  if (del)  del.style.display = n > 0 ? "inline-flex" : "none";
  const head  = root.querySelector("#ov-sel-all");
  const total = root.querySelectorAll(".ov-rt-table tbody .ov-row-chk").length;
  if (head) {
    head.checked       = total > 0 && n === total;
    head.indeterminate = n > 0 && n < total;
  }
}

// Human-readable byte size — mirrors home.js fmtSize.
function _fmtBytes(b) {
  if (b == null) return "—";
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1024 / 1024).toFixed(1)} MB`;
}

// Short date — "May 13" style; falls back to the raw string.
function _fmtDate(iso) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  } catch { return String(iso); }
}

// ── Wrapped-CSV detector ─────────────────────────────────────────────
// A file is "wrapped" when:
//   • There's exactly ONE column, AND
//   • that column's NAME itself contains a separator, AND
//   • most preview values contain the same separator.
//
// The column-name signal is the killer: Polars used the first line as
// the header, so a wrapped file's single column is named something
// like `Numero_dossier_ID,"Client","Formule",…`. A legitimate
// one-column file has a clean header (`email`, `id`) — its name never
// contains a comma / semicolon / tab. The earlier "stable separator
// count across rows" heuristic was too strict: real datasets have
// free-text fields with internal commas, so the per-row count varies
// and the file would slip past undetected.
//
// Never destructive — the banner just reveals the Fix button; the
// Rust `unwrap_csv` step does the real re-parse. A false positive is
// just a banner the user can ignore.
function _renderWrappedBanner(root) {
  const banner = root.querySelector("#cleaner-fix-wrapped");
  if (!banner) return;
  banner.style.display = _detectWrappedCsv() ? "" : "none";
}

function _detectWrappedCsv() {
  if (STATE.columns.length !== 1) return false;
  const colName = String(STATE.columns[0]?.name ?? "");
  const rows = STATE.pageData?.rows ?? [];
  if (rows.length < 2) return false;
  const sample = rows.slice(0, 12).map((r) => String(r[0] ?? ""));
  for (const sep of [",", ";", "\t", "|"]) {
    if (!colName.includes(sep)) continue;            // header must carry the sep
    const withSep = sample.filter((s) => s.includes(sep)).length;
    if (withSep >= Math.ceil(sample.length * 0.7)) return true;  // ≥70% of rows agree
  }
  return false;
}

// Pick the separator that gives the most CONSISTENT column count
// across sample lines. Mirrors Polars' own CSV sep sniff but only on
// the preview we already have on the client.
function _guessSeparator(lines) {
  const SEPS = [",", ";", "\t", "|"];
  let best = ",", bestVariance = Infinity;
  for (const s of SEPS) {
    const counts = lines.map((l) => _splitCsvLine(String(l ?? ""), s).length);
    if (counts.every((c) => c === 1)) continue;  // sep doesn't appear → skip
    const mean = counts.reduce((a, b) => a + b, 0) / counts.length;
    const variance = counts.reduce((a, c) => a + (c - mean) ** 2, 0) / counts.length;
    if (variance < bestVariance) { bestVariance = variance; best = s; }
  }
  return best;
}

// Minimal CSV-line splitter that honours double-quote escaping. Good
// enough for the After-preview rendering; Rust handles the real parse.
function _splitCsvLine(line, sep) {
  const out = [];
  let cur = "", inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') { inQ = false; }
      else { cur += ch; }
    } else {
      if (ch === '"') { inQ = true; }
      else if (ch === sep) { out.push(cur); cur = ""; }
      else { cur += ch; }
    }
  }
  out.push(cur);
  return out;
}

// ── Filter side panel ────────────────────────────────────────────────
// Each predicate row owns three controls:
//   • column dropdown ([data-fb-col])  — from STATE.columns
//   • op dropdown     ([data-fb-op])   — 16 ops, mirrors Rust vocabulary
//   • value input     ([data-fb-val])  — text/number/date depending on op
// Plus a remove button. Op vocabulary lives in one place so a future
// vocabulary widening just edits the list below.
const FILTER_OPS = [
  ["eq",          "equals"],
  ["neq",         "not equals"],
  ["contains",    "contains"],
  ["starts_with", "starts with"],
  ["ends_with",   "ends with"],
  ["in",          "in (comma-list)"],
  ["not_in",      "not in (comma-list)"],
  ["gt",          ">"],
  ["gte",         "≥"],
  ["lt",          "<"],
  ["lte",         "≤"],
  ["between",     "between (lo, hi)"],
  ["before",      "before (YYYY-MM-DD)"],
  ["after",       "after (YYYY-MM-DD)"],
  ["is_null",     "is null"],
  ["not_null",    "is not null"],
];

function _ensureFilterRow(root) {
  const box = root.querySelector("#cleaner-filter-rows");
  if (box && !box.children.length) _appendFilterRow(root);
}

function _appendFilterRow(root) {
  const box = root.querySelector("#cleaner-filter-rows");
  if (!box || !STATE.columns.length) return;
  const colOpts = STATE.columns.map((c) =>
    `<option value="${_escAttr(c.name)}">${_escHtml(c.name)}${c.dtype ? ` · ${_escHtml(c.dtype)}` : ""}</option>`
  ).join("");
  const opOpts = FILTER_OPS.map(([v, l]) =>
    `<option value="${v}">${_escHtml(l)}</option>`
  ).join("");

  const div = document.createElement("div");
  div.className = "rp-rt-fb-row";
  // Three stacked rows, same shape as the Objects-page row:
  //   row 1: × (top-right via align-self: flex-end on .rp-rt-fb-rm)
  //   row 2: col + op selects, 50/50 grid (.rp-rt-fb-selects)
  //   row 3: value input (.rp-rt-fb-val)
  div.innerHTML =
      `<button class="rp-rt-fb-rm" onclick="_cleanerFilterRowRemove(this)" title="Remove predicate">`
    +   `<i class="bi bi-x"></i>`
    + `</button>`
    + `<div class="rp-rt-fb-selects">`
    +   `<select data-fb-col onchange="_cleanerFilterRowChanged(this)">${colOpts}</select>`
    +   `<select data-fb-op  onchange="_cleanerFilterRowChanged(this)">${opOpts}</select>`
    + `</div>`
    + `<input class="rp-rt-fb-val" data-fb-val type="text" placeholder="value"`
    +   ` oninput="_cleanerFilterRowChanged(this)" />`;
  box.appendChild(div);
  _refreshFilterApplyState(root);
}

// Snapshot the current filter-panel draft into the same shape Apply
// posts — used by the floppy Save handler so the in-panel state and
// the saved-named-filter entry stay isomorphic.
function _cleanerCollectDraft(root) {
  const box  = root.querySelector("#cleaner-filter-rows");
  const rows = box ? [...box.querySelectorAll(".rp-rt-fb-row")] : [];
  const comboBtn   = root.querySelector("#cleaner-fb-combo button.is-active");
  const combinator = comboBtn ? comboBtn.dataset.combo : "and";
  const predicates = [];
  for (const r of rows) {
    const column = r.querySelector("[data-fb-col]")?.value;
    const op     = r.querySelector("[data-fb-op]")?.value;
    if (!column || !op) continue;
    const pred = { column, op };
    if (op === "is_null" || op === "not_null") { predicates.push(pred); continue; }
    const raw = r.querySelector("[data-fb-val]")?.value ?? "";
    if (op === "in" || op === "not_in") {
      pred.value = raw.split(",").map((s) => s.trim()).filter(Boolean);
      if (!pred.value.length) continue;
    } else if (op === "between") {
      const parts = raw.split(",").map((s) => s.trim()).filter(Boolean);
      if (parts.length !== 2) continue;
      pred.value = parts;
    } else {
      if (!raw.length) continue;
      pred.value = raw;
    }
    predicates.push(pred);
  }
  return { combinator, predicates };
}

// Restore a saved filter into the panel — wipes any current draft,
// rebuilds one row per predicate, sets the combinator pill. Doesn't
// auto-apply: the user reviews + clicks Apply themselves.
function _cleanerLoadDraft(root, entry) {
  if (!entry || !Array.isArray(entry.predicates)) return;
  const box = root.querySelector("#cleaner-filter-rows");
  if (!box) return;
  box.innerHTML = "";
  for (const p of entry.predicates) {
    _appendFilterRow(root);
    const row = box.lastElementChild;
    if (!row) continue;
    const colSel = row.querySelector("[data-fb-col]");
    const opSel  = row.querySelector("[data-fb-op]");
    if (colSel) colSel.value = p.column;
    if (opSel)  opSel.value  = p.op;
    // Op may change the value-input shape — fire the change handler
    // before writing the value so the (potentially-newly-typed) input
    // accepts it.
    if (opSel) window._cleanerFilterRowChanged?.(opSel);
    const valEl = row.querySelector("[data-fb-val]");
    if (valEl && p.value != null) {
      valEl.value = Array.isArray(p.value) ? p.value.join(", ") : String(p.value);
    }
  }
  // Combinator pill
  const combo = String(entry.combinator ?? "and").toLowerCase();
  root.querySelectorAll("#cleaner-fb-combo button").forEach((b) => {
    b.classList.toggle("is-active", b.dataset.combo === combo);
  });
  _refreshFilterApplyState(root);
}

// One handler covers all three controls on a predicate row. Re-shapes
// the value input (text → number → date → hidden) when the op changes,
// then re-evaluates whether Apply should be enabled.
window._cleanerFilterRowChanged = (el) => {
  const row = el.closest(".rp-rt-fb-row");
  if (!row) return;
  const op  = row.querySelector("[data-fb-op]")?.value;
  const inp = row.querySelector("[data-fb-val]");
  if (op && inp) {
    if (op === "is_null" || op === "not_null") {
      row.classList.add("rp-rt-fb-no-value");
    } else {
      row.classList.remove("rp-rt-fb-no-value");
      // Switch the input type to match the op so the user gets the
      // right keyboard / picker. between/in keep `text` so the user
      // can type a comma-list.
      const dateOp    = op === "before" || op === "after";
      const numericOp = ["gt", "gte", "lt", "lte"].includes(op);
      inp.type = dateOp ? "date" : numericOp ? "number" : "text";
      inp.placeholder = (op === "between") ? "10, 50"
                      : (op === "in" || op === "not_in") ? "France, Italy"
                      : "value";
    }
  }
  _refreshFilterApplyState(document);
};

window._cleanerFilterRowRemove = (btn) => {
  const row = btn.closest(".rp-rt-fb-row");
  row?.remove();
  _refreshFilterApplyState(document);
};

// Apply enabled when at least one row has a column + op + valid value
// (or is one of the value-less ops). Avoids the "click apply, get
// nothing happened" UX of letting the button fire on an empty form.
function _refreshFilterApplyState(scope) {
  const apply = scope.querySelector("#cleaner-filter-apply");
  if (!apply) return;
  const rows = scope.querySelectorAll("#cleaner-filter-rows .rp-rt-fb-row");
  let ok = false;
  for (const r of rows) {
    const op  = r.querySelector("[data-fb-op]")?.value;
    if (!op) continue;
    if (op === "is_null" || op === "not_null") { ok = true; break; }
    const val = r.querySelector("[data-fb-val]")?.value ?? "";
    if (val.trim() !== "") { ok = true; break; }
  }
  apply.disabled = !ok;
}

// ── Selection chip + bulk-delete button visibility ──────────────────
// Two surfaces react to selected-count > 0:
//   • the chip itself (`#cleaner-sel-chip`) shows N selected
//   • the red trash button next to it shows up
// The CSS pin (`.rp-rt-mode-select .rp-rt-sel-chip[data-has-sel="1"]`)
// also gates on the panel being in select-mode, so leaving select-mode
// hides both even if the Set wasn't yet cleared.
function _renderSelectionChip(root) {
  const chip = root.querySelector("#cleaner-sel-chip");
  const cnt  = root.querySelector("#cleaner-sel-count");
  const del  = root.querySelector("#cleaner-bulk-del-btn");
  const n    = STATE.selected.size;
  if (chip) chip.dataset.hasSel = n > 0 ? "1" : "0";
  if (cnt)  cnt.textContent = `${n} selected`;
  if (del)  del.style.display = n > 0 ? "inline-flex" : "none";
  // Sync the master checkbox (indeterminate when partial).
  const head = root.querySelector("#cleaner-sel-all");
  const total = root.querySelectorAll("tbody .rp-rt-row-chk").length;
  if (head) {
    head.checked       = total > 0 && n === total;
    head.indeterminate = n > 0 && n < total;
  }
}

// ── Utilities ────────────────────────────────────────────────────────
function _escHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (ch) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]
  ));
}
function _escAttr(s) { return _escHtml(s); }

// ── Phase 3 wiring — sandbox markup ↔ real backend ──────────────────
// Active when the prerelease shell (/partials/cleaner.html → data-include
// tree under /partials/cleaner/) is on screen. Mirrors the live cleaner's
// multi-project tab model: each tab is one "opened project" from the
// user's prefs.cleaner_open_projects list, hydrated with labels from
// /api/projects. Landing via the URL always adds the target project to
// the open list if it's missing.
//
// Click on a tab → location.hash = "#/cleaner?project=PRJ_…" → router
// re-mounts cleaner with the new active. Heavier than a state-only
// switch (re-fetches partial + re-runs rpInclude) but matches the
// hash-router model; a state-only switcher lands later.
//
// Roadmap (TODO list below the function body):
//   • Once active project is known: fetch /projects/:rid/files, populate
//     the file-tabs strip with one tab per file.
//   • When ?file=FIL_… is set, fetch /files/:rid + /files/:rid/page and
//     paint the redtable body.
//   • Wire toolbar mode triplet + selection chip to STATE.
//   • Bridge the sandbox filter panel to live's filters/panel.js engine.
//   • Bridge each sandbox tool modal to its scripts/cleaner/tools/* dispatcher.
async function mountSandbox(root, ctx, strip) {
  // Drop sandbox demo data FIRST — before any awaits or early returns.
  // The sandbox cleaner partials ship hardcoded "sentinel" / "Clients
  // Clean" project tabs (and similar file tabs / header chrome / table
  // rows) so the standalone mockup looks alive. On the real backend
  // those tabs are misleading, so we strip them on every mount. Real
  // tabs land below after the API fetch resolves.
  strip.querySelectorAll(".rp-rt-proj-tab").forEach((t) => t.remove());

  // Restore the global "file tabs I've closed" set from server prefs.
  // The legacy mount() does this around line 178 — sandbox mount must
  // do it too, otherwise STATE.hiddenFiles starts empty on every
  // refresh and previously-closed file tabs come back as visible.
  // File rids are globally unique, so a single flat Set suffices —
  // a hidden rid from project A won't accidentally match in project B.
  const savedHidden = ctx?.session?.prefs?.cleaner_hidden_files;
  STATE.hiddenFiles = new Set(Array.isArray(savedHidden) ? savedHidden : []);

  // Restore the toolbar / saved-filter prefs the legacy mount() loads
  // around lines 59–74. Without these, the saved-settings modal reads
  // STATE.savedFilters as undefined → defensive guard falls back to {}
  // → every file row shows "No saved filters" even when the user has
  // some saved in their account. Same for filePrefs, linkToolbar, etc.
  // — they all source from ctx.session.prefs (server-cached at login,
  // see project_redpash_file_metadata_cache.md). filePrefs is a Map
  // populated per-file by the (legacy, not yet ported) _loadFilePrefs;
  // init it empty here so the per-file accumulation has a place to land.
  STATE.linkToolbar   = ctx?.session?.prefs?.cleaner_link_toolbar  === true;
  STATE.showRowNums   = ctx?.session?.prefs?.cleaner_show_row_nums === true;
  STATE.showOpenLinks = ctx?.session?.prefs?.cleaner_show_open_links !== false;
  const sf = ctx?.session?.prefs?.cleaner_saved_filters;
  STATE.savedFilters  = (sf && typeof sf === "object" && !Array.isArray(sf))
    ? { ...sf }
    : {};
  if (!(STATE.filePrefs instanceof Map)) STATE.filePrefs = new Map();
  // Page size + cursor — _paintSandboxTable reads STATE.pageSize / STATE.page
  // when building the /page request. Pref is a global default; per-file
  // override piggybacks on filePrefs later. Cursor always resets to 1
  // on tab switch (paint redoes the URL from STATE.page).
  const savedPageSize = Number(ctx?.session?.prefs?.cleaner_page_size);
  STATE.pageSize = savedPageSize > 0 ? savedPageSize : _OV_DEFAULT_PAGE_SIZE;
  STATE.page = 1;
  // Row selection (global row indices). Cleared on every paint —
  // pagination / step apply / refresh all reset selection by design
  // (legacy did the same; absolute indices would point at the wrong
  // rows after a drop / shift anyway).
  STATE.selected = new Set();

  // Install window.cleaner* handlers BEFORE any tab onclick can fire.
  // The legacy mount() defines them deep in its body (line ~1455), but
  // mountSandbox returns before that block — so without this call the
  // composite onclicks (spActivateTab(this);cleanerActivateTab('FID')
  // etc.) throw "cleanerActivateTab is not defined" on the first click.
  _installSandboxLiveHandlers(root);

  const q          = new URLSearchParams(location.hash.split("?")[1] ?? "");
  const projectRid = q.get("project");
  const fileRid    = q.get("file");

  if (!projectRid && !fileRid) {
    toast.error("Cleaner needs ?project=PRJ_… or ?file=FIL_… in the URL");
    return;
  }

  // Resolve the active project id — prefer the URL's ?project, else
  // derive from the file's project_redpash_id.
  let activePid = projectRid;
  if (!activePid && fileRid) {
    try {
      const detail = await api.get(`/files/${encodeURIComponent(fileRid)}`);
      activePid = detail.summary?.project_redpash_id ?? null;
    } catch (err) {
      console.error("[cleaner] /files/:rid fetch failed", err);
      toast.error("Failed to load file");
      return;
    }
  }
  if (!activePid) {
    toast.error("Could not resolve project from URL");
    return;
  }

  // Hydrate the user's project list (for tab labels + membership check).
  let projects = [];
  try {
    const res = await api.get("/projects");
    projects = res.items ?? [];
  } catch (err) {
    console.error("[cleaner] /projects fetch failed", err);
    toast.error("Failed to load projects");
    return;
  }

  const projectsByPid = new Map(projects.map((p) => [p.redpash_id, p]));
  if (!projectsByPid.has(activePid)) {
    toast.error(`Project not found: ${activePid}`);
    return;
  }

  // Merge saved open-tabs pref with the active project. The URL always
  // wins — direct nav to a project should open it as a tab if it
  // wasn't already, since the user is by definition working there now.
  const savedOpen = ctx?.session?.prefs?.cleaner_open_projects;
  let openList = Array.isArray(savedOpen)
    ? savedOpen.filter((pid) => projectsByPid.has(pid))
    : [];
  if (!openList.includes(activePid)) openList.push(activePid);
  if (!openList.length) openList = [activePid];

  // Persist if the open list grew or pruned. Fire-and-forget — pref
  // failures shouldn't block the render.
  const prevJson = JSON.stringify(savedOpen ?? []);
  const nextJson = JSON.stringify(openList);
  if (prevJson !== nextJson && typeof window.rpSavePref === "function") {
    window.rpSavePref("cleaner_open_projects", openList);
  }

  // Mirror the locals into STATE so the window.cleaner* handlers
  // (installed above by _installSandboxLiveHandlers) can read the
  // right values. Without this, cleanerCloseProject sees an empty
  // openProjects and bails (length <= 1 guard), spOpenFilePicker
  // sees an empty STATE.files and the picker renders blank, etc.
  STATE.openProjects    = openList;
  STATE.activeProjectId = activePid;
  if (!(STATE.projectMeta instanceof Map)) STATE.projectMeta = new Map();
  for (const [pid, p] of projectsByPid.entries()) STATE.projectMeta.set(pid, p);

  _renderSandboxProjectTabs(strip, projectsByPid, openList, activePid);
  _populateOpenProjectPicker(root, projects, openList);

  // ── Files for the active project ────────────────────────────────
  // Fetch files, decide active file (URL ?file= wins; else first file).
  let files = [];
  try {
    const res = await api.get(`/projects/${encodeURIComponent(activePid)}/files`);
    files = res.items ?? [];
  } catch (err) {
    console.error("[cleaner] /projects/:rid/files fetch failed", err);
    toast.error("Failed to load files");
    return;
  }

  let activeFile = null;
  if (fileRid) {
    activeFile = files.find((f) => f.redpash_id === fileRid) ?? null;
    if (!activeFile) {
      toast.error(`File not found in this project: ${fileRid}`);
    }
  }
  if (!activeFile && files.length) activeFile = files[0];

  const activeProj = projectsByPid.get(activePid);
  // Mirror file slice into STATE for the handlers + spOpenFilePicker.
  STATE.files   = files;
  STATE.project = activeProj;
  STATE.rid     = activeFile?.redpash_id ?? null;

  _renderSandboxHeader(root, activeProj, activeFile, files);
  _renderSandboxFileTabs(root, files, activeFile);

  if (activeFile) {
    await _paintSandboxTable(root, activeFile);
  } else {
    // No file in the project (or URL is project-only) — land on the
    // Overview pane with the project's file list painted, even when
    // the list is empty (the painter emits a friendly empty state).
    _showSandboxOverview(root);
    _paintSandboxOverview(root);
  }

  // Sync undo / redo button enabled state from the freshly-loaded
  // STATE.steps (populated by _paintSandboxTable's detail fetch).
  // Without this the buttons sit at their HTML `disabled` default
  // even when there's history to undo on first paint.
  _installSandboxLiveHandlers._syncUndoRedoButtons?.();
}

// Install window.cleaner* handlers used by the sandbox tab onclicks.
// The legacy mount() defines these deep in its body (line ~1455) but
// mountSandbox returns before that block runs — so without installing
// equivalents here, the composite onclicks emitted by the sandbox
// renderers throw "cleanerActivateTab is not defined" on first click.
//
// Behaviour mirrors the legacy versions (STATE + persistence + sandbox
// re-paint), minus the legacy `_renderTabs(root)` / `_renderProjectTabs
// (root)` calls — those write into #cleaner-tabs-list / #cleaner-proj-
// tabs-list which only exist in the historical cleaner.live.html
// markup. The sandbox strip is repainted via spActivateTab (visual
// flip), spDeleteTab (animated remove), spAddProjectTab / spAddFileTab
// (animated add) — those run alongside via the composite onclick.
function _installSandboxLiveHandlers(root) {
  const _persistHidden = () => {
    window.rpSavePref?.("cleaner_hidden_files", [...STATE.hiddenFiles]);
  };

  // Sync [data-sp-undo] / [data-sp-redo] disabled state from STATE.steps.
  // Backend's ProjectStep.applied tells us whether each step is in the
  // active cursor (true) or undone-and-waiting-to-redo (false). Used by
  // mountSandbox on first paint AND after every history mutation
  // (undo / redo / tool apply) so the buttons never read stale.
  const _syncUndoRedoButtons = () => {
    const steps   = Array.isArray(STATE.steps) ? STATE.steps : [];
    const applied = steps.filter((s) => s.applied === true).length;
    const undone  = steps.filter((s) => s.applied === false).length;
    root.querySelectorAll("[data-sp-undo]").forEach((b) => { b.disabled = applied === 0; });
    root.querySelectorAll("[data-sp-redo]").forEach((b) => { b.disabled = undone  === 0; });
  };
  _installSandboxLiveHandlers._syncUndoRedoButtons = _syncUndoRedoButtons;

  // Sandbox-aware post-history refresh — sibling of the legacy
  // _afterHistory inside mount(), tuned for the sandbox DOM. Backend
  // POSTs to /undo / /redo / each tool's endpoint return the same
  // FileEnvelope: { summary, columns, steps }. We mirror those into
  // STATE, sync the active file's strip entry so its cleanness dot
  // moves, then re-paint header / file-tabs / table / undo-redo
  // state. No legacy _renderTabs(root) / _renderHistoryButtons(root)
  // — those target dead DOM ids in sandbox mode.
  const _afterHistory = async (envelope, label) => {
    if (!envelope) return;
    STATE.summary = envelope.summary;
    STATE.columns = envelope.columns ?? [];
    STATE.steps   = envelope.steps   ?? [];
    if (Array.isArray(STATE.files) && envelope.summary) {
      const idx = STATE.files.findIndex((f) => f.redpash_id === STATE.rid);
      if (idx >= 0) STATE.files[idx] = envelope.summary;
    }
    const activeFile = (STATE.files || []).find((f) => f.redpash_id === STATE.rid) ?? null;
    const proj       = STATE.project ?? (STATE.projectMeta?.get(STATE.activeProjectId));
    if (typeof _renderSandboxHeader === "function") {
      _renderSandboxHeader(root, proj, activeFile, STATE.files || []);
    }
    if (typeof _renderSandboxFileTabs === "function") {
      _renderSandboxFileTabs(root, STATE.files || [], activeFile);
    }
    if (activeFile && typeof _paintSandboxTable === "function") {
      await _paintSandboxTable(root, activeFile);
    }
    _syncUndoRedoButtons();
    if (label && window.toast?.success) window.toast.success(label);
  };

  // Undo / Redo / Save — POST to backend, hand the FileEnvelope to
  // _afterHistory. No-op when no file is active (button is disabled
  // by _syncUndoRedoButtons in that case, but guard anyway in case
  // someone calls from the console).
  window.cleanerUndo = async () => {
    if (!STATE.rid) return;
    try {
      const env = await api.post(`/files/${encodeURIComponent(STATE.rid)}/undo`, {});
      await _afterHistory(env, "Undone");
    } catch (err) {
      toast.error(`Undo failed: ${err.body?.error ?? err.message}`);
    }
  };
  window.cleanerRedo = async () => {
    if (!STATE.rid) return;
    try {
      const env = await api.post(`/files/${encodeURIComponent(STATE.rid)}/redo`, {});
      await _afterHistory(env, "Redone");
    } catch (err) {
      toast.error(`Redo failed: ${err.body?.error ?? err.message}`);
    }
  };

  // + Add file — opens the new-project rp-modal with the active project's
  // name pre-filled + locked. spOpenNewProjectModal handles the reset
  // + drop-zone bind. Wrapper exists because inline onclick can only
  // see window-scoped values — STATE is module-scoped in cleaner.js.
  window.cleanerAddFile = () => {
    const name = STATE?.project?.name || "";
    window.spOpenNewProjectModal?.(name);
  };

  // Export — GET /:rid/export streams the current view (post step-replay)
  // as CSV. fetch-as-blob (not navigation) so failures surface as a
  // toast and the session cookie rides along via credentials:"include".
  // Server-suggested filename comes from Content-Disposition; falls back
  // to the in-memory summary name when the header is missing.
  window.cleanerExport = async () => {
    if (!STATE.rid) { toast.error("Open a file first."); return; }
    const btn = root.querySelector("[data-cleaner-export]");
    btn?.classList.add("is-spinning");
    try {
      const res = await fetch(
        `/api/files/${encodeURIComponent(STATE.rid)}/export`,
        { credentials: "include" },
      );
      if (!res.ok) {
        let msg = `HTTP ${res.status}`;
        try { msg = (await res.json()).error ?? msg; } catch {}
        throw new Error(msg);
      }
      const cd = res.headers.get("Content-Disposition") ?? "";
      const m  = /filename="?([^"]+)"?/.exec(cd);
      const stem = (STATE.summary?.display_name ?? STATE.summary?.filename ?? "export")
        .replace(/\.csv$/i, "");
      const name = m?.[1] ?? `${stem}.csv`;

      const blob = await res.blob();
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement("a");
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast.success(`Exported ${name}`);
    } catch (err) {
      toast.error(`Export failed: ${err.message ?? err}`);
    } finally {
      btn?.classList.remove("is-spinning");
    }
  };

  // Saved-settings rp-modal — read-only per-open-file inspector. One
  // row per file in STATE.files (visible OR hidden); .is-active on the
  // row matching STATE.rid. Filters group reads STATE.savedFilters[rid]
  // (array of named filter envelopes); empty → "No saved filters"
  // placeholder. Toolbar group surfaces per-file prefs from
  // STATE.filePrefs (Map keyed by rid) — page size, search query,
  // sort chain — falling back to the linked / default values when a
  // file has no per-tab snapshot yet.
  window.cleanerOpenSavedSettings = () => {
    const host = root.querySelector("[data-cleaner-saved-settings]");
    if (host) {
      const files = Array.isArray(STATE.files) ? STATE.files : [];
      if (!files.length) {
        host.innerHTML =
          '<div class="rp-form-meta" style="padding:1rem;text-align:center;font-style:italic">'
          + 'No open files in this project.'
          + '</div>';
      } else {
        const savedFilters = (STATE.savedFilters && typeof STATE.savedFilters === "object")
          ? STATE.savedFilters : {};
        const filePrefs = STATE.filePrefs instanceof Map ? STATE.filePrefs : new Map();
        host.innerHTML = files.map((f) => {
          const rid    = f.redpash_id;
          const name   = f.display_name || f.filename || rid;
          const active = rid === STATE.rid;

          // Filters group — one chip per saved filter name, else default.
          const savedList = Array.isArray(savedFilters[rid]) ? savedFilters[rid] : [];
          const filterChips = savedList.length
            ? savedList.map((sf) =>
                `<span class="rp-view-chip">${_escHtml(sf.name || "(unnamed)")}</span>`
              ).join("")
            : '<span class="rp-view-default">No saved filters</span>';

          // Toolbar group — page size + search + sort count from this
          // file's snapshot (or live STATE if it's the active file).
          const prefs    = filePrefs.get(rid) || {};
          const pageSize = active ? (STATE.pageSize ?? prefs.pageSize)
                                  : (prefs.pageSize ?? "—");
          const q        = active ? (STATE.q ?? prefs.q ?? "") : (prefs.q ?? "");
          const sorts    = active ? (STATE.sorts ?? prefs.sorts ?? [])
                                  : (prefs.sorts ?? []);
          const toolbarChips = [
            `<span class="rp-view-chip">${_escHtml(String(pageSize))} rows</span>`,
            q
              ? `<span class="rp-view-chip">search: ${_escHtml(q)}</span>`
              : "",
            Array.isArray(sorts) && sorts.length
              ? `<span class="rp-view-chip">${sorts.length} sort${sorts.length === 1 ? "" : "s"}</span>`
              : "",
          ].filter(Boolean).join("");

          return `
            <div class="rp-view-row${active ? " is-active" : ""}">
              <i class="rp-view-icon bi bi-file-earmark-text"></i>
              <div class="rp-view-body">
                <div class="rp-view-name">${_escHtml(name)}${active ? ' <span class="rp-view-active">Active</span>' : ""}</div>
                <div class="rp-view-group">
                  <span class="rp-view-lbl">Filters:</span> ${filterChips}
                </div>
                <div class="rp-view-group">
                  <span class="rp-view-lbl">Toolbar:</span> ${toolbarChips}
                </div>
              </div>
            </div>`;
        }).join("");
      }
    }
    if (typeof window.openModal === "function") window.openModal("saved-settings");
  };

  // History rp-modal — paint the list from STATE.steps (newest first)
  // and open. Backend ProjectStep shape: { id, op_kind, params, applied,
  // created_at, … }. Local-cache vs backend-fetched split (.rp-hist-local
  // marker) lands in a later pass — for now the modal just dumps the
  // step history we already have in memory from the last /files/:rid
  // fetch. Revert / Undo-all-local buttons are still inert; clicking
  // them is a no-op pending the backend reverse-action endpoint.
  window.cleanerOpenHistory = () => {
    const host = root.querySelector("[data-cleaner-history-list]");
    if (host) {
      const steps = Array.isArray(STATE.steps) ? STATE.steps : [];
      if (!steps.length) {
        host.innerHTML =
          '<div class="rp-form-meta" style="padding:1rem;text-align:center;font-style:italic">'
          + 'No actions yet on this file.'
          + '</div>';
      } else {
        // Newest first — backend returns chronological order; reverse
        // for display so the most recent action is at the top.
        const ordered = [...steps].reverse();
        host.innerHTML = ordered.map((s) => {
          const ts = s.created_at
            ? new Date(s.created_at).toLocaleString()
            : "—";
          const op = s.op_kind || s.kind || "action";
          // params is usually an object; stringify briefly for the demo.
          let detail = "";
          if (s.params && typeof s.params === "object") {
            try {
              detail = Object.entries(s.params)
                .filter(([, v]) => v != null && v !== "")
                .slice(0, 4)
                .map(([k, v]) =>
                  `${k}=${typeof v === "object" ? JSON.stringify(v) : String(v)}`)
                .join(" · ");
            } catch { detail = ""; }
          }
          const dim = s.applied === false ? ' style="opacity:0.5"' : "";
          const tag = s.applied === false
            ? ' <span style="opacity:0.6;font-style:italic">(undone)</span>'
            : "";
          return `
            <div class="rp-hist-row"${dim}>
              <i class="bi bi-magic rp-hist-ico"></i>
              <div class="rp-hist-body">
                <div class="rp-hist-action">${_escHtml(op)}${tag}</div>
                <div class="rp-hist-detail">${_escHtml(detail)}</div>
              </div>
              <div class="rp-hist-when">${_escHtml(ts)}</div>
            </div>`;
        }).join("");
      }
    }
    if (typeof window.openModal === "function") window.openModal("history");
  };

  // Reactive picker re-populates. Called after every hidden / open
  // mutation so a modal already on screen reflects the change without
  // a re-fetch round-trip — the picker grids are built from in-memory
  // STATE.files / STATE.projectMeta which are guaranteed fresh after
  // mountSandbox. Client-first UX: no spinner, no API hit, picker
  // updates same tick as the strip.
  const _refilePicker = () => {
    if (typeof _populateOpenFilePicker !== "function") return;
    _populateOpenFilePicker(root, STATE.files || [], STATE.hiddenFiles || new Set());
  };
  const _reprojPicker = () => {
    if (typeof _populateOpenProjectPicker !== "function") return;
    const projects = STATE.projectMeta instanceof Map
      ? [...STATE.projectMeta.values()]
      : [];
    _populateOpenProjectPicker(root, projects, STATE.openProjects || []);
  };

  // × on a file tab — hide it from the strip (file stays in the project).
  // If the hidden tab was active, switch to the next visible file (or
  // Overview if no visible files remain).
  window.cleanerHideFileTab = (fid) => {
    if (!fid) return;
    if (!(STATE.hiddenFiles instanceof Set)) STATE.hiddenFiles = new Set();
    STATE.hiddenFiles.add(fid);
    _persistHidden();
    _refilePicker();
    if (STATE.rid === fid) {
      const nextVisible = (STATE.files || []).find((f) =>
        f.redpash_id !== fid && !STATE.hiddenFiles.has(f.redpash_id));
      const target = nextVisible?.redpash_id ?? "";
      window.cleanerActivateTab?.(target);
    }
  };

  // Picker card → un-hide a closed file. spAddFileTab handles the
  // animated insertion in the sandbox strip; this handler just owns
  // the STATE + pref update.
  window.cleanerShowFileTab = (fid) => {
    if (!fid) return;
    if (!(STATE.hiddenFiles instanceof Set)) STATE.hiddenFiles = new Set();
    STATE.hiddenFiles.delete(fid);
    _persistHidden();
    _refilePicker();
  };

  // Click a project tab — restore its snapshot if cached, else fetch
  // fresh; update URL via replaceState (NOT a hash change — that would
  // re-trigger the router and re-mount). spActivateTab on the tab DOM
  // (fired by composite onclick) handles the .active flip.
  window.cleanerSwitchProject = async (pid) => {
    if (!pid || pid === STATE.activeProjectId) return;
    if (STATE.activeProjectId) _saveProjectSnapshot(STATE.activeProjectId);
    STATE.activeProjectId = pid;
    try {
      history.replaceState(null, "", `#/cleaner?project=${encodeURIComponent(pid)}`);
    } catch {}

    // Try the in-memory snapshot first (sync). When there's no
    // snapshot we fall through to _fetchProjectFresh — that's the
    // path the user feels as "slow". Snappy fix: between setting
    // STATE.activeProjectId and awaiting the fetch, flip the
    // header to the new project IMMEDIATELY from cached projectMeta
    // (loaded by mountSandbox's /projects fetch — has name, stage,
    // file_count, cleanness_pct) and wipe the file-tab strip + table
    // so the OLD project's contents don't linger. The correction
    // pass below then fills in real data once the fetch resolves.
    const hadSnapshot = _loadProjectSnapshot(pid);
    if (!hadSnapshot) {
      const cachedProj = STATE.projectMeta?.get(pid) ?? null;
      if (cachedProj && typeof _renderSandboxHeader === "function") {
        // files=null → header reads file_count from cachedProj for
        // the "N files" meta line (vs files=[] which would render "0 files").
        _renderSandboxHeader(root, cachedProj, null, null);
      }
      if (typeof _renderSandboxFileTabs === "function") {
        _renderSandboxFileTabs(root, [], null);
      }
      const tableHost = root.querySelector("[data-cleaner-table]");
      if (tableHost) {
        tableHost.innerHTML = '<div class="rp-form-meta" style="padding:1rem;font-style:italic">Loading…</div>';
      }
      await _fetchProjectFresh(pid, { fileRid: null });
    }

    // Correction pass — paint from STATE (now hydrated either by
    // snapshot restore or fresh fetch). Sandbox project-tab strip is
    // NOT repainted here — spActivateTab already flipped .active,
    // and a full repaint would wipe in-flight .is-entering animations
    // from picker-driven spAddProjectTab.
    const activeProj = (STATE.projectMeta && STATE.projectMeta.get(pid)) || STATE.project;
    const files = STATE.files || [];
    const activeFile = STATE.rid ? files.find((f) => f.redpash_id === STATE.rid) || null : null;
    if (typeof _renderSandboxHeader === "function") {
      _renderSandboxHeader(root, activeProj, activeFile, files);
    }
    if (typeof _renderSandboxFileTabs === "function") {
      _renderSandboxFileTabs(root, files, activeFile);
    }
    if (activeFile) {
      _showSandboxTable(root);
      await _paintSandboxTable(root, activeFile);
    } else {
      // New project has no active file (snapshot was overview-only, or
      // fresh fetch with no fileRid). Land on overview so the body
      // isn't showing stale content from the previous project.
      _showSandboxOverview(root);
      _paintSandboxOverview(root);
    }
  };

  // Picker card → open another project. Push onto openProjects + persist,
  // then switch to it. No-op if already open.
  window.cleanerOpenProject = async (pid) => {
    if (!pid) return;
    if (!Array.isArray(STATE.openProjects)) STATE.openProjects = [];
    if (!STATE.openProjects.includes(pid)) {
      STATE.openProjects.push(pid);
      window.rpSavePref?.("cleaner_open_projects", STATE.openProjects);
    }
    _reprojPicker();
    if (pid !== STATE.activeProjectId) {
      await window.cleanerSwitchProject(pid);
    }
  };

  // × on a project tab — drop from openProjects + persist. Refuses to
  // close the only remaining tab (would orphan the page). If the closed
  // tab was active, switch to a neighbour.
  window.cleanerCloseProject = async (pid) => {
    if (!pid) return;
    if (!Array.isArray(STATE.openProjects) || STATE.openProjects.length <= 1) return;
    const i = STATE.openProjects.indexOf(pid);
    if (i < 0) return;
    STATE.openProjects.splice(i, 1);
    if (STATE.projectSnapshots) STATE.projectSnapshots.delete(pid);
    window.rpSavePref?.("cleaner_open_projects", STATE.openProjects);
    _reprojPicker();
    if (pid === STATE.activeProjectId) {
      const next = STATE.openProjects[i] ?? STATE.openProjects[i - 1];
      STATE.activeProjectId = null;
      if (next) await window.cleanerSwitchProject(next);
    }
  };

  // Click a file tab — paint chrome from the cached STATE.files entry
  // instantly (snappy feel), then _paintSandboxTable fetches /files/:rid
  // + /page in parallel and mirrors the fresh summary back. Header gets
  // a SECOND paint after the fetch so any post-cache cleanness drift
  // (e.g. a score recompute that ran between mount and tab-switch)
  // corrects in the same tick. URL via replaceState so the router
  // doesn't re-mount. Auto-unhides the file if it was previously
  // × -closed (explicit activate intent overrides the hidden flag).
  //
  // Previously this also fetched /files/:rid for STATE.summary +
  // .columns + .steps — but _paintSandboxTable does that fetch ANYWAY
  // (it needs detail for columns_meta), and mirrors the same fields
  // into STATE. The duplicate round-trip is gone; header now updates
  // synchronously from cache for the snappy feel.
  window.cleanerActivateTab = async (fid) => {
    const proj = STATE.project ?? STATE.projectMeta?.get(STATE.activeProjectId);
    if (!fid) {
      // Overview — no active file; clear the file-specific slice and
      // re-paint the chrome that depends on it. Header flips from
      // "File cleanness" to "Project cleanness" via _renderSandboxHeader's
      // null-activeFile branch. Body swaps: [data-cleaner-table] hides,
      // [data-cleaner-overview] shows + gets painted with the file list.
      try {
        history.replaceState(null, "", `#/cleaner?project=${encodeURIComponent(STATE.project?.redpash_id ?? STATE.activeProjectId ?? "")}`);
      } catch {}
      STATE.rid = null;
      STATE.summary = null;
      STATE.columns = [];
      STATE.steps = [];
      _showSandboxOverview(root);
      _paintSandboxOverview(root);
      if (typeof _renderSandboxHeader === "function") {
        _renderSandboxHeader(root, proj, null, STATE.files || []);
      }
      return;
    }
    if (fid === STATE.rid) return;
    if (STATE.hiddenFiles?.has(fid)) {
      STATE.hiddenFiles.delete(fid);
      _persistHidden();
    }
    try {
      history.replaceState(null, "", `#/cleaner?file=${encodeURIComponent(fid)}`);
    } catch {}
    STATE.rid = fid;
    // Coming from Overview → flip body back to the table side BEFORE
    // _paintSandboxTable runs (otherwise its "Loading…" placeholder
    // paints into a hidden host and the user sees an empty page).
    _showSandboxTable(root);
    // Instant paint from cached file summary (mountSandbox loaded
    // STATE.files from /api/projects/:rid/files, which carries
    // cleanness_pct). _paintSandboxTable's post-fetch header repaint
    // will overwrite with the fresh value a few hundred ms later.
    const activeFile = (STATE.files || []).find((f) => f.redpash_id === fid) ?? null;
    if (activeFile && typeof _renderSandboxHeader === "function") {
      _renderSandboxHeader(root, proj, activeFile, STATE.files || []);
    }
    if (activeFile) {
      await _paintSandboxTable(root, activeFile);
    }
  };

  // ── Toolbar wiring (file-view) ───────────────────────────────────
  // Live halves for the toolbar buttons. Each is paired with a sandbox
  // sp* handler in toolbar.html via the composite onclick pattern
  // (sandbox owns DOM affordance / animation, live owns STATE +
  // persistence + backend). See docs/frontend/sandbox-integration.md.

  // Refresh — re-fetch the active file's current page. Takes the
  // button so we can flag .is-spinning for the fetch duration; the
  // broadened .rp-btn.is-spinning .bi CSS rule animates infinitely
  // while the class is present. No-op on Overview (button is still
  // clickable but the refetch needs STATE.rid).
  //
  // 600ms minimum spin — refresh's two parallel fetches often finish
  // in <100ms when the data is small/cached, which reads as a flash
  // rather than "I clicked refresh". Promise.all with a sleep pads
  // the spin to a consistent floor without slowing slower fetches.
  // 600ms matches the sandbox spRefresh's original one-shot duration
  // for visual consistency with other toolbar feedback (spClean too).
  // Compute / clear cleanness don't need this — the POST/DELETE
  // round-trip naturally takes long enough.
  window.cleanerRefresh = async (btn) => {
    if (!STATE.rid) return;
    btn?.classList.add("is-spinning");
    try {
      const activeFile = (STATE.files || []).find((f) => f.redpash_id === STATE.rid) ?? null;
      const work = activeFile ? _paintSandboxTable(root, activeFile) : Promise.resolve();
      const minSpin = new Promise((r) => setTimeout(r, 600));
      await Promise.all([work, minSpin]);
    } finally {
      btn?.classList.remove("is-spinning");
    }
  };

  // Row-numbers toggle — sandbox flips `.is-hide-rownums` on the panel
  // via spToggleRowNums (CSS collapses the # gutter column). Live half
  // mirrors STATE.showRowNums + persists so the choice survives
  // refresh / re-mount.
  window.cleanerToggleRowNums = () => {
    STATE.showRowNums = !STATE.showRowNums;
    window.rpSavePref?.("cleaner_show_row_nums", STATE.showRowNums);
  };

  // Sync toolbar — sandbox flips `.is-sync-on` on the panel via
  // spToggleSync (CSS outlines synced fields). Live half persists
  // STATE.linkToolbar; the actual propagation across file tabs lands
  // when search + page-size wiring is migrated and snapshot-skip
  // logic is added.
  window.cleanerToggleSync = () => {
    STATE.linkToolbar = !STATE.linkToolbar;
    window.rpSavePref?.("cleaner_link_toolbar", STATE.linkToolbar);
  };

  // Open-links toggle — panel class gates the report/dashboard anchors
  // (cleaner-hide-open-links CSS rule). Live half persists the choice.
  // No sandbox half today; bound as a single live handler.
  window.cleanerToggleRowOpen = (btn) => {
    STATE.showOpenLinks = !STATE.showOpenLinks;
    if (btn) {
      btn.classList.toggle("is-active", STATE.showOpenLinks);
      btn.setAttribute("aria-pressed", STATE.showOpenLinks ? "true" : "false");
    }
    root.querySelector(".rp-rt-panel")?.classList.toggle("cleaner-hide-open-links", !STATE.showOpenLinks);
    window.rpSavePref?.("cleaner_show_open_links", STATE.showOpenLinks);
  };

  // Report / Dashboard anchors — preventDefault on the click, build
  // the hash with the current file / project, open in a new tab.
  // anchor_links_new_tab.md memory: every <a href> defaults to a new
  // tab; window.open with "_blank" matches. Returns false to stop the
  // anchor's bare href from navigating the current tab too.
  window.cleanerOpenReportForFile = (ev) => {
    ev?.preventDefault?.();
    if (!STATE.rid) { window.toast?.info?.("Open a file first."); return false; }
    window.open(`#/reports?new=1&source=${encodeURIComponent(STATE.rid)}`, "_blank", "noopener");
    return false;
  };
  window.cleanerOpenDashboardForProject = (ev) => {
    ev?.preventDefault?.();
    const pid = STATE.project?.redpash_id ?? STATE.activeProjectId
              ?? STATE.summary?.project_redpash_id;
    if (!pid) { window.toast?.info?.("Couldn't resolve the project."); return false; }
    window.open(`#/dashboards?new=1&project=${encodeURIComponent(pid)}`, "_blank", "noopener");
    return false;
  };

  // Compute / clear cleanness — POST + DELETE /files/:rid/cleanness,
  // both return the updated summary. Wrap into a synthetic envelope
  // (keeps STATE.columns / .steps untouched — cleanness is metadata,
  // not a data-frame mutation) and pipe through _afterHistory so the
  // header widget + file-tab data-cleanness pick up the new pct in the
  // same paint pass.
  window.cleanerScoreFile = async (btn) => {
    if (!STATE.rid) { window.toast?.info?.("Open a file first."); return; }
    btn?.classList.add("is-spinning");
    btn && (btn.disabled = true);
    try {
      const summary = await api.post(`/files/${encodeURIComponent(STATE.rid)}/cleanness`, {});
      await _afterHistory({ summary, columns: STATE.columns, steps: STATE.steps }, "Cleanness computed");
    } catch (err) {
      window.toast?.error?.(`Score failed: ${err.body?.error ?? err.message}`);
    } finally {
      btn?.classList.remove("is-spinning");
      btn && (btn.disabled = false);
    }
  };
  window.cleanerClearScore = async (btn) => {
    if (!STATE.rid) { window.toast?.info?.("Open a file first."); return; }
    btn?.classList.add("is-spinning");
    btn && (btn.disabled = true);
    try {
      const summary = await api.delete(`/files/${encodeURIComponent(STATE.rid)}/cleanness`);
      await _afterHistory({ summary, columns: STATE.columns, steps: STATE.steps }, "Cleanness cleared");
    } catch (err) {
      window.toast?.error?.(`Clear failed: ${err.body?.error ?? err.message}`);
    } finally {
      btn?.classList.remove("is-spinning");
      btn && (btn.disabled = false);
    }
  };

  // ── Row selection + bulk delete ──────────────────────────────────
  // STATE.selected is a Set of GLOBAL row indices (page-offset added
  // in _paintSandboxTable). Source of truth for the chip count and
  // the bulk-delete drop_rows payload. The DOM .rp-rt-row-sel class
  // is just visual; STATE.selected is what the backend POST reads.

  // Repaint the selection chip from STATE.selected.size. data-count=0
  // hides the chip via CSS (.rp-rt-sel-chip[data-count="0"] display:none);
  // any positive count + .is-mode-select on the panel shows it.
  const _renderSelChip = () => {
    const chip = root.querySelector(".rp-rt-sel-chip");
    if (!chip) return;
    const n = STATE.selected instanceof Set ? STATE.selected.size : 0;
    chip.setAttribute("data-count", String(n));
    chip.innerHTML = `<i class="bi bi-check2-square"></i> ${n} selected`;
    // Master header checkbox state — checked when ALL rows on the
    // current page are selected, indeterminate while some are.
    const headerCb = root.querySelector(".rp-rt-table thead .rp-rt-th-mode input[type='checkbox']");
    const rowCbs   = root.querySelectorAll(".rp-rt-table tbody .rp-rt-row-chk");
    if (headerCb && rowCbs.length) {
      headerCb.checked       = (n === rowCbs.length && rowCbs.length > 0);
      headerCb.indeterminate = (n > 0 && n < rowCbs.length);
    }
  };

  // Row checkbox click — toggles STATE.selected entry + the row's
  // .rp-rt-row-sel class (CSS uses it for the active-bg inversion +
  // the check2-circle icon swap). data-ri carries the GLOBAL row
  // index (set by _paintSandboxTable).
  // Delete-mode single-row click routing is NOT implemented on the
  // sandbox path. The sandbox first-cell overlaps a transparent
  // checkbox (z-index:1, full-cell click target) with decorative
  // uncheck/check/trash glyphs, so a click anywhere in the cell
  // toggles the checkbox below regardless of which icon is showing.
  // In delete mode that reads as "click row to select" instead of
  // "click row to drop", which is the same complaint live's
  // implementation had before the legacy _applyDropRows pipeline.
  //
  // Sandbox dispatch (spToggleRowSel) routes to spDeleteRow when
  // is-mode-delete is on the panel. The cleaner-page equivalent
  // is now wired here directly — we don't need to migrate the
  // legacy _applyDropRows / _absoluteIndex helpers because:
  //   1. cleanerMaybeBulkDelete already POSTs drop_rows + pipes
  //      the envelope through _afterHistory.
  //   2. _paintSandboxTable emits GLOBAL row indices on every data
  //      cell (data-row-idx, page-offset added), so single-row
  //      drop doesn't need _absoluteIndex's page-relative → global
  //      conversion.
  //
  // Wiring shape: _paintSandboxTable puts onclick="cleanerRowClick(this)"
  // on the <tr>. The mode-cell checkbox has NO onclick of its own —
  // native toggle bubbles up, cleanerRowClick re-syncs cb.checked to
  // match the new row state. One dispatcher, three modes:
  //   • delete mode: POST drop_rows for this row's global index;
  //     _afterHistory's repaint clears the now-stale row.
  //   • select mode: toggle .rp-rt-row-sel + STATE.selected + chip,
  //     force cb.checked to match.
  //   • edit / no mode: no-op (edit cells handle their own focusin).
  window.cleanerRowClick = async (row) => {
    if (!row) return;
    const panel = row.closest(".rp-rt-panel");
    if (!panel) return;

    if (panel.classList.contains("is-mode-delete")) {
      if (!STATE.rid) return;
      // Undo the native checkbox toggle that fires before the click
      // bubbles up — keeps the checkbox visually consistent for the
      // ~50-200ms between POST issue and _afterHistory repaint.
      const cb0 = row.querySelector(".rp-rt-row-chk");
      if (cb0) cb0.checked = false;
      // Any data cell on this row carries the global row index.
      const dataCell = row.querySelector("td[data-row-idx]");
      if (!dataCell) return;
      const ri = parseInt(dataCell.dataset.rowIdx, 10);
      if (!Number.isFinite(ri)) return;
      try {
        const env = await api.post(
          `/files/${encodeURIComponent(STATE.rid)}/steps`,
          { kind: "drop_rows", params: { indices: [ri] } },
        );
        await _afterHistory(env, "Row dropped");
      } catch (err) {
        window.toast?.error?.(`Drop failed: ${err.body?.error ?? err.message}`);
      }
      return;
    }

    if (!panel.classList.contains("is-mode-select")) return;

    // Select mode — toggle this row's selection. Computed from the
    // CURRENT class (not from cb.checked), so a row-click outside
    // the checkbox cell flips correctly. cb.checked is then forced
    // to match, overriding any native auto-toggle that happened
    // when the click target was the checkbox itself.
    const cb = row.querySelector(".rp-rt-row-chk");
    if (!cb) return;
    const ri = Number(cb.dataset.ri);
    if (!Number.isFinite(ri)) return;
    const willBe = !row.classList.contains("rp-rt-row-sel");
    row.classList.toggle("rp-rt-row-sel", willBe);
    cb.checked = willBe;
    if (!(STATE.selected instanceof Set)) STATE.selected = new Set();
    if (willBe) STATE.selected.add(ri);
    else        STATE.selected.delete(ri);
    _renderSelChip();
  };

  // Master checkbox in the table header — flips all visible-page row
  // checkboxes + STATE.selected to match. Page-scoped (not cross-page);
  // selection clears on pagination by design.
  window.cleanerSelectAllRows = (chk) => {
    if (!chk) return;
    const on = !!chk.checked;
    if (!(STATE.selected instanceof Set)) STATE.selected = new Set();
    STATE.selected.clear();
    root.querySelectorAll(".rp-rt-table tbody .rp-rt-row-chk").forEach((cb) => {
      cb.checked = on;
      cb.closest("tr")?.classList.toggle("rp-rt-row-sel", on);
      if (on) {
        const ri = Number(cb.dataset.ri);
        if (Number.isFinite(ri)) STATE.selected.add(ri);
      }
    });
    _renderSelChip();
  };

  // Bulk delete — POST a drop_rows step with the selected global
  // indices. Called from two places:
  //   1. The toolbar trash pill (delete-mode click with selection) —
  //      sandbox spSetMode animates the rows out in parallel.
  //   2. The in-table master trash (.rp-master-trash in header), only
  //      visible in delete mode.
  // No-op when there's no selection (the trash pill is also a plain
  // mode-flip in that case). STATE.selected is cleared optimistically
  // so the chip resets immediately; _afterHistory's repaint clears
  // again as a belt-and-braces.
  window.cleanerMaybeBulkDelete = async () => {
    if (!STATE.rid) return;
    const sel = STATE.selected;
    if (!(sel instanceof Set) || sel.size === 0) return;
    const indices = [...sel].map(Number).filter((n) => Number.isFinite(n));
    if (!indices.length) return;
    const n = indices.length;
    STATE.selected.clear();
    _renderSelChip();
    try {
      const env = await api.post(
        `/files/${encodeURIComponent(STATE.rid)}/steps`,
        { kind: "drop_rows", params: { indices } },
      );
      await _afterHistory(env, `Dropped ${n} row${n === 1 ? "" : "s"}`);
    } catch (err) {
      window.toast?.error?.(`Drop failed: ${err.body?.error ?? err.message}`);
    }
  };

  // Rows-per-page — drives _paintSandboxTable's /page request via
  // STATE.pageSize. Cursor resets to 1 since the old offset doesn't
  // map at a new size. Persisted as a global pref; per-file override
  // lands with filePrefs migration. spDdSelectRows (sandbox) flips
  // the DD's is-selected + writes the rows-label in parallel.
  window.cleanerSetPageSize = async (n) => {
    const size = Math.max(1, Math.min(Number(n) || _OV_DEFAULT_PAGE_SIZE, 5000));
    if (size === STATE.pageSize) return;
    STATE.pageSize = size;
    STATE.page = 1;
    window.rpSavePref?.("cleaner_page_size", size);
    if (STATE.rid) {
      const activeFile = (STATE.files || []).find((f) => f.redpash_id === STATE.rid) ?? null;
      if (activeFile) await _paintSandboxTable(root, activeFile);
    }
  };

  // Cell-edit dispatcher — POST a set_cell step on focusout of any
  // data cell whose textContent actually changed. Cells are marked
  // editable by controls.js's spSetMode when the edit-mode pill is
  // active (sets contenteditable="true" on every tbody td). The
  // dispatcher only acts on cells carrying [data-row-idx] +
  // [data-col-name] — those are emitted by _paintSandboxTable, so
  // file-name / project-name / column-header edits flow through
  // their own (legacy / future) rename paths instead.
  //
  // Own dataset key (rpCellPrev) — controls.js's focusout reads
  // and deletes el.dataset.spPrevText before bubbling to us, so we
  // can't piggyback on it. Same idea, separate slot.
  //
  // document-level listener installed once (guarded by the function
  // property) — mountSandbox runs on every hash change and would
  // otherwise stack listeners.
  if (!_installSandboxLiveHandlers._cellEditInstalled) {
    _installSandboxLiveHandlers._cellEditInstalled = true;

    const _isDataCell = (el) =>
      el && el.dataset
        && el.dataset.rowIdx != null
        && el.dataset.colName != null;

    document.addEventListener("focusin", (e) => {
      const el = e.target;
      if (!_isDataCell(el)) return;
      el.dataset.rpCellPrev = el.textContent;
    });

    document.addEventListener("focusout", async (e) => {
      const el = e.target;
      if (!_isDataCell(el))            return;
      if (el.dataset.rpCellPrev == null) return;
      const prev = el.dataset.rpCellPrev;
      delete el.dataset.rpCellPrev;
      const next = el.textContent;
      if (prev === next) return;
      if (!STATE.rid) {
        el.textContent = prev;
        return;
      }
      const row    = parseInt(el.dataset.rowIdx, 10);
      const column = el.dataset.colName;
      if (!Number.isFinite(row) || !column) {
        el.textContent = prev;
        return;
      }
      try {
        const env = await api.post(
          `/files/${encodeURIComponent(STATE.rid)}/steps`,
          { kind: "set_cell", params: { row, column, value: next } },
        );
        await _afterHistory(env, "Cell updated");
      } catch (err) {
        // Backend rejected (type cast failed, row out of range, etc).
        // Roll the cell back so the on-screen value matches the
        // server's authoritative state and surface why.
        el.textContent = prev;
        window.toast?.error(`Edit failed: ${err.body?.error ?? err.message}`);
      }
    });
  }
}

// Paint the project + file labels, the meta line, and the cleanness
// widget from the active project + active file. All fields fall back
// to "—" when missing so the user can tell what's not yet loaded.
// Body visibility toggles — sandbox has TWO .rp-rt-table-wrap siblings:
// [data-cleaner-table] (file CSV) and [data-cleaner-overview] (project
// summary). Overview.html ships hidden; table.html ships visible. The
// two helpers flip which one is on screen. The .rp-rt-pager (file paging
// footer) hides with the table since paging is per-file.
function _showSandboxOverview(root) {
  const tbl = root.querySelector("[data-cleaner-table]");
  const ov  = root.querySelector("[data-cleaner-overview]");
  const pgr = root.querySelector(".rp-rt-pager");
  if (tbl) tbl.hidden = true;
  if (ov)  ov.hidden  = false;
  if (pgr) pgr.hidden = true;
}
function _showSandboxTable(root) {
  const tbl = root.querySelector("[data-cleaner-table]");
  const ov  = root.querySelector("[data-cleaner-overview]");
  const pgr = root.querySelector(".rp-rt-pager");
  if (tbl) tbl.hidden = false;
  if (ov)  ov.hidden  = true;
  if (pgr) pgr.hidden = false;
}

// Paint the Overview pane — project-level file list (one row per file
// in STATE.files). V0: name · stage · rows · cleanness · modified;
// click a row to open that file as the active tab (composite: sandbox
// flip + live activate + fetch). Keeps the markup deliberately plain
// .rp-rt-table — overview-specific chrome (rp-rt-ov-*) lands as the
// page grows per the feedback_overview_separate_namespace memory.
//
// Empty state: project has no files yet → friendly placeholder pointing
// to the + add affordance. Hidden-file rows are still listed (they're
// part of the project, just closed as tabs); clicking unhides via
// cleanerActivateTab's auto-unhide path.
function _paintSandboxOverview(root) {
  const host = root.querySelector("[data-cleaner-overview]");
  if (!host) return;
  const files = STATE.files || [];
  if (!files.length) {
    host.innerHTML = ''
      + '<div class="rp-form-meta" style="padding:1.5rem;text-align:center;font-style:italic">'
      +   'No files in this project yet. Use <i class="bi bi-plus-lg"></i> to add one.'
      + '</div>';
    return;
  }
  const fmtDate = (s) => s ? new Date(s).toLocaleDateString() : "—";
  const rows = files.map((f) => {
    const rid       = _escAttr(f.redpash_id);
    const name      = _escHtml(f.display_name || f.filename || f.redpash_id);
    const stage     = _escHtml(f.stage || "—");
    const rowCount  = f.row_count != null ? f.row_count.toLocaleString() : "—";
    const cleanness = f.cleanness_pct != null ? `${Math.round(f.cleanness_pct)}%` : "—";
    const modified  = _escHtml(fmtDate(f.updated_at));
    // Row click → activate that file as the on-screen tab. Use the
    // sibling .rp-rtp-tab[data-file-id=…] for the sandbox visual flip,
    // then live cleanerActivateTab does fetch+paint (+ auto-unhide if
    // the user had × -closed this tab earlier).
    return ''
      + `<tr style="cursor:pointer" onclick="`
      +   `var t=document.querySelector('.rp-rtp-tab[data-file-id=&quot;${rid}&quot;]');`
      +   `if(t)spActivateTab(t);`
      +   `cleanerActivateTab('${rid}')`
      + `">`
      +   `<td>${name}</td>`
      +   `<td>${stage}</td>`
      +   `<td style="text-align:right">${rowCount}</td>`
      +   `<td style="text-align:right">${cleanness}</td>`
      +   `<td>${modified}</td>`
      + `</tr>`;
  }).join("");
  host.innerHTML = ''
    + '<table class="rp-rt-table">'
    +   '<thead><tr>'
    +     '<th>Name</th><th>Stage</th>'
    +     '<th style="text-align:right">Rows</th>'
    +     '<th style="text-align:right">Cleanness</th>'
    +     '<th>Modified</th>'
    +   '</tr></thead>'
    +   `<tbody>${rows}</tbody>`
    + '</table>';
}

function _renderSandboxHeader(root, proj, activeFile, files) {
  const txt = (sel, val) => {
    const el = root.querySelector(sel);
    if (el) el.textContent = (val == null || val === "") ? "—" : val;
  };
  txt("[data-cleaner-proj-name]", proj?.name);
  txt("[data-cleaner-file-name]",
      activeFile ? (activeFile.display_name || activeFile.filename) : null);

  // Meta line: "N files · stage: clean · last modified …"
  // Pass files=null when the project's file list hasn't been fetched
  // yet (cleanerSwitchProject snappy-paint path) — we still want the
  // count to read sensibly so it falls back to proj.file_count from
  // the cached projectMeta. files=[] is treated as authoritative "no
  // files", since that's a real post-fetch state.
  const meta = [];
  if (Array.isArray(files)) {
    meta.push(`${files.length} file${files.length === 1 ? "" : "s"}`);
  } else if (proj?.file_count != null) {
    meta.push(`${proj.file_count} file${proj.file_count === 1 ? "" : "s"}`);
  }
  if (proj?.stage) meta.push(`stage: ${proj.stage}`);
  if (proj?.status && proj.status !== "active") meta.push(proj.status);
  txt("[data-cleaner-proj-meta]", meta.join(" · "));

  // Cleanness widget — file-level if a file is active, project-level
  // otherwise. Project-level is the MEAN of the per-file cleanness
  // values computed client-side from STATE.files (via the `files`
  // arg). Why client-side: a file's cleanness_pct can change in the
  // same session (the user just hit Compute Cleanness / Clear); the
  // backend's proj.cleanness_pct may not have been recomputed since.
  // Mean from current STATE always matches what the user sees in the
  // overview file list. Width-driven fill (clamped 0–100).
  const pct = activeFile
    ? activeFile.cleanness_pct
    : _computeProjectMeanCleanness(files);
  txt("[data-cleaner-cleanness-lbl]",
      activeFile ? "File cleanness" : "Project cleanness");
  txt("[data-cleaner-cleanness-pct]",
      pct != null ? `${Math.round(pct)}%` : "—");
  const fill = root.querySelector("[data-cleaner-cleanness-fill]");
  if (fill) {
    const w = pct != null ? Math.max(0, Math.min(100, Math.round(pct))) : 0;
    fill.style.width = `${w}%`;
  }
}

// Mean of per-file cleanness_pct values across the project's files.
// Files with null / non-finite cleanness are excluded from the mean
// (they're "not scored yet"), not counted as 0. Returns null when no
// file has a score yet — header reads that as "—".
function _computeProjectMeanCleanness(files) {
  if (!Array.isArray(files) || !files.length) return null;
  const vals = files
    .map((f) => Number(f?.cleanness_pct))
    .filter((v) => Number.isFinite(v));
  if (!vals.length) return null;
  return vals.reduce((a, v) => a + v, 0) / vals.length;
}

// Paint the file-tab strip — one .rp-rtp-tab per file in the active
// project, between the Overview tab and the trailing + add wrap. The
// active file's tab gets .active. Clicking a tab navigates the hash
// (router re-mounts with the new ?file=). data-cleanness drives the
// header widget when controls.js's spActivateTab is later wired to
// keep the file-tab as the source-of-truth for cleanness; for now
// our header paint runs once per mount with the URL-resolved file.
function _renderSandboxFileTabs(root, files, activeFile) {
  const strip = root.querySelector("[data-cleaner-file-tabs]");
  if (!strip) return;
  // Wipe previously-rendered file tabs (keep Overview + the + add wrap).
  strip.querySelectorAll(".rp-rtp-tab:not([data-is-overview])")
       .forEach((t) => t.remove());
  const addWrap = strip.querySelector(".rp-tab-add-wrap");
  // Filter out files closed via × — STATE.hiddenFiles survives across
  // mounts via prefs.cleaner_hidden_files, so a closed tab stays
  // closed across page refresh. Hidden files are listed in the
  // open-file picker so the user can re-open them.
  const hidden = STATE.hiddenFiles || new Set();
  const visible = files.filter((f) => !hidden.has(f.redpash_id));
  visible.forEach((file) => {
    const isActive = activeFile && activeFile.redpash_id === file.redpash_id;
    const tab = document.createElement("button");
    tab.type = "button";
    tab.className = "rp-rtp-tab" + (isActive ? " active" : "");
    tab.setAttribute("data-file-id", file.redpash_id);
    if (file.cleanness_pct != null) {
      tab.setAttribute("data-cleanness", String(Math.round(file.cleanness_pct)));
    }
    // Composite onclick: sandbox handler flips active class + drives
    // the cleanness widget visually (instant), then the live handler
    // does the fetch + STATE update. Avoids the location.hash route
    // that would re-mount the entire page and drop the animation.
    const rid = _escAttr(file.redpash_id);
    tab.setAttribute(
      "onclick",
      `spActivateTab(this);cleanerActivateTab('${rid}')`,
    );
    const name = file.display_name || file.filename || "(unnamed)";
    // × — spDeleteTab animates the remove (.is-removing → DOM removal
    // after 180ms + activates DOM-next sibling). cleanerHideFileTab
    // runs in parallel and owns the persistence (STATE.hiddenFiles +
    // pref) + the state-aware "next visible file" switch when the
    // closed tab was active. _repaintSandboxStrips is NOT called from
    // there anymore, so the .is-removing animation completes cleanly.
    tab.innerHTML =
        '<i class="bi bi-file-earmark-text"></i>'
      + '<span class="rp-rtp-tab-name">' + _escHtml(name) + '</span>'
      + '<span class="rp-rtp-tab-x" title="Close this tab"'
      + ' onclick="event.stopPropagation();spDeleteTab(this);cleanerHideFileTab(\''
      +   rid + '\')">'
      +   '<i class="bi bi-x"></i>'
      + '</span>';
    if (addWrap) strip.insertBefore(tab, addWrap);
    else         strip.appendChild(tab);
  });
}

// Paint the file's data into the redtable mount. Fetches /files/:rid
// (for column metadata) and /files/:rid/page?page=1&size=25 (for rows),
// builds a plain <table class="rp-rt-table"> with all visible columns
// + all returned rows. First milestone — no pagination control yet,
// no sort/filter wiring; clicking a column header is a no-op. The
// columns picker / sort chain / pagination land in the next pass.
async function _paintSandboxTable(root, activeFile) {
  const host = root.querySelector("[data-cleaner-table]");
  if (!host) return;
  host.innerHTML = '<div class="rp-form-meta" style="padding:1rem;font-style:italic">Loading…</div>';

  let detail, pageRes;
  try {
    // Page + size come from STATE so the rows-per-page dropdown +
    // (future) pagination buttons drive the fetch. mountSandbox seeds
    // both from prefs.cleaner_page_size + a 1-page reset; cleanerSetPageSize
    // updates them on user pick.
    const pg   = Math.max(1, Number(STATE.page) || 1);
    const sz   = Math.max(1, Number(STATE.pageSize) || _OV_DEFAULT_PAGE_SIZE);
    [detail, pageRes] = await Promise.all([
      api.get(`/files/${encodeURIComponent(activeFile.redpash_id)}`),
      api.get(`/files/${encodeURIComponent(activeFile.redpash_id)}/page?page=${pg}&size=${sz}`),
    ]);
  } catch (err) {
    console.error("[cleaner] file/page fetch failed", err);
    host.innerHTML = `<div class="rp-form-meta" style="padding:1rem;color:var(--red, #c33)">Couldn't load file: ${_escHtml(err.body?.error ?? err.message ?? "unknown")}</div>`;
    return;
  }

  // Mirror the active file's slice into STATE so handlers (undo/redo,
  // tools panel, history modal) read fresh values without re-fetching.
  // Without this, STATE.steps stays empty on first paint and the
  // [data-sp-undo] / [data-sp-redo] sync helper would always see a
  // 0-applied / 0-undone history → buttons permanently disabled.
  STATE.summary = detail.summary;
  STATE.columns = detail.columns ?? [];
  STATE.steps   = detail.steps   ?? [];

  // Mirror the fresh summary into STATE.files so subsequent reads
  // (file-tabs, picker, header) see the same numbers — cleanness can
  // recompute server-side between mount and switch. Then re-paint the
  // header so the widget reflects the up-to-date value (cleanerActivateTab
  // painted from cache for instant feel; this is the correction pass).
  if (Array.isArray(STATE.files) && detail.summary) {
    const idx = STATE.files.findIndex((f) => f.redpash_id === activeFile.redpash_id);
    if (idx >= 0) STATE.files[idx] = detail.summary;
  }
  const _proj = STATE.project ?? STATE.projectMeta?.get(STATE.activeProjectId);
  if (typeof _renderSandboxHeader === "function") {
    _renderSandboxHeader(root, _proj, detail.summary, STATE.files || []);
  }

  const columns = detail.columns ?? [];
  const rows    = pageRes.rows  ?? [];
  const total   = pageRes.total ?? rows.length;
  // Page-relative offset → global row index for each cell. Edit-mode's
  // focusout dispatcher reads data-row-idx as a GLOBAL index so the
  // backend set_cell step doesn't have to know about pagination state.
  const pageNum  = pageRes.page ?? 1;
  const pageSize = pageRes.size ?? rows.length;
  const startIdx = (pageNum - 1) * pageSize;
  const start   = ((pageRes.page ?? 1) - 1) * (pageRes.size ?? rows.length) + 1;
  const end     = start + rows.length - 1;

  // Clear stale selection on every paint — pagination / step apply /
  // refresh all rewrite the tbody; the old indices may no longer map
  // to the same rows (drop_rows shifts), so we reset to a clean slate.
  // Reset the chip too (data-count=0 also hides it via the CSS rule
  // .rp-rt-sel-chip[data-count="0"] { display: none }).
  if (STATE.selected instanceof Set) STATE.selected.clear();
  const _chipReset = root.querySelector(".rp-rt-sel-chip");
  if (_chipReset) {
    _chipReset.setAttribute("data-count", "0");
    _chipReset.innerHTML = '<i class="bi bi-check2-square"></i> 0 selected';
  }

  // Leading mode column — matches the cleaner sandbox convention from
  // redpash-components/spreadsheet-paper/main.css. ONE rail per row
  // holding overlapping icons: native checkbox (invisible overlay,
  // source-of-truth for :checked), .rp-row-uncheck / .rp-row-check
  // (visible glyphs that fade via :checked sibling + .is-mode-select),
  // .rp-row-trash (visible in .is-mode-delete). Then rownum, then data.
  //
  // controls.js's contenteditable selector
  //   td:not(.rp-rt-rownum-td):not(:first-child)
  // still works — :first-child is now the mode column (skipped), the
  // rownum-td is class-skipped, data cells start at the 3rd column.
  // Master trash icon is purely visual — matches the Objects markup
  // convention (two classes `rp-row-trash rp-master-trash`, no onclick).
  // CSS gives it pointer-events: auto in delete mode, but the master
  // checkbox above carries z-index: 1 + inset: 0, so it absorbs the
  // click. Bulk-delete fires from the toolbar trash pill (composite
  // onclick: spSetMode(this);cleanerMaybeBulkDelete()), which is the
  // single canonical entry point for "delete selected".
  const theadHtml = "<tr>"
    + '<th class="rp-rt-th-mode">'
    +   '<input type="checkbox" onclick="cleanerSelectAllRows(this)">'
    +   '<i class="bi bi-circle rp-row-uncheck"></i>'
    +   '<i class="bi bi-check2-circle rp-row-check"></i>'
    +   '<i class="bi bi-trash rp-row-trash rp-master-trash"></i>'
    + '</th>'
    + '<th class="rp-rt-rownum-th">#</th>'
    + columns.map((c) =>
        `<th class="rp-rt-th-sortable">${_escHtml(c.name)} <i class="bi bi-arrow-down-up rp-rt-sort-ico"></i></th>`
      ).join("")
    + "</tr>";

  // data-row-idx is a GLOBAL row index (page offset added) so the
  // set_cell step is page-agnostic; data-col-name carries the column
  // by name (Polars accepts &str). The focusout dispatcher in
  // _installSandboxLiveHandlers reads both attrs to build the step
  // payload — without them, the dispatcher can't tell which cell moved.
  // The mode-column checkbox's data-ri carries the same global index
  // for cleanerRowClick → STATE.selected → bulk-delete drop_rows.
  //
  // <tr onclick="cleanerRowClick(this)"> is the single mode-aware
  // dispatcher: select-mode toggles selection (mirrors spToggleRowSel),
  // delete-mode POSTs drop_rows for that row's global index. Checkbox
  // has NO onclick — native toggle bubbles up, cleanerRowClick
  // re-syncs cb.checked to the new row state. No double-toggle race.
  const tbodyHtml = rows.map((row, rowIdx) => {
    const globalRow = startIdx + rowIdx;
    return '<tr onclick="cleanerRowClick(this)">'
      + '<td>'
      +   `<input type="checkbox" class="rp-rt-row-chk" data-ri="${globalRow}">`
      +   '<i class="bi bi-circle rp-row-uncheck"></i>'
      +   '<i class="bi bi-check2-circle rp-row-check"></i>'
      +   '<i class="bi bi-trash rp-row-trash"></i>'
      + '</td>'
      + `<td class="rp-rt-rownum-td">${(globalRow + 1).toLocaleString()}</td>`
      + columns.map((c, i) => {
          const v = row[i];
          return `<td data-row-idx="${globalRow}" data-col-name="${_escAttr(c.name)}">${_escHtml(v ?? "")}</td>`;
        }).join("")
      + "</tr>";
  }).join("");

  host.innerHTML = `<table class="rp-rt-table"><thead>${theadHtml}</thead><tbody>${tbodyHtml}</tbody></table>`;

  // Populate the toolbar's Columns picker from the file's columns_meta.
  // One .rp-dd-checkbox per column, all checked by default (column hide
  // toggling lands later — currently the checkboxes are inert).
  _populateColsPicker(root, columns);

  // Paging info — server time too, useful for quick perf signal.
  const info = root.querySelector("[data-cleaner-rows-info]");
  if (info) {
    if (rows.length) {
      info.textContent = `Showing ${start}–${end} of ${total} rows` +
        (pageRes.ms != null ? ` · ${pageRes.ms} ms` : "");
    } else {
      info.textContent = "0 rows";
    }
  }
}

// The render in _renderSandboxProjectTabs duplicates the leading
// strip.querySelectorAll(".rp-rt-proj-tab").forEach(remove) cleanup so
// it's safe to call standalone — useful for later state-only switching.

// Paint the sandbox project-tab strip from state. Drops every existing
// .rp-rt-proj-tab (sandbox demo + previous render) and emits one fresh
// tab per pid in openList, inserted before the trailing + wrap so the
// add-affordance always sits at the right. The active tab gets .active;
// each tab's onclick navigates the hash to its project — re-triggering
// the router → mountSandbox with the new active. The × per-tab calls
// the sandbox's spDeleteTab (local DOM removal); the pref-level close
// (drop from openList + persist) lands as part of the close-tab wiring
// in the next milestone.
function _renderSandboxProjectTabs(strip, projectsByPid, openList, activePid) {
  strip.querySelectorAll(".rp-rt-proj-tab").forEach((t) => t.remove());
  const addWrap = strip.querySelector(".rp-tab-add-wrap");
  // openList IS the persisted list (STATE.openProjects, saved as
  // prefs.cleaner_open_projects), so a closed project tab stays
  // closed across mounts.
  // last-tab guard — `cleanerCloseProject` refuses to drop the only
  // remaining project (would orphan the page), but `spDeleteTab` would
  // still animate the DOM remove. Skip the × entirely in that case so
  // the visual + state can't disagree.
  const onlyOne = openList.length <= 1;
  openList.forEach((pid) => {
    const proj = projectsByPid.get(pid);
    if (!proj) return;
    const tab = document.createElement("button");
    tab.type = "button";
    tab.className = "rp-rt-proj-tab" + (pid === activePid ? " active" : "");
    tab.setAttribute("data-sp-project-key", pid);
    // Composite onclick: sandbox handler flips .active class + drives
    // the cleanness widget. Live handler does the heavy lift —
    // snapshots leaving project's STATE, restores incoming snapshot
    // (or fetches), repaints header/title/cleanness. URL is updated
    // via history.replaceState inside switchProject (not a hash
    // change), so we avoid the router re-mount + animation loss.
    const epid = _escAttr(pid);
    tab.setAttribute(
      "onclick",
      `spActivateTab(this);cleanerSwitchProject('${epid}')`,
    );
    // × — spDeleteTab animates the remove + activates the next DOM
    // sibling visually; cleanerCloseProject runs in parallel and
    // owns the STATE drop + pref persist + (if active) the project
    // switch fetch. Suppressed when only one tab is open (see onlyOne
    // above) so the user can't trigger an animated-remove that the
    // state handler refuses to commit.
    const xSpan = onlyOne ? "" :
        '<span class="rp-rt-proj-tab-x" title="Close this tab"'
      + ' onclick="event.stopPropagation();spDeleteTab(this);cleanerCloseProject(\''
      +   epid + '\')">'
      +   '<i class="bi bi-x"></i>'
      + '</span>';
    tab.innerHTML =
        '<i class="bi bi-folder2-open"></i>'
      + '<span class="rp-rt-proj-tab-name">' + _escHtml(proj.name) + '</span>'
      + xSpan;
    if (addWrap) strip.insertBefore(tab, addWrap);
    else         strip.appendChild(tab);
  });
}

// Paint the open-project picker grid from the user's projects list,
// filtered to those NOT currently in openList. Each card is a button
// that calls spOpenProjectFromPicker(rid) on click — closes the modal
// and navigates to that project (the router re-runs mountSandbox which
// hydrates the new project's data). Empty state means "all open".
function _populateOpenProjectPicker(root, projects, openList) {
  const grid = root.querySelector("[data-cleaner-project-picker]");
  if (!grid) return;
  const openSet = new Set(openList);
  const closed  = (projects || []).filter((p) => !openSet.has(p.redpash_id));
  if (!closed.length) {
    grid.innerHTML =
      '<div class="rp-form-meta" style="padding:1rem;text-align:center;font-style:italic">'
      + 'All your projects are already open as tabs.'
      + '</div>';
    return;
  }
  grid.innerHTML = closed.map((p) => {
    const meta = [];
    if (p.file_count != null) {
      meta.push(`${p.file_count} file${p.file_count === 1 ? "" : "s"}`);
    }
    if (p.stage)                 meta.push(`stage: ${_escHtml(p.stage)}`);
    if (p.cleanness_pct != null) meta.push(`${Math.round(p.cleanness_pct)}% clean`);
    // Pass the project name as the second arg so spAddProjectTab
    // (inside spOpenProjectFromPicker) can de-dupe + label the new
    // animated tab.
    return ''
      + '<button type="button" class="rp-pick-card"'
      + ' onclick="spOpenProjectFromPicker(\'' + p.redpash_id + '\',\''
      +   _escAttr(p.name) + '\')">'
      +   '<i class="bi bi-folder2-open rp-pick-ico"></i>'
      +   '<div class="rp-pick-body">'
      +     '<div class="rp-pick-name">' + _escHtml(p.name) + '</div>'
      +     '<div class="rp-pick-meta">' + _escHtml(meta.join(" · ")) + '</div>'
      +   '</div>'
      + '</button>';
  }).join("");
}

// Paint the toolbar's Columns picker — one .rp-dd-checkbox per column
// (DB order from the file's columns_meta). Checked = visible. Hide /
// reorder toggling isn't wired yet; for now this is a structural mirror
// of the sandbox's static demo so the dropdown opens to real columns
// instead of an empty rectangle.
function _populateColsPicker(root, columns) {
  const host = root.querySelector("[data-cleaner-cols-picker]");
  if (!host) return;
  if (!columns || !columns.length) {
    host.innerHTML = '<div class="rp-form-meta" style="padding:0.5rem;font-style:italic">No columns.</div>';
    return;
  }
  host.innerHTML = columns.map((c) =>
    '<label class="rp-dd-checkbox"><input type="checkbox" checked /> '
    + _escHtml(c.name)
    + '</label>'
  ).join("");
}

// Card-click handler — close the picker, then use the sandbox add-tab
// helper to animate a new tab into the project strip (.is-entering
// CSS + de-dupe by name), tag it with the backend pid + state-aware
// onclicks, then drive the live state path (cleanerOpenProject →
// switchProject) for STATE + persistence + chrome paint. We DON'T go
// through location.hash anymore — the router re-mount would clobber
// the entering animation.
window.spOpenProjectFromPicker = function (pid, name) {
  if (!pid) return;
  if (typeof window.closeModal === "function") {
    window.closeModal('open-project');
  }
  const strip = document.querySelector(".rp-rt-proj-tabs-inner");
  if (strip && typeof window.spAddProjectTab === "function") {
    // De-dupe: if a tab with this name is already on screen, sandbox
    // just activates it. Otherwise it inserts a .is-entering tab.
    const before = strip.querySelectorAll(".rp-rt-proj-tab").length;
    window.spAddProjectTab(strip, name || pid);
    const after = strip.querySelectorAll(".rp-rt-proj-tab").length;
    if (after > before) {
      // A new tab was inserted (not a de-dupe activate). Find it via
      // the addWrap's previousElementSibling and tag it with pid +
      // composite onclicks so subsequent click / × know the backend id.
      const addWrap = strip.querySelector(".rp-tab-add-wrap");
      const newTab = addWrap?.previousElementSibling;
      if (newTab && newTab.classList.contains("rp-rt-proj-tab")) {
        const epid = _escAttr(pid);
        newTab.setAttribute("data-sp-project-key", pid);
        newTab.setAttribute(
          "onclick",
          `spActivateTab(this);cleanerSwitchProject('${epid}')`,
        );
        const x = newTab.querySelector(".rp-rt-proj-tab-x");
        if (x) {
          x.setAttribute(
            "onclick",
            `event.stopPropagation();spDeleteTab(this);cleanerCloseProject('${epid}')`,
          );
        }
      }
    }
  }
  // State + fetch — cleanerOpenProject pushes pid into
  // STATE.openProjects, persists prefs.cleaner_open_projects, then
  // calls cleanerSwitchProject which restores / fetches the project.
  if (typeof window.cleanerOpenProject === "function") {
    window.cleanerOpenProject(pid);
  }
};

// Paint the open-file picker. Mirrors _populateOpenProjectPicker:
// reads STATE.files (or refetched list), filters to files currently
// HIDDEN as tabs (i.e. closeable from picker = re-openable), and
// renders one card per file. Empty state when nothing is closed.
function _populateOpenFilePicker(root, files, hiddenSet) {
  const grid = root.querySelector("[data-cleaner-file-picker]");
  if (!grid) return;
  const hidden = (files || []).filter((f) => hiddenSet.has(f.redpash_id));
  if (!hidden.length) {
    grid.innerHTML =
      '<div class="rp-form-meta" style="padding:1rem;text-align:center;font-style:italic">'
      + 'All files in this project are already open as tabs.'
      + '</div>';
    return;
  }
  grid.innerHTML = hidden.map((f) => {
    const name = f.display_name || f.filename || f.redpash_id;
    const meta = [];
    if (f.row_count != null) meta.push(`${f.row_count.toLocaleString()} rows`);
    if (f.col_count != null) meta.push(`${f.col_count} cols`);
    if (f.cleanness_pct != null) meta.push(`${Math.round(f.cleanness_pct)}% clean`);
    if (f.file_size_bytes != null) {
      const kb = f.file_size_bytes / 1024;
      meta.push(kb >= 1024 ? `${(kb / 1024).toFixed(1)} MB` : `${kb.toFixed(0)} KB`);
    }
    // Pass the file's display name as second arg so spAddFileTab
    // (inside spOpenFileFromPicker) can de-dupe + label the new
    // animated tab.
    return ''
      + '<button type="button" class="rp-pick-card"'
      + ' onclick="spOpenFileFromPicker(\'' + f.redpash_id + '\',\''
      +   _escAttr(name) + '\')">'
      +   '<i class="bi bi-file-earmark-text rp-pick-ico"></i>'
      +   '<div class="rp-pick-body">'
      +     '<div class="rp-pick-name">' + _escHtml(name) + '</div>'
      +     '<div class="rp-pick-meta">' + _escHtml(meta.join(" · ")) + '</div>'
      +   '</div>'
      + '</button>';
  }).join("");
}

// File picker card click — close the picker, animate a new tab
// inserting via spAddFileTab (.is-entering CSS + de-dupe), tag the
// inserted DOM with the backend rid + state-aware onclicks, then run
// the live state path: cleanerShowFileTab removes the rid from
// STATE.hiddenFiles + persists, cleanerActivateTab fetches/paints.
window.spOpenFileFromPicker = function (rid, name) {
  if (!rid) return;
  if (typeof window.closeModal === "function") {
    window.closeModal('open-file');
  }
  const strip = document.querySelector(".rp-rtp-tabs-inner");
  if (strip && typeof window.spAddFileTab === "function") {
    const before = strip.querySelectorAll(".rp-rtp-tab:not([data-is-overview])").length;
    window.spAddFileTab(strip, name || rid);
    const after = strip.querySelectorAll(".rp-rtp-tab:not([data-is-overview])").length;
    if (after > before) {
      // New tab inserted — find it via addWrap's previousElementSibling
      // and tag with backend rid + composite onclicks.
      const addWrap = strip.querySelector(".rp-tab-add-wrap");
      const newTab = addWrap?.previousElementSibling;
      if (newTab && newTab.classList.contains("rp-rtp-tab")) {
        const erid = _escAttr(rid);
        newTab.setAttribute("data-file-id", rid);
        newTab.setAttribute(
          "onclick",
          `spActivateTab(this);cleanerActivateTab('${erid}')`,
        );
        const x = newTab.querySelector(".rp-rtp-tab-x");
        if (x) {
          x.setAttribute(
            "onclick",
            `event.stopPropagation();spDeleteTab(this);cleanerHideFileTab('${erid}')`,
          );
        }
      }
    }
  }
  // Un-hide in STATE + persist (pulls the file back into the visible
  // set for the next render), then activate + fetch the file.
  if (typeof window.cleanerShowFileTab === "function") {
    window.cleanerShowFileTab(rid);
  }
  if (typeof window.cleanerActivateTab === "function") {
    window.cleanerActivateTab(rid);
  }
};

// Reuse the new-project modal as the "add files to current project"
// flow. Closes the open-file picker (if open), then opens new-project
// pre-filled with the active project's name (locked, so the user can't
// retype). spCleanerCreateProject's loop POSTs each file with that
// name; ensure_named_project upserts so all files land in the same
// project regardless of how many uploads we make.
window.spAddFilesToCurrentProject = function () {
  if (typeof window.closeModal === "function") {
    window.closeModal('open-file');
  }
  const pname = STATE.project?.name || "";
  window.spOpenNewProjectModal?.(pname);
};

// Sandbox tab close handlers (spSandboxCloseFileTab /
// spSandboxCloseProjectTab) used to live here. They were redundant
// with the live handlers (cleanerHideFileTab / cleanerCloseProject)
// which already own STATE + persistence; the sandbox renderers now
// call those directly. The visual re-paint of the sandbox strips is
// handled inside the live handlers via _repaintSandboxStrips (a
// closure-scoped helper inside mount()) so both old and sandbox
// markup stay in sync from a single source of truth.

// proj-tabs + handler — re-fetch /api/projects + repopulate the picker
// before opening the modal. Without this the picker shows whatever
// closed projects existed at page-mount time; closing a tab then
// hitting + would leave the just-closed project missing because the
// picker doesn't refresh. STATE.openProjects is the source of truth
// for which projects are currently tabbed; everything else is closed.
window.spOpenProjectPicker = async function () {
  const root = document.getElementById("page-cleaner");
  if (!root) return;
  try {
    const res = await api.get("/projects");
    const projects = res.items ?? [];
    _populateOpenProjectPicker(root, projects, STATE.openProjects);
  } catch (err) {
    console.error("[cleaner] /projects refetch failed", err);
  }
  window.openModal && window.openModal("open-project");
};

// file-tabs + handler — mirrors spOpenProjectPicker. Re-fetches the
// active project's file list so newly-uploaded files (or files closed
// since mount) show up correctly, then opens the picker. Falls back
// to STATE.files if the refetch fails so the picker isn't blank just
// because the network blipped.
window.spOpenFilePicker = async function () {
  const root = document.getElementById("page-cleaner");
  if (!root) return;
  const pid = STATE.activeProjectId;
  let files = STATE.files || [];
  if (pid) {
    try {
      const res = await api.get(`/projects/${encodeURIComponent(pid)}/files`);
      files = res.items ?? [];
      STATE.files = files;
    } catch (err) {
      console.error("[cleaner] /projects/:rid/files refetch failed", err);
    }
  }
  _populateOpenFilePicker(root, files, STATE.hiddenFiles ?? new Set());
  window.openModal && window.openModal("open-file");
};

// Update the file-drop label as the user picks files (replaces the
// "Drop CSV/TSV/Excel files…" placeholder with picked filenames).
// Inline onchange on the hidden <input type="file" multiple> wires here.
// Single file → show name; multiple → "N files: a.csv, b.csv, …".
window.__npFileLabel = function (inp) {
  if (!inp) return;
  const lbl = document.querySelector("[data-cleaner-np-droplbl]");
  if (!lbl) return;
  const files = inp.files ? Array.from(inp.files) : [];
  if (!files.length) {
    lbl.textContent = "Drop CSV / TSV / Excel files, or click to browse";
    return;
  }
  if (files.length === 1) {
    lbl.textContent = files[0].name;
    return;
  }
  const names = files.map((f) => f.name).join(", ");
  lbl.textContent = `${files.length} files: ${names}`;
};

// Open the new-project modal with a clean slate. Without resetting,
// a second visit shows the previous name + file + any error line —
// confusing if the user dismissed an attempt and came back to start
// over. Also wires drag-and-drop on the .rp-obj-drop-zone (binding
// per-open is fine since the markup is static; idempotent flag avoids
// double-binding).
//
// Optional `presetName` pre-fills the project name and disables the
// input — used by the file-tabs upload flow ("add files to current
// project") where the project is already known and shouldn't be
// retyped. spCleanerCreateProject sends whatever value is in the
// name field, so backend ensure_named_project upserts into the same
// project regardless.
window.spOpenNewProjectModal = function (presetName) {
  const modal = document.getElementById("rp-modal-new-project");
  if (!modal) return;
  const name   = modal.querySelector("#np-name");
  const desc   = modal.querySelector("#np-desc");
  const file   = modal.querySelector("#np-file");
  const status = modal.querySelector("[data-cleaner-np-status]");
  const submit = modal.querySelector("[data-cleaner-np-submit]");
  if (name) {
    name.value    = presetName || "";
    name.disabled = !!presetName;
    name.title    = presetName ? `Uploading into "${presetName}"` : "";
  }
  if (desc)   desc.value = "";
  if (file)   file.value = "";
  if (status) { status.hidden = true; status.textContent = ""; }
  if (submit) submit.disabled = false;
  window.__npFileLabel?.(file);

  // Drop-zone bind — assigns the dropped file to the hidden input so
  // the submit handler reads it from the same place as the click-to-
  // browse path. preventDefault on dragover is required to allow drop.
  const drop = modal.querySelector("[data-cleaner-np-drop]");
  if (drop && !drop.__npBound) {
    drop.__npBound = true;
    drop.addEventListener("dragover", (e) => {
      e.preventDefault();
      drop.classList.add("is-dragover");
    });
    drop.addEventListener("dragleave", () => drop.classList.remove("is-dragover"));
    drop.addEventListener("drop", (e) => {
      e.preventDefault();
      drop.classList.remove("is-dragover");
      const dropped = e.dataTransfer?.files;
      if (!dropped || !dropped.length || !file) return;
      const dt = new DataTransfer();
      for (const f of dropped) dt.items.add(f);
      file.files = dt.files;
      window.__npFileLabel?.(file);
    });
  }

  window.openModal && window.openModal("new-project");
};

// "Create project" submit — gather name + file, POST a multipart to
// /api/files/upload with project_name set. Backend's ensure_named_project
// upserts the project row on demand. On success, close the modal and
// navigate to the new file (which lands the user in the cleaner with
// the project + file freshly active). Description input is captured but
// not persisted yet (ensure_named_project doesn't take one; would need
// a follow-up PATCH /api/projects/:rid).
window.spCleanerCreateProject = async function (btn) {
  const modal = document.getElementById("rp-modal-new-project");
  if (!modal) return;
  const nameInp   = modal.querySelector("#np-name");
  const fileInp   = modal.querySelector("#np-file");
  const statusEl  = modal.querySelector("[data-cleaner-np-status]");
  const setStatus = (msg, isError) => {
    if (!statusEl) return;
    statusEl.hidden = !msg;
    statusEl.textContent = msg || "";
    statusEl.style.color = isError ? "var(--red, #c33)" : "var(--muted)";
  };

  const name  = (nameInp?.value || "").trim();
  const files = fileInp?.files ? Array.from(fileInp.files) : [];
  if (!name) {
    setStatus("Pick a project name.", true);
    nameInp?.focus();
    return;
  }
  if (!files.length) {
    setStatus("Pick at least one file — projects are created with their first file.", true);
    return;
  }

  // Disable the submit while in flight so a double-click can't fire
  // duplicate uploads.
  if (btn) btn.disabled = true;

  // Backend /files/upload takes ONE file per request — but
  // ensure_named_project upserts by name, so subsequent uploads with
  // the same project_name land in the same project. POST each file
  // serially (concurrent uploads of the same project_name would race
  // the upsert and could double-create). Track the first response so
  // we can resolve the project_redpash_id for navigation, and collect
  // failures to report at the end without blocking the rest.
  const results = [];
  const failures = [];
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    setStatus(`Uploading ${i + 1}/${files.length}: ${f.name}…`, false);
    const fd = new FormData();
    fd.append("project_name", name);
    fd.append("file", f, f.name);
    try {
      const res = await api.post("/files/upload", fd);
      results.push(res);
    } catch (err) {
      console.error("[cleaner] upload failed for", f.name, err);
      failures.push({ name: f.name, msg: err.body?.error ?? err.message ?? "unknown" });
    }
  }

  if (!results.length) {
    // Every file failed — keep the modal open so the user can retry.
    setStatus(
      "No file uploaded. " + failures.map((f) => `${f.name}: ${f.msg}`).join("; "),
      true,
    );
    if (btn) btn.disabled = false;
    return;
  }

  if (typeof window.closeModal === "function") {
    window.closeModal("new-project");
  }
  // Single-file success → land in that file's cleaner view.
  // Multi-file (or unknown file rid) → land on the project so the
  // user sees the file-tabs strip with all the new files.
  const first = results[0];
  const firstRid = first?.summary?.redpash_id;
  const pid      = first?.summary?.project_redpash_id;
  if (results.length === 1 && firstRid) {
    location.hash = "#/cleaner?file=" + encodeURIComponent(firstRid);
  } else if (pid) {
    location.hash = "#/cleaner?project=" + encodeURIComponent(pid);
  } else if (firstRid) {
    location.hash = "#/cleaner?file=" + encodeURIComponent(firstRid);
  }
  if (failures.length) {
    // Partial success — let the user know some files didn't make it.
    toast.error?.(`${failures.length} file(s) failed: ${failures.map((f) => f.name).join(", ")}`);
  }
  if (btn) btn.disabled = false;
};
