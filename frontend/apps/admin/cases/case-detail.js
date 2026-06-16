/* admin/cases — the case detail + comment thread (Phase C-1). Opened as a full
   record view (surface swap) from a Cases-table row click. Reads GET
   /api/cases/:rid → { case, comments, activity, attachments } and posts a comment
   via POST /api/cases/:rid/comments. Read-only properties + attachments for now;
   status-change / inline-edit / upload / kanban are later slices (the backend
   already supports them). Page-scoped (.pg-admin-cases-detail-*); composes
   framework atoms + empty-state + toast — no framework-class literals.

   mountCaseDetail(host, { rid, onBack }) -> { destroy } */

import { api } from "../../../framework/boot/api.js";
import { el } from "../../../framework/boot/dom.js";
import { button, badge, textarea } from "../../../framework/atoms/atoms.js";
import { mountEmptyState } from "../../../framework/empty-state/empty-state.js";
import { toast } from "../../../framework/toast/toast.js";
import { fmtDateTime } from "../../../framework/boot/format.js";

// two-letter avatar from an id (CAS_… / USR_… → strip the type prefix).
const initials = (id) => String(id || "?").replace(/^[A-Z]+_/, "").slice(0, 2).toUpperCase();
// the kanban stages → badge tone.
const STATUS_TONE = {
  backlog: "", todo: "info", in_progress: "accent", in_review: "warn",
  done: "ok", new: "info", closed: "ok",
};

export function mountCaseDetail(host, { rid, onBack }) {
  const root = el("div", { class: "pg-admin-cases-detail" });
  host.append(root);
  let alive = true;

  const prop = (k, v) =>
    el("div", { class: "pg-admin-cases-detail-prop" },
      el("span", { class: "pg-admin-cases-detail-prop-k" }, k),
      el("span", { class: "pg-admin-cases-detail-prop-v" }, v == null || v === "" ? "—" : String(v)));

  const commentEl = (c) =>
    el("div", { class: "pg-admin-cases-detail-comment" },
      el("div", { class: "pg-admin-cases-detail-avatar" }, initials(c.author_id)),
      el("div", { class: "pg-admin-cases-detail-cbody" },
        el("div", { class: "pg-admin-cases-detail-cmeta" },
          el("span", { class: "pg-admin-cases-detail-cauthor" }, c.author_id || "Unknown"),
          el("span", { class: "pg-admin-cases-detail-ctime" }, fmtDateTime(c.created_at))),
        el("div", { class: "pg-admin-cases-detail-ctext" }, c.body || "")));

  (async () => {
    let data;
    try {
      data = await api.get(`/cases/${rid}`);
    } catch (e) {
      if (!alive) return;
      root.replaceChildren(
        button({ icon: "bi-arrow-left", label: "Back", variant: "ghost", size: "sm", onClick: () => onBack?.() }));
      mountEmptyState(root, { title: "Couldn't load the case", line: e.message || "The case detail did not answer." });
      return;
    }
    if (!alive) return;
    const c = data.case || {};
    const comments = data.comments || [];
    const activity = data.activity || [];
    const attachments = data.attachments || [];

    // ── header ──
    const header = el("div", { class: "pg-admin-cases-detail-head" },
      button({ icon: "bi-arrow-left", label: "Back", variant: "ghost", size: "sm", onClick: () => onBack?.() }),
      el("h2", { class: "pg-admin-cases-detail-title" }, c.title || rid),
      badge({ label: c.status || "—", tone: STATUS_TONE[c.status] ?? "" }));

    // ── left: the comment thread ──
    const thread = el("div", { class: "pg-admin-cases-detail-thread" },
      el("h3", { class: "pg-admin-cases-detail-h3" }, "Comments"));
    const feed = el("div", { class: "pg-admin-cases-detail-feed" });
    thread.append(feed);
    if (comments.length) comments.forEach((cm) => feed.append(commentEl(cm)));
    else mountEmptyState(feed, { title: "No comments yet", line: "Be the first to comment on this case." });

    // composer
    let busy = false;
    const ta = textarea({ placeholder: "Write a comment…", rows: 3 });
    const send = button({
      label: "Comment", variant: "accent",
      onClick: async () => {
        if (busy) return;
        const body = ta.value.trim();
        if (!body) { toast({ message: "Comment can't be empty", tone: "danger" }); return; }
        busy = true; send.disabled = true;
        try {
          const cm = await api.post(`/cases/${rid}/comments`, { body });
          if (!feed.querySelector(".pg-admin-cases-detail-comment")) feed.replaceChildren(); // clear the empty-state
          feed.append(commentEl(cm));
          ta.value = "";
        } catch (e) {
          toast({ message: e.message || "Couldn't post the comment", tone: "danger" });
        } finally { busy = false; send.disabled = false; }
      },
    });
    thread.append(el("div", { class: "pg-admin-cases-detail-composer" },
      ta, el("div", { class: "pg-admin-cases-detail-composer-actions" }, send)));

    // ── right: properties · attachments · activity ──
    const aside = el("div", { class: "pg-admin-cases-detail-aside" },
      el("h3", { class: "pg-admin-cases-detail-h3" }, "Properties"),
      prop("Type", c.type), prop("Status", c.status), prop("Source", c.source),
      prop("Assignee", c.assignee_id), prop("Created", fmtDateTime(c.created_at)),
      el("h3", { class: "pg-admin-cases-detail-h3" }, "Attachments"));
    if (attachments.length) {
      attachments.forEach((a) => aside.append(prop(a.filename || "file", a.size != null ? `${a.size} bytes` : "")));
    } else {
      aside.append(el("p", { class: "pg-admin-cases-detail-muted" }, "None"));
    }
    aside.append(el("h3", { class: "pg-admin-cases-detail-h3" }, "Activity"));
    if (activity.length) {
      activity.forEach((ev) => aside.append(
        el("div", { class: "pg-admin-cases-detail-act" },
          el("span", { class: "pg-admin-cases-detail-act-text" }, ev.summary || ev.message || ev.kind || "event"),
          el("span", { class: "pg-admin-cases-detail-act-time" }, fmtDateTime(ev.at || ev.created_at)))));
    } else {
      aside.append(el("p", { class: "pg-admin-cases-detail-muted" }, "No activity yet"));
    }

    root.replaceChildren(header, el("div", { class: "pg-admin-cases-detail-body" }, thread, aside));
  })();

  return { destroy: () => { alive = false; root.remove(); } };
}
