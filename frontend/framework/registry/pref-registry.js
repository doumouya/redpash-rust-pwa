/* pref-registry.js — THE BEHAVIOR REGISTRY ("the third framework").
   UI is data (component-registry), objects are data (type-registry); this
   makes BEHAVIOR data: every user-customizable pref and admin-manageable
   policy is a REGISTRATION. Settings and Admin Console render themselves
   from these registrations — they never know what knobs exist.

   Definitions live here (code). Values live in the backend `settings` table,
   resolved server-side (platform → role → user) and seeded at boot from
   /api/me. Unknown stored keys pass through untouched: removing a feature
   orphans its values harmlessly.

   registerPref({key, label, group, control, options?, default, scope:'user'})
   registerPolicy({key, label, group, control, options?, default,
                   scope:'platform'|'role'|'company'})
   control: 'select' | 'toggle' | 'text' | 'multi'                       */

import { api } from "../boot/api.js";
import { getTypes } from "./type-registry.js";

const prefs = new Map();
const policies = new Map();
let resolved = {}; // server-resolved cascade, seeded at boot
let ctx = { userRid: null };
const listeners = new Set();

const LS_PREFIX = "rp-pref-";

function lsRead(key) {
  try {
    const v = localStorage.getItem(LS_PREFIX + key);
    return v === null ? undefined : JSON.parse(v);
  } catch {
    return undefined;
  }
}

function lsWrite(key, value) {
  try {
    localStorage.setItem(LS_PREFIX + key, JSON.stringify(value));
  } catch {
    /* quota/private mode — the server copy is the truth anyway */
  }
}

export function registerPref(def) {
  prefs.set(def.key, { scope: "user", ...def });
  notify(def.key);
}

export function registerPolicy(def) {
  policies.set(def.key, { scope: "platform", ...def });
  notify(def.key);
}

/** Boot seed: localStorage mirror first (instant), then the server-resolved
    cascade over it (truth). */
export function seedResolved(map, context) {
  ctx = { ...ctx, ...context };
  resolved = { ...resolved, ...(map || {}) };
  // Refresh the mirror for the FOUC keys so next boot paints right.
  for (const k of ["theme", "density", "fontsize"]) {
    if (k in resolved) lsWrite(k, resolved[k]);
  }
  notify();
}

/** The cascade: server-resolved value → localStorage mirror → registered
    default → undefined. */
export function getPref(key) {
  if (key in resolved) return resolved[key];
  const mirrored = lsRead(key);
  if (mirrored !== undefined) return mirrored;
  const def = prefs.get(key) ?? policies.get(key);
  return def ? def.default : undefined;
}

/** Optimistic set: paint now (resolved + mirror + DOM attrs), persist to the
    user scope fire-and-forget. Failures self-correct on next boot's seed. */
export function setPref(key, value) {
  resolved[key] = value;
  lsWrite(key, value);
  applyDocumentPref(key, value);
  notify(key);
  if (ctx.userRid) {
    api.put(`/settings/user/${ctx.userRid}/${key}`, { value }).catch(() => {});
  }
}

/** Admin surfaces write other scopes explicitly. Platform scope has no id —
    the route still needs a segment, so an empty id rides as `_` (the backend
    normalizes it away). */
export function setPolicy(scopeType, scopeId, key, value) {
  return api.put(`/settings/${scopeType}/${scopeId || "_"}/${key}`, { value });
}

/** The document-level prefs (theme/density/fontsize) reflect onto <html>. */
export function applyDocumentPref(key, value) {
  if (key === "theme") document.documentElement.dataset.theme = value;
  if (key === "density") {
    if (value === "default") delete document.documentElement.dataset.density;
    else document.documentElement.dataset.density = value;
  }
  if (key === "fontsize") {
    if (value === "default") delete document.documentElement.dataset.fontsize;
    else document.documentElement.dataset.fontsize = value;
  }
}

/** Registry listings — what Settings (prefs) and Admin Console (policies)
    render themselves from. Grouped, registration order preserved. */
export function listPrefs() {
  return [...prefs.values()];
}
export function listPolicies() {
  return [...policies.values()];
}

export function onPrefChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function notify(key) {
  for (const fn of listeners) fn(key);
}

/* ── prefs as a server-driven TYPE ──────────────────────────────────────────
   The pref DEFINITIONS (theme/density/fontsize/…/the app.* policies) are no
   longer registered in client JS — they're the fields of the builtin
   `preference` type, served by /api/types. Settings and the Console Policies
   section render from these (the values still resolve through the settings
   cascade on /api/me; getPref/setPref unchanged). registerPref/registerPolicy
   stay for tests + any future runtime registration, but nothing calls them at
   load anymore.

   prefDefs(scope) maps the preference type's fields → the settings-form def
   shape, for a given scope ('user' → Settings; 'platform'/'role' → policies). */
const PREF_TYPE = "preference";

function controlForField(field) {
  if (field.data_type === "bool") return "toggle";
  if (Array.isArray(field.options) && field.options.length) return "select";
  return "text";
}

function optionsForField(field) {
  const o = field.options;
  if (!Array.isArray(o)) return [];
  return o.map((x) => (typeof x === "string" ? { value: x, label: x } : x));
}

export async function prefDefs(scope = "user") {
  const types = await getTypes();
  const pref = types.find((t) => t.type_id === PREF_TYPE);
  if (!pref) return [];
  return pref.fields
    .filter((f) => (f.scope ?? "user") === scope)
    .map((f) => ({
      key: f.key,
      label: f.label,
      group: f.field_group || "General",
      control: controlForField(f),
      options: optionsForField(f),
    }));
}

/** The distinct user-pref groups (for any client that wants them without the
    rail). Server-sourced via prefDefs. */
export async function prefGroups() {
  const defs = await prefDefs("user");
  return [...new Set(defs.map((d) => d.group))];
}
