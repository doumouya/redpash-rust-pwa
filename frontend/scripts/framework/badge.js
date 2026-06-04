/* Purpose: Badge — soft-tint label pill (plan / role / connection-state / "Soon").
   Doc: docs/internal/code/frontend/scripts/framework/badge.md */
// ── Badge (framework atom, CAS_37B2E1BF — form-control set) ──────────────────
// The passive soft-tint label pill (rp-badge, styles/framework/badge.css),
// replacing the ~4 page-local copies (profile.css plan/soon/role/conn-state).
// badgeHTML() returns the markup for inline composition (inside rp-head / a
// field / a table cell); mountBadge() fills a host. Every field esc()'d.
"use strict";

import { register } from "/scripts/framework/component-registry.js";
import { esc } from "/scripts/dom.js";

const TONES = { accent: "rp-badge--accent", ok: "rp-badge--ok", warn: "rp-badge--warn", soon: "rp-badge--soon", neutral: "" };

function toneClass(t) { return TONES[t] != null ? TONES[t] : ""; }
function innerHTML(o) {
  return (o.icon ? '<i class="bi ' + esc(o.icon) + '"></i>' : '') + esc(o.label != null ? o.label : '');
}

/** Inline badge markup. @param {{label:string, tone?:string, icon?:string}} o */
export function badgeHTML(o = {}) {
  const tone = toneClass(o.tone);
  return '<span class="rp-badge' + (tone ? " " + tone : "") + '">' + innerHTML(o) + '</span>';
}

/** Render a badge into `host` (host becomes the badge). @returns {{el:Element}} */
export function mountBadge(host, opts = {}) {
  if (!host) return null;
  const tone = toneClass(opts.tone);
  host.className = "rp-badge" + (tone ? " " + tone : "");
  host.innerHTML = innerHTML(opts);
  return { el: host };
}

register("badge", mountBadge);
