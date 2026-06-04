/* Purpose: Avatar-upload — editable avatar (rp-avatar + camera button + file input → PATCH avatar_url).
   Doc: docs/internal/code/frontend/scripts/framework/avatar-upload.md */
// ── Avatar upload (framework, CAS_37B2E1BF — form-control set) ───────────────
// The profile-picture edit affordance the UI never exposed: wraps the rp-avatar
// atom with a camera button + hidden file input. Picks a file → opts.onFile(file)
// (the seam the Profile page wires to upload + PATCH /users {avatar_url} — backend
// ready). Shows the current picture (opts.src) or deterministic initials.
// CSS: styles/framework/avatar-upload.css.
//
// SECURITY: initials/name/colour are esc()'d. The picture URL is applied via the
// style API (NOT interpolated into an HTML/inline-style string) and accepted only
// when it is an http(s) URL — so a hostile avatar_url can't inject CSS/markup.
"use strict";

import { register } from "/scripts/framework/component-registry.js";
import { esc } from "/scripts/dom.js";

const AVATAR_COLORS = ["blue", "mauve", "peach", "green", "teal"];
function colorFor(key) {
  const k = String(key || "");
  let h = 0;
  for (let i = 0; i < k.length; i++) h = ((h << 5) - h + k.charCodeAt(i)) | 0;
  return AVATAR_COLORS[Math.abs(h) % AVATAR_COLORS.length];
}
function initialsOf(name) {
  return String(name || "").split(/\s+/).filter(Boolean).slice(0, 2)
    .map((s) => s.charAt(0).toUpperCase()).join("") || "·";
}
function safePictureUrl(src) {
  const s = String(src || "").trim();
  return /^https?:\/\//i.test(s) ? s : "";   // only http(s); reject data:/javascript:/etc.
}

/**
 * @param {Element} host
 * @param {{ name?:string, src?:string, color?:string, size?:string, onFile?:(file:File)=>void }} [opts]
 * @returns {{ el:Element, setSrc:(url:string)=>void }}
 */
export function mountAvatarUpload(host, opts = {}) {
  if (!host) return null;
  const sizeCls = opts.size === "lg" ? " rp-avatar--lg" : "";
  const name = opts.name || "";
  host.className = "rp-avatar-upload";
  host.innerHTML =
      '<span class="rp-avatar' + sizeCls + '" data-c="' + esc(opts.color || colorFor(name)) + '" title="' + esc(name) + '">'
    +   esc(initialsOf(name))
    + '</span>'
    + '<button type="button" class="rp-btn-icon rp-avatar-upload-btn" title="Change picture"><i class="bi bi-camera"></i></button>'
    + '<input type="file" accept="image/*" hidden>';

  const avatarEl = host.querySelector(".rp-avatar");
  const input = host.querySelector('input[type="file"]');

  function setSrc(url) {
    const safe = safePictureUrl(url);
    if (safe) { avatarEl.setAttribute("data-src", ""); avatarEl.style.backgroundImage = 'url("' + safe.replace(/["\\]/g, "") + '")'; }
    else { avatarEl.removeAttribute("data-src"); avatarEl.style.backgroundImage = ""; }
  }
  setSrc(opts.src);

  host.querySelector(".rp-avatar-upload-btn").addEventListener("click", () => input.click());
  input.addEventListener("change", () => {
    const f = input.files && input.files[0];
    if (f && typeof opts.onFile === "function") opts.onFile(f);
  });

  return { el: host, setSrc };
}

register("avatar-upload", mountAvatarUpload);
