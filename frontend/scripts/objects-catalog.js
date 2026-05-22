// Shared catalog of object types shown on the Objects page.
//
// Two consumers:
//   • objects.js  — renders the customizable tab strip from the user's
//                   saved `prefs.objects_tabs` list.
//   • profile.js  — the "Object tabs" settings control (a mirror of the
//                   same preference).
//
// Both write the SAME pref (`users.prefs.objects_tabs`, via rpSavePref),
// so the inline ×/+ on the Objects page and the Settings control stay in
// sync. When the backend grows more entity types (events / cases /
// companies / visualizations — see the redpash_id prefix system in
// docs), add a row here and both surfaces pick it up.
//
// `key` matches the SCHEMAS keys in objects.js and the catalog `data-key`
// attributes in settings.html.
//
// Reports & Dashboards are NOT object types — per the locked object model
// they're derived views (a project's chart-files / dashboard-files), not
// browsable entities. Removed as Objects tabs 2026-05-22;
// normalizeObjectTabs() below drops them from any stored pref.

export const OBJECT_TAB_CATALOG = [
  { key: "projects",   label: "Projects",   icon: "bi-folder2-open" },
  { key: "files",      label: "Files",      icon: "bi-file-earmark-text" },
  { key: "companies",  label: "Companies",  icon: "bi-building" },
  { key: "users",      label: "Users",      icon: "bi-people-fill" },
];

// Canonical key list, in catalog order. Also the default tab set (a user
// with no saved preference sees every object type).
export const OBJECT_TAB_KEYS = OBJECT_TAB_CATALOG.map((c) => c.key);

// Normalise a stored `objects_tabs` pref into a clean ordered key list.
// Drops unknown keys (catalog may have shrunk), preserves the user's
// order, de-dupes, and falls back to the full catalog when the result
// would be empty — every user always sees at least one object type.
export function normalizeObjectTabs(raw) {
  if (Array.isArray(raw)) {
    const seen = new Set();
    const valid = raw.filter((k) =>
      OBJECT_TAB_KEYS.includes(k) && !seen.has(k) && seen.add(k),
    );
    if (valid.length) return valid;
  }
  return [...OBJECT_TAB_KEYS];
}
