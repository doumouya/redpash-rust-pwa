/* Purpose: framework Comment-view component — thread + rich composer (rp-comment-* / rp-composer-*).
   Doc: docs/internal/code/frontend/scripts/framework/comments.md */
// ── Comment view (framework component, CAS_37B2E1BF, manifest B5) ────────────
// A de-cased port of the Cases comment thread + composer into ONE reusable
// component (Em: "We could decide to use a Comment view somewhere else one day,
// don't specify rp-cases"). Render-first: emits the full rp-comment-* /
// rp-composer-* DOM from a plain comments array so the sandbox proves the view
// rebuilds from framework parts. Behaviour (send / edit / mention / drag-drop)
// wires at the cases-detail cutover when cases.js delegates here; the MARKUP
// CONTRACT lives in this module + framework/styles/comments.css.
//
// Composes shared atoms — does NOT redefine them:
//   • rp-avatar (A5) for the author chip; the --sm size + deterministic
//     data-c colour land when A5 folds in rp-cases-user-avatar.
//   • rp-btn-icon (A1) for the inline edit-form Save/Cancel (CSS only here).
// Date/body rendering is injectable (opts.fmtClock / dayKey / dayLabel /
// renderBody) with safe defaults, so the component carries no page coupling and
// the sandbox renders sample data with zero external wiring.
//
// SECURITY: every author/name/date/file field is escaped via esc() before it
// reaches innerHTML. The ONLY raw-HTML path is a comment's `bodyHtml` (rich
// formatting), which is the caller's pre-sanitized output — same defence-in-depth
// contract as the legacy cases.js (sanitizeRichHtml runs before store AND on
// render). The default renderBody escapes plain `body`; the cases-detail cutover
// passes its sanitizeRichHtml as opts.renderBody. Never feed unsanitized HTML in.
"use strict";

import { register } from "/scripts/framework/component-registry.js";
import { esc } from "/scripts/dom.js";

// ── avatar — composes the rp-avatar atom (A5) ───────────────────────────────
const AVATAR_COLORS = ["blue", "mauve", "peach", "green", "teal"];
function avatarColor(key) {
  const k = String(key || "");
  let h = 0;
  for (let i = 0; i < k.length; i++) h = ((h << 5) - h + k.charCodeAt(i)) | 0;
  return AVATAR_COLORS[Math.abs(h) % AVATAR_COLORS.length];
}
function initials(name) {
  return String(name || "").split(/\s+/).filter(Boolean).slice(0, 2)
    .map((s) => s.charAt(0).toUpperCase()).join("") || "·";
}
function avatarHTML(rid, displayName) {
  const name = displayName || rid || "—";
  return '<span class="rp-avatar rp-avatar--sm" data-c="' + avatarColor(rid || name) + '"'
    + ' title="' + esc(name) + '">' + esc(initials(name)) + '</span>';
}

