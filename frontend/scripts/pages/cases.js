/* Purpose: see doc for details.
 * Doc: docs/internal/code/frontend/scripts/pages/cases.md */
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
import { mountActivity } from "/scripts/framework/activity.js"; // rp-activity timeline

// Case-state label vocabulary + done-window filter constants
// extracted into `cases/labels.js` as slice 6 of the god-object
// decomposition (broadcast.md 00:53). Module-private to cases.js;
// promote if a future surface composes the kanban vocabulary.
import {
  STATUS_ORDER,
  STATUS_LABEL,
  PRIORITY_LABEL,
  TYPE_LABEL,
  TYPE_ICON,
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
  let currentAttachments = [];                 // last-painted case.attachments — base for attach/remove
  let pendingAttachments = [];                  // files staged in the composer, sent with the next comment
  let detailReporterId = null;                  // for the per-message Reporter/Assignee role tag
  let detailAssigneeId = null;
  let currentDetailCase = null;                 // last-painted case — feeds the property menus
  let categoriesCache = null;                   // GET /api/cases/categories, fetched once on demand

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
    const window = getPref("cases-doneWindow");
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
    const active = getPref("cases-doneWindow");
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
    pref:     "cases-activeSource",
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
  if (getPref("cases-filterAssignee") == null) setPref("cases-filterAssignee", "all");
  if (getPref("cases-filterStatus")   == null) setPref("cases-filterStatus",   "all");
  syncChipRow(chipsAssignee, getPref("cases-filterAssignee"));
  syncChipRow(chipsStatus,   getPref("cases-filterStatus"));

  chipsAssignee?.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-chip-assignee]");
    if (!btn) return;
    const next = btn.dataset.chipAssignee;
    if (next && next !== getPref("cases-filterAssignee")) {
      setPref("cases-filterAssignee", next);
      syncChipRow(chipsAssignee, next);
      refreshCases();
    }
  });
  chipsStatus?.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-chip-status]");
    if (!btn) return;
    const next = btn.dataset.chipStatus;
    if (next && next !== getPref("cases-filterStatus")) {
      setPref("cases-filterStatus", next);
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
      syncChipRow(chipsAssignee, getPref("cases-filterAssignee"));
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
      if (w && w !== getPref("cases-doneWindow")) {
        setPref("cases-doneWindow", w);
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
    if (w && w !== getPref("cases-doneWindow")) {
      setPref("cases-doneWindow", w);
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
      params.set("source", getPref("cases-activeSource") || "internal");
      // Assignee / Status chip filters — "all" = no constraint
      // (don't send the param). "mine" resolves to the caller's own
      // rid; "__unassigned__" is a sentinel the backend matches as
      // assignee_id IS NULL. Per-agent chips carry their USR_<rid>
      // directly in data-chip-assignee.
      const fa = getPref("cases-filterAssignee");
      if (fa && fa !== "all") {
        params.set("assignee", fa === "mine" ? meRid : fa);
      }
      const fs = getPref("cases-filterStatus");
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
    const age = c.updated_at ? fmtAge(c.updated_at) : "";
    const href = "#/cases?id=" + encodeURIComponent(rid);
    // Tooltip names the destination ("→ Send for review") instead of
    // the generic "Advance status" — same verb-based labels the detail
    // page's primary advance button uses, so the user sees where the
    // click is taking them. Done cycles back to backlog → "Reopen".
    const cycleLabel = ADVANCE_LABEL[c.status || "backlog"] || "Advance status";
    // Triage signal, three channels (Em 2026-05-30): priority drives the
    // left accent bar (data-priority → ::before in cases.css); type shows
    // as a colored glyph in the head; assignee is an avatar (or a muted
    // dash when unassigned) instead of a name string that ellipsised away.
    const priority = c.priority || "medium";
    const type     = c.type || "task";
    const typeIcon = TYPE_ICON[type] || TYPE_ICON.task;
    const assignee = c.assignee_id
      ? userAvatarHTML(c.assignee_id, c.assignee_display_name, "sm")
      : '<span class="rp-cases-card-unassigned" title="Unassigned">—</span>';
    return ''
      + '<a class="rp-cases-card" href="' + esc(href) + '" draggable="true" '
      +    'data-rid="' + esc(rid) + '" '
      +    'data-status="' + esc(c.status || "backlog") + '" '
      +    'data-priority="' + esc(priority) + '" '
      +    'data-title="' + esc(c.title || "(untitled)") + '" '
      +    'title="' + esc((PRIORITY_LABEL[priority] || "") + " · " + (TYPE_LABEL[type] || "")) + '">'
      +   '<div class="rp-cases-card-head">'
      +     '<span class="rp-cases-card-rid">' + esc(rid.slice(0, 8)) + '</span>'
      +     '<i class="bi ' + typeIcon + ' rp-cases-card-type is-' + esc(type) + '" '
      +        'title="' + esc(TYPE_LABEL[type] || type) + '"></i>'
      +     '<span class="rt-tab-close rp-cases-card-hide" title="Hide from board"><i class="bi bi-x"></i></span>'
      +   '</div>'
      +   '<div class="rp-title">' + esc(c.title || "(untitled)") + '</div>'
      +   '<div class="rp-cases-card-foot">'
      +     '<span class="rp-cases-card-assignee">' + assignee + '</span>'
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
  const sideCategory = app.querySelector("#rp-cases-side-category");
  const sideError    = app.querySelector("#rp-cases-side-error");
  const sideErrorPre = app.querySelector("#rp-cases-side-error-pre");
  const sideAssignee        = app.querySelector("#rp-cases-side-assignee");
  const sideAssigneeBtn     = app.querySelector("#rp-cases-side-assignee-btn");
  const sideAssigneePicker  = app.querySelector("#rp-cases-side-assignee-picker");
  const sideAssigneeInput   = app.querySelector("#rp-cases-side-assignee-input");
  const sideAssigneeResults = app.querySelector("#rp-cases-side-assignee-results");
  const sideReporter = app.querySelector("#rp-cases-side-reporter");
  const sideCreated  = app.querySelector("#rp-cases-side-created");
  const sideUpdated  = app.querySelector("#rp-cases-side-updated");
  const sideDescBody    = app.querySelector("#rp-cases-side-desc-body");
  const activityCountEl = app.querySelector("#rp-cases-side-activity-count");
  const activityFilterEl = app.querySelector("#rp-cases-activity-filter");

  // Attachments — sidebar list + the composer's paperclip affordance.
  const sideAttachments = app.querySelector("#rp-cases-side-attachments");
  const attachList      = app.querySelector("#rp-cases-attach-list");
  const attachCount     = app.querySelector("#rp-cases-side-attachments-count");
  const attachBtn       = app.querySelector("#rp-cases-comment-attach");
  const attachInput     = app.querySelector("#rp-cases-comment-attach-input");
  // Rail mirror (CAS_1E6D3B2E) — second surface for the same
  // attachments, sitting in the cases rail above the foot. Mirrors
  // the Workspace Project→Files pattern. Shares state with the
  // sidebar (currentAttachments); renderAttachments paints both.
  const railAttachWrap  = app.querySelector("#rp-cases-rail-attach");
  const railAttachList  = app.querySelector("#rp-cases-rail-attach-list");
  const railAttachCount = app.querySelector("#rp-cases-rail-attach-count");

  // Composer extras — formatting toolbar, pending-files tray, drop zone.
  const composerEl = app.querySelector("#rp-cases-composer");
  const toolbarEl  = app.querySelector("#rp-cases-composer-toolbar");
  const pendingEl  = app.querySelector("#rp-cases-composer-pending");
  const dropEl     = app.querySelector("#rp-cases-composer-drop");

  // Paperclip + drag-drop STAGE files as pending attachments — they ride
  // along with the next comment (per-message attachments), not the
  // case-level list. v1 records name/type/size (no byte upload yet).
  function stageFiles(fileList) {
    if (!fileList || !fileList.length) return;
    const now = new Date().toISOString();
    for (const f of fileList) {
      pendingAttachments.push({ name: f.name, mime: f.type || null, size: f.size, uploaded_at: now });
    }
    renderPending();
    syncComposeState();
  }
  function renderPending() {
    if (!pendingEl) return;
    pendingEl.hidden = pendingAttachments.length === 0;
    pendingEl.innerHTML = pendingAttachments.map((a, i) =>
      '<span class="rp-cases-pending-chip" data-pending-idx="' + i + '">'
      +   '<i class="bi ' + attachIcon(a.mime, a.name) + '"></i>'
      +   '<span class="rp-cases-pending-name">' + esc(a.name) + '</span>'
      +   '<span class="rp-cases-pending-size">' + esc(fmtBytes(a.size)) + '</span>'
      +   '<button type="button" class="rp-cases-pending-remove" title="Remove"><i class="bi bi-x"></i></button>'
      + '</span>').join("");
  }
  attachBtn?.addEventListener("click", () => attachInput?.click());
  attachInput?.addEventListener("change", () => { stageFiles(attachInput.files); attachInput.value = ""; });
  pendingEl?.addEventListener("click", (e) => {
    const chip = e.target.closest("[data-pending-idx]");
    if (!chip || !e.target.closest(".rp-cases-pending-remove")) return;
    pendingAttachments.splice(Number(chip.dataset.pendingIdx), 1);
    renderPending();
    syncComposeState();
  });

  // Toolbar — mousedown (not click) + preventDefault so the editor's
  // selection survives (a click would blur it + collapse the range).
  toolbarEl?.addEventListener("mousedown", (e) => {
    const btn = e.target.closest("[data-cmd]");
    if (!btn) return;
    e.preventDefault();
    applyFormat(btn.dataset.cmd, commentInput, composerEl, syncComposeState);
  });

  // Drag-and-drop files onto the composer.
  if (composerEl) {
    let dragDepth = 0;
    composerEl.addEventListener("dragenter", (e) => { e.preventDefault(); if (dragDepth++ === 0 && dropEl) dropEl.hidden = false; });
    composerEl.addEventListener("dragover",  (e) => { e.preventDefault(); });
    composerEl.addEventListener("dragleave", (e) => { e.preventDefault(); if (--dragDepth <= 0) { dragDepth = 0; if (dropEl) dropEl.hidden = true; } });
    composerEl.addEventListener("drop", (e) => {
      e.preventDefault(); dragDepth = 0; if (dropEl) dropEl.hidden = true;
      if (e.dataTransfer?.files?.length) stageFiles(e.dataTransfer.files);
    });
  }
  // Remove an attachment (event-delegated; PATCHes the filtered list).
  // Attached to BOTH surfaces (sidebar + rail mirror per CAS_1E6D3B2E)
  // so the user can remove from whichever one they're looking at.
  const onAttachRemoveClick = (e) => {
    const btn = e.target.closest(".rp-cases-attach-remove");
    if (!btn) return;
    const idx = Number(btn.closest("[data-attach-idx]")?.dataset.attachIdx);
    if (Number.isNaN(idx)) return;
    patchCase({ attachments: currentAttachments.filter((_, i) => i !== idx) });
  };
  attachList?.addEventListener("click",     onAttachRemoveClick);
  railAttachList?.addEventListener("click", onAttachRemoveClick);

  let currentDetailRid = null;
  let assigneePickerTimer = null;

  // Property value menus — Priority / Type / Category open a popover of
  // choices; picking one fires a sparse PATCH. (Assignee uses the user
  // picker below; status lives in the path hero.) Delegated click on the
  // props container; an outside click closes the open menu.
  const propsEl = app.querySelector(".rp-cases-props");
  propsEl?.addEventListener("click", (e) => {
    const btn = e.target.closest(".rp-cases-prop-val[data-prop]");
    if (!btn) return;
    e.stopPropagation();
    if (btn.classList.contains("is-menu-open")) { closePropMenu(); return; }
    openPropMenu(btn);
  });
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".rp-cases-prop-pop") && !e.target.closest(".rp-cases-prop-val[data-prop]")) closePropMenu();
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

  // Properties-panel toggle — same mechanism as the workspace panels'
  // bindPanel: the button flips .open on the side + .is-active on itself,
  // and the choice persists via the casesDetailPanel pref so it survives
  // reloads + case switches. The markup's default .open is just the
  // pre-JS state; we reconcile to the pref here at mount (the detail is
  // still hidden at this point, so no collapse animation flashes).
  const sideToggle = app.querySelector("#rp-cases-side-toggle");
  const sidePanel  = app.querySelector("#rp-cases-detail-side");
  if (sideToggle && sidePanel) {
    const setSidePanel = (open) => {
      sidePanel.classList.toggle("open", open);
      sideToggle.classList.toggle("is-active", open);
      sideToggle.setAttribute("aria-pressed", String(open));
    };
    setSidePanel(getPref("cases-detailPanel") === "open");
    sideToggle.addEventListener("click", () => {
      const open = !sidePanel.classList.contains("open");
      setSidePanel(open);
      setPref("cases-detailPanel", open ? "open" : "closed");
    });
  }

  // "Replying as X" — fills once at mount; session is constant per page.
  const commentFormAs = app.querySelector("#rp-cases-comment-form-as");
  if (commentFormAs) commentFormAs.textContent = meName;

  commentForm?.addEventListener("submit", (e) => { e.preventDefault(); sendComment(); });

  // Keyboard: ⌘↵ send · ⌘B bold · ⌘I italic · ⌘K link.
  commentInput?.addEventListener("keydown", (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (e.key === "Enter" && mod) { e.preventDefault(); sendComment(); return; }
    if (!mod) return;
    const k = e.key.toLowerCase();
    if (k === "b")      { e.preventDefault(); applyFormat("bold", commentInput, composerEl, syncComposeState); }
    else if (k === "i") { e.preventDefault(); applyFormat("italic", commentInput, composerEl, syncComposeState); }
    else if (k === "k") { e.preventDefault(); applyFormat("link", commentInput, composerEl, syncComposeState); }
  });

  // ── @mention autocomplete ───────────────────────────────────────
  // Typing "@" + a name in any rich editor (composer or inline edit)
  // opens a user menu (the same /admin/users?q= search the assignee
  // picker uses). Picking inserts a non-editable chip
  // <span class="rp-mention" data-uid="RID">@Name</span> that survives
  // sanitizeRichHtml, so the mention persists on the body + re-renders
  // as a chip in the thread. One menu element is reused across editors
  // and lives under `app` so it's torn down with the page.
  const mentionMenu = document.createElement("div");
  mentionMenu.className = "rp-mention-menu";
  mentionMenu.hidden = true;
  app.appendChild(mentionMenu);
  let mentionState = null;   // { editor, range:{node,start,end}, items, sel, after } | null
  let mentionTimer = null;

  function closeMention() {
    mentionState = null;
    mentionMenu.hidden = true;
    mentionMenu.innerHTML = "";
  }
  // Find an active "@token" right before a collapsed caret in `editor`.
  // The "@" must start a word (preceded by start-of-text or whitespace)
  // so emails (a@b) don't trigger; the query is [\w.-]* (no spaces).
  function mentionTokenAtCaret(editor) {
    const sel = window.getSelection();
    if (!sel || !sel.isCollapsed || sel.rangeCount === 0) return null;
    const r = sel.getRangeAt(0);
    const node = r.startContainer;
    if (node.nodeType !== Node.TEXT_NODE || !editor.contains(node)) return null;
    const caret = r.startOffset;
    const m = /(^|\s)@([\w.\-]*)$/.exec(node.nodeValue.slice(0, caret));
    if (!m) return null;
    return { node, start: caret - m[2].length - 1, end: caret, query: m[2] };
  }
  function positionMentionMenu(editor) {
    const sel = window.getSelection();
    let rect = sel && sel.rangeCount ? sel.getRangeAt(0).getBoundingClientRect() : null;
    if (!rect || (!rect.top && !rect.left)) rect = editor.getBoundingClientRect();
    // Open upward — the composer sits at the bottom, so a downward menu
    // would overflow the panel.
    mentionMenu.style.left = Math.round(rect.left) + "px";
    mentionMenu.style.top = "auto";
    mentionMenu.style.bottom = Math.round(window.innerHeight - rect.top + 4) + "px";
  }
  function renderMentionMenu(rows) {
    mentionMenu.innerHTML = rows.length
      ? rows.map((u, i) => {
          const label = u.display_name || u.username || u.redpash_id;
          const sub = [u.username, u.email].filter(Boolean).join(" · ");
          return '<div class="rp-user-picker-result rp-mention-item' + (i === 0 ? ' is-sel' : '') + '" '
            + 'data-user-rid="' + esc(u.redpash_id) + '" data-name="' + esc(label) + '">'
            +   '<span class="rp-user-picker-result-name">' + esc(label) + '</span>'
            +   (sub ? '<span class="rp-user-picker-result-sub">' + esc(sub) + '</span>' : '')
            + '</div>';
        }).join("")
      : '<div class="rp-ac-empty">No matches.</div>';
  }
  async function queryMentions(editor, token) {
    try {
      const data = await api.get("/admin/users?q=" + encodeURIComponent(token.query) + "&size=8");
      if (!mentionState || mentionState.editor !== editor) return;   // stale
      mentionState.items = data?.rows || [];
      mentionState.sel = 0;
      renderMentionMenu(mentionState.items);
      positionMentionMenu(editor);
      mentionMenu.hidden = false;
    } catch { closeMention(); }
  }
  function moveMentionSel(delta) {
    if (!mentionState || !mentionState.items.length) return;
    const n = mentionState.items.length;
    mentionState.sel = (mentionState.sel + delta + n) % n;
    [...mentionMenu.querySelectorAll(".rp-mention-item")].forEach((el, i) =>
      el.classList.toggle("is-sel", i === mentionState.sel));
    mentionMenu.querySelector(".is-sel")?.scrollIntoView({ block: "nearest" });
  }
  // Swap the @token range for a chip + trailing nbsp, caret after it.
  function insertMention(editor, user, after) {
    if (!mentionState) return;
    const { node, start, end } = mentionState.range;
    const r = document.createRange();
    r.setStart(node, start);
    r.setEnd(node, end);
    r.deleteContents();
    const chip = document.createElement("span");
    chip.className = "rp-mention";
    chip.setAttribute("data-uid", user.rid);
    chip.setAttribute("contenteditable", "false");
    chip.textContent = "@" + user.name;
    const space = document.createTextNode(" ");
    r.insertNode(space);
    r.insertNode(chip);
    const sel = window.getSelection();
    const caret = document.createRange();
    caret.setStartAfter(space);
    caret.collapse(true);
    sel.removeAllRanges();
    sel.addRange(caret);
    closeMention();
    if (after) after();
  }
  function attachMentionAutocomplete(editor, after) {
    if (!editor) return;
    editor.addEventListener("input", () => {
      const token = mentionTokenAtCaret(editor);
      if (!token) { if (mentionState && mentionState.editor === editor) closeMention(); return; }
      mentionState = { editor, range: token, items: [], sel: 0, after };
      clearTimeout(mentionTimer);
      mentionTimer = setTimeout(() => queryMentions(editor, token), 160);
    });
    // Capture phase → pre-empt the editor's own Enter/⌘ handlers while
    // the menu is open.
    editor.addEventListener("keydown", (e) => {
      if (!mentionState || mentionState.editor !== editor || mentionMenu.hidden) return;
      if (e.key === "ArrowDown")      { e.preventDefault(); e.stopImmediatePropagation(); moveMentionSel(1); }
      else if (e.key === "ArrowUp")   { e.preventDefault(); e.stopImmediatePropagation(); moveMentionSel(-1); }
      else if (e.key === "Escape")    { e.preventDefault(); e.stopImmediatePropagation(); closeMention(); }
      else if (e.key === "Enter" || e.key === "Tab") {
        const it = mentionState.items[mentionState.sel];
        if (!it) { closeMention(); return; }
        e.preventDefault(); e.stopImmediatePropagation();
        insertMention(editor, { rid: it.redpash_id, name: it.display_name || it.username || it.redpash_id }, mentionState.after);
      }
    }, true);
    editor.addEventListener("blur", () =>
      setTimeout(() => { if (mentionState && mentionState.editor === editor) closeMention(); }, 120));
  }
  // mousedown (not click) so the editor keeps focus through the pick.
  mentionMenu.addEventListener("mousedown", (e) => {
    const item = e.target.closest(".rp-mention-item");
    if (!item || !mentionState) return;
    e.preventDefault();
    insertMention(mentionState.editor, { rid: item.dataset.userRid, name: item.dataset.name }, mentionState.after);
  });
  attachMentionAutocomplete(commentInput, syncComposeState);

  // Send is live when there's text OR a staged file. The contentEditable
  // grows on its own — no manual autosize. textContent (not innerHTML)
  // so an empty editor holding only a stray <br> still reads as blank.
  function composerHasContent() {
    return (commentInput?.textContent || "").trim().length > 0 || pendingAttachments.length > 0;
  }
  function syncComposeState() {
    if (commentSend) commentSend.disabled = !composerHasContent();
    if (commentError && !commentError.hidden) { commentError.hidden = true; commentError.textContent = ""; }
  }
  commentInput?.addEventListener("input", syncComposeState);

  function showComposeError(msg) {
    if (!commentError) return;
    commentError.textContent = msg;
    commentError.hidden = false;
  }

  function clearComposer() {
    if (commentInput) commentInput.innerHTML = "";
    pendingAttachments = [];
    renderPending();
    syncComposeState();
  }

  // Serialize + sanitize the editor, then post. A files-only message
  // (no prose) is valid — body sent as "".
  function sendComment() {
    if (!currentDetailRid) return;
    const hasText = (commentInput?.textContent || "").trim().length > 0;
    if (!hasText && pendingAttachments.length === 0) return;
    const body = hasText ? sanitizeRichHtml(commentInput?.innerHTML || "") : "";
    postComment(body, pendingAttachments.slice());
  }

  // ── rich-text formatting (execCommand-driven WYSIWYG) ──────────
  // Generalized over a target editor + its container so both the comment
  // composer and the description editor share one toolbar. `after` runs
  // post-format (e.g. the composer's send-state sync); no-op for desc.
  function applyFormat(cmd, ed, container, after) {
    ed = ed || commentInput;
    container = container || composerEl;
    if (!ed) return;
    ed.focus();
    switch (cmd) {
      case "bold":   document.execCommand("bold"); break;
      case "italic": document.execCommand("italic"); break;
      case "ul":     document.execCommand("insertUnorderedList"); break;
      case "ol":     document.execCommand("insertOrderedList"); break;
      case "quote":  document.execCommand("formatBlock", false, "blockquote"); break;
      case "code":   document.execCommand("insertHTML", false,
                       "<code>" + esc((window.getSelection()?.toString()) || "code") + "</code>"); break;
      case "link":   openLinkPopover(ed, container, after); return;  // commits async
    }
    if (after) after();
  }
  // Link popover — text + URL form anchored in the editor's container, so
  // customers get "see the docs", not a raw URL. Restores the selection
  // before inserting. Missing scheme defaults to https://.
  function openLinkPopover(ed, container, after) {
    ed = ed || commentInput;
    container = container || composerEl;
    if (!container || !ed) return;
    container.querySelector(".rp-cases-link-pop")?.remove();
    const sel = window.getSelection();
    const range = sel && sel.rangeCount ? sel.getRangeAt(0).cloneRange() : null;
    const selText = sel ? sel.toString() : "";
    const pop = document.createElement("div");
    pop.className = "rp-cases-link-pop";
    pop.innerHTML = ''
      + (selText ? '' : '<input class="rp-cases-link-text" type="text" placeholder="Link text" />')
      + '<input class="rp-cases-link-url" type="text" placeholder="https://…" />'
      + '<button type="button" class="rp-cases-link-add">Add</button>'
      + '<button type="button" class="rp-cases-link-cancel">Cancel</button>';
    container.appendChild(pop);
    const urlInput  = pop.querySelector(".rp-cases-link-url");
    const textInput = pop.querySelector(".rp-cases-link-text");
    (textInput || urlInput).focus();
    const close = () => pop.remove();
    const commit = () => {
      let url = (urlInput.value || "").trim();
      if (!url) { close(); return; }
      if (!/^(https?:|mailto:)/i.test(url)) url = "https://" + url;
      const text = selText || (textInput && textInput.value.trim()) || url;
      ed.focus();
      if (range) { const s = window.getSelection(); s.removeAllRanges(); s.addRange(range); }
      if (selText && range) document.execCommand("createLink", false, url);
      else document.execCommand("insertHTML", false, '<a href="' + esc(url) + '">' + esc(text) + '</a>');
      close();
      if (after) after();
    };
    pop.querySelector(".rp-cases-link-add").addEventListener("click", commit);
    pop.querySelector(".rp-cases-link-cancel").addEventListener("click", close);
    pop.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); commit(); }
      else if (e.key === "Escape") { e.preventDefault(); close(); }
    });
  }

  // Whitelist-rebuild sanitizer — the comment body is stored + rendered
  // as HTML, so both the editor output (on send) and the stored value
  // (on render) pass through here. Rebuilds a clean tree: only allowed
  // tags survive (disallowed ones are unwrapped, keeping their text);
  // only <a href> with a safe scheme is kept, forced to open in a new
  // tab with noopener. No attributes, no script/style/event vectors.
  function sanitizeRichHtml(html) {
    const ALLOWED = {
      B: 1, STRONG: 1, I: 1, EM: 1, U: 1, CODE: 1, PRE: 1,
      UL: 1, OL: 1, LI: 1, BLOCKQUOTE: 1, BR: 1, P: 1, DIV: 1, A: 1,
    };
    const src = document.createElement("template");
    src.innerHTML = html || "";
    const build = (node, dest) => {
      node.childNodes.forEach((n) => {
        if (n.nodeType === Node.TEXT_NODE) {
          dest.appendChild(document.createTextNode(n.nodeValue));
        } else if (n.nodeType === Node.ELEMENT_NODE) {
          // Mention chip — span.rp-mention carrying the user rid. Rebuilt
          // with only safe attrs + its text (no nested markup), so an
          // @mention persists on the stored body and re-renders as a chip.
          if (n.tagName === "SPAN" && n.classList.contains("rp-mention")) {
            const m = document.createElement("span");
            m.className = "rp-mention";
            const uid = n.getAttribute("data-uid");
            if (uid) m.setAttribute("data-uid", uid);
            m.setAttribute("contenteditable", "false");
            m.textContent = n.textContent;
            dest.appendChild(m);
          } else if (ALLOWED[n.tagName]) {
            const el = document.createElement(n.tagName);
            if (n.tagName === "A") {
              const href = n.getAttribute("href") || "";
              if (/^(https?:|mailto:)/i.test(href)) {
                el.setAttribute("href", href);
                el.setAttribute("target", "_blank");
                el.setAttribute("rel", "noopener noreferrer nofollow");
              }
            }
            build(n, el);
            dest.appendChild(el);
          } else {
            build(n, dest);     // unwrap disallowed tag, keep its cleaned children
          }
        }
      });
    };
    const out = document.createElement("div");
    build(src.content, out);
    return out.innerHTML.trim();
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
        sideAssigneeResults.innerHTML = '<div class="rp-ac-empty">No matches.</div>';
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
      sideAssigneeResults.innerHTML = '<div class="rp-ac-empty">Couldn’t search'
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

  // ── rich description edit ───────────────────────────────────
  // Pencil → swap the rendered body for a rich editor (same WYSIWYG as
  // comments: toolbar + contentEditable + sanitizer + shared link
  // popover) prefilled with the current HTML. Save sanitizes + PATCHes;
  // patchCase's repaint re-renders from the server response.
  const descEditBtn = app.querySelector("#rp-cases-side-desc-edit-btn");
  let descEditing = false;
  function descCurrentHtml() {
    if (!sideDescBody) return "";
    return sideDescBody.querySelector(".rp-cases-side-unassigned") ? "" : sideDescBody.innerHTML;
  }
  function openDescEdit() {
    if (descEditing || !sideDescBody) return;
    descEditing = true;
    sideDescBody.hidden = true;
    if (descEditBtn) descEditBtn.hidden = true;
    const form = document.createElement("div");
    form.className = "rp-cases-side-desc-form";
    form.innerHTML = ''
      + '<div class="rp-cases-composer-toolbar rp-cases-desc-toolbar">'
      +   '<button type="button" data-cmd="bold" title="Bold (⌘B)"><i class="bi bi-type-bold"></i></button>'
      +   '<button type="button" data-cmd="italic" title="Italic (⌘I)"><i class="bi bi-type-italic"></i></button>'
      +   '<button type="button" data-cmd="link" title="Link (⌘K)"><i class="bi bi-link-45deg"></i></button>'
      +   '<button type="button" data-cmd="code" title="Inline code"><i class="bi bi-code"></i></button>'
      +   '<button type="button" data-cmd="ul" title="Bulleted list"><i class="bi bi-list-ul"></i></button>'
      + '</div>'
      + '<div class="rp-cases-side-desc-input" contenteditable="true" '
      +    'data-placeholder="Steps to reproduce, context, expected behavior…"></div>'
      + '<div class="rp-cases-side-desc-actions">'
      +   '<button type="button" class="rt-btn" data-act="cancel">Cancel</button>'
      +   '<button type="button" class="rt-btn rt-btn--accent" data-act="save">Save</button>'
      + '</div>';
    sideDescBody.insertAdjacentElement("afterend", form);
    const ed = form.querySelector(".rp-cases-side-desc-input");
    ed.innerHTML = descCurrentHtml();
    ed.focus();
    const close = () => { form.remove(); sideDescBody.hidden = false; if (descEditBtn) descEditBtn.hidden = false; descEditing = false; };
    const save = async () => {
      const next = sanitizeRichHtml(ed.innerHTML || "");
      const prev = descCurrentHtml();
      close();
      if (next !== prev) await patchCase({ description: next });
    };
    form.querySelector(".rp-cases-desc-toolbar").addEventListener("mousedown", (e) => {
      const btn = e.target.closest("[data-cmd]");
      if (!btn) return;
      e.preventDefault();
      applyFormat(btn.dataset.cmd, ed, form);
    });
    form.addEventListener("click", (e) => {
      if (e.target.closest('[data-act="cancel"]')) close();
      else if (e.target.closest('[data-act="save"]')) save();
    });
    ed.addEventListener("keydown", (e) => {
      const mod = e.ctrlKey || e.metaKey;
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); }
      else if (e.key === "Enter" && mod) { e.preventDefault(); save(); }
      else if (mod && e.key.toLowerCase() === "b") { e.preventDefault(); applyFormat("bold", ed, form); }
      else if (mod && e.key.toLowerCase() === "i") { e.preventDefault(); applyFormat("italic", ed, form); }
      else if (mod && e.key.toLowerCase() === "k") { e.preventDefault(); applyFormat("link", ed, form); }
    });
  }
  descEditBtn?.addEventListener("click", openDescEdit);

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

  // ── property value menus (priority / type / category) ──────────
  const PRIORITY_OPTS = [
    { value: "low",      label: "Low",      dot: true },
    { value: "medium",   label: "Medium",   dot: true },
    { value: "high",     label: "High",     dot: true },
    { value: "critical", label: "Critical", dot: true },
  ];
  const TYPE_OPTS = ["task", "bug", "feature", "epic"].map((t) =>
    ({ value: t, label: TYPE_LABEL[t] || t, icon: TYPE_ICON[t] || TYPE_ICON.task }));
  const CARET = '<i class="bi bi-chevron-down rp-cases-prop-caret"></i>';

  function priorityValHTML(p) {
    p = p || "medium";
    return '<span class="rp-cases-priority-dot is-' + esc(p) + '"></span>'
      + '<span class="rp-cases-prop-val-txt">' + esc(PRIORITY_LABEL[p] || p) + '</span>' + CARET;
  }
  function typeValHTML(t) {
    t = t || "task";
    return '<i class="bi ' + (TYPE_ICON[t] || TYPE_ICON.task) + ' rp-cases-type-glyph is-' + esc(t) + '"></i>'
      + '<span class="rp-cases-prop-val-txt">' + esc(TYPE_LABEL[t] || t) + '</span>' + CARET;
  }
  function categoryValHTML(c) {
    if (c && c.category_id) {
      const parent = c.category_parent_name ? esc(c.category_parent_name) + " › " : "";
      return '<span class="rp-cases-prop-val-txt">' + parent + esc(c.category_name || c.category_id) + '</span>' + CARET;
    }
    return '<span class="rp-cases-prop-val-txt rp-cases-side-unassigned">— none —</span>' + CARET;
  }
  // Category list — fetched once, mapped to "parent › child" labels.
  async function categoryOptions() {
    if (!categoriesCache) {
      try { const res = await api.get("/cases/categories"); categoriesCache = res.items || res || []; }
      catch { categoriesCache = []; }
    }
    const byId = {};
    categoriesCache.forEach((cat) => { byId[cat.redpash_id] = cat; });
    return categoriesCache.map((cat) => {
      const parent = cat.parent_id && byId[cat.parent_id] ? byId[cat.parent_id].name + " › " : "";
      return { value: cat.redpash_id, label: parent + cat.name };
    });
  }

  let activePropPop = null;
  function closePropMenu() {
    if (activePropPop) { activePropPop.remove(); activePropPop = null; }
    app.querySelectorAll(".rp-cases-prop-val.is-menu-open").forEach((b) => b.classList.remove("is-menu-open"));
  }
  async function openPropMenu(btn) {
    closePropMenu();
    const prop = btn.dataset.prop;
    const c = currentDetailCase || {};
    const cur = prop === "category" ? (c.category_id || "") : (c[prop] || "");
    let options;
    if (prop === "priority")      options = PRIORITY_OPTS;
    else if (prop === "type")     options = TYPE_OPTS;
    else if (prop === "category") options = await categoryOptions();
    else return;
    if (!options.length) return;
    const pop = document.createElement("div");
    pop.className = "rp-cases-prop-pop";
    pop.innerHTML = options.map((o) =>
      '<button type="button" class="rp-cases-prop-opt' + ((o.value || "") === (cur || "") ? " is-active" : "") + '" data-val="' + esc(o.value || "") + '">'
      + (o.dot ? '<span class="rp-cases-priority-dot is-' + esc(o.value) + '"></span>'
               : (o.icon ? '<i class="bi ' + o.icon + ' rp-cases-type-glyph is-' + esc(o.value || "") + '"></i>' : ''))
      + '<span class="rp-cases-prop-opt-lbl">' + esc(o.label) + '</span>'
      + ((o.value || "") === (cur || "") ? '<i class="bi bi-check2 rp-cases-prop-opt-check"></i>' : '')
      + '</button>').join("");
    btn.parentNode.appendChild(pop);          // .rp-cases-prop is position:relative
    btn.classList.add("is-menu-open");
    activePropPop = pop;
    pop.addEventListener("click", (e) => {
      const opt = e.target.closest("[data-val]");
      if (!opt) return;
      const val = opt.dataset.val;
      closePropMenu();
      if (val === cur) return;                 // no-op on re-pick
      if (prop === "category") { if (val) patchCase({ category_id: val }); }
      else patchCase({ [prop]: val });
    });
  }

  function paintDetail(detail) {
    const c = detail?.case || detail || {};
    // Stash the case's people for the per-message Reporter/Assignee tag
    // (present on both the GET-detail and PATCH shapes).
    detailReporterId = c.reporter_id || null;
    detailAssigneeId = c.assignee_id || null;
    currentDetailCase = c;                       // feeds the property value menus
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
    // Properties — colored priority pill, type glyph, category path,
    // assignee avatar. Each button opens its value menu / picker.
    if (sidePriority) sidePriority.innerHTML = priorityValHTML(c.priority);
    if (sideType)     sideType.innerHTML     = typeValHTML(c.type);
    if (sideCategory) sideCategory.innerHTML = categoryValHTML(c);
    if (sideAssignee) {
      sideAssignee.innerHTML = c.assignee_id
        ? userBadgeHTML(c.assignee_id, c.assignee_display_name)
        : '<span class="rp-cases-side-unassigned">— unassigned —</span>';
    }
    // Reporter + source badge — Internal (RedPash team) vs External (customer).
    if (sideReporter) {
      if (!c.reporter_id) {
        sideReporter.innerHTML = '—';
      } else {
        const badge = c.is_internal
          ? '<span class="rp-cases-source-badge is-internal"><i class="bi bi-people"></i>Internal</span>'
          : '<span class="rp-cases-source-badge is-external"><i class="bi bi-globe2"></i>External</span>';
        sideReporter.innerHTML = userBadgeHTML(c.reporter_id, c.reporter_display_name) + badge;
      }
    }
    // Timeline — relative, full timestamp on hover.
    if (sideCreated) { sideCreated.textContent = c.created_at ? fmtAge(c.created_at) : "—"; sideCreated.title = c.created_at ? fmtTime(c.created_at) : ""; }
    if (sideUpdated) { sideUpdated.textContent = c.updated_at ? fmtAge(c.updated_at) : "—"; sideUpdated.title = c.updated_at ? fmtTime(c.updated_at) : ""; }

    // Error payload — auto-triaged crashes carry a raw error string;
    // hidden when the case has none.
    if (sideError) {
      const em = (c.error_message || "").trim();
      sideError.hidden = !em;
      if (sideErrorPre) sideErrorPre.textContent = em;
    }

    // Description — rendered as sanitized HTML (rich); placeholder when empty.
    if (sideDescBody) {
      sideDescBody.innerHTML = c.description
        ? sanitizeRichHtml(c.description)
        : '<span class="rp-cases-side-unassigned">— no description —</span>';
    }

    // Attachments — present on both the GET detail and PATCH (bare
    // Case) shapes, so this repaints correctly after any field edit.
    renderAttachments(c.attachments);

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
  // ── attachments ─────────────────────────────────────────────
  // Case-level file references (logs, error screenshots, repro CSVs).
  // v1 is metadata-only: name + mime + size + uploaded_at. The chip
  // gets a type-glyph (image / csv / json / log / zip) + a hover ×.
  function fmtBytes(n) {
    n = Number(n) || 0;
    if (n < 1024) return n + " B";
    const u = ["KB", "MB", "GB", "TB"];
    let i = -1;
    do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
    return (n < 10 ? n.toFixed(1) : Math.round(n)) + " " + u[i];
  }
  function attachIcon(mime, name) {
    const m = (mime || "").toLowerCase();
    const ext = (name || "").split(".").pop().toLowerCase();
    if (m.startsWith("image/") || ["png", "jpg", "jpeg", "gif", "svg", "webp"].includes(ext)) return "bi-file-earmark-image";
    if (m === "text/csv" || ext === "csv") return "bi-filetype-csv";
    if (m === "application/json" || ext === "json") return "bi-filetype-json";
    if (m === "text/plain" || ["log", "txt"].includes(ext)) return "bi-file-earmark-text";
    if (["zip", "gz", "tar"].includes(ext)) return "bi-file-earmark-zip";
    return "bi-file-earmark";
  }
  function attachItemHTML(att, i) {
    const name = att.name || "file";
    return ''
      + '<li class="rp-cases-attach" data-attach-idx="' + i + '">'
      +   '<i class="bi ' + attachIcon(att.mime, name) + ' rp-cases-attach-icon"></i>'
      +   '<span class="rp-cases-attach-name" title="' + esc(name) + '">' + esc(name) + '</span>'
      +   '<span class="rp-cases-attach-size">' + esc(fmtBytes(att.size)) + '</span>'
      +   '<button type="button" class="rp-cases-attach-remove" title="Remove attachment">'
      +     '<i class="bi bi-x"></i></button>'
      + '</li>';
  }
  // Renders the sidebar list AND the rail mirror (CAS_1E6D3B2E),
  // caches the array as the base for attach/remove PATCHes. Hides
  // each surface independently when empty so the rail collapses
  // cleanly while the sidebar's container in the detail panel stays
  // a deliberate placeholder.
  function renderAttachments(list) {
    currentAttachments = Array.isArray(list) ? list : [];
    const n = currentAttachments.length;
    const itemsHTML = currentAttachments.map(attachItemHTML).join("");
    const countLabel = n ? "(" + n + ")" : "";
    if (sideAttachments) sideAttachments.hidden = n === 0;
    if (attachCount)     attachCount.textContent = countLabel;
    if (attachList)      attachList.innerHTML = itemsHTML;
    // Rail mirror — same items, same data-attach-idx so the existing
    // remove-button click delegate at attachList fires from either
    // surface (delegated below this fn to cover the rail too).
    if (railAttachWrap)  railAttachWrap.hidden = n === 0;
    if (railAttachCount) railAttachCount.textContent = countLabel;
    if (railAttachList)  railAttachList.innerHTML = itemsHTML;
    // Auto-open the rail <details> when the case has attachments so
    // the user doesn't have to click to discover them; collapses
    // naturally on cases with none (the wrap is hidden in that case).
    if (railAttachWrap && n > 0) railAttachWrap.open = true;
  }

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
  // The timeline itself is the shared rp-activity framework component
  // (mountActivity); this page owns only the filter (ACTIVITY_PILLS) and
  // hands it the filtered events. Empty-state copy stays filter-aware.
  function renderActivityList(activity) {
    if (!activityList) return;
    const pill = ACTIVITY_PILLS.find((p) => p.key === activityFilter) || ACTIVITY_PILLS[0];
    const filtered = activity.filter(pill.pred);
    const empty = activityFilter === "all"
      ? "No activity yet."
      : "No activity in this filter.";
    mountActivity(activityList, { events: filtered, empty });
  }

  // Chat-bubble layout — own author right-aligned + accent-soft tint,
  // others left-aligned + surface. Avatar sits to the outside, the
  // bubble carries author + timestamp header + body. The "you"
  // bubble drops the author name in the header since it's redundant
  // when avatar + alignment + color all signal self-authorship.
  // Role tag for the message header — distinguishes the customer
  // (Reporter) from the engineer (Assignee). Team members get no tag,
  // keeping the common case uncluttered.
  function authorRoleLabel(authorId) {
    if (!authorId) return "";
    if (authorId === detailReporterId) return "Reporter";
    if (authorId === detailAssigneeId) return "Assignee";
    return "";
  }
  // A file shared in a message — type glyph + name + size. Byte download
  // is a later slice, so it's a non-link card for now.
  function attachmentCardHTML(att) {
    const name = att.name || "file";
    return ''
      + '<span class="rp-cases-msg-file" title="' + esc(name) + ' · download coming soon">'
      +   '<i class="bi ' + attachIcon(att.mime, name) + ' rp-cases-msg-file-icon"></i>'
      +   '<span class="rp-cases-msg-file-name">' + esc(name) + '</span>'
      +   '<span class="rp-cases-msg-file-size">' + esc(fmtBytes(att.size)) + '</span>'
      + '</span>';
  }
  function commentHTML(cm) {
    const rid = cm.redpash_id || cm.rid || "";
    const author = cm.author_display_name || cm.author_id || "—";
    const isOwn = cm.author_id && cm.author_id === meRid;
    const when = cm.created_at ? fmtClock(cm.created_at) : "";
    const role = authorRoleLabel(cm.author_id);
    const atts = Array.isArray(cm.attachments) ? cm.attachments : [];
    const filesHTML = atts.length
      ? '<div class="rp-cases-msg-files">' + atts.map(attachmentCardHTML).join("") + '</div>'
      : '';
    // Body is stored as sanitized HTML; sanitize again on render (defence
    // in depth) so formatting + links render, never raw markup or script.
    const bodyHTML = cm.body ? sanitizeRichHtml(cm.body) : '';
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
      +     '<header class="rp-cases-comment-head">'
      +       '<span class="rp-cases-comment-author">' + esc(author) + '</span>'
      +       (role ? '<span class="rp-cases-comment-role is-' + role.toLowerCase() + '">' + role + '</span>' : '')
      +       (when ? '<span class="rp-cases-comment-when">' + esc(when) + '</span>' : '')
      +       (cm.is_edited ? '<span class="rp-cases-comment-edited">edited</span>' : '')
      +     '</header>'
      +     '<div class="rp-cases-comment-body">' + bodyHTML + '</div>'
      +     filesHTML
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
    const rawHtml = bodyEl.innerHTML;          // already-sanitized HTML
    bodyEl.hidden = true;
    const form = document.createElement("div");
    form.className = "rp-cases-comment-edit-form";
    form.innerHTML = ''
      + '<div class="rp-cases-comment-edit-input" contenteditable="true"></div>'
      + '<div class="rp-cases-comment-edit-actions">'
      +   '<button type="button" class="rt-btn rp-cases-comment-edit-cancel">Cancel</button>'
      +   '<button type="button" class="rt-btn rt-btn--accent rp-cases-comment-edit-save">Save</button>'
      + '</div>';
    bodyEl.insertAdjacentElement("afterend", form);
    const ed = form.querySelector(".rp-cases-comment-edit-input");
    ed.innerHTML = rawHtml;
    ed.focus();
    attachMentionAutocomplete(ed);
    // ⌘↵ saves; ⌘B/I format the focused editor via execCommand.
    ed.addEventListener("keydown", (ev) => {
      const mod = ev.ctrlKey || ev.metaKey;
      if (ev.key === "Enter" && mod) { ev.preventDefault(); form.querySelector(".rp-cases-comment-edit-save").click(); }
      else if (mod && ev.key.toLowerCase() === "b") { ev.preventDefault(); document.execCommand("bold"); }
      else if (mod && ev.key.toLowerCase() === "i") { ev.preventDefault(); document.execCommand("italic"); }
    });
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
      const ed = wrap.querySelector(".rp-cases-comment-edit-input");
      const next = sanitizeRichHtml(ed?.innerHTML || "");
      const prev = wrap.querySelector(".rp-cases-comment-body")?.innerHTML || "";
      const hasText = (ed?.textContent || "").trim().length > 0;
      if (!hasText || next === prev) { exitCommentEdit(wrap); return; }
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

  async function postComment(body, attachments) {
    if (!currentDetailRid) return;
    if (commentSend)  commentSend.disabled = true;
    if (commentInput) commentInput.setAttribute("contenteditable", "false");
    if (commentError) { commentError.hidden = true; commentError.textContent = ""; }
    try {
      await api.post("/cases/" + encodeURIComponent(currentDetailRid) + "/comments",
        { body, attachments: attachments || [] });
      clearComposer();                          // wipe text + pending files
      await loadCaseDetail(currentDetailRid);   // pulls the new comment + repaints
      scrollCommentsToLatest();                 // auto-scroll so user sees their own message
    } catch (err) {
      const msg = err?.body?.message || err?.body?.error || err?.message || "Couldn't post comment";
      showComposeError(msg + (err?.status ? " (" + err.status + ")" : ""));
    } finally {
      if (commentInput) commentInput.setAttribute("contenteditable", "true");
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
