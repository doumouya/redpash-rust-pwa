/* Purpose: generic overlay modal — head + field form + foot (rp-modal-*), used by create-action + confirms.
   Doc: docs/internal/code/frontend/scripts/framework/modal.md */
// ── Modal (framework component, CAS_37B2E1BF — S4 support) ───────────────────
// One generic dialog that dedups the bespoke .rp-modal-* dialogs (cases-create,
// home-create, settings-chart, monitoring). The CSS atom (.rp-modal-*) already
// lives in styles/modal.css and is already rp- compliant + loaded by main.css —
// so this is a JS-only component that COMPOSES those classes + the rp-btn-icon /
// rp-btn atoms (the legacy markup used rp-btn-icon--sq / rp-btn-icon in the dialog; the
// framework version uses the atoms).
//
// Two entry points share one markup builder:
//   • mountModal(host, opts)  → render the dialog VISIBLE into host (sandbox /
//     embedded use); self-registers as "modal".
//   • openModal(opts)         → the OVERLAY: append a hidden-then-shown dialog to
//     <body>, wire ESC / backdrop / close / cancel, return { el, close }.
// create-action.js (S4) calls openModal for kind:"modal" create specs.
//
// SECURITY: every title/label/placeholder/hint/value is esc()'d before innerHTML;
// field VALUES are read from the live inputs on submit (never interpolated).
"use strict";

import { register } from "/scripts/framework/component-registry.js";
import { esc } from "/scripts/dom.js";

// ── one field → an rp-modal-field (label + input|textarea|select) ────────────
function fieldHTML(f, idBase) {
  const id = idBase + "-" + f.key;
  const req = f.required ? " required" : "";
  const ph = f.placeholder ? ' placeholder="' + esc(f.placeholder) + '"' : "";
  const ac = f.autocomplete ? ' autocomplete="' + esc(f.autocomplete) + '"' : "";
  let control;
  if (f.type === "textarea") {
    control = '<textarea class="rp-modal-textarea" id="' + id + '" name="' + esc(f.key) + '" rows="' + (f.rows || 5) + '"' + req + ph + ac + '></textarea>';
  } else if (f.type === "select") {
    control = '<select class="rp-modal-input" id="' + id + '" name="' + esc(f.key) + '"' + req + '>'
      + (f.options || []).map((o) => '<option value="' + esc(o.value) + '">' + esc(o.label != null ? o.label : o.value) + '</option>').join("")
      + '</select>';
  } else {
    control = '<input class="rp-modal-input" id="' + id + '" name="' + esc(f.key) + '" type="' + esc(f.type || "text") + '"' + req + ph + ac + ' />';
  }
  return '<div class="rp-modal-field">'
    + '<label class="rp-modal-label" for="' + id + '">' + esc(f.label || f.key) + '</label>'
    + control
    + (f.hint ? '<p class="rp-modal-hint">' + esc(f.hint) + '</p>' : "")
    + '</div>';
}

/** The inner .rp-modal markup (head + form + foot). idBase namespaces field ids. */
export function modalHTML(opts = {}, idBase = "rp-modal") {
  const fields = Array.isArray(opts.fields) ? opts.fields : [];
  return '<div class="rp-modal-backdrop" data-modal-dismiss="1"></div>'
    + '<div class="rp-modal-body">'
    +   '<header class="rp-modal-head">'
    +     '<h2 class="rp-modal-title">' + esc(opts.title || "") + '</h2>'
    +     '<button class="rp-btn-icon rp-modal-close" type="button" data-modal-dismiss="1" title="Close"><i class="bi bi-x-lg"></i></button>'
    +   '</header>'
    +   '<form class="rp-modal-form" novalidate>'
    +     '<div class="rp-modal-content rp-modal-fields">' + fields.map((f) => fieldHTML(f, idBase)).join("") + '</div>'
    +     '<p class="rp-modal-error" hidden></p>'
    +     '<footer class="rp-modal-foot">'
    +       '<button class="rp-btn rp-btn--glass" type="button" data-modal-dismiss="1">' + esc(opts.cancelLabel || "Cancel") + '</button>'
    +       '<button class="rp-btn rp-btn-icon--accent rp-modal-submit" type="submit">'
    +         (opts.submitIcon ? '<i class="bi ' + esc(opts.submitIcon) + '"></i> ' : "")
    +         esc(opts.submitLabel || "Save")
    +       '</button>'
    +     '</footer>'
    +   '</form>'
    + '</div>';
}

// Gather { name: value } from the form's named controls.
function readValues(formEl) {
  const out = {};
  if (!formEl) return out;
  formEl.querySelectorAll("[name]").forEach((el) => { out[el.name] = el.value; });
  return out;
}

// Wire dismiss (backdrop/close/cancel) + submit on a rendered .rp-modal element.
function wire(el, opts, close) {
  el.querySelectorAll("[data-modal-dismiss]").forEach((d) => d.addEventListener("click", close));
  const form = el.querySelector(".rp-modal-form");
  if (form && opts.onSubmit) {
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const errEl = el.querySelector(".rp-modal-error");
      try {
        await opts.onSubmit(readValues(form), { el, close });
        close();
      } catch (err) {
        if (errEl) { errEl.textContent = (err && err.message) || "Something went wrong."; errEl.hidden = false; }
      }
    });
  }
}

/** Render the dialog VISIBLE into `host` (sandbox / embedded). Returns { el }. */
export function mountModal(host, opts = {}) {
  if (!host) return null;
  host.classList.add("rp-modal");
  host.removeAttribute("hidden");
  host.setAttribute("role", "dialog");
  host.setAttribute("aria-modal", "true");
  host.innerHTML = modalHTML(opts, (host.id || "rp-modal"));
  wire(host, opts, () => { /* embedded: no-op close (host stays) */ });
  return { el: host };
}

/** Open the dialog as a body overlay. ESC / backdrop / close / cancel dismiss it. */
export function openModal(opts = {}) {
  const el = document.createElement("div");
  el.className = "rp-modal";
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-modal", "true");
  el.innerHTML = modalHTML(opts);
  document.body.appendChild(el);
  const onKey = (e) => { if (e.key === "Escape") close(); };
  function close() {
    document.removeEventListener("keydown", onKey);
    el.remove();
    if (opts.onClose) opts.onClose();
  }
  document.addEventListener("keydown", onKey);
  wire(el, opts, close);
  const first = el.querySelector(".rp-modal-input, .rp-modal-textarea");
  if (first) first.focus();
  return { el, close };
}

register("modal", mountModal);
