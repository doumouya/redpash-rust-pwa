/* Purpose: Head framework component — the object/surface header bar (id pill, editable title, delete, close).
   Doc: docs/internal/code/frontend/scripts/framework/head.md */
// ── Head (framework component, CAS_37B2E1BF) ────────────────────────────────
// The surface HEADER bar that sits at the top of an object detail surface (the
// open-case <aside>, and — after cutover — modal / shell / doc heads as ancestor-
// scoped context variants). A flex row of: an optional object-id RID pill
// (click-to-copy), the object title (optionally click-to-edit), and optional
// right-edge actions (delete button + close link).
//
// Generic + data-driven: mountHead(host, config) emits the whole rp-head-*
// structure from a plain config of demo-able data + handlers — pages supply the
// config, the builder owns the structure + behavior ("lego brick"). It is the
// framework consolidation of the live cases.js header (the authored
// rp-cases-detail-head markup + its copy/edit/delete wiring).
//
// Composes, not duplicates:
//   - rp-mono-pill.is-copyable atom (atoms.css A10) for the object-id RID pill —
//     click-to-copy with the .is-copied flash. The only delta vs the atom is a
//     flex-shrink:0 context tweak (in head.css).
//   - rp-title atom (atoms.css A6) for the heading — the base owns margin/weight/
//     font/color; the .rp-head context adds flex:1 + truncation + click-to-edit +
//     the .is-editing ring (all in head.css, never a duplicate class).
//   - rp-btn-icon--sq atom variant (atoms.css) for BOTH the delete <button> and
//     the close <a> — the --sq variant is the 1.75rem SQUARE shape (the legacy
//     .rp-btn-icon--sq the delete/close actually used; the rp-btn-icon base is the
//     wider .rp-btn-icon pill). The destructive-hover tint on delete is a .rp-head
//     context override (head.css), not a new class.
"use strict";

import { register } from "/scripts/framework/component-registry.js";
import { esc } from "/scripts/dom.js";

// ── config shape (every field optional) ──────────────────────────────────────
//   objectId    : string                 → rp-object-id RID pill (click-to-copy);
//                                           omitted = no pill (e.g. modal/shell head)
//   title       : string                 → rp-title heading text ("Loading…" default)
//   editable    : bool                   → title is click-to-edit (contenteditable)
//   onTitleEdit : (newTitle) => void     → commit handler (Enter / blur), only when
//                                           the value changed + is non-empty
//   onDelete    : () => void             → renders the rp-object-delete trash button
//                                           + calls this on click; omitted = no button
//   closeHash   : string                 → renders the rp-object-close <a href=…>;
//                                           omitted = no close link. The Esc-key path
//                                           is a PAGE concern (global handler), not here.
//   shortenId   : (id) => string         → optional display-shortener for the RID
//                                           (full id stays in the copy + title attr)
// The close is purely declarative (<a href>); the hash router does the hide.

const COPIED_MS = 1200;

/** Build + wire the head into `host`. `host` becomes the `.rp-head` element. */
export function mountHead(host, config = {}) {
  if (!host) return null;
  const c = config;
  const fullId = c.objectId != null ? String(c.objectId) : "";
  const shortId = fullId && typeof c.shortenId === "function" ? c.shortenId(fullId) : fullId;

  host.className = "rp-head";
  host.innerHTML =
      idHTML(fullId, shortId)
    + titleHTML(c)
    + deleteHTML(c)
    + closeHTML(c);

  // ── id pill — click / Enter / Space copies the full id to the clipboard ────
  const idEl = fullId ? host.querySelector(".rp-object-id") : null;
  if (idEl) {
    idEl.setAttribute("role", "button");
    idEl.setAttribute("tabindex", "0");
    const copy = () => copyId(idEl, fullId, shortId);
    idEl.addEventListener("click", copy);
    idEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); copy(); }
    });
  }

  // ── title — click-to-edit (contenteditable), commit on Enter/blur ──────────
  const titleEl = host.querySelector(".rp-title");
  if (titleEl && c.editable) {
    titleEl.addEventListener("click", () => {
      if (titleEl.classList.contains("is-editing")) return;
      startTitleEdit(titleEl, c.onTitleEdit);
    });
  }

  // ── delete — confirm, then hand off to the page's handler ──────────────────
  const deleteEl = host.querySelector(".rp-object-delete");
  if (deleteEl && typeof c.onDelete === "function") {
    deleteEl.addEventListener("click", () => {
      const name = titleEl ? titleEl.textContent.trim() : "";
      const ok = window.confirm(
        name ? 'Delete "' + name + '"? This cannot be undone.' : "Delete this item? This cannot be undone.");
      if (ok) c.onDelete();
    });
  }
  // Close is pure declarative <a href> — no JS handler needed.

  return {
    el: host,
    /** Replace the displayed title text (e.g. after an async load). */
    setTitle(title) {
      if (!titleEl) return;
      titleEl.textContent = title == null ? "" : String(title);
    },
  };
}

