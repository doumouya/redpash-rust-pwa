// Cases — rail + (kanban board | case detail) surface.
//
// Workstream spec: docs/internal/jira-flow-proposition/proposition.md.
// v1 scope: cases + comments tables, kanban (5 columns), detail page,
// agent migration from /Internal-Slack/. The detail page's activity
// feed is a direct port of Monitoring's M-2 UserActivity render shape
// — same `events` table, same `.rp-mon-row-expandable` atom for the
// per-event context expander, same `redact_chain` already applied at
// the airlock.
//
// Layout — same rail-page shell as /home + /monitoring:
//   • left rail (.rt-nav): case list, status-grouped, with a "Board"
//     pseudo-item at top + the New-case button in the head + the
//     search input in a filter strip below the head
//   • main: kanban board (default) OR case detail (when ?id=CAS_…)
// One data fetch feeds both surfaces — `refreshCases()` pulls the
// list, re-paints the rail, and re-paints the board if visible.
// Mutations (status flip, create) re-trigger refreshCases so both
// halves stay in sync.
//
// URL routing:
//   #/cases               → kanban board (board view)
//   #/cases?id=CAS_xyz    → case detail   (detail view)
// The hashchange handler in main.js fires the router; this module
// inspects `location.hash` on mount to pick the right surface.
//
// Per the spec lock (proposition.md, v1): NO drag-drop. Click a
// card to cycle status forward (backlog → todo → in_progress →
// in_review → done → backlog). The agent-workflow value is
// "status moves through the lanes", not drag affordance. v2 adds
// drag-drop if/when interaction data justifies the lift.

import { api } from "/scripts/api.js";
import { mountTopbar } from "/scripts/topbar.js";
import { esc } from "/scripts/dom.js";
import { getPref, setPref } from "/scripts/prefs.js";
import { fmtAge, fmtTime, fmtClock, dayKey, dayLabel } from "/scripts/format.js";

// Case-state label vocabulary + done-window filter constants
// extracted into `cases/labels.js` as slice 6 of the god-object
// decomposition (broadcast.md 00:53). Module-private to cases.js;
// promote if a future surface composes the kanban vocabulary.
import {
  STATUS_ORDER,
  STATUS_LABEL,
  PRIORITY_LABEL,
  TYPE_LABEL,
  RAIL_MARK_COLOR,
  DONE_WINDOW_MS,
  DONE_WINDOW_LABEL,
  DONE_WINDOW_ORDER,
} from "/scripts/pages/cases/labels.js";

