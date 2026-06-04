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

const TONES = { accent: "accent", ok: "ok", warn: "warn", soon: "soon", neutral: "" };

function toneVariant(t) { return TONES[t] != null ? TONES[t] : ""; }
function innerHTML(o) {
  return (o.icon ? '<i class="bi ' + esc(o.icon) + '"></i>' : '') + esc(o.label != null ? o.label : '');
}

/** Inline badge markup. @param {{label:string, tone?:string, icon?:string}} o */
export function badgeHTML(o = {}) {
  const v = toneVariant(o.tone);
  return '<span class="rp-badge"' + (v ? ' data-variant="' + v + '"' : '') + '>' + innerHTML(o) + '</span>';
}

/** Render a badge into `host` (host becomes the badge). @returns {{el:Element}} */
export function mountBadge(host, opts = {}) {
  if (!host) return null;
  const v = toneVariant(opts.tone);
  host.className = "rp-badge";
  if (v) host.setAttribute("data-variant", v);
  host.innerHTML = innerHTML(opts);
  return { el: host };
}

register("badge", mountBadge);