// ── section renderers (pure HTML, all dynamic content via esc()) ──────────────

function idHTML(fullId, shortId) {
  if (!fullId) return "";
  // rp-mono-pill atom + .is-copyable affordance; .rp-object-id is the head's
  // role hook (context: flex-shrink:0). title documents the click-to-copy.
  return '<span class="rp-mono-pill is-copyable rp-object-id" '
    + 'title="' + esc(fullId) + ' — click to copy">' + esc(shortId) + '</span>';
}

function titleHTML(c) {
  // rp-title atom; .rp-head context grows + truncates it. data-editable marks
  // the click-to-edit affordance (cursor:text) without a duplicate class.
  const text = c.title != null ? String(c.title) : "Loading…";
  const editable = c.editable
    ? ' data-editable="true" spellcheck="false"'
    : "";
  return '<h1 class="rp-title" title=""' + editable + '>' + esc(text) + '</h1>';
}

function deleteHTML(c) {
  if (typeof c.onDelete !== "function") return "";
  // rp-btn-icon atom owns the box; .rp-object-delete adds the destructive hover
  // (a .rp-head context override in head.css), NOT a duplicate shape.
  return '<button type="button" class="rp-btn-icon rp-btn-icon--sq rp-object-delete" title="Delete">'
    + '<i class="bi bi-trash3"></i></button>';
}

function closeHTML(c) {
  if (!c.closeHash) return "";
  // rp-btn-icon atom as an <a> (it already handles text-decoration:none + anchor
  // use). Declarative href = the hash router clears the detail; Esc is a global
  // page handler, not this component.
  return '<a class="rp-btn-icon rp-btn-icon--sq rp-object-close" href="' + esc(c.closeHash) + '" '
    + 'title="Close (Esc)"><i class="bi bi-x-lg"></i></a>';
}

// ── id copy — write to clipboard, flash .is-copied, restore after a beat ──────
function copyId(idEl, fullId, shortId) {
  const restore = () => {
    idEl.classList.remove("is-copied");
    idEl.textContent = shortId;
  };
  const flash = () => {
    idEl.classList.add("is-copied");
    idEl.textContent = "Copied";
    window.setTimeout(restore, COPIED_MS);
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(fullId).then(flash, flash);
  } else {
    flash();
  }
}

// ── title inline-edit — contenteditable, commit on Enter/blur, revert on Esc ──
function startTitleEdit(titleEl, onCommit) {
  const original = titleEl.textContent;
  titleEl.classList.add("is-editing");
  titleEl.setAttribute("contenteditable", "plaintext-only");
  titleEl.focus();
  // select-all so a re-type replaces the whole title
  const sel = window.getSelection && window.getSelection();
  if (sel && document.createRange) {
    const range = document.createRange();
    range.selectNodeContents(titleEl);
    sel.removeAllRanges();
    sel.addRange(range);
  }

  let done = false;
  const finish = (save) => {
    if (done) return;
    done = true;
    titleEl.removeAttribute("contenteditable");
    titleEl.classList.remove("is-editing");
    const clear = window.getSelection && window.getSelection();
    if (clear) clear.removeAllRanges();
    const value = titleEl.textContent.trim();
    if (save && value && value !== original) {
      titleEl.textContent = value;
      onCommit?.(value);
    } else {
      titleEl.textContent = original;
    }
    titleEl.removeEventListener("keydown", onKey);
    titleEl.removeEventListener("blur", onBlur);
  };
  const onKey = (e) => {
    if (e.key === "Enter") { e.preventDefault(); finish(true); }
    // stopPropagation so the page-level Esc panel-close doesn't also fire.
    else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); finish(false); }
  };
  const onBlur = () => finish(true);
  titleEl.addEventListener("keydown", onKey);
  titleEl.addEventListener("blur", onBlur);
}

register("head", mountHead);
