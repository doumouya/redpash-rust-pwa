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
// Two ways to move a card's status: click to cycle forward (backlog →
// todo → in_progress → in_review → done → backlog), OR kanban drag-drop
// between columns (added 2026-05-28). The agent-workflow value is
// "status moves through the lanes"; both routes funnel through setStatus.

import { api } from "/scripts/api.js";
import { mountTopbar } from "/scripts/topbar.js";
import { mountRailFooterNav } from "/scripts/rail-footer.js";
import { mountRailCollapse, mountRailSeg } from "/scripts/rail-controls.js";
import { esc } from "/scripts/dom.js";
import { getPref, setPref } from "/scripts/prefs.js";
import { heroStripHTML, createListCharts } from "/scripts/list-page.js";
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
  DONE_WINDOW_MS,
  DONE_WINDOW_LABEL,
  DONE_WINDOW_ORDER,
} from "/scripts/pages/cases/labels.js";

export default function cases(app, { session }) {
  mountTopbar(app.querySelector("#rp-topbar"), { active: "cases", session });
  mountRailFooterNav(app.querySelector(".rt-nav-foot"), { active: "", session });

  // Page state — module-scoped to the mount call (the router calls
  // this function fresh on each route activation).
  const meRid  = session?.redpash_id || "";       // for own/other bubble alignment
  const meName = session?.display_name || session?.username || "you";
  const detailEl = app.querySelector("#rp-cases-detail");
  const boardEl  = app.querySelector("#rp-cases-board");
  const railBody = app.querySelector("#rp-cases-rail-body");
  let searchQ = "";
  let searchDebounce = null;
  let cachedCases = [];                        // last fetched roster — feeds rail + board
  // railGroupExpanded + railAssigneeExpanded retired 2026-05-28 with
  // the rail flatten (status moved to per-row dot; source moved to
  // top-toggle tabs). No groups means no per-group expand state.
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

  function renderRoute() {
    const rid = activeCaseRid();
    const isDetail = !!rid;
    // Clean two-state swap (Em 2026-05-28): opening a case shows ONLY
    // the case (full-bleed detail), closing shows ONLY the board. No
    // more overlay-over-kanban — the board + detail are mutually
    // exclusive in the main area. The rail stays as the constant nav.
    detailEl.hidden = !rid;
    if (boardEl) boardEl.hidden = isDetail;
    if (rid) loadCaseDetail(rid);
    // Repaint the board even while hidden so it's fresh when the user
    // closes the detail (cheap; avoids a flash of stale cards).
    if (cachedCases.length) paintBoard(cachedCases);
    paintRail(cachedCases, rid);
    // Rail no longer auto-folds on case-open — the board hiding frees
    // the width, so the rail stays expanded for case-to-case nav.
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

  // ── rail source toggle (Internal / External) ──────────────────
  // Shared rail-controls seg helper. Source is a server-side filter on
  // /api/cases?source=, so the onChange refetches. No fireOnMount —
  // the page's own boot calls refreshCases() once, which reads the
  // pref the helper seeds here.
  mountRailSeg(app.querySelector("#rp-cases-rail-source"), {
    pref:     "casesActiveSource",
    fallback: "internal",
    onChange: () => refreshCases(),
  });

  // ── filter chip rows (Assignee / Status) ───────────────────────
  // Em 2026-05-28: two independent filter dimensions ANDing against
  // the active source tab. Each chip row is single-select with an
  // "All" chip for the unconstrained-on-this-axis state. Selections
  // persist via per-row prefs so a reload keeps the user's filter.
  //
  // Assignee chips are dynamic — per-agent chips populate from
  // /api/admin/users on mount. Static chips ([All] [Mine]
  // [Unassigned]) are pre-rendered in the partial.
  const chipsAssignee = app.querySelector("#rp-cases-chips-assignee");
  const chipsStatus   = app.querySelector("#rp-cases-chips-status");
  function syncChipRow(row, value) {
    if (!row) return;
    row.querySelectorAll(".rp-chip").forEach((b) => {
      const key = b.dataset.chipAssignee || b.dataset.chipStatus;
      b.classList.toggle("is-active", key === value);
    });
  }
  if (getPref("casesFilterAssignee") == null) setPref("casesFilterAssignee", "all");
  if (getPref("casesFilterStatus")   == null) setPref("casesFilterStatus",   "all");
  syncChipRow(chipsAssignee, getPref("casesFilterAssignee"));
  syncChipRow(chipsStatus,   getPref("casesFilterStatus"));

  chipsAssignee?.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-chip-assignee]");
    if (!btn) return;
    const next = btn.dataset.chipAssignee;
    if (next && next !== getPref("casesFilterAssignee")) {
      setPref("casesFilterAssignee", next);
      syncChipRow(chipsAssignee, next);
      refreshCases();
    }
  });
  chipsStatus?.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-chip-status]");
    if (!btn) return;
    const next = btn.dataset.chipStatus;
    if (next && next !== getPref("casesFilterStatus")) {
      setPref("casesFilterStatus", next);
      syncChipRow(chipsStatus, next);
      refreshCases();
    }
  });

  // Populate the per-agent chips after the static chips. Fire-and-
  // forget: if the admin endpoint 403s (non-admin session in future
  // RBAC) the chip row just stays with the static set, no crash.
  async function loadAgentChips() {
    if (!chipsAssignee) return;
    try {
      const data = await api.get("/admin/users?size=20");
      const users = data?.rows || [];
      // Skip the current user — already covered by [Mine]. Skip users
      // without a usable display name.
      const others = users.filter((u) =>
        u.redpash_id && u.redpash_id !== meRid && (u.display_name || u.username));
      const html = others.map((u) =>
        '<button type="button" class="rp-chip" data-chip-assignee="' + esc(u.redpash_id) + '">'
        +   esc(u.display_name || u.username)
        + '</button>'
      ).join("");
      // Insert before the Unassigned chip so the per-agent chips
      // cluster between [Mine] and [Unassigned].
      const unassignedBtn = chipsAssignee.querySelector('[data-chip-assignee="__unassigned__"]');
      if (unassignedBtn) unassignedBtn.insertAdjacentHTML("beforebegin", html);
      else               chipsAssignee.insertAdjacentHTML("beforeend", html);
      // Re-sync in case the active pref is a per-agent rid.
      syncChipRow(chipsAssignee, getPref("casesFilterAssignee"));
    } catch (err) {
      console.warn("[cases] couldn't load agent chips:", err);
    }
  }
  loadAgentChips();

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

  // Overview table (row 3) — a row click opens that case's detail, same
  // destination as a kanban card. Delegated on the host so it survives
  // paintCasesOverview rebuilds.
  app.querySelector("#rp-cases-ov-table")?.addEventListener("click", (e) => {
    const row = e.target.closest(".rp-cases-ov-row");
    if (row?.dataset.rid) location.hash = "#/cases?id=" + encodeURIComponent(row.dataset.rid);
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
    // Group-head expand/collapse retired 2026-05-28 — the flat rail
    // has no groups (status moved into a per-row dot, source moved
    // into the top toggle tabs). Anything that wasn't a chip falls
    // through to the browser-handled anchor click on the .rt-tab.
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

  // ── kanban drag-drop — move a card between status columns ───────
  // Native HTML5 DnD (no library, per [[feedback-no-frameworks]]).
  // proposition.md deferred this to v2 ("if interaction data justifies
  // the lift") — Em greenlit 2026-05-28. The dragged rid is held in a
  // closure var (cross-document transfer isn't needed); dataTransfer
  // is still seeded so Firefox initiates the drag. Drop reads the
  // target column's data-status and routes through setCaseStatus
  // (optimistic move + PATCH + revert-on-error). A drag gesture
  // doesn't fire a click, so the card anchor's navigation is
  // unaffected — plain clicks still open the case.
  let draggedRid = null;
  let draggedFromStatus = null;
  function clearDropTargets() {
    colsHost?.querySelectorAll(".rp-cases-col.is-drop-target")
      .forEach((c) => c.classList.remove("is-drop-target"));
  }
  colsHost?.addEventListener("dragstart", (e) => {
    const card = e.target.closest(".rp-cases-card");
    if (!card) return;
    draggedRid = card.dataset.rid || null;
    draggedFromStatus = card.dataset.status || null;
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", draggedRid || "");
    }
    card.classList.add("is-dragging");
  });
  colsHost?.addEventListener("dragend", (e) => {
    e.target.closest(".rp-cases-card")?.classList.remove("is-dragging");
    clearDropTargets();
    draggedRid = null;
    draggedFromStatus = null;
  });
  colsHost?.addEventListener("dragover", (e) => {
    if (!draggedRid) return;
    const col = e.target.closest(".rp-cases-col");
    if (!col) return;
    e.preventDefault();                       // mark as a valid drop zone
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    if (!col.classList.contains("is-drop-target")) {
      clearDropTargets();
      col.classList.add("is-drop-target");
    }
  });
  colsHost?.addEventListener("drop", (e) => {
    if (!draggedRid) return;
    const col = e.target.closest(".rp-cases-col");
    if (!col) return;
    e.preventDefault();
    const target = col.dataset.status;
    const rid = draggedRid;
    clearDropTargets();
    if (target && target !== draggedFromStatus) setCaseStatus(rid, target);
  });

  // ── rail collapse toggle ─────────────────────────────────────
  // Shared rail-controls helper (same chevron compact-toggle as every
  // other railed page). The auto-fold-on-detail-open was removed when
  // the board↔detail swap went full-bleed (d407ef4), so the manual
  // chevron is the only collapse driver now — no bespoke mutator.
  mountRailCollapse(app.querySelector("#rp-cases-rail"),
                    app.querySelector("#rp-cases-rail-collapse"));

  async function refreshCases() {
    try {
      const params = new URLSearchParams();
      params.set("size", "200");                     // pull a large window; v2 paginates per column
      if (searchQ) params.set("q", searchQ);
      // Source filter — scopes the fetch to the active rail tab.
      // Defaults to "internal" so the agent team's queue shows on
      // first paint. External cases require flipping the toggle.
      params.set("source", getPref("casesActiveSource") || "internal");
      // Assignee / Status chip filters — "all" = no constraint
      // (don't send the param). "mine" resolves to the caller's own
      // rid; "__unassigned__" is a sentinel the backend matches as
      // assignee_id IS NULL. Per-agent chips carry their USR_<rid>
      // directly in data-chip-assignee.
      const fa = getPref("casesFilterAssignee");
      if (fa && fa !== "all") {
        params.set("assignee", fa === "mine" ? meRid : fa);
      }
      const fs = getPref("casesFilterStatus");
      if (fs && fs !== "all") params.set("status", fs);
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
    paintCasesOverview([]);
    colsHost.innerHTML = STATUS_ORDER.map((s) =>
      columnShellHTML(s, s === "backlog" ? msg : "—")
    ).join("");
  }

  // ── overview rows (Em 2026-05-29) — hero strip + contextual table.
  // The board is a 3-row overview now (a variation of the Home/Monitoring
  // layout): row 1 = hero (two donuts flanking a 2×2 stats grid), row 2 =
  // the kanban (paintBoard), row 3 = a cases table. Stats + charts derive
  // from the same filtered roster the columns render, so everything tracks
  // the done-window + hidden filters. Stats are cross-cutting (Total /
  // Urgent / Mine / Unassigned) — not per-status counts, which already
  // live in the column headers.
  const CASES_OV_CHARTS = [
    { id: "rp-cases-ov-status", title: "By status", kind: "donut",
      data: (s) => (s.items || []).reduce((a, c) => {
        const k = STATUS_ORDER.includes(c.status) ? c.status : "backlog";
        const label = STATUS_LABEL[k] || k;
        a[label] = (a[label] || 0) + 1; return a;
      }, {}) },
    { id: "rp-cases-ov-priority", title: "By priority", kind: "donut",
      data: (s) => (s.items || []).reduce((a, c) => {
        const k = c.priority || "medium"; a[k] = (a[k] || 0) + 1; return a;
      }, {}) },
  ];
  const boardCharts = createListCharts(boardEl, { logPrefix: "cases-ov" });

  function paintCasesOverview(rows) {
    const hero = app.querySelector("#rp-cases-ov-hero");
    const tableHost = app.querySelector("#rp-cases-ov-table");
    if (hero) {
      const urgent     = rows.filter((c) => c.priority === "high" || c.priority === "critical").length;
      const mine       = meRid ? rows.filter((c) => c.assignee_id === meRid).length : 0;
      const unassigned = rows.filter((c) => !c.assignee_id).length;
      hero.innerHTML = heroStripHTML(
        [ { label: "Total",      value: rows.length },
          { label: "Urgent",     value: urgent      },
          { label: "Mine",       value: mine        },
          { label: "Unassigned", value: unassigned  } ],
        CASES_OV_CHARTS
      );
      // Mount from data in hand (no refetch). Only when the board's
      // visible — echarts sizes to 0 on a display:none container, and
      // renderRoute re-runs paintBoard when the board re-shows, which
      // re-mounts them at the right size.
      boardCharts.dispose();
      if (boardEl && !boardEl.hidden) {
        boardCharts.mountData({ charts: CASES_OV_CHARTS }, { items: rows });
      }
    }
    if (tableHost) tableHost.innerHTML = casesTableHTML(rows);
  }

  function casesTableHTML(rows) {
    if (!rows.length) return '<p class="rt-empty rp-cases-ov-table-empty">No cases.</p>';
    const sorted = rows.slice().sort((a, b) =>
      String(b.updated_at || "").localeCompare(String(a.updated_at || "")));
    const body = sorted.map((c) => {
      const rid = c.redpash_id || c.rid || "";
      return '<tr class="rp-cases-ov-row" data-rid="' + esc(rid) + '">'
        + '<td>' + esc(c.title || "(untitled)") + '</td>'
        + '<td>' + esc(STATUS_LABEL[c.status] || c.status || "—") + '</td>'
        + '<td>' + priorityDotHTML(c.priority) + ' ' + esc(c.priority || "—") + '</td>'
        + '<td>' + esc(c.assignee_display_name || c.assignee_id || "—") + '</td>'
        + '<td>' + (c.updated_at ? esc(fmtAge(c.updated_at)) : "—") + '</td>'
        + '</tr>';
    }).join("");
    return '<table class="rt-table">'
      + '<thead><tr><th>Title</th><th>Status</th><th>Priority</th>'
      +   '<th>Assignee</th><th>Updated</th></tr></thead>'
      + '<tbody>' + body + '</tbody></table>';
  }

  function paintBoard(rows) {
    const filtered = applyHiddenFilter(applyDoneWindow(rows));
    paintCasesOverview(filtered);
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
      + '<a class="rp-cases-card" href="' + esc(href) + '" draggable="true" '
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

  // Flat rail painter — replaces the previous status/assignee group
  // dispatch (Em 2026-05-28). The active source-tab is the only axis
  // now; the cases come back already filtered server-side. Each row
  // carries an inline status dot (rt-tab-dot family) so the kanban-
  // skim is preserved without group headers.
  //
  // The list sorts cases by status order (backlog → done) then by
  // updated_at desc within status — same visual rhythm as the
  // status-grouped rail without the grouping chrome.
  function paintRail(rows, activeRid) {
    if (!railBody) return;
    const filtered = applyHiddenFilter(applyDoneWindow(rows));
    filtered.sort((a, b) => {
      const ai = STATUS_ORDER.indexOf(a.status);
      const bi = STATUS_ORDER.indexOf(b.status);
      if (ai !== bi) return ai - bi;
      const at = a.updated_at || "";
      const bt = b.updated_at || "";
      return bt.localeCompare(at);
    });
    const items = filtered.length
      ? filtered.map((c) => railItemHTML(c, activeRid)).join("")
      : '<p class="rp-cases-rail-empty">No cases.</p>';
    // Done-window chip-row sits at the top of the rail body (used to
    // live in the done group's body before the flatten). One-line
    // strip so the user can still cap the productivity window from
    // the rail. paintRail-level rather than per-case so it doesn't
    // depend on a "done" group existing.
    railBody.innerHTML = railBoardItemHTML(activeRid)
      + doneWindowChipsHTML("rail")
      + items
      + renderHiddenSection();
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

  function railItemHTML(c, activeRid) {
    const rid = c.redpash_id || c.rid || "";
    const isActive = rid === activeRid;
    const href = "#/cases?id=" + encodeURIComponent(rid);
    // Status moved from group-header (previous design) into a per-row
    // .rt-tab-dot 2026-05-28. Per-status variant class drives the
    // color (see cases.css); the shared atom keeps shape parity with
    // workspace's file dot.
    const statusKey = STATUS_ORDER.includes(c.status) ? c.status : "backlog";
    return ''
      + '<a class="rt-tab rp-cases-rail-item' + (isActive ? ' active' : '') + '" '
      +    'href="' + esc(href) + '" title="' + esc(c.title || rid) + '" '
      +    'data-rid="' + esc(rid) + '" '
      +    'data-status="' + esc(statusKey) + '" '
      +    'data-title="' + esc(c.title || "(untitled)") + '">'
      +   priorityDotHTML(c.priority)
      +   '<span class="rt-tab-name">' + esc(c.title || "(untitled)") + '</span>'
      +   '<span class="rt-tab-dot rp-cases-status-dot is-' + esc(statusKey)
      +     '" title="Status: ' + esc(STATUS_LABEL[statusKey]) + '"></span>'
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
    setCaseStatus(rid, next);
  }

  // Direct status set — used by the kanban drag-drop + the cycle
  // button. Optimistic: mutate the cached case + repaint so the card
  // lands in the target column immediately, then PATCH; on error
  // revert the cache + repaint. No-op when the status is unchanged.
  async function setCaseStatus(rid, status) {
    const c = cachedCases.find((x) => (x.redpash_id || x.rid) === rid);
    const prev = c ? c.status : null;
    if (prev === status) return;
    if (c) {
      c.status = status;
      paintBoard(cachedCases);
      paintRail(cachedCases, activeCaseRid());
    }
    try {
      await api.patch("/cases/" + encodeURIComponent(rid), { status });
      refreshCases();                 // reconcile updated_at + ordering
    } catch (err) {
      console.warn("[cases] set status failed:", err);
      if (c) {                        // revert the optimistic move
        c.status = prev;
        paintBoard(cachedCases);
        paintRail(cachedCases, activeCaseRid());
      }
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
  const pathEl       = app.querySelector("#rp-cases-detail-path");
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
  // Status moved to the path hero (below); priority + type stay here.
  [
    [sidePriority, "priority"],
    [sideType,     "type"],
  ].forEach(([el, field]) => {
    el?.addEventListener("change", () => patchCase({ [field]: el.value }));
  });

  // Status path hero — click a step → set status directly (not just
  // cycle-forward). Allows backward moves (reopen) + jumps. The
  // PATCH emits the case_status_change event same as any status edit.
  pathEl?.addEventListener("click", (e) => {
    const step = e.target.closest("[data-path-status]");
    if (!step || !currentDetailRid) return;
    const next = step.dataset.pathStatus;
    // No-op if already on this status — avoids a redundant PATCH +
    // event row when the user clicks the current step.
    if (next && next !== pathEl.dataset.current) patchCase({ status: next });
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

  // RID display — CAS_5F3C7A21D8E94B6E92A1C0F4B3D7E0A2 is unreadable
  // in the head bar (40+ chars, eats the title space). Show the prefix
  // + 4 chars of the hex; full RID lives in title= for hover and gets
  // copied to clipboard on click.
  function shortenRid(rid) {
    if (!rid || typeof rid !== "string") return rid || "";
    const us = rid.indexOf("_");
    if (us < 0 || rid.length - us - 1 <= 5) return rid;
    return rid.slice(0, us + 5) + "…";
  }

  if (ridEl) {
    ridEl.setAttribute("role", "button");
    ridEl.setAttribute("tabindex", "0");
    const copyRid = async () => {
      if (!currentDetailRid) return;
      try { await navigator.clipboard.writeText(currentDetailRid); }
      catch { /* no clipboard (no https / blocked) — silent */ }
      const prev = ridEl.textContent;
      ridEl.classList.add("is-copied");
      ridEl.textContent = "Copied";
      setTimeout(() => {
        ridEl.classList.remove("is-copied");
        ridEl.textContent = prev;
      }, 1200);
    };
    ridEl.addEventListener("click", copyRid);
    ridEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); copyRid(); }
    });
  }

  async function loadCaseDetail(rid) {
    currentDetailRid = rid;
    if (ridEl) {
      ridEl.textContent = shortenRid(rid);
      ridEl.title = rid + " — click to copy";
    }
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

    // Status path hero — mark steps left-of-current as done, the
    // current step as current, the rest upcoming. Stash the current
    // status on the container so the click handler can no-op a click
    // on the already-active step.
    if (pathEl) {
      const cur = STATUS_ORDER.includes(c.status) ? c.status : "backlog";
      const curIdx = STATUS_ORDER.indexOf(cur);
      pathEl.dataset.current = cur;
      pathEl.querySelectorAll("[data-path-status]").forEach((step) => {
        const idx = STATUS_ORDER.indexOf(step.dataset.pathStatus);
        step.classList.toggle("is-done",   idx < curIdx);
        // is-active reuses the .rp-chip atom's accent-fill active state.
        step.classList.toggle("is-active", idx === curIdx);
      });
    }
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
    const rid = cm.redpash_id || cm.rid || "";
    const author = cm.author_display_name || cm.author_id || "—";
    const isOwn = cm.author_id && cm.author_id === meRid;
    const when = cm.created_at ? fmtClock(cm.created_at) : "";
    const headerParts = [];
    if (!isOwn) headerParts.push('<span class="rp-cases-comment-author">' + esc(author) + '</span>');
    if (when)   headerParts.push('<span class="rp-cases-comment-when">' + esc(when) + '</span>');
    if (cm.is_edited) headerParts.push('<span class="rp-cases-comment-edited">edited</span>');
    // Own comments get hover-revealed edit + delete affordances. The
    // raw body is recoverable from the <pre>'s textContent (esc →
    // render → textContent round-trips), so no data-raw attr needed.
    const actions = isOwn
      ? '<div class="rp-cases-comment-actions">'
        +   '<button type="button" class="rp-cases-comment-edit" title="Edit"><i class="bi bi-pencil"></i></button>'
        +   '<button type="button" class="rp-cases-comment-delete" title="Delete"><i class="bi bi-trash3"></i></button>'
        + '</div>'
      : '';
    return ''
      + '<div class="rp-cases-comment' + (isOwn ? ' rp-cases-comment--own' : '') + '" '
      +    'data-cmt-rid="' + esc(rid) + '">'
      +   userAvatarHTML(cm.author_id, author, "sm")
      +   '<div class="rp-cases-comment-bubble">'
      +     (headerParts.length
        ? '<header class="rp-cases-comment-head">' + headerParts.join("") + '</header>'
        : '')
      +     '<div class="rp-cases-comment-body"><pre>' + esc(cm.body || "") + '</pre></div>'
      +     actions
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

  // ── comment edit / delete ───────────────────────────────────
  // Own comments carry hover-revealed edit + delete buttons (rendered
  // in commentHTML). One delegator on the comments list routes the
  // four actions: edit (swap body → inline textarea), save (PATCH),
  // cancel (local restore, no fetch), delete (confirm → DELETE).
  // Backend: PATCH/DELETE /cases/:rid/comments/:cmt_rid (cases.rs).
  function enterCommentEdit(wrap) {
    const bodyEl = wrap.querySelector(".rp-cases-comment-body");
    if (!bodyEl || wrap.querySelector(".rp-cases-comment-edit-form")) return;
    // Raw body round-trips through the <pre>'s textContent.
    const raw = wrap.querySelector(".rp-cases-comment-body pre")?.textContent || "";
    bodyEl.hidden = true;
    const form = document.createElement("div");
    form.className = "rp-cases-comment-edit-form";
    form.innerHTML = ''
      + '<textarea class="rp-cases-comment-edit-input" rows="3"></textarea>'
      + '<div class="rp-cases-comment-edit-actions">'
      +   '<button type="button" class="rt-btn rp-cases-comment-edit-cancel">Cancel</button>'
      +   '<button type="button" class="rt-btn rt-btn--accent rp-cases-comment-edit-save">Save</button>'
      + '</div>';
    bodyEl.insertAdjacentElement("afterend", form);
    const ta = form.querySelector("textarea");
    ta.value = raw;
    ta.focus();
  }
  function exitCommentEdit(wrap) {
    wrap.querySelector(".rp-cases-comment-edit-form")?.remove();
    const bodyEl = wrap.querySelector(".rp-cases-comment-body");
    if (bodyEl) bodyEl.hidden = false;
  }
  commentsList?.addEventListener("click", async (e) => {
    const wrap = e.target.closest(".rp-cases-comment");
    if (!wrap || !currentDetailRid) return;
    const cmtRid = wrap.dataset.cmtRid;
    if (!cmtRid) return;
    const base = "/cases/" + encodeURIComponent(currentDetailRid)
      + "/comments/" + encodeURIComponent(cmtRid);

    if (e.target.closest(".rp-cases-comment-edit")) {
      enterCommentEdit(wrap);
      return;
    }
    if (e.target.closest(".rp-cases-comment-edit-cancel")) {
      exitCommentEdit(wrap);
      return;
    }
    if (e.target.closest(".rp-cases-comment-edit-save")) {
      const ta = wrap.querySelector(".rp-cases-comment-edit-input");
      const next = (ta?.value || "").trim();
      const prev = wrap.querySelector(".rp-cases-comment-body pre")?.textContent || "";
      if (!next || next === prev) { exitCommentEdit(wrap); return; }
      try {
        await api.patch(base, { body: next });
        await loadCaseDetail(currentDetailRid);   // re-render shows the "edited" flag
      } catch (err) {
        alert("Couldn't save edit" + (err?.status ? " (" + err.status + ")" : ""));
      }
      return;
    }
    if (e.target.closest(".rp-cases-comment-delete")) {
      if (!confirm("Delete this comment? This cannot be undone.")) return;
      try {
        await api.delete(base);
        await loadCaseDetail(currentDetailRid);
      } catch (err) {
        alert("Couldn't delete comment" + (err?.status ? " (" + err.status + ")" : ""));
      }
      return;
    }
  });

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
