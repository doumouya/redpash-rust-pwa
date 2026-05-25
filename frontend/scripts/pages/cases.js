// Cases — rail + (kanban board | case detail) surface.
//
// Workstream spec: docs/internal/jira-flow-proposition/proposition.md.
// v1 scope: cases + comments tables, kanban (5 columns), detail page,
// agent migration from /Internal-Slack/. The detail page's activity
// feed is a direct port of Monitoring's M-2 UserActivity render shape
// — same `events` table, same `.rt-mon-row-expandable` atom for the
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

const STATUS_ORDER = ["backlog", "todo", "in_progress", "in_review", "done"];
const STATUS_LABEL = {
  backlog:     "Backlog",
  todo:        "Todo",
  in_progress: "In progress",
  in_review:   "In review",
  done:        "Done",
};
const PRIORITY_LABEL = {
  low: "Low", medium: "Medium", high: "High", critical: "Critical",
};
const TYPE_LABEL = {
  task: "Task", bug: "Bug", feature: "Feature", epic: "Epic",
};

// Status → color token name for the rail group's .rt-group-mark.
// Same mapping the column accent stripe uses (cases.css) so the
// rail mark + column stripe + status chip read as one palette.
const RAIL_MARK_COLOR = {
  backlog:     "mute",
  todo:        "blue",
  in_progress: "mauve",
  in_review:   "peach",
  done:        "green",
};

