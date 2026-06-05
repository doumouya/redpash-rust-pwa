/* Purpose: see doc for details.
 * Doc: docs/internal/code/frontend/scripts/pages/settings-hidden.md */
// Settings v2 step 5 — Hidden Items recovery surface.
//
// Every page in the app lets users hide rows ("×" on a rail row, a
// rail tab's recovery section, the Cases hide control). State
// persists as unregistered prefs in localStorage:
//
//   rp-pref-rail_hidden_projects   — Workspace
//   rp-pref-rail_hidden_files      — Workspace
//   rp-pref-home_hidden_<tabKey>   — Home (one key per tab — projects,
//                                    files, charts, users, …)
//   rp-pref-cases_hidden           — Cases
//
// Today every page has its own × buried in its rail; this is the
// canonical place users come to manage everything they hid. The
// surface is read-only over the source pages — those keep writing
// the same unregistered keys, this scans + offers per-item restore
// and per-page Restore all.
//
// Deliberate non-coupling: the source pages don't know this exists.
// Adding a fourth hide-surface = the user gets to manage it here as
// long as it uses the same `rp-pref-*_hidden_*` convention.

import { esc } from "/scripts/dom.js";
import { setPref } from "/scripts/prefs.js";

// Per-page taxonomy. Each entry maps a page label to the
// localStorage-key pattern(s) that surface there.
//
//   keys: array of full pref names (the localStorage suffix after
//         `rp-pref-`). Multiple keys per page means scanning all of
//         them and concatenating their entries; restoring restores
//         from the specific key the entry came from.
//
//   keyMatcher: optional fn(prefName) -> { tabLabel?, group }
//         used when the page hides per-tab so we want to show "Home
//         · Projects · 3 items" rather than collapsing them.
const PAGE_SOURCES = [
  {
    page: "Workspace",
    icon: "bi-grid-3x3",
    keys: ["rail_hidden_projects", "rail_hidden_files"],
    keyLabel: { rail_hidden_projects: "Projects", rail_hidden_files: "Files" },
  },
  {
    page: "Home",
    icon: "bi-house",
    keyPrefix: "home_hidden_",
    // Tab key (e.g. "projects") inferred from the suffix after the
    // prefix. Pretty-label uses a small map below + title-case fallback.
    tabLabel: { projects: "Projects", files: "Files", charts: "Charts",
                cases: "Cases", users: "Users", companies: "Companies",
                teams: "Teams", memberships: "Memberships" },
  },
  {
    page: "Cases",
    icon: "bi-card-list",
    keys: ["cases_hidden"],
    keyLabel: { cases_hidden: "Cases" },
  },
];

const KEY_PREFIX = "rp-pref-";
const storageKey = (name) => KEY_PREFIX + name;

