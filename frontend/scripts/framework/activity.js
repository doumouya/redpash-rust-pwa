/* Purpose: rp-activity — reusable activity-timeline atom. Renders an event
   feed as a connected vertical timeline: a kind-toned marker (or actor
   avatar), the action text with an optional status pill, and a relative
   timestamp. De-cased from the per-page cases.js feed so any page (Cases,
   Monitoring, an audit trail) mounts the same component.
   Doc: docs/internal/code/frontend/scripts/framework/activity.md */
"use strict";

import { register } from "/scripts/framework/component-registry.js";
import { esc } from "/scripts/dom.js";

// kind (first word of the de-prefixed kind) → tone. Drives both the marker
// dot colour and the rp-status pill state. Unmapped kinds render neutral.
const TONE = {
  done: "ok", resolved: "ok", closed: "ok", created: "ok", uploaded: "ok",
  status: "info", assigned: "info", reopened: "info", moved: "info", edited: "info",
  priority: "warn", deleted: "warn", error: "warn", failed: "warn",
};
// tone → the rp-status atom's state class (its 3 tokenized tints).
const PILL = { ok: "is-active", info: "is-new", warn: "is-lapsed" };

function initials(name) {
  const parts = String(name || "").trim().split(/\s+/).slice(0, 2);
  return parts.map((w) => w[0] || "").join("").toUpperCase() || "?";
}

// Relative label ("now" / "5m" / "2h" / "3d" / "Jun 5"); the <time> element's
// title + datetime carry the absolute value for hover + machine-readability.
function relTime(ts) {
  const then = ts ? new Date(ts).getTime() : NaN;
  if (Number.isNaN(then)) return "—";
  const s = Math.max(0, (Date.now() - then) / 1000);
  if (s < 60) return "now";
  if (s < 3600) return Math.floor(s / 60) + "m";
  if (s < 86400) return Math.floor(s / 3600) + "h";
  if (s < 2592000) return Math.floor(s / 86400) + "d";
  return new Date(ts).toLocaleDateString([], { month: "short", day: "numeric" });
}

function kindLabel(kind) {
  return String(kind || "").replace(/^case_/, "").replace(/_/g, " ").trim();
}

function eventHTML(e) {
  const label = kindLabel(e.kind);
  const tone = TONE[label.split(" ")[0]] || "";
  const actorName = e.actor && (e.actor.name || (typeof e.actor === "string" ? e.actor : ""));

  // Lead marker: an actor avatar when we have one, else a kind-toned dot.
  const lead = actorName
    ? '<span class="rp-avatar" aria-hidden="true">' + esc(initials(actorName)) + "</span>"
    : '<span class="rp-activity-dot"' + (tone ? ' data-tone="' + tone + '"' : "") + ' aria-hidden="true"></span>';

  // Optional status pill for the event kind (status/priority/etc.).
  const pill = label
    ? ' <span class="rp-status' + (PILL[tone] ? " " + PILL[tone] : "") + '">' + esc(label) + "</span>"
    : "";

  return (
    '<li class="rp-activity-event">' +
    lead +
    '<div class="rp-activity-body">' +
    '<p class="rp-activity-text">' +
    (actorName ? "<b>" + esc(actorName) + "</b> " : "") +
    esc(e.message || label || "event") +
    pill +
    "</p>" +
    '<time class="rp-activity-time" datetime="' + esc(e.occurred_at || "") +
    '" title="' + esc(e.occurred_at || "") + '">' + relTime(e.occurred_at) + "</time>" +
    "</div>" +
    "</li>"
  );
}

/**
 * Mount an activity timeline into `host`.
 * @param {HTMLElement} host
 * @param {{ events?: Array<{ kind?: string, occurred_at?: string, message?: string,
 *           actor?: { name: string } | string }>, empty?: string }} [opts]
 * @returns {{ update: (next: { events?: Array<object> }) => void }}
 */
export function mountActivity(host, opts = {}) {
  const emptyMsg = opts.empty || "No activity yet";
  const render = (events) =>
    events && events.length
      ? '<ol class="rp-activity">' + events.map(eventHTML).join("") + "</ol>"
      : '<p class="rp-activity-empty">' + esc(emptyMsg) + "</p>";

  host.innerHTML = render(opts.events || []);
  return {
    update(next = {}) { host.innerHTML = render(next.events || []); },
  };
}

register("activity", mountActivity);
