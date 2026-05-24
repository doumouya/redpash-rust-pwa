// Cases — kanban board + detail page.
//
// Workstream spec: docs/internal/jira-flow-proposition/proposition.md.
// v1 scope: cases + comments tables, kanban (5 columns), detail page,
// agent migration from /Internal-Slack/. The detail page's activity
// feed is a direct port of Monitoring's M-2 UserActivity render shape
// — same `events` table, same `.rt-mon-row-expandable` atom for the
// per-event context expander, same `redact_chain` already applied at
// the airlock.
//
// Two surfaces in one partial; the URL hash selects which renders:
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

export default function cases(app, { session }) {
  mountTopbar(app.querySelector("#rp-topbar"), { active: "cases", session });

  // Page state — module-scoped to the mount call (the router calls
  // this function fresh on each route activation).
  const boardEl  = app.querySelector("#rp-cases-board");
  const detailEl = app.querySelector("#rp-cases-detail");
  let searchQ = "";
  let searchDebounce = null;

  // ── route — board vs detail by ?id=… in the hash ────────────
  function activeCaseRid() {
    const params = new URLSearchParams(location.hash.split("?")[1] || "");
    return params.get("id") || null;
  }

  function renderRoute() {
    const rid = activeCaseRid();
    if (rid) {
      boardEl.hidden = true;
      detailEl.hidden = false;
      loadCaseDetail(rid);
    } else {
      detailEl.hidden = true;
      boardEl.hidden = false;
      loadCaseBoard();
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

  // ── board view ──────────────────────────────────────────────
  const searchInput = app.querySelector("#rp-cases-search");
  const newCaseBtn  = app.querySelector("#rp-cases-new");
  const colsHost    = app.querySelector("#rp-cases-cols");

  searchInput?.addEventListener("input", () => {
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => {
      searchQ = searchInput.value.trim();
      loadCaseBoard();
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

  async function loadCaseBoard() {
    if (!colsHost) return;
    colsHost.innerHTML = STATUS_ORDER.map((s) => columnShellHTML(s, "Loading…")).join("");
    try {
      const params = new URLSearchParams();
      params.set("size", "200");                     // pull a large window; v2 paginates per column
      if (searchQ) params.set("q", searchQ);
      const data = await api.get("/cases?" + params.toString());
      // Backend returns { items, total, page, size } per the cookbook
      // contract. The original v1 shell read `.rows` (wrong) and
      // rendered an empty board even when cases existed.
      const rows = data?.items || [];
      paintBoard(rows);
    } catch (err) {
      if (err?.status === 404) {
        // Backend not yet shipped — graceful empty state for the
        // pre-handoff window. Re-renders cleanly once Gus's
        // routes::cases lands.
        colsHost.innerHTML = STATUS_ORDER.map((s) =>
          columnShellHTML(s, s === "backlog" ? "Cases endpoint not live yet." : "—")
        ).join("");
        return;
      }
      colsHost.innerHTML = STATUS_ORDER.map((s) =>
        columnShellHTML(s, "Couldn't load cases" + (err?.status ? " (" + err.status + ")" : "") + ".")
      ).join("");
    }
  }

  function paintBoard(rows) {
    const byStatus = STATUS_ORDER.reduce((acc, s) => (acc[s] = [], acc), {});
    rows.forEach((c) => {
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
      +     '<p class="rp-cases-col-empty">' + esc(emptyText) + '</p>'
      +   '</div>'
      + '</section>';
  }

  function columnHTML(status, cards) {
    const body = cards.length
      ? cards.map(cardHTML).join("")
      : '<p class="rp-cases-col-empty">No cases.</p>';
    return ''
      + '<section class="rp-cases-col" data-status="' + status + '">'
      +   '<header class="rp-cases-col-head">'
      +     '<span class="rp-cases-col-name">' + esc(STATUS_LABEL[status]) + '</span>'
      +     '<span class="rp-cases-col-count">' + cards.length + '</span>'
      +   '</header>'
      +   '<div class="rp-cases-col-body">' + body + '</div>'
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
      +     '<button class="rp-cases-card-cycle" type="button" title="Advance status">'
      +       '<i class="bi bi-chevron-right"></i>'
      +     '</button>'
      +   '</div>'
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
      loadCaseBoard();
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
    if (e.key === "Escape" && createModal && !createModal.hidden) {
      closeCreateModal();
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
      } else {
        loadCaseBoard();
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
  const metaStrip  = app.querySelector("#rp-cases-detail-meta-strip");
  const descEl     = app.querySelector("#rp-cases-detail-description");
  const tabsEl     = app.querySelector("#rp-cases-detail-tabs");
  const commentsList    = app.querySelector("#rp-cases-comments-list");
  const commentForm     = app.querySelector("#rp-cases-comment-form");
  const commentInput    = app.querySelector("#rp-cases-comment-input");
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

  commentForm?.addEventListener("submit", (e) => {
    e.preventDefault();
    const body = (commentInput?.value || "").trim();
    if (!body || !currentDetailRid) return;
    postComment(body);
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
        sideAssigneeResults.innerHTML = '<div class="rp-user-picker-empty">No matches.</div>';
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
      sideAssigneeResults.innerHTML = '<div class="rp-user-picker-empty">Couldn’t search'
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
    if (metaStrip) metaStrip.innerHTML = "";
    if (descEl) descEl.innerHTML = "";
    if (commentsList) commentsList.innerHTML = '<p class="rp-cases-empty">Loading comments…</p>';
    if (activityList) activityList.innerHTML = '<p class="rp-cases-empty">Loading activity…</p>';
    try {
      const detail = await api.get("/cases/" + encodeURIComponent(rid));
      paintDetail(detail);
    } catch (err) {
      if (err?.status === 404) {
        if (titleEl) titleEl.textContent = "Case not found";
        if (descEl) descEl.innerHTML = '<p class="rp-cases-empty">'
          + 'Cases endpoint not live yet (backend pending) or no case with this RID.</p>';
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

    if (titleEl) titleEl.textContent = c.title || "(untitled)";
    if (metaStrip) {
      metaStrip.innerHTML = ''
        + statusChip(c.status)
        + typeChip(c.type)
        + priorityChip(c.priority);
    }
    if (descEl) {
      descEl.innerHTML = c.description
        ? '<pre>' + esc(c.description) + '</pre>'
        : '<p class="rp-cases-empty rp-cases-empty--inline">No description.</p>';
    }

    if (sideStatus && c.status)     sideStatus.value = c.status;
    if (sidePriority && c.priority) sidePriority.value = c.priority;
    if (sideType && c.type)         sideType.value = c.type;
    if (sideAssignee) sideAssignee.textContent = c.assignee_display_name || c.assignee_id || "— unassigned —";
    if (sideReporter) sideReporter.textContent = c.reporter_display_name || c.reporter_id || "—";
    if (sideCreated)  sideCreated.textContent = c.created_at ? fmtTime(c.created_at) : "—";
    if (sideUpdated)  sideUpdated.textContent = c.updated_at ? fmtTime(c.updated_at) : "—";

    if (commentsList) {
      commentsList.innerHTML = comments.length
        ? comments.map(commentHTML).join("")
        : '<p class="rp-cases-empty">No comments yet. Be the first.</p>';
    }
    if (activityList) {
      activityList.innerHTML = activity.length
        ? activity.map(activityRow).join("")
        : '<p class="rp-cases-empty">No activity yet.</p>';
    }
  }

  function commentHTML(cm) {
    const author = cm.author_display_name || cm.author_id || "—";
    const when = cm.created_at ? fmtTime(cm.created_at) : "";
    return ''
      + '<article class="rp-cases-comment">'
      +   '<header class="rp-cases-comment-head">'
      +     '<span class="rp-cases-comment-author">' + esc(author) + '</span>'
      +     '<span class="rp-cases-comment-when">' + esc(when) + '</span>'
      +     (cm.is_edited ? '<span class="rp-cases-comment-edited">(edited)</span>' : '')
      +   '</header>'
      +   '<div class="rp-cases-comment-body"><pre>' + esc(cm.body || "") + '</pre></div>'
      + '</article>';
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
    } catch (err) {
      console.warn("[cases] patch failed:", err);
    }
  }

  async function postComment(body) {
    if (!currentDetailRid) return;
    try {
      await api.post("/cases/" + encodeURIComponent(currentDetailRid) + "/comments", { body });
      if (commentInput) commentInput.value = "";
      loadCaseDetail(currentDetailRid);
    } catch (err) {
      console.warn("[cases] comment post failed:", err);
    }
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
  renderRoute();
}