export default function cases(app, { session }) {
  mountTopbar(app.querySelector("#rp-topbar"), { active: "cases", session });

  // Page state — module-scoped to the mount call (the router calls
  // this function fresh on each route activation).
  const meRid  = session?.redpash_id || "";       // for own/other bubble alignment
  const meName = session?.display_name || session?.username || "you";
  const detailEl = app.querySelector("#rp-cases-detail");
  const railBody = app.querySelector("#rp-cases-rail-body");
  let searchQ = "";
  let searchDebounce = null;
  let cachedCases = [];                        // last fetched roster — feeds rail + board
  let railGroupExpanded = {                    // sticky per-mount; v2 could persist
    backlog:     true,
    todo:        true,
    in_progress: true,
    in_review:   true,
    done:        false,                        // done is collapsed by default — usually noisy
  };
  let railAssigneeExpanded = new Map();        // per-mount, keyed by assignee_id (or "__unassigned__")
  let activityFilter = "all";                  // sticky per-mount; per-case mem only
  let lastDetailActivity = [];                 // memoized for filter pill re-render

  // ── hide / restore — replicated from workspace `8d070eb` per the
  //    docs/internal/processes/replicable-feature-pattern.md recipe.
  //    Pref key + helper trio + applyHiddenFilter; render-time filter
  //    in paintBoard + paintRail; `<details class="rt-hidden">` recovery
  //    surface appended at the tail of the rail body. One pref key
  //    because cases are a single entity type (vs workspace's two).
  const HIDDEN_CASES_KEY = "cases_hidden";
  function getHidden() {
    const list = getPref(HIDDEN_CASES_KEY);
    return Array.isArray(list) ? list : [];
  }
  function hideOne(entry) {
    const list = getHidden();
    if (list.some((x) => x.rid === entry.rid)) return;
    list.push(entry);
    setPref(HIDDEN_CASES_KEY, list);
  }
  function unhideOne(rid) {
    setPref(HIDDEN_CASES_KEY, getHidden().filter((x) => x.rid !== rid));
  }
  // Invariant 1: filter at render-time, never fetch-time. cachedCases
  // always carries the full roster; the hidden set is applied here
  // before grouping/painting in both surfaces.
  function applyHiddenFilter(rows) {
    const hiddenSet = new Set(getHidden().map((x) => x.rid));
    return hiddenSet.size ? rows.filter((c) => !hiddenSet.has(c.redpash_id || c.rid)) : rows;
  }

  // ── done-window filter — drop Done cases older than the window ───
  // Lives outside paint functions so cycleStatus + the chip-row both
  // see the same source of truth (the pref). Anything not-Done
  // passes through; Done items keep only if their updated_at is
  // within the window cap.
  function applyDoneWindow(rows) {
    const window = getPref("casesDoneWindow");
    const capMs = DONE_WINDOW_MS[window];
    if (!Number.isFinite(capMs)) return rows;
    const cutoff = Date.now() - capMs;
    return rows.filter((c) => {
      if (c.status !== "done") return true;
      const ts = c.updated_at ? Date.parse(c.updated_at) : NaN;
      return Number.isFinite(ts) && ts >= cutoff;
    });
  }

  function doneWindowChipsHTML(host) {
    // host: "kanban" | "rail" — kept distinct so the click delegate
    // knows where the chip lives (purely informational; both update
    // the same pref).
    const active = getPref("casesDoneWindow");
    const chips = DONE_WINDOW_ORDER.map((w) =>
      '<button type="button" class="rp-chip rp-cases-done-chip'
        + (w === active ? ' is-active' : '') + '" '
        + 'data-done-window="' + w + '" data-host="' + host + '">'
        + esc(DONE_WINDOW_LABEL[w])
        + '</button>'
    ).join("");
    return ''
      + '<div class="rp-chip-row rp-cases-done-window">'
      +   '<span class="rp-chip-row-label">Closed</span>'
      +   chips
      + '</div>';
  }

  // ── route — board vs detail by ?id=… in the hash ────────────
  function activeCaseRid() {
    const params = new URLSearchParams(location.hash.split("?")[1] || "");
    return params.get("id") || null;
  }

  // Tracks whether we were last on detail-view so renderRoute only
  // auto-folds the rail on actual board ↔ detail transitions, not
  // on every case-to-case navigation. Initial value matches the
  // mount-time route so the first renderRoute is also a "transition"
  // (deep-link to /cases?id=… auto-folds; deep-link to /cases keeps
  // the rail expanded).
  let lastWasDetail = null;

  function renderRoute() {
    const rid = activeCaseRid();
    const isDetail = !!rid;
    // Board is ALWAYS rendered now — the detail panel slides over
    // it as an overlay (Em's call vs the Salesforce full-page swap).
    detailEl.hidden = !rid;
    if (rid) loadCaseDetail(rid);
    if (cachedCases.length) paintBoard(cachedCases);
    paintRail(cachedCases, rid);
    // Auto-fold the rail on board ↔ detail transitions only. Same-
    // route navigation (case-to-case, board refresh) leaves the rail
    // alone so the manual chevron survives until the next transition.
    if (isDetail !== lastWasDetail) {
      setRailCompact(isDetail);
      lastWasDetail = isDetail;
    }
  }

  // Listen for in-page hash changes (board ↔ detail) — main.js
  // dispatches on hashchange but mounts the page module ONCE per
  // route entry; ?id= changes are sub-route navigations that we
  // handle locally without unmounting.
  function onHashChange() {
    if (!location.hash.startsWith("#/cases")) return;
    renderRoute();
  }
  window.addEventListener("hashchange", onHashChange);
  // Cleanup not strictly needed (router replaces the app innerHTML
  // on next mount, removing our DOM), but the listener leaks
  // without removal. Detach on the next route's mount via a
  // sentinel global — cheap and predictable.
  if (window._rpCasesHashHandler) window.removeEventListener("hashchange", window._rpCasesHashHandler);
  window._rpCasesHashHandler = onHashChange;

  // ── rail + board: one data fetch feeds both ─────────────────
  const searchInput = app.querySelector("#rp-cases-search");
  const newCaseBtn  = app.querySelector("#rp-cases-new");
  const colsHost    = app.querySelector("#rp-cases-cols");

  searchInput?.addEventListener("input", () => {
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => {
      searchQ = searchInput.value.trim();
      refreshCases();
    }, 200);
  });

  newCaseBtn?.addEventListener("click", () => openCreateModal());

  // ── rail group-by toggle (Status / Assignee) ───────────────────
  // Delegated handler on the rt-seg container — flips the
  // `casesRailGroupBy` pref + repaints. The painter's syncGroupByToggle
  // call updates the is-active visual on every paint so refreshCases
  // keeps the toggle in sync with the pref.
  const groupByToggle = app.querySelector("#rp-cases-rail-groupby");
  groupByToggle?.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-rail-group-by]");
    if (!btn) return;
    const mode = btn.dataset.railGroupBy;
    if (mode && mode !== getPref("casesRailGroupBy")) {
      setPref("casesRailGroupBy", mode);
      paintRail(cachedCases, activeCaseRid());
    }
  });

  // Cards are <a href="#/cases?id=…"> anchors — browser handles
  // the navigation for ordinary clicks (and middle-click → new tab,
  // and keyboard activation). The delegate intercepts the action
  // children: hide × hides + repaints; cycle chevron PATCHes status.
  // Each branch preventDefault + stopPropagation + return per
  // Invariant 2 — let one slip through and the click would navigate
  // to detail on top of the action.
  colsHost?.addEventListener("click", (e) => {
    const hideBtn = e.target.closest(".rp-cases-card-hide");
    if (hideBtn) {
      e.preventDefault();
      e.stopPropagation();
      const card = hideBtn.closest(".rp-cases-card");
      if (card?.dataset.rid) {
        hideOne({
          rid:    card.dataset.rid,
          name:   card.dataset.title || card.dataset.rid,
          status: card.dataset.status,
        });
        paintBoard(cachedCases);
        paintRail(cachedCases, activeCaseRid());
      }
      return;
    }
    const cycleBtn = e.target.closest(".rp-cases-card-cycle");
    if (cycleBtn) {
      e.preventDefault();
      e.stopPropagation();
      const card = cycleBtn.closest(".rp-cases-card");
      if (card) cycleStatus(card.dataset.rid, card.dataset.status);
      return;
    }
  });

  // Rail click delegate — handles hide × on rail rows, restore on
  // hidden items, group-head expand/collapse, and the Done-window
  // chip-row. Case tabs are <a> anchors so the browser handles
  // ordinary clicks for free. Action branches per Invariant 2 each
  // end in `return` so the click never bubbles to the parent <a>.
  railBody?.addEventListener("click", (e) => {
    const hideBtn = e.target.closest(".rp-cases-rail-item .rt-tab-close");
    if (hideBtn) {
      e.preventDefault();
      e.stopPropagation();
      const item = hideBtn.closest(".rp-cases-rail-item");
      if (item?.dataset.rid) {
        hideOne({
          rid:    item.dataset.rid,
          name:   item.dataset.title || item.dataset.rid,
          status: item.dataset.status,
        });
        paintRail(cachedCases, activeCaseRid());
        paintBoard(cachedCases);
      }
      return;
    }
    const restoreItem = e.target.closest(".rt-hidden-item");
    if (restoreItem?.dataset.rid) {
      e.preventDefault();
      e.stopPropagation();
      unhideOne(restoreItem.dataset.rid);
      paintRail(cachedCases, activeCaseRid());
      paintBoard(cachedCases);
      return;
    }
    const chip = e.target.closest("[data-done-window]");
    if (chip) {
      e.preventDefault();
      const w = chip.dataset.doneWindow;
      if (w && w !== getPref("casesDoneWindow")) {
        setPref("casesDoneWindow", w);
        paintRail(cachedCases, activeCaseRid());
        paintBoard(cachedCases);
      }
      return;
    }
    const groupHead = e.target.closest(".rt-group-head");
    if (!groupHead) return;
    const group = groupHead.closest(".rt-group");
    if (!group) return;
    const status = group.dataset.status;
    const assignee = group.dataset.assignee;
    if (status) {
      // Status mode — toggle persists across paints in railGroupExpanded.
      railGroupExpanded[status] = !group.classList.contains("expanded");
      group.classList.toggle("expanded", railGroupExpanded[status]);
    } else if (assignee) {
      // Assignee mode — toggle persists across paints in
      // railAssigneeExpanded (Map keyed by assignee_id / "__unassigned__").
      const next = !group.classList.contains("expanded");
      railAssigneeExpanded.set(assignee, next);
      group.classList.toggle("expanded", next);
    }
  });

  // Same Done-window chip-row sits in the kanban Done column; one
  // shared handler so toggling from either surface updates both.
  colsHost?.addEventListener("click", (e) => {
    const chip = e.target.closest("[data-done-window]");
    if (!chip) return;
    e.preventDefault();
    const w = chip.dataset.doneWindow;
    if (w && w !== getPref("casesDoneWindow")) {
      setPref("casesDoneWindow", w);
      paintBoard(cachedCases);
      paintRail(cachedCases, activeCaseRid());
    }
  });

  // ── rail collapse toggle ─────────────────────────────────────
  // Same compact-mode affordance as the Workspace / Docs / Monitoring
  // rails — the chevron-double-left button on the head flips the
  // .rt-nav.compact modifier; rail.css collapses everything to the
  // 60px icon-only width.
  //
  // The rail also auto-folds when a case detail panel opens (board
  // ↔ detail transition in `renderRoute`) — three columns (rail +
  // detail-overlay + kanban-behind) competing for width feels
  // crushed otherwise. `setRailCompact` is the shared mutator so
  // the manual chevron + the auto-fold can't fight each other.
  const railEl       = app.querySelector("#rp-cases-rail");
  const railCollapse = app.querySelector("#rp-cases-rail-collapse");
  function setRailCompact(compact) {
    if (!railEl) return;
    railEl.classList.toggle("compact", compact);
    const icon = railCollapse?.querySelector("i");
    if (icon) {
      icon.classList.toggle("bi-chevron-double-left", !compact);
      icon.classList.toggle("bi-chevron-double-right", compact);
    }
    if (railCollapse) railCollapse.title = compact ? "Expand" : "Collapse";
  }
  railCollapse?.addEventListener("click", () => {
    setRailCompact(!railEl?.classList.contains("compact"));
  });

  async function refreshCases() {
    try {
      const params = new URLSearchParams();
      params.set("size", "200");                     // pull a large window; v2 paginates per column
      if (searchQ) params.set("q", searchQ);
      const data = await api.get("/cases?" + params.toString());
      // Backend returns { items, total, page, size } per the cookbook
      // contract — the original v1 shell read `.rows` (wrong).
      cachedCases = data?.items || [];
      paintRail(cachedCases, activeCaseRid());
      paintBoard(cachedCases);
    } catch (err) {
      const status = err?.status;
      if (status === 404) {
        cachedCases = [];
        paintRailState("Cases endpoint not live yet.");
        paintBoardEmpty("Cases endpoint not live yet.");
        return;
      }
      const msg = "Couldn't load cases" + (status ? " (" + status + ")" : "") + ".";
      paintRailState(msg);
      paintBoardEmpty(msg);
    }
  }

  function paintBoardEmpty(msg) {
    if (!colsHost) return;
    colsHost.innerHTML = STATUS_ORDER.map((s) =>
      columnShellHTML(s, s === "backlog" ? msg : "—")
    ).join("");
  }

  function paintBoard(rows) {
    const filtered = applyHiddenFilter(applyDoneWindow(rows));
    const byStatus = STATUS_ORDER.reduce((acc, s) => (acc[s] = [], acc), {});
    filtered.forEach((c) => {
      const s = STATUS_ORDER.includes(c.status) ? c.status : "backlog";
      byStatus[s].push(c);
    });
    colsHost.innerHTML = STATUS_ORDER.map((s) => columnHTML(s, byStatus[s])).join("");
  }

  function columnShellHTML(status, emptyText) {
    return ''
      + '<section class="rp-cases-col" data-status="' + status + '">'
      +   '<header class="rp-cases-col-head">'
      +     '<span class="rp-cases-col-name">' + esc(STATUS_LABEL[status]) + '</span>'
      +     '<span class="rp-cases-col-count">0</span>'
      +   '</header>'
      +   '<div class="rp-cases-col-body">'
      +     '<p class="rt-empty rp-cases-col-empty">' + esc(emptyText) + '</p>'
      +   '</div>'
      + '</section>';
  }

  function columnHTML(status, cards) {
    const body = cards.length
      ? cards.map(cardHTML).join("")
      : '<p class="rt-empty rp-cases-col-empty">No cases.</p>';
    // Done column gets the window chip-row above the cards so the
    // user can switch the cap without leaving the board.
    const head = status === "done" ? doneWindowChipsHTML("kanban") : "";
    return ''
      + '<section class="rp-cases-col" data-status="' + status + '">'
      +   '<header class="rp-cases-col-head">'
      +     '<span class="rp-cases-col-name">' + esc(STATUS_LABEL[status]) + '</span>'
      +     '<span class="rp-cases-col-count">' + cards.length + '</span>'
      +   '</header>'
      +   '<div class="rp-cases-col-body">' + head + body + '</div>'
      + '</section>';
  }

  function cardHTML(c) {
    const rid = c.redpash_id || c.rid || "";
    const assignee = c.assignee_display_name || c.assignee_id || "—";
    const age = c.updated_at ? fmtAge(c.updated_at) : "";
    const href = "#/cases?id=" + encodeURIComponent(rid);
    // Tooltip names the destination ("→ Send for review") instead of
    // the generic "Advance status" — same verb-based labels the detail
    // page's primary advance button uses, so the user sees where the
    // click is taking them. Done cycles back to backlog → "Reopen".
    const cycleLabel = ADVANCE_LABEL[c.status || "backlog"] || "Advance status";
    return ''
      + '<a class="rp-cases-card" href="' + esc(href) + '" '
      +    'data-rid="' + esc(rid) + '" '
      +    'data-status="' + esc(c.status || "backlog") + '" '
      +    'data-title="' + esc(c.title || "(untitled)") + '">'
      +   '<div class="rp-cases-card-head">'
      +     '<span class="rp-cases-card-rid">' + esc(rid.slice(0, 8)) + '</span>'
      +     priorityDotHTML(c.priority)
      +     '<span class="rt-tab-close rp-cases-card-hide" title="Hide from board"><i class="bi bi-x"></i></span>'
      +   '</div>'
      +   '<div class="rp-cases-card-title">' + esc(c.title || "(untitled)") + '</div>'
      +   '<div class="rp-cases-card-foot">'
      +     '<span class="rp-cases-card-assignee">' + esc(assignee) + '</span>'
      +     '<span class="rp-cases-card-age">' + esc(age) + '</span>'
      +     '<button class="rt-icon-btn rt-icon-btn--sm rp-cases-card-cycle" type="button" title="' + esc(cycleLabel) + '">'
      +       '<i class="bi bi-chevron-right"></i>'
      +     '</button>'
      +   '</div>'
      + '</a>';
  }

  // ── rail render ─────────────────────────────────────────────
  // Reuses the workspace's rail atoms — .rt-group + .rt-tab —
  // so the visual rhythm matches the rest of the app. A
  // "Board" pseudo-tab sits above the groups as the always-on
  // way back to the kanban view. Each status group's mark uses
  // the same color token as the column accent stripe.
  function paintRailState(msg) {
    if (railBody) railBody.innerHTML = '<p class="rt-nav-state">' + esc(msg) + '</p>';
  }

  // Dispatcher — reads the `casesRailGroupBy` pref and picks the
  // right painter. Sync's the toggle's is-active class with the pref
  // so a pref change from elsewhere (seedPrefs on boot) still reflects
  // visually without a manual click. Per the proposition.md phase 2-3
  // requirement: each agent gets a queryable "what's on my plate"
  // view; the assignee grouping is that view.
  function paintRail(rows, activeRid) {
    if (!railBody) return;
    const mode = getPref("casesRailGroupBy");
    syncGroupByToggle(mode);
    if (mode === "assignee") paintRailByAssignee(rows, activeRid);
    else                     paintRailByStatus(rows, activeRid);
  }

  function syncGroupByToggle(mode) {
    const toggle = app.querySelector("#rp-cases-rail-groupby");
    if (!toggle) return;
    toggle.querySelectorAll("[data-rail-group-by]").forEach((b) =>
      b.classList.toggle("is-active", b.dataset.railGroupBy === mode));
  }

  function railBoardItemHTML(activeRid) {
    const boardActive = !activeRid;
    return ''
      + '<a class="rt-tab rp-cases-rail-board' + (boardActive ? ' active' : '') + '" '
      +    'href="#/cases" data-tab="board">'
      +   '<i class="rt-tab-icon bi bi-kanban"></i>'
      +   '<span class="rt-tab-name">Board</span>'
      + '</a>';
  }

  function paintRailByStatus(rows, activeRid) {
    const filtered = applyHiddenFilter(applyDoneWindow(rows));
    const byStatus = STATUS_ORDER.reduce((acc, s) => (acc[s] = [], acc), {});
    filtered.forEach((c) => {
      const s = STATUS_ORDER.includes(c.status) ? c.status : "backlog";
      byStatus[s].push(c);
    });

    const groupsHTML = STATUS_ORDER.map((status) => {
      const cases = byStatus[status];
      const expanded = railGroupExpanded[status];
      // Done group gets the window chip-row at the top of its body
      // so the user can change the cap from the rail without
      // jumping to the board.
      const chipRow = status === "done" ? doneWindowChipsHTML("rail") : "";
      const itemsHTML = cases.length
        ? cases.map((c) => railItemHTML(c, activeRid, "status")).join("")
        : '<p class="rp-cases-rail-empty">No cases.</p>';
      return ''
        + '<div class="rt-group' + (expanded ? ' expanded' : '') + '" data-status="' + status + '">'
        +   '<button class="rt-group-head" type="button">'
        +     '<i class="rt-group-caret bi bi-chevron-down"></i>'
        +     '<span class="rt-group-mark" data-c="' + RAIL_MARK_COLOR[status] + '"></span>'
        +     '<span class="rt-group-name">' + esc(STATUS_LABEL[status]) + '</span>'
        +     '<span class="rt-group-count">' + cases.length + '</span>'
        +   '</button>'
        +   '<div class="rt-group-body">' + chipRow + itemsHTML + '</div>'
        + '</div>';
    }).join("");

    railBody.innerHTML = railBoardItemHTML(activeRid) + groupsHTML + renderHiddenSection();
  }

  // Assignee grouping — one group per `assignee_id` plus a single
  // "Unassigned" pseudo-group at the bottom for nulls. Sorted
  // alphabetically by display name (Unassigned always last). Each
  // item shows its status as a small colored dot at the right of the
  // row so the user still sees where the case sits without the
  // status-grouped header context.
  function paintRailByAssignee(rows, activeRid) {
    const filtered = applyHiddenFilter(applyDoneWindow(rows));
    const byAssignee = new Map();
    filtered.forEach((c) => {
      const key = c.assignee_id || "__unassigned__";
      if (!byAssignee.has(key)) {
        byAssignee.set(key, {
          id:    c.assignee_id || null,
          name:  c.assignee_display_name || (c.assignee_id || "Unassigned"),
          cases: [],
        });
      }
      byAssignee.get(key).cases.push(c);
    });

    const groups = Array.from(byAssignee.values()).sort((a, b) => {
      if (a.id === null && b.id !== null) return 1;          // Unassigned last
      if (b.id === null && a.id !== null) return -1;
      return a.name.localeCompare(b.name);
    });

    const groupsHTML = groups.map((g) => {
      const key = g.id || "__unassigned__";
      const expanded = railAssigneeExpanded.has(key)
        ? railAssigneeExpanded.get(key)
        : true;                                              // default expanded in assignee mode
      const itemsHTML = g.cases.length
        ? g.cases.map((c) => railItemHTML(c, activeRid, "assignee")).join("")
        : '<p class="rp-cases-rail-empty">No cases.</p>';
      // All assignee groups get a muted mark for v1 (no per-assignee
      // color hash yet — the avatar atom in cases.js carries that
      // logic, will reuse it here once A2 lands as a shared atom).
      return ''
        + '<div class="rt-group' + (expanded ? ' expanded' : '') + '" data-assignee="' + esc(key) + '">'
        +   '<button class="rt-group-head" type="button">'
        +     '<i class="rt-group-caret bi bi-chevron-down"></i>'
        +     '<span class="rt-group-mark" data-c="mute"></span>'
        +     '<span class="rt-group-name">' + esc(g.name) + '</span>'
        +     '<span class="rt-group-count">' + g.cases.length + '</span>'
        +   '</button>'
        +   '<div class="rt-group-body">' + itemsHTML + '</div>'
        + '</div>';
    }).join("");

    railBody.innerHTML = railBoardItemHTML(activeRid) + groupsHTML + renderHiddenSection();
  }

  // Recovery surface — rendered only when ≥1 case is hidden. Native
  // <details> drives the open/closed state + a11y; reuses the
  // `.rt-hidden-*` atoms from rail.css that workspace shares.
  function renderHiddenSection() {
    const hidden = getHidden();
    if (!hidden.length) return "";
    const items = hidden.map((c) =>
      '<button class="rt-hidden-item" type="button" data-rid="' + esc(c.rid) + '">'
      +   '<span class="rt-hidden-name">' + esc(c.name || c.rid)
      +     (c.status ? ' <span class="rt-hidden-meta">· ' + esc(STATUS_LABEL[c.status] || c.status) + '</span>' : "")
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

  function railItemHTML(c, activeRid, mode) {
    const rid = c.redpash_id || c.rid || "";
    const isActive = rid === activeRid;
    const href = "#/cases?id=" + encodeURIComponent(rid);
    // In assignee mode, append a small colored status dot so the user
    // still sees where the case sits in the workflow without the
    // status-grouped header overhead. Rounded-square shape (vs the
    // priority dot's filled circle) so the two readouts don't get
    // confused at a glance.
    const statusDot = mode === "assignee"
      ? '<span class="rp-cases-rail-status-dot is-' + esc(c.status || "backlog")
          + '" title="Status: ' + esc(STATUS_LABEL[c.status] || "—") + '"></span>'
      : '';
    return ''
      + '<a class="rt-tab rp-cases-rail-item' + (isActive ? ' active' : '') + '" '
      +    'href="' + esc(href) + '" title="' + esc(c.title || rid) + '" '
      +    'data-rid="' + esc(rid) + '" '
      +    'data-status="' + esc(c.status || "backlog") + '" '
      +    'data-title="' + esc(c.title || "(untitled)") + '">'
      +   priorityDotHTML(c.priority)
      +   '<span class="rt-tab-name">' + esc(c.title || "(untitled)") + '</span>'
      +   statusDot
      +   '<span class="rt-tab-close" title="Hide from rail"><i class="bi bi-x"></i></span>'
      + '</a>';
  }

  function priorityDotHTML(p) {
    const cls = p === "critical" ? "is-critical"
              : p === "high"     ? "is-high"
              : p === "low"      ? "is-low"
              :                    "is-medium";
    return '<span class="rp-cases-priority-dot ' + cls + '" title="Priority: '
      + esc(PRIORITY_LABEL[p] || "—") + '"></span>';
  }

  async function cycleStatus(rid, currentStatus) {
    const idx = STATUS_ORDER.indexOf(currentStatus);
    const next = STATUS_ORDER[(idx + 1) % STATUS_ORDER.length];
    try {
      await api.patch("/cases/" + encodeURIComponent(rid), { status: next });
      refreshCases();
    } catch (err) {
      console.warn("[cases] cycle status failed:", err);
    }
  }

  // ── create modal ────────────────────────────────────────────
  // Replaces the v1.0 prompt() flow — collects title + description
  // (and, once Gus's backend ships, attachments) in a single dialog
  // before the POST. The attachments slot in the modal is wired
  // into the DOM today with a "backend pending" placeholder so the
  // layout doesn't shift when the upload affordance lights up.
  const createModal     = app.querySelector("#rp-cases-create-modal");
  const createForm      = app.querySelector("#rp-cases-create-form");
  const createTitleEl   = app.querySelector("#rp-cases-create-title-input");
  const createDescEl    = app.querySelector("#rp-cases-create-desc-input");
  const createSubmitBtn = app.querySelector("#rp-cases-create-submit");

  function openCreateModal() {
    if (!createModal) return;
    createModal.hidden = false;
    if (createForm) createForm.reset();
    if (createTitleEl) {
      createTitleEl.value = "";
      // Defer focus to next tick so the [hidden] removal applies
      // before the browser tries to move focus into the input.
      setTimeout(() => createTitleEl.focus(), 0);
    }
  }
  function closeCreateModal() {
    if (createModal) createModal.hidden = true;
  }

  createModal?.addEventListener("click", (e) => {
    if (e.target.closest("[data-modal-dismiss]")) {
      e.preventDefault();
      closeCreateModal();
    }
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (createModal && !createModal.hidden) {
      closeCreateModal();
      return;
    }
    // Detail panel close — navigate back to /cases (no ?id=), the
    // router clears detailEl.hidden on the resulting renderRoute.
    if (detailEl && !detailEl.hidden) {
      location.hash = "#/cases";
    }
  });

  createForm?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const title = (createTitleEl?.value || "").trim();
    if (!title) { createTitleEl?.focus(); return; }
    const description = (createDescEl?.value || "").trim();
    if (createSubmitBtn) createSubmitBtn.disabled = true;
    try {
      const body = { title };
      if (description) body.description = description;
      const created = await api.post("/cases", body);
      const rid = created?.redpash_id || created?.rid;
      closeCreateModal();
      if (rid) {
        location.hash = "#/cases?id=" + encodeURIComponent(rid);
        refreshCases();                          // pick up the new row in the rail
      } else {
        refreshCases();
      }
    } catch (err) {
      const msg = err?.body?.message || err?.body?.error || err?.message || "Create failed";
      alert(msg + (err?.status ? " (" + err.status + ")" : ""));
    } finally {
      if (createSubmitBtn) createSubmitBtn.disabled = false;
    }
  });

  // ── detail view ─────────────────────────────────────────────
  const ridEl      = app.querySelector("#rp-cases-detail-rid");
  const titleEl    = app.querySelector("#rp-cases-detail-title");
  const commentsList    = app.querySelector("#rp-cases-comments-list");
  const commentForm     = app.querySelector("#rp-cases-comment-form");
  const commentInput    = app.querySelector("#rp-cases-comment-input");
  const commentSend     = app.querySelector("#rp-cases-comment-form-send");
  const commentError    = app.querySelector("#rp-cases-comment-form-error");
  const activityList    = app.querySelector("#rp-cases-activity-list");
  const sideStatus   = app.querySelector("#rp-cases-side-status");
  const sidePriority = app.querySelector("#rp-cases-side-priority");
  const sideType     = app.querySelector("#rp-cases-side-type");
  const sideAssignee        = app.querySelector("#rp-cases-side-assignee");
  const sideAssigneeBtn     = app.querySelector("#rp-cases-side-assignee-btn");
  const sideAssigneePicker  = app.querySelector("#rp-cases-side-assignee-picker");
  const sideAssigneeInput   = app.querySelector("#rp-cases-side-assignee-input");
  const sideAssigneeResults = app.querySelector("#rp-cases-side-assignee-results");
  const sideReporter = app.querySelector("#rp-cases-side-reporter");
  const sideCreated  = app.querySelector("#rp-cases-side-created");
  const sideUpdated  = app.querySelector("#rp-cases-side-updated");
  const sideDescDetails = app.querySelector("#rp-cases-side-desc");
  const sideDescBody    = app.querySelector("#rp-cases-side-desc-body");
  const activityCountEl = app.querySelector("#rp-cases-side-activity-count");
  const activityFilterEl = app.querySelector("#rp-cases-activity-filter");

  let currentDetailRid = null;
  let assigneePickerTimer = null;

  // Side-panel selects fire sparse PATCHes — single field per change.
  [
    [sideStatus,   "status"],
    [sidePriority, "priority"],
    [sideType,     "type"],
  ].forEach(([el, field]) => {
    el?.addEventListener("change", () => patchCase({ [field]: el.value }));
  });

  // "Sending as X" hint — fills once at mount; the session is
  // constant for the page lifetime.
  const commentFormAs = app.querySelector("#rp-cases-comment-form-as");
  if (commentFormAs) commentFormAs.textContent = meName;

  commentForm?.addEventListener("submit", (e) => {
    e.preventDefault();
    const body = (commentInput?.value || "").trim();
    if (!body || !currentDetailRid) return;
    postComment(body);
  });

  // Ctrl/Cmd + Enter sends from the textarea — keeps users in
  // the keyboard flow when typing a long comment.
  commentInput?.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      commentForm?.requestSubmit();
    }
  });

  // Compose ergonomics — autosize textarea, enable/disable send
  // based on whether there's a non-blank message, hide stale
  // error on next keystroke.
  function syncComposeState() {
    if (!commentInput) return;
    // Autosize: reset height to read scrollHeight accurately,
    // then set to the natural content height. scrollHeight is
    // a computed pixel value; convert to rem so the inline
    // style honors the relative-units principle
    // (docs/frontend/css-units.md) and scales with root font-size.
    // CSS max-height: 18rem caps actual rendered growth.
    commentInput.style.height = "auto";
    const rootFs = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
    commentInput.style.height = (commentInput.scrollHeight / rootFs) + "rem";
    const hasBody = commentInput.value.trim().length > 0;
    if (commentSend) commentSend.disabled = !hasBody;
    if (commentError && !commentError.hidden) {
      commentError.hidden = true;
      commentError.textContent = "";
    }
  }
  commentInput?.addEventListener("input", syncComposeState);

  function showComposeError(msg) {
    if (!commentError) return;
    commentError.textContent = msg;
    commentError.hidden = false;
  }

  // Activity feed filter pills — change the in-memory filter, re-
  // render the list from the memoized last activity payload (no
  // network round-trip per pill click).
  activityFilterEl?.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-activity-filter]");
    if (!btn) return;
    const f = btn.dataset.activityFilter;
    if (!f || f === activityFilter) return;
    activityFilter = f;
    activityFilterEl.querySelectorAll("[data-activity-filter]").forEach((b) =>
      b.classList.toggle("is-active", b.dataset.activityFilter === f));
    renderActivityList(lastDetailActivity);
  });

  // ── assignee picker — shared atom from user-picker.css, hits the
  //    same /admin/users?q= shape as Monitoring's M-2 surface. Click
  //    the side-panel value → reveals the picker; pick a user →
  //    PATCH /cases/:rid { assignee_id }; outside-click closes.
  sideAssigneeBtn?.addEventListener("click", () => {
    if (!sideAssigneePicker) return;
    const opening = sideAssigneePicker.hidden;
    sideAssigneePicker.hidden = !opening;
    if (opening && sideAssigneeInput) {
      sideAssigneeInput.value = "";
      sideAssigneeInput.focus();
    }
    if (!opening && sideAssigneeResults) {
      sideAssigneeResults.hidden = true;
      sideAssigneeResults.innerHTML = "";
    }
  });
  sideAssigneeInput?.addEventListener("input", () => {
    const q = sideAssigneeInput.value.trim();
    clearTimeout(assigneePickerTimer);
    if (!q) {
      if (sideAssigneeResults) { sideAssigneeResults.hidden = true; sideAssigneeResults.innerHTML = ""; }
      return;
    }
    assigneePickerTimer = setTimeout(() => searchAssignees(q), 200);
  });
  sideAssigneeResults?.addEventListener("click", (e) => {
    const item = e.target.closest("[data-user-rid]");
    if (!item) return;
    const rid = item.dataset.userRid;
    pickAssignee(rid);
  });
  // Outside-click closes the picker — scoped to the detail panel so
  // hash navigation away from /cases?id=… doesn't fight this handler.
  document.addEventListener("click", (e) => {
    if (!sideAssigneePicker || sideAssigneePicker.hidden) return;
    if (e.target.closest("#rp-cases-side-assignee-btn")) return;
    if (e.target.closest("#rp-cases-side-assignee-picker")) return;
    sideAssigneePicker.hidden = true;
    if (sideAssigneeResults) { sideAssigneeResults.hidden = true; sideAssigneeResults.innerHTML = ""; }
  });

  async function searchAssignees(q) {
    if (!sideAssigneeResults) return;
    try {
      const data = await api.get("/admin/users?q=" + encodeURIComponent(q) + "&size=10");
      const rows = data?.rows || [];
      if (!rows.length) {
        sideAssigneeResults.innerHTML = '<div class="rt-ac-empty">No matches.</div>';
      } else {
        sideAssigneeResults.innerHTML = rows.map((u) => {
          const label = u.display_name || u.username || u.redpash_id;
          const sub   = [u.username, u.email].filter(Boolean).join(" · ");
          return '<div class="rp-user-picker-result" '
            + 'data-user-rid="' + esc(u.redpash_id) + '">'
            +   '<span class="rp-user-picker-result-name">' + esc(label) + '</span>'
            +   (sub ? '<span class="rp-user-picker-result-sub">' + esc(sub) + '</span>' : '')
            + '</div>';
        }).join("");
      }
      sideAssigneeResults.hidden = false;
    } catch (err) {
      sideAssigneeResults.innerHTML = '<div class="rt-ac-empty">Couldn’t search'
        + (err?.status ? " (" + err.status + ")" : "") + '.</div>';
      sideAssigneeResults.hidden = false;
    }
  }

  async function pickAssignee(userRid) {
    if (!currentDetailRid || !userRid) return;
    // Close picker optimistically; patchCase will repaint the value.
    if (sideAssigneePicker) sideAssigneePicker.hidden = true;
    if (sideAssigneeResults) { sideAssigneeResults.hidden = true; sideAssigneeResults.innerHTML = ""; }
    await patchCase({ assignee_id: userRid });
  }

  // ── delete case ─────────────────────────────────────────────
  // Trash icon in the detail head → window.confirm → DELETE /cases/:rid
  // → navigate back to /cases (board). Refresh pulls the deleted row
  // out of the rail + board. v3 RBAC overlay gates this by reporter /
  // admin role; v1 is dev-permissive per [[redpash-stage]].
  const deleteBtn = app.querySelector("#rp-cases-detail-delete");
  deleteBtn?.addEventListener("click", async () => {
    if (!currentDetailRid) return;
    const title = titleEl?.textContent || currentDetailRid;
    if (!confirm('Delete case "' + title + '"? This cannot be undone.')) return;
    deleteBtn.disabled = true;
    try {
      await api.delete("/cases/" + encodeURIComponent(currentDetailRid));
      location.hash = "#/cases";
      refreshCases();
    } catch (err) {
      const msg = err?.body?.message || err?.body?.error || err?.message || "Delete failed";
      alert(msg + (err?.status ? " (" + err.status + ")" : ""));
    } finally {
      deleteBtn.disabled = false;
    }
  });

  // ── inline title edit ───────────────────────────────────────
  // Click the H1 → contenteditable=plaintext-only + focus + select-all.
  // Enter commits; Escape reverts; Blur commits if changed. Suppresses
  // newline insertion (Enter triggers commit, not a line break).
  let titleEditing = false;
  let titleEditOriginal = "";
  function startTitleEdit() {
    if (!titleEl || titleEditing) return;
    titleEditing = true;
    titleEditOriginal = titleEl.textContent || "";
    titleEl.setAttribute("contenteditable", "plaintext-only");
    titleEl.classList.add("is-editing");
    titleEl.focus();
    // Select-all so a quick re-type replaces the title without manual selection
    const range = document.createRange();
    range.selectNodeContents(titleEl);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
  }
  function endTitleEdit(commit) {
    if (!titleEl || !titleEditing) return;
    titleEditing = false;
    titleEl.removeAttribute("contenteditable");
    titleEl.classList.remove("is-editing");
    window.getSelection()?.removeAllRanges();
    const next = (titleEl.textContent || "").trim();
    if (!commit || !next || next === titleEditOriginal) {
      titleEl.textContent = titleEditOriginal;
      return;
    }
    patchCase({ title: next });
  }
  titleEl?.addEventListener("click", () => { if (!titleEditing) startTitleEdit(); });
  titleEl?.addEventListener("keydown", (e) => {
    if (!titleEditing) return;
    if (e.key === "Enter")  { e.preventDefault(); endTitleEdit(true);  }
    // stopPropagation — the global Escape handler closes the detail
    // panel; while editing, Escape should only exit edit mode.
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      endTitleEdit(false);
    }
  });
  titleEl?.addEventListener("blur", () => { if (titleEditing) endTitleEdit(true); });

  // ── inline description edit ─────────────────────────────────
  // Pencil button below the description body → swap to a textarea
  // form prefilled with the current value. Save PATCHes; Cancel
  // restores. patchCase's repaint re-renders the body from the
  // server response so we don't have to optimistically rewrite it.
  const descEditBtn   = app.querySelector("#rp-cases-side-desc-edit-btn");
  const descForm      = app.querySelector("#rp-cases-side-desc-form");
  const descInput     = app.querySelector("#rp-cases-side-desc-input");
  function openDescEdit() {
    if (!descForm || !sideDescBody) return;
    // Prefill from the live case (the rendered span sometimes carries
    // the unassigned-placeholder; descBody's data-raw stash holds the
    // real value set in paintDetail).
    const raw = sideDescBody.dataset.raw || "";
    if (descInput) descInput.value = raw;
    sideDescBody.hidden = true;
    if (descEditBtn) descEditBtn.hidden = true;
    descForm.hidden = false;
    descInput?.focus();
  }
  function closeDescEdit() {
    if (!descForm || !sideDescBody) return;
    descForm.hidden = true;
    sideDescBody.hidden = false;
    if (descEditBtn) descEditBtn.hidden = false;
  }
  descEditBtn?.addEventListener("click", openDescEdit);
  // Escape inside the textarea cancels the edit without bubbling to
  // the global handler (which would close the whole detail panel).
  descInput?.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    closeDescEdit();
  });
  descForm?.addEventListener("click", (e) => {
    if (e.target.closest('[data-act="cancel"]')) {
      e.preventDefault();
      closeDescEdit();
    }
  });
  descForm?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const next = (descInput?.value || "").trim();
    const prev = sideDescBody?.dataset.raw || "";
    if (next === prev) { closeDescEdit(); return; }
    closeDescEdit();
    // Empty string clears the description (backend trims + maps "" → NULL).
    await patchCase({ description: next });
  });

  async function loadCaseDetail(rid) {
    currentDetailRid = rid;
    if (ridEl) ridEl.textContent = rid;
    if (titleEl) { titleEl.textContent = "Loading…"; titleEl.title = ""; }
    if (commentsList) commentsList.innerHTML = '<p class="rt-empty rp-cases-empty">Loading comments…</p>';
    if (activityList) activityList.innerHTML = '<p class="rt-empty rp-cases-empty">Loading activity…</p>';
    try {
      const detail = await api.get("/cases/" + encodeURIComponent(rid));
      paintDetail(detail);
    } catch (err) {
      if (err?.status === 404) {
        if (titleEl) titleEl.textContent = "Case not found";
        if (commentsList) commentsList.innerHTML = "";
        if (activityList) activityList.innerHTML = "";
        return;
      }
      if (titleEl) titleEl.textContent = "Couldn't load case";
    }
  }

  function paintDetail(detail) {
    const c = detail?.case || detail || {};
    // PATCH responses are bare Case rows (no comments / activity);
    // GET /cases/:rid returns the full CaseDetail. Detect which shape
    // we got so a field-edit repaint doesn't wipe the comments thread
    // or reset the activity filter's memoized payload.
    const hasComments = Array.isArray(detail?.comments);
    const hasActivity = Array.isArray(detail?.activity) || Array.isArray(detail?.events);
    const comments = hasComments ? detail.comments : null;
    const activity = hasActivity ? (detail.activity || detail.events) : null;

    if (hasActivity) lastDetailActivity = activity;

    if (titleEl) {
      const t = c.title || "(untitled)";
      titleEl.textContent = t;
      titleEl.title = t;                         // full title on hover (ellipsis fallback)
    }

    if (sideStatus && c.status)     sideStatus.value = c.status;
    if (sidePriority && c.priority) sidePriority.value = c.priority;
    if (sideType && c.type)         sideType.value = c.type;
    if (sideAssignee) {
      sideAssignee.innerHTML = c.assignee_id
        ? userBadgeHTML(c.assignee_id, c.assignee_display_name)
        : '<span class="rp-cases-side-unassigned">— unassigned —</span>';
    }
    if (sideReporter) {
      sideReporter.innerHTML = c.reporter_id
        ? userBadgeHTML(c.reporter_id, c.reporter_display_name)
        : '—';
    }
    if (sideCreated)  sideCreated.textContent = c.created_at ? fmtTime(c.created_at) : "—";
    if (sideUpdated)  sideUpdated.textContent = c.updated_at ? fmtTime(c.updated_at) : "—";

    // Description — auto-open when populated, closed when empty.
    // Native <details>/<summary> handles the affordance + a11y.
    // dataset.raw stashes the unrendered value for the inline editor
    // (the rendered DOM may be escaped HTML or a placeholder span).
    if (sideDescBody) {
      sideDescBody.dataset.raw = c.description || "";
      sideDescBody.innerHTML = c.description
        ? esc(c.description)
        : '<span class="rp-cases-side-unassigned">— no description —</span>';
    }
    if (sideDescDetails) sideDescDetails.open = !!c.description;

    // Activity count in the summary — gives the user a sense of
    // whether expanding is worthwhile without forcing it open.
    if (hasActivity && activityCountEl) {
      const n = activity.length;
      activityCountEl.textContent = n ? "(" + n + ")" : "";
      activityCountEl.hidden = !n;
    }

    if (hasComments && commentsList) {
      commentsList.innerHTML = comments.length
        ? commentsListHTML(comments)
        : '<p class="rt-empty rp-cases-empty">No comments yet.</p>';
    }
    if (hasActivity) renderActivityList(activity);
    // Pin to latest comment after the paint settles. requestAnimationFrame
    // so the new comment nodes are laid out before we read scrollHeight.
    if (hasComments) requestAnimationFrame(scrollCommentsToLatest);
  }

  // Verb-based labels for the card chevron tooltip. Reads as a
  // workflow command, not as a state-machine assertion. Done →
  // "Reopen" since the click cycles back to backlog.
  const ADVANCE_LABEL = {
    backlog:     "Move to Todo",
    todo:        "Start working",
    in_progress: "Send for review",
    in_review:   "Mark as Done",
    done:        "Reopen",
  };

  // Avatar atom — initials in a deterministically-colored circle.
  // Color hashes the user rid so the same user always reads the
  // same color across the app. Returns the avatar element only;
  // composes into userBadgeHTML (avatar + name) and into the
  // comment bubble (avatar standalone, name lives in the bubble
  // header).
  function userAvatarHTML(userRid, displayName, size) {
    const name = displayName || userRid || "—";
    const initials = name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((s) => s.charAt(0).toUpperCase())
      .join("") || "·";
    const color = userBadgeColor(userRid || name);
    const sizeCls = size ? ' rp-cases-user-avatar--' + size : '';
    return '<span class="rp-cases-user-avatar' + sizeCls + '" '
      + 'data-c="' + color + '" title="' + esc(name) + '">'
      + esc(initials)
      + '</span>';
  }
  function userBadgeHTML(userRid, displayName) {
    const name = displayName || userRid || "—";
    return ''
      + '<div class="rp-cases-user-badge" title="' + esc(name) + '">'
      +   userAvatarHTML(userRid, displayName)
      +   '<span class="rp-cases-user-name">' + esc(name) + '</span>'
      + '</div>';
  }
  const USER_BADGE_COLORS = ["blue", "mauve", "peach", "green", "teal"];
  function userBadgeColor(key) {
    let h = 0;
    for (let i = 0; i < key.length; i++) h = ((h << 5) - h + key.charCodeAt(i)) | 0;
    return USER_BADGE_COLORS[Math.abs(h) % USER_BADGE_COLORS.length];
  }

  // Activity feed filter — pill metadata (label + kind predicate)
  // single-sourced here. The partial's `#rp-cases-activity-filter` is
  // an empty host; paintActivityFilter() renders the pills from this
  // array so adding a category is a one-line edit instead of HTML+JS.
  const ACTIVITY_PILLS = [
    { key: "all",        label: "All",        pred: () => true },
    { key: "comments",   label: "Comments",   pred: (e) => e.kind === "case_comment_post" },
    { key: "status",     label: "Status",     pred: (e) => e.kind === "case_status_change" },
    { key: "assignment", label: "Assignment", pred: (e) => e.kind === "case_assignee_change" },
    { key: "edits",      label: "Edits",      pred: (e) => e.kind === "case_metadata_change"
                                                        || e.kind === "case_priority_change"
                                                        || e.kind === "case_type_change" },
  ];
  function paintActivityFilter() {
    if (!activityFilterEl) return;
    activityFilterEl.innerHTML = ACTIVITY_PILLS.map((p) =>
      '<button type="button" class="rp-chip'
      + (p.key === activityFilter ? ' is-active' : '')
      + '" data-activity-filter="' + esc(p.key) + '">'
      + esc(p.label)
      + '</button>'
    ).join("");
  }
  function renderActivityList(activity) {
    if (!activityList) return;
    const pill = ACTIVITY_PILLS.find((p) => p.key === activityFilter) || ACTIVITY_PILLS[0];
    const filtered = activity.filter(pill.pred);
    if (!filtered.length) {
      const msg = activityFilter === "all"
        ? "No activity yet."
        : "No activity in this filter.";
      activityList.innerHTML = '<p class="rt-empty rp-cases-empty">' + msg + '</p>';
      return;
    }
    activityList.innerHTML = filtered.map(activityRow).join("");
  }

  // Chat-bubble layout — own author right-aligned + accent-soft tint,
  // others left-aligned + surface. Avatar sits to the outside, the
  // bubble carries author + timestamp header + body. The "you"
  // bubble drops the author name in the header since it's redundant
  // when avatar + alignment + color all signal self-authorship.
  function commentHTML(cm) {
    const author = cm.author_display_name || cm.author_id || "—";
    const isOwn = cm.author_id && cm.author_id === meRid;
    const when = cm.created_at ? fmtClock(cm.created_at) : "";
    const headerParts = [];
    if (!isOwn) headerParts.push('<span class="rp-cases-comment-author">' + esc(author) + '</span>');
    if (when)   headerParts.push('<span class="rp-cases-comment-when">' + esc(when) + '</span>');
    if (cm.is_edited) headerParts.push('<span class="rp-cases-comment-edited">edited</span>');
    return ''
      + '<div class="rp-cases-comment' + (isOwn ? ' rp-cases-comment--own' : '') + '">'
      +   userAvatarHTML(cm.author_id, author, "sm")
      +   '<div class="rp-cases-comment-bubble">'
      +     (headerParts.length
        ? '<header class="rp-cases-comment-head">' + headerParts.join("") + '</header>'
        : '')
      +     '<div class="rp-cases-comment-body"><pre>' + esc(cm.body || "") + '</pre></div>'
      +   '</div>'
      + '</div>';
  }

  // Walk the comments in created_at order, inserting a centered
  // day-divider whenever the calendar date changes. The first
  // divider always shows the first comment's day. Empty list →
  // no dividers (caller renders the empty-state instead).
  function commentsListHTML(comments) {
    let lastDay = null;
    let out = "";
    for (const cm of comments) {
      const day = cm.created_at ? dayKey(cm.created_at) : "—";
      if (day !== lastDay) {
        out += '<div class="rp-cases-comment-day"><span>' + esc(dayLabel(cm.created_at)) + '</span></div>';
        lastDay = day;
      }
      out += commentHTML(cm);
    }
    return out;
  }

  // dayKey / dayLabel / fmtClock now imported from /scripts/format.js
  // (extracted 2026-05-25 per cases-UI review).

  function activityRow(e) {
    // Mirrors Monitoring's M-2 userActivityRow shape — same atom,
    // different kind set. case_* events get a distinct chip per kind.
    const kindLabel = (e.kind || "").replace(/^case_/, "").replace(/_/g, " ");
    return ''
      + '<div class="rp-cases-activity-item">'
      +   '<span class="rp-cases-activity-time">' + esc(e.occurred_at ? fmtTime(e.occurred_at) : "—") + '</span>'
      +   '<span class="rp-cases-activity-kind">' + esc(kindLabel || e.kind || "event") + '</span>'
      +   '<span class="rp-cases-activity-message">' + esc(e.message || "") + '</span>'
      + '</div>';
  }

  async function patchCase(patch) {
    if (!currentDetailRid) return;
    try {
      const updated = await api.patch("/cases/" + encodeURIComponent(currentDetailRid), patch);
      paintDetail(updated);
      // Keep the rail in sync — status/priority/assignee changes
      // from the side panel should reflect in the rail item without
      // a manual refresh.
      refreshCases();
    } catch (err) {
      console.warn("[cases] patch failed:", err);
    }
  }

  async function postComment(body) {
    if (!currentDetailRid) return;
    if (commentSend)  commentSend.disabled = true;
    if (commentInput) commentInput.disabled = true;
    if (commentError) { commentError.hidden = true; commentError.textContent = ""; }
    try {
      await api.post("/cases/" + encodeURIComponent(currentDetailRid) + "/comments", { body });
      if (commentInput) {
        commentInput.value = "";
        commentInput.style.height = "auto";    // reset autosize after clear
      }
      await loadCaseDetail(currentDetailRid);   // pulls the new comment + repaints
      scrollCommentsToLatest();                 // auto-scroll so user sees their own message
    } catch (err) {
      const msg = err?.body?.message || err?.body?.error || err?.message || "Couldn't post comment";
      showComposeError(msg + (err?.status ? " (" + err.status + ")" : ""));
    } finally {
      if (commentInput) commentInput.disabled = false;
      // Re-evaluate send state from current input contents (form
      // was cleared on success → disabled; failed → still has body
      // → enabled so user can retry).
      syncComposeState();
      commentInput?.focus();
    }
  }

  // Pin comments to the latest message — called after open and
  // after a successful post. Uses scrollTop on the list element,
  // which is the bounded scroll container for the comments tab.
  function scrollCommentsToLatest() {
    if (!commentsList) return;
    commentsList.scrollTop = commentsList.scrollHeight;
  }

  // fmtTime / fmtAge now imported from /scripts/format.js.

  // ── boot ─────────────────────────────────────────────────────
  // First show the right surface (board vs detail), render the
  // static activity-filter pills, then fetch the case list — fetch
  // populates the rail and re-paints the board once the response
  // lands. Detail view fires its own /cases/:rid fetch independently
  // of the list call.
  renderRoute();
  paintActivityFilter();
  refreshCases();
}