// Done-window filter — caps the Done column / rail group to
// recently-closed cases so the productivity view stays focused.
// Default "day" (today's closed). Persisted via the `casesDoneWindow`
// registered pref (prefs.js) so it survives reloads + syncs per-user.
// Edge: we use updated_at as the proxy for "closed at" — accurate
// for the common case (Done cases rarely get edits), wrong if a Done
// case gets its description edited months after closing. The honest
// fix is a closed_at column on cases or a derived value from the
// events table; queued for Gus's lane.
const DONE_WINDOW_MS = {
  day:   86_400_000,         // 24h
  week:  604_800_000,        // 7d
  month: 2_592_000_000,      // 30d
  all:   Infinity,
};
const DONE_WINDOW_LABEL = {
  day:   "Today",
  week:  "Week",
  month: "Month",
  all:   "All",
};
const DONE_WINDOW_ORDER = ["day", "week", "month", "all"];

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
  let activityFilter = "all";                  // sticky per-mount; per-case mem only
  let lastDetailActivity = [];                 // memoized for filter pill re-render
  let currentDetailCase = null;                // for the primary advance button

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
    // Board is ALWAYS rendered now — the detail panel slides over
    // it as an overlay (Em's call vs the Salesforce full-page swap).
    detailEl.hidden = !rid;
    if (rid) loadCaseDetail(rid);
    if (cachedCases.length) paintBoard(cachedCases);
    paintRail(cachedCases, rid);
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

  // Cards are <a href="#/cases?id=…"> anchors — browser handles
  // the navigation for ordinary clicks (and middle-click → new tab,
  // and keyboard activation). The delegate only intercepts the
  // cycle-status chevron: preventDefault stops the nav, then we
  // PATCH the next status.
  colsHost?.addEventListener("click", (e) => {
    const cycleBtn = e.target.closest(".rp-cases-card-cycle");
    if (!cycleBtn) return;
    e.preventDefault();
    e.stopPropagation();
    const card = cycleBtn.closest(".rp-cases-card");
    if (card) cycleStatus(card.dataset.rid, card.dataset.status);
  });

  // Rail click delegate — handles group-head expand/collapse and the
  // Done-window chip-row. Case tabs are <a> anchors so the browser
  // handles those clicks for free.
  railBody?.addEventListener("click", (e) => {
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
    if (status) {
      railGroupExpanded[status] = !group.classList.contains("expanded");
      group.classList.toggle("expanded", railGroupExpanded[status]);
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
  const railEl       = app.querySelector("#rp-cases-rail");
  const railCollapse = app.querySelector("#rp-cases-rail-collapse");
  railCollapse?.addEventListener("click", () => {
    if (!railEl) return;
    railEl.classList.toggle("compact");
    const compact = railEl.classList.contains("compact");
    const icon = railCollapse.querySelector("i");
    if (icon) {
      icon.classList.toggle("bi-chevron-double-left", !compact);
      icon.classList.toggle("bi-chevron-double-right", compact);
    }
    railCollapse.title = compact ? "Expand" : "Collapse";
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
    const filtered = applyDoneWindow(rows);
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
    return ''
      + '<a class="rp-cases-card" href="' + esc(href) + '" '
      +    'data-rid="' + esc(rid) + '" '
      +    'data-status="' + esc(c.status || "backlog") + '">'
      +   '<div class="rp-cases-card-head">'
      +     '<span class="rp-cases-card-rid">' + esc(rid.slice(0, 8)) + '</span>'
      +     priorityDotHTML(c.priority)
      +   '</div>'
      +   '<div class="rp-cases-card-title">' + esc(c.title || "(untitled)") + '</div>'
      +   '<div class="rp-cases-card-foot">'
      +     '<span class="rp-cases-card-assignee">' + esc(assignee) + '</span>'
      +     '<span class="rp-cases-card-age">' + esc(age) + '</span>'
      +     '<button class="rt-icon-btn rt-icon-btn--sm rp-cases-card-cycle" type="button" title="Advance status">'
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

  function paintRail(rows, activeRid) {
    if (!railBody) return;
    const filtered = applyDoneWindow(rows);
    const boardActive = !activeRid;
    const boardItem = ''
      + '<a class="rt-tab rp-cases-rail-board' + (boardActive ? ' active' : '') + '" '
      +    'href="#/cases" data-tab="board">'
      +   '<i class="rt-tab-icon bi bi-kanban"></i>'
      +   '<span class="rt-tab-name">Board</span>'
      + '</a>';

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
        ? cases.map((c) => railItemHTML(c, activeRid)).join("")
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

    railBody.innerHTML = boardItem + groupsHTML;
  }

  function railItemHTML(c, activeRid) {
    const rid = c.redpash_id || c.rid || "";
    const isActive = rid === activeRid;
    const href = "#/cases?id=" + encodeURIComponent(rid);
    return ''
      + '<a class="rt-tab rp-cases-rail-item' + (isActive ? ' active' : '') + '" '
      +    'href="' + esc(href) + '" title="' + esc(c.title || rid) + '">'
      +   priorityDotHTML(c.priority)
      +   '<span class="rt-tab-name">' + esc(c.title || "(untitled)") + '</span>'
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
  const controlsRow = app.querySelector("#rp-cases-detail-controls");
  const tabsEl     = app.querySelector("#rp-cases-detail-tabs");
  const commentsList    = app.querySelector("#rp-cases-comments-list");
  const commentForm     = app.querySelector("#rp-cases-comment-form");
  const commentInput    = app.querySelector("#rp-cases-comment-input");
  const commentSend     = app.querySelector("#rp-cases-comment-form-send");
  const commentError    = app.querySelector("#rp-cases-comment-form-error");
  const activityList    = app.querySelector("#rp-cases-activity-list");
  const detailsDl       = app.querySelector("#rp-cases-details-dl");
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
  const advanceBtn   = app.querySelector("#rp-cases-advance-btn");
  const advanceLabel = app.querySelector("#rp-cases-advance-label");
  const activityFilterEl = app.querySelector("#rp-cases-activity-filter");

  let currentDetailRid = null;
  let assigneePickerTimer = null;

  tabsEl?.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-tab]");
    if (!btn) return;
    const tab = btn.dataset.tab;
    tabsEl.querySelectorAll("button[data-tab]").forEach((b) =>
      b.classList.toggle("is-active", b.dataset.tab === tab));
    detailEl.querySelectorAll(".rp-cases-detail-tab").forEach((s) => {
      const match = s.dataset.tab === tab;
      s.hidden = !match;
      s.classList.toggle("is-active", match);
    });
  });

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

  // Primary advance button — advances current status to the next
  // in the lifecycle. Uses cycleStatus under the hood (same wrap-to-
  // backlog semantics for the Done case, which reads as "Reopen").
  advanceBtn?.addEventListener("click", () => {
    if (!currentDetailCase) return;
    cycleStatus(currentDetailRid, currentDetailCase.status || "backlog");
  });

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

  async function loadCaseDetail(rid) {
    currentDetailRid = rid;
    if (ridEl) ridEl.textContent = rid;
    if (titleEl) titleEl.textContent = "Loading…";
    if (controlsRow) controlsRow.innerHTML = "";
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
    const comments = detail?.comments || [];
    const activity = detail?.activity || detail?.events || [];

    currentDetailCase = c;                       // for the advance button
    lastDetailActivity = activity;               // memoize for filter re-render

    if (titleEl) titleEl.textContent = c.title || "(untitled)";
    // Centered at-a-glance badge row — read-only. The matching
    // editable selects + picker live in the Case details tab.
    if (controlsRow) {
      const assigneeChip = c.assignee_id
        ? '<span class="rp-cases-chip rp-cases-chip--assignee">'
            + userAvatarHTML(c.assignee_id, c.assignee_display_name, "xs")
            + '<span>' + esc(c.assignee_display_name || c.assignee_id) + '</span>'
          + '</span>'
        : '<span class="rp-cases-chip rp-cases-chip--unassigned">— unassigned —</span>';
      controlsRow.innerHTML = ''
        + statusChip(c.status)
        + priorityChip(c.priority)
        + typeChip(c.type)
        + assigneeChip;
    }
    // Description lives in the Case details tab now (renderDetailsDl);
    // dropped from the overview region per Em — the duplicate was
    // making the layout awkward.

    // Primary advance button label — verb-based, matched to the
    // current status. cycleStatus wraps Done → Backlog so the Done
    // label reads as "Reopen" (advances to backlog → user moves to
    // todo if they want).
    if (advanceBtn && advanceLabel) {
      const next = ADVANCE_LABEL[c.status] || "Advance status";
      advanceLabel.textContent = next;
      advanceBtn.disabled = !c.status;
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

    if (commentsList) {
      commentsList.innerHTML = comments.length
        ? commentsListHTML(comments)
        : '<p class="rt-empty rp-cases-empty">No comments yet. Be the first.</p>';
    }
    renderActivityList(activity);
    renderDetailsDl(c);
    // Pin to latest comment after the paint settles. requestAnimationFrame
    // so the new comment nodes are laid out before we read scrollHeight.
    requestAnimationFrame(scrollCommentsToLatest);
  }

  // Case details tab — full reference card. Renders every hydrated
  // field as a definition-list row. Mirrors what the inline meta
  // strip + info row carry, expanded (full RIDs, ISO timestamps,
  // category, error_message) for the copy / print / audit case.
  function renderDetailsDl(c) {
    if (!detailsDl) return;
    const rows = [];
    const add = (label, value) => {
      if (value === null || value === undefined || value === "") return;
      rows.push(
        '<dt>' + esc(label) + '</dt>'
        + '<dd>' + value + '</dd>'              // value pre-escaped or HTML by caller
      );
    };
    add("Case ID",     '<code>' + esc(c.redpash_id || "—") + '</code>');
    add("Title",       esc(c.title || "(untitled)"));
    add("Type",        esc(TYPE_LABEL[c.type] || c.type || "—"));
    add("Status",      esc(STATUS_LABEL[c.status] || c.status || "—"));
    add("Priority",    esc(PRIORITY_LABEL[c.priority] || c.priority || "—"));
    if (c.category_id) add("Category", '<code>' + esc(c.category_id) + '</code>');
    add("Reporter",    c.reporter_id ? userBadgeHTML(c.reporter_id, c.reporter_display_name) : "—");
    add("Assignee",    c.assignee_id ? userBadgeHTML(c.assignee_id, c.assignee_display_name) : '<span class="rp-cases-side-unassigned">— unassigned —</span>');
    if (c.project_id)  add("Project",  '<code>' + esc(c.project_id) + '</code>');
    if (c.company_id)  add("Company",  '<code>' + esc(c.company_id) + '</code>');
    add("Created",     esc(c.created_at || "—"));
    add("Updated",     esc(c.updated_at || "—"));
    if (c.description) {
      add("Description", '<pre class="rp-cases-details-pre">' + esc(c.description) + '</pre>');
    }
    if (c.error_message) {
      add("Error",     '<pre class="rp-cases-details-pre rp-cases-details-error">' + esc(c.error_message) + '</pre>');
    }
    detailsDl.innerHTML = rows.join("");
  }

  // Verb-based labels for the primary advance button. Reads as a
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

  // Activity feed filter — maps the pill choice to the case_* kinds
  // that pass through. Re-renders from the memoized last payload so
  // changing the filter doesn't re-fetch.
  const ACTIVITY_FILTERS = {
    all:        () => true,
    comments:   (e) => e.kind === "case_comment_post",
    status:     (e) => e.kind === "case_status_change",
    assignment: (e) => e.kind === "case_assignee_change",
    edits:      (e) => e.kind === "case_metadata_change"
                    || e.kind === "case_priority_change"
                    || e.kind === "case_type_change",
  };
  function renderActivityList(activity) {
    if (!activityList) return;
    const pred = ACTIVITY_FILTERS[activityFilter] || ACTIVITY_FILTERS.all;
    const filtered = activity.filter(pred);
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

  function dayKey(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "—";
    return d.getFullYear() + "-" + d.getMonth() + "-" + d.getDate();
  }
  function dayLabel(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "—";
    const today = new Date();
    const startOfDay = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const diffDays = Math.round((startOfDay(today) - startOfDay(d)) / 86_400_000);
    if (diffDays === 0) return "Today";
    if (diffDays === 1) return "Yesterday";
    if (diffDays < 7)   return d.toLocaleDateString(undefined, { weekday: "long" });
    return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric" });
  }
  function fmtClock(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  }

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

  // ── chip + format helpers ──────────────────────────────────
  function statusChip(s) {
    return '<span class="rp-cases-chip rp-cases-chip--status is-' + esc(s || "backlog") + '">'
      + esc(STATUS_LABEL[s] || s || "—") + '</span>';
  }
  function typeChip(t) {
    return '<span class="rp-cases-chip rp-cases-chip--type">'
      + esc(TYPE_LABEL[t] || t || "task") + '</span>';
  }
  function priorityChip(p) {
    return '<span class="rp-cases-chip rp-cases-chip--priority is-' + esc(p || "medium") + '">'
      + esc(PRIORITY_LABEL[p] || p || "—") + '</span>';
  }
  function fmtTime(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "—";
    return d.toLocaleString();
  }
  function fmtAge(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    const diff = Math.max(0, Date.now() - d.getTime()) / 1000;
    if (diff < 60) return Math.floor(diff) + "s";
    if (diff < 3600) return Math.floor(diff / 60) + "m";
    if (diff < 86400) return Math.floor(diff / 3600) + "h";
    return Math.floor(diff / 86400) + "d";
  }

  // ── boot ─────────────────────────────────────────────────────
  // First show the right surface (board vs detail), then fetch the
  // case list — fetch populates the rail and re-paints the board
  // once the response lands. Detail view fires its own /cases/:rid
  // fetch independently of the list call.
  renderRoute();
  refreshCases();
}