// ── injectable defaults (decoupled from the cases page) ─────────────────────
function defaultRenderBody(cm) {
  if (cm.bodyHtml != null) return cm.bodyHtml;          // SECURITY: caller-sanitized rich HTML only
  return cm.body ? '<p>' + esc(cm.body) + '</p>' : '';  // safe default — plain text, escaped
}
function defaultClock(ts) { try { return new Date(ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }); } catch (e) { return ""; } }
function defaultDayKey(ts) { try { return new Date(ts).toISOString().slice(0, 10); } catch (e) { return "—"; } }
function defaultDayLabel(ts) { try { return new Date(ts).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" }); } catch (e) { return "—"; } }

function roleLabel(authorId, reporterId, assigneeId) {
  if (!authorId) return "";
  if (authorId === reporterId) return "Reporter";
  if (authorId === assigneeId) return "Assignee";
  return "";
}

// ── thread ──────────────────────────────────────────────────────────────────
function fileCardHTML(att) {
  const name = att.name || "file";
  return '<span class="rp-comment-file" title="' + esc(name) + '">'
    + '<i class="bi ' + esc(att.icon || "bi-file-earmark") + ' rp-comment-file-icon"></i>'
    + '<span class="rp-comment-file-name">' + esc(name) + '</span>'
    + (att.sizeLabel ? '<span class="rp-comment-file-size">' + esc(att.sizeLabel) + '</span>' : '')
    + '</span>';
}

function commentHTML(cm, ctx) {
  const rid = cm.redpash_id || cm.rid || "";
  const author = cm.author_display_name || cm.author_id || "—";
  const isOwn = cm.author_id && cm.author_id === ctx.me;
  const when = cm.created_at ? ctx.fmtClock(cm.created_at) : "";
  const role = roleLabel(cm.author_id, ctx.reporterId, ctx.assigneeId);
  const atts = Array.isArray(cm.attachments) ? cm.attachments : [];
  const filesHTML = atts.length ? '<div class="rp-comment-files">' + atts.map(fileCardHTML).join("") + '</div>' : '';
  const bodyHTML = ctx.renderBody(cm) || '';
  const actions = isOwn
    ? '<div class="rp-comment-actions">'
      +   '<button type="button" class="rp-comment-edit" title="Edit"><i class="bi bi-pencil"></i></button>'
      +   '<button type="button" class="rp-comment-delete" title="Delete"><i class="bi bi-trash3"></i></button>'
      + '</div>'
    : '';
  return '<div class="rp-comment' + (isOwn ? ' rp-comment--own' : '') + '" data-cmt-rid="' + esc(rid) + '">'
    +   avatarHTML(cm.author_id, author)
    +   '<div class="rp-comment-bubble">'
    +     '<header class="rp-comment-head">'
    +       '<span class="rp-comment-author">' + esc(author) + '</span>'
    +       (role ? '<span class="rp-comment-role is-' + role.toLowerCase() + '">' + role + '</span>' : '')
    +       (when ? '<span class="rp-comment-date">' + esc(when) + '</span>' : '')
    +       (cm.is_edited ? '<span class="rp-comment-edited">edited</span>' : '')
    +     '</header>'
    +     '<div class="rp-comment-body">' + bodyHTML + '</div>'
    +     filesHTML
    +     actions
    +   '</div>'
    + '</div>';
}

// Walk comments in created_at order, inserting a centered day-divider whenever
// the calendar date changes (first divider always shows the first comment's day).
function threadHTML(comments, ctx) {
  let lastDay = null, out = "";
  for (const cm of comments) {
    const day = cm.created_at ? ctx.dayKey(cm.created_at) : "—";
    if (day !== lastDay) {
      out += '<div class="rp-comment-day"><span>' + esc(ctx.dayLabel(cm.created_at)) + '</span></div>';
      lastDay = day;
    }
    out += commentHTML(cm, ctx);
  }
  return out;
}

// ── composer ─────────────────────────────────────────────────────────────────
const TOOLBAR = [
  { cmd: "bold",   icon: "bi-type-bold",   title: "Bold (⌘B)" },
  { cmd: "italic", icon: "bi-type-italic", title: "Italic (⌘I)" },
  { cmd: "link",   icon: "bi-link-45deg",  title: "Link (⌘K)" },
  { cmd: "code",   icon: "bi-code",        title: "Inline code" },
  { sep: true },
  { cmd: "ul",     icon: "bi-list-ul",     title: "Bulleted list" },
  { cmd: "ol",     icon: "bi-list-ol",     title: "Numbered list" },
  { cmd: "quote",  icon: "bi-quote",       title: "Quote" },
];

function composerHTML(placeholder, sendingAs) {
  const tools = TOOLBAR.map((t) => t.sep
    ? '<span class="rp-composer-sep" aria-hidden="true"></span>'
    : '<button type="button" data-cmd="' + t.cmd + '" title="' + esc(t.title) + '"><i class="bi ' + t.icon + '"></i></button>'
  ).join("");
  return '<form class="rp-comment-form">'
    +   '<div class="rp-composer">'
    +     '<div class="rp-composer-toolbar" role="toolbar" aria-label="Formatting">' + tools + '</div>'
    +     '<div class="rp-composer-input" contenteditable="true" role="textbox" aria-multiline="true"'
    +       ' data-placeholder="' + esc(placeholder) + '"></div>'
    +     '<div class="rp-composer-pending" hidden></div>'
    +     '<div class="rp-composer-foot">'
    +       '<button class="rp-composer-attach" type="button" title="Attach files to this message"><i class="bi bi-paperclip"></i><span>Attach</span></button>'
    +       '<span class="rp-composer-as">Replying as <strong>' + esc(sendingAs || "you") + '</strong></span>'
    +       '<button class="rp-comment-send" type="submit" title="Send (⌘↵)" disabled><i class="bi bi-send-fill"></i><span>Send</span></button>'
    +     '</div>'
    +     '<div class="rp-composer-drop" hidden><i class="bi bi-paperclip"></i> Drop files to attach</div>'
    +   '</div>'
    +   '<p class="rp-comment-error" hidden></p>'
    + '</form>';
}

/**
 * Render a comment view (thread + composer) into `host`.
 * @param {Element} host
 * @param {{comments?:Array, me?:string, reporterId?:string, assigneeId?:string,
 *          composer?:boolean, placeholder?:string, sendingAs?:string,
 *          renderBody?:Function, fmtClock?:Function, dayKey?:Function, dayLabel?:Function}} [opts]
 */
export function mountComments(host, opts = {}) {
  if (!host) return;
  const ctx = {
    me: opts.me || null,
    reporterId: opts.reporterId || null,
    assigneeId: opts.assigneeId || null,
    renderBody: opts.renderBody || defaultRenderBody,
    fmtClock: opts.fmtClock || defaultClock,
    dayKey: opts.dayKey || defaultDayKey,
    dayLabel: opts.dayLabel || defaultDayLabel,
  };
  const comments = Array.isArray(opts.comments) ? opts.comments : [];
  const thread = comments.length
    ? threadHTML(comments, ctx)
    : '<p class="rp-empty">No comments yet.</p>';
  host.innerHTML =
      '<div class="rp-comment-list">' + thread + '</div>'
    + (opts.composer === false ? ''
        : composerHTML(opts.placeholder || "Write a reply…  ⌘↵ to send · drag files here to attach", opts.sendingAs));
  return host;
}

register("comments", mountComments);