function safeParse(raw) {
  if (raw == null) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

function titleCase(s) {
  if (!s) return "";
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Scan localStorage for every hidden-key bucket; return a structured
 *  list grouped by page + sub-group (tab / kind). Cheap — bounded
 *  by the number of LS keys (a few hundred at most). */
function scanHiddenBuckets() {
  const buckets = [];
  // Pages whose keys are enumerated explicitly.
  for (const src of PAGE_SOURCES) {
    if (!src.keys && !src.keyPrefix) continue;
    if (src.keys) {
      for (const key of src.keys) {
        const items = safeParse(localStorage.getItem(storageKey(key)));
        if (!Array.isArray(items) || !items.length) continue;
        buckets.push({
          page:     src.page,
          icon:     src.icon,
          label:    src.keyLabel[key] || titleCase(key),
          prefName: key,
          items:    items,
        });
      }
    }
    if (src.keyPrefix) {
      // Enumerate every `rp-pref-<prefix>*` localStorage key.
      for (let i = 0; i < localStorage.length; i++) {
        const fullKey = localStorage.key(i);
        if (!fullKey || !fullKey.startsWith(KEY_PREFIX + src.keyPrefix)) continue;
        const prefName = fullKey.slice(KEY_PREFIX.length);
        const items = safeParse(localStorage.getItem(fullKey));
        if (!Array.isArray(items) || !items.length) continue;
        const tab = prefName.slice(src.keyPrefix.length);
        buckets.push({
          page:     src.page,
          icon:     src.icon,
          label:    src.tabLabel?.[tab] || titleCase(tab),
          prefName: prefName,
          items:    items,
        });
      }
    }
  }
  return buckets;
}

/** Render one bucket as an HTML block. Returns the HTML string. */
function renderBucket(bucket) {
  const items = bucket.items.map((item, i) => {
    const name = String(item?.name || item?.title || item?.rid || "Item " + (i + 1));
    const sub  = item?.sub ? '<span class="rp-settings__hidden-sub">' + esc(item.sub) + '</span>' : '';
    return ''
      + '<li class="rp-settings__hidden-item"'
      +   ' data-pref="' + esc(bucket.prefName) + '"'
      +   ' data-idx="' + i + '">'
      +   '<span class="rp-settings__hidden-name">' + esc(name) + '</span>'
      +   sub
      +   '<button type="button" class="rp-settings__hidden-restore"'
      +     ' title="Restore" aria-label="Restore ' + esc(name) + '">'
      +     '<i class="bi bi-arrow-counterclockwise"></i>'
      +   '</button>'
      + '</li>';
  }).join("");
  return ''
    + '<section class="rp-settings__hidden-bucket"'
    +   ' data-pref="' + esc(bucket.prefName) + '">'
    +   '<header class="rp-settings__hidden-bucket-head">'
    +     '<span class="rp-settings__hidden-bucket-icon"><i class="' + esc(bucket.icon || "bi-folder") + '"></i></span>'
    +     '<span class="rp-settings__hidden-bucket-title">'
    +       esc(bucket.page) + ' · ' + esc(bucket.label)
    +     '</span>'
    +     '<span class="rp-settings__hidden-bucket-count">' + bucket.items.length + '</span>'
    +     '<button type="button" class="rp-btn-icon rp-settings__hidden-restore-all"'
    +       ' data-pref="' + esc(bucket.prefName) + '">Restore all</button>'
    +   '</header>'
    +   '<ul class="rp-settings__hidden-list">' + items + '</ul>'
    + '</section>';
}

/** Render the empty state. */
function renderEmpty() {
  return ''
    + '<div class="rp-settings__hidden-empty">'
    +   '<i class="bi bi-eye-slash rp-settings__hidden-empty-icon"></i>'
    +   '<p class="rp-settings__hidden-empty-text">'
    +     "You haven't hidden anything yet. Use the × on a row to bury it; it lands here."
    +   '</p>'
    + '</div>';
}

/**
 * Mount the Hidden Items surface into the `[data-rp-rows="hidden"]`
 * slot. Renders a per-page grouped list with per-item × restore +
 * per-page Restore all. Click delegation lives on the section root.
 *
 *   app — the page root element.
 *
 * Returns `{ refresh() }` for tests / dev tools — useful if the
 * caller wants to re-scan after a fresh hide outside the page.
 */
export function mountHidden(app) {
  const mount = app.querySelector('[data-rp-rows="hidden"]');
  if (!mount) return null;

  // Dedicated content container so re-renders replace ONLY our
  // content, leaving the registry-rendered general-hiddenAutoPurge
  // toggle row above untouched. Pattern parallels every other
  // settings.js section render: `wrapper.innerHTML = htmlString`.
  let content = mount.querySelector(".rp-settings__hidden-content");
  if (!content) {
    content = document.createElement("div");
    content.className = "rp-settings__hidden-content";
    mount.appendChild(content);
  }

  function render() {
    const buckets = scanHiddenBuckets();
    content.innerHTML = buckets.length
      ? buckets.map(renderBucket).join("")
      : renderEmpty();
  }

  render();

  // Click delegation — per-item × + per-bucket Restore all. Both
  // mutate the source pref via setPref then re-render (cheap; the
  // bucket inventory is bounded by localStorage key count).
  mount.addEventListener("click", (e) => {
    const restoreAll = e.target.closest(".rp-settings__hidden-restore-all");
    if (restoreAll) {
      setPref(restoreAll.dataset.pref, []);
      render();
      return;
    }
    const item = e.target.closest(".rp-settings__hidden-restore");
    if (item) {
      const li = item.closest(".rp-settings__hidden-item");
      if (!li) return;
      const prefName = li.dataset.pref;
      const idx = parseInt(li.dataset.idx, 10);
      const current = safeParse(localStorage.getItem(storageKey(prefName))) || [];
      const next = current.slice();
      next.splice(idx, 1);
      setPref(prefName, next);
      render();
      return;
    }
  });

  return { refresh: render };
}
