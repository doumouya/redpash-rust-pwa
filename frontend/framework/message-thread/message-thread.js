/* message-thread — a channel's message feed + a Markdown composer. Each body is
   rendered through the SAFE markdown renderer (never raw HTML). While mounted it
   POLLS `GET /api/messages?channel&after=<cursor>` for new messages (P1 — SSE
   replaces polling in P2) and marks the channel read. The composer is the
   `textarea` atom + a Write/Preview toggle + a formatting toolbar (wraps/prefixes
   the selection with Markdown) + Send → `POST /api/messages`. Sole owner of .rp-mt-*.

   mountMessageThread(host, { channelId, session }) -> { destroy } */

import { el } from "../boot/dom.js";
import { api } from "../boot/api.js";
import { button, textarea } from "../atoms/atoms.js";
import { mountEmptyState } from "../empty-state/empty-state.js";
import { renderMarkdown } from "../markdown/markdown.js";
import { fmtDateTime, initials } from "../boot/format.js";
import { toast } from "../toast/toast.js";
import { register } from "../registry/component-registry.js";

const POLL_MS = 4000;

// toolbar edits over the <textarea> selection.
function wrap(ta, before, after) {
  const s = ta.selectionStart ?? ta.value.length;
  const e = ta.selectionEnd ?? ta.value.length;
  ta.value = ta.value.slice(0, s) + before + ta.value.slice(s, e) + after + ta.value.slice(e);
  ta.focus();
}
function prefixLines(ta, prefix) {
  const s = ta.selectionStart ?? 0;
  const e = ta.selectionEnd ?? 0;
  const start = ta.value.lastIndexOf("\n", s - 1) + 1;
  const block = ta.value.slice(start, e).split("\n").map((l) => prefix + l).join("\n");
  ta.value = ta.value.slice(0, start) + block + ta.value.slice(e);
  ta.focus();
}

export function mountMessageThread(host, { channelId, session } = {}) {
  void session;
  const root = el("div", { class: "rp-mt" });
  const feed = el("div", { class: "rp-mt-feed" });
  const composer = el("div", { class: "rp-mt-composer" });
  root.append(feed, composer);
  host.append(root);

  let cursor = null;            // last seen message created_at (poll cursor)
  let timer = null;
  let alive = true;
  let busy = false;
  const seen = new Set();       // message rids already rendered (poll dedup)

  function addMessage(m) {
    if (!m || !m.rid || seen.has(m.rid)) return;
    seen.add(m.rid);
    feed.append(el("div", { class: "rp-mt-msg" },
      el("div", { class: "rp-mt-avatar" }, initials(m.author_id)),
      el("div", { class: "rp-mt-msg-body" },
        el("div", { class: "rp-mt-msg-meta" },
          el("span", { class: "rp-mt-author" }, m.author_id || "Unknown"),
          el("span", { class: "rp-mt-time" }, fmtDateTime(m.created_at))),
        renderMarkdown(m.body || ""))));
    if (m.created_at) cursor = m.created_at;
    feed.scrollTop = feed.scrollHeight;
  }
  function emptyFeed() {
    feed.replaceChildren();
    const h = el("div", { class: "rp-mt-empty" });
    feed.append(h);
    mountEmptyState(h, { title: "No messages yet", line: "Start the conversation below." });
  }
  function markRead() {
    if (!channelId || !cursor) return;
    api.post(`/channels/${channelId}/read`, { at: cursor }).catch(() => {});
  }
  async function pull(initial) {
    if (!channelId) { if (initial) emptyFeed(); return; }
    let out;
    try {
      out = await api.get(`/messages?channel=${channelId}${cursor ? `&after=${encodeURIComponent(cursor)}` : ""}`);
    } catch {
      if (initial && !seen.size) emptyFeed(); // BE absent / error → empty-state on first load
      return;
    }
    if (!alive) return;
    const rows = Array.isArray(out) ? out : (out?.rows || out?.items || []);
    if (initial && !rows.length && !seen.size) { emptyFeed(); return; }
    if (rows.length && feed.querySelector(".rp-mt-empty")) feed.replaceChildren();
    rows.forEach(addMessage);
    if (rows.length) markRead();
  }

  // ── composer: Write/Preview · toolbar · textarea · Send ─────────────────────
  const ta = textarea({ placeholder: "Write a message…  (Markdown supported)", rows: 3 });
  const preview = el("div", { class: "rp-mt-preview" });
  preview.hidden = true;

  const tool = (icon, title, fn) => button({ icon, title, variant: "ghost", size: "sm", onClick: fn });
  const toolbar = el("div", { class: "rp-mt-toolbar" },
    tool("bi-type-bold", "Bold", () => wrap(ta, "**", "**")),
    tool("bi-type-italic", "Italic", () => wrap(ta, "_", "_")),
    tool("bi-code", "Code", () => wrap(ta, "`", "`")),
    tool("bi-link-45deg", "Link", () => wrap(ta, "[", "](https://)")),
    tool("bi-list-ul", "List", () => prefixLines(ta, "- ")),
    tool("bi-quote", "Quote", () => prefixLines(ta, "> ")));

  const writeTab = button({ label: "Write", variant: "ghost", size: "sm", onClick: () => setMode("write") });
  const previewTab = button({ label: "Preview", variant: "ghost", size: "sm", onClick: () => setMode("preview") });
  function setMode(m) {
    const w = m !== "preview";
    writeTab.classList.toggle("is-active", w);
    previewTab.classList.toggle("is-active", !w);
    ta.hidden = !w; toolbar.hidden = !w;
    preview.hidden = w;
    if (!w) preview.replaceChildren(renderMarkdown(ta.value.trim() || "_Nothing to preview_"));
  }

  const send = button({
    label: "Send", icon: "bi-send", variant: "accent",
    onClick: async () => {
      if (busy) return;
      const body = ta.value.trim();
      if (!body) { toast({ message: "Message is empty", tone: "danger" }); return; }
      busy = true; send.disabled = true;
      try {
        const m = await api.post("/messages", { channel_id: channelId, body });
        if (feed.querySelector(".rp-mt-empty")) feed.replaceChildren();
        addMessage(m);
        ta.value = ""; setMode("write");
      } catch (e) {
        toast({ message: e.message || "Couldn't send the message", tone: "danger" });
      } finally { busy = false; send.disabled = false; }
    },
  });

  composer.append(
    el("div", { class: "rp-mt-composer-head" },
      el("div", { class: "rp-mt-tabs" }, writeTab, previewTab), toolbar),
    ta, preview,
    el("div", { class: "rp-mt-composer-actions" }, send));
  setMode("write");

  pull(true);
  timer = setInterval(() => { if (alive) pull(false); }, POLL_MS);

  return { destroy: () => { alive = false; if (timer) clearInterval(timer); root.remove(); } };
}

register("message-thread", mountMessageThread);
