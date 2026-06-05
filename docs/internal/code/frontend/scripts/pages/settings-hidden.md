---
title: frontend/scripts/pages/settings-hidden.js
source: ../../../../../frontend/scripts/pages/settings-hidden.js
owner: Torv
section: Internal · Code · Frontend · scripts/pages
last modified date: 2026-06-05
---

# settings-hidden.js

> The "Restore all" bucket button is the `rp-btn-icon` atom (was `rt-btn`; design-language rollout,
> 2026-06-05).

## Purpose

Settings v2 step 5 (CAS_55984AC7) — the unified Hidden Items
recovery surface. Every page in the app lets users bury a row via
a `×` (Workspace rail, Home tabs, Cases card); that state persists
to localStorage as unregistered prefs
(`rp-pref-{rail_hidden_*,home_hidden_*,cases_hidden}`). Today each
page has its own × buried in its rail; this is the canonical place
users come to manage everything they hid, with per-item + per-page
restore.

Deliberately one-way coupling: the source pages don't know this
exists. They keep writing the same unregistered keys; this module
scans + offers restore. Adding a fourth hide-surface = if it uses
the same `rp-pref-*_hidden_*` convention, it surfaces here without
any edit to this module.

## Public surface

- `mountHidden(app)` — mount the surface into the `[data-rp-rows="hidden"]`
  slot. Returns `{ refresh() }` for tests / dev tools.

Called once by `pages/settings.js` after `renderFromRegistry` +
`callPostMountHooks` lay down the rest of the page. Tab landing key
is `set-hidden` under the GENERAL rail group.

## Per-page taxonomy

`PAGE_SOURCES` is the source of truth for which localStorage keys
land in which page bucket. Two shapes:

- **Explicit keys** (Workspace, Cases): named keys + a per-key
  pretty label.
  - `rail_hidden_projects` → "Workspace · Projects"
  - `rail_hidden_files`    → "Workspace · Files"
  - `cases_hidden`         → "Cases"
- **Key prefix** (Home): enumerate every `rp-pref-home_hidden_*`,
  derive the tab from the suffix.
  - `home_hidden_projects` → "Home · Projects"
  - `home_hidden_users`    → "Home · Users"
  - etc.

Pretty labels (`tabLabel`) cover the known tabs; everything else
falls back to title-case of the raw key.

## How a restore happens

Per-item `[Restore]` — `setPref(prefName, list.splice(idx, 1))`.
Per-bucket `[Restore all]` — `setPref(prefName, [])`. Both write
through the standard prefs.js write-through (localStorage + PATCH
`/api/me/prefs` fire-and-forget). The source page's read on next
visit shows the restored item back in its rail.

## Drift-prone areas

- **Source pages must keep using the same convention** —
  `rp-pref-<prefix>_hidden_*` with the value as a JSON array of
  `{rid, name, sub?}`-shaped entries. If a future page writes a
  different shape, the renderer falls back to "Item N" labels.
- **Auto-purge after 30 days** is REGISTERED as a pref
  (`general-hiddenAutoPurge`, step 5 of Settings v2) but the
  actual age-based purge needs a per-entry timestamp on the
  hide-write side (rail-controls.js + home-hide-actions etc.).
  That's a follow-up; the registered pref's hint copy says so.
- **Click delegation lives on the section root** so the per-item
  + bucket restore both work without re-binding after every
  render. The render() function rebuilds `.rp-settings__hidden-content`
  innerHTML; the section root + its event listener survive.
- **No XSS surface vs the pre-step-5 state** — every interpolated
  value goes through `esc()` (project standard). The values
  themselves come from app-written localStorage entries (same
  trust boundary as the rest of prefs.js).

## Settings v2 rollout reference

Step 5 of the 7-step plan
(`~/.claude/plans/transient-dazzling-conway.md`). Steps 1-4 built
the open registry + registry-driven render + search + chart-layouts
control this module sits alongside. Step 6 (26 new prefs +
read-site cutover + rail-view auto-toggle) and step 7 (SQL
backfill) extend the same pattern.

## Related

- [Frontend pillar landing](../../../index.md)
- [`prefs.js`](../prefs.md) — the `setPref` write-through this
  module uses to persist restores.
- [`pages/settings.js`](settings.md) — calls `mountHidden` after
  the post-mount hooks.
- [Settings v2 plan](~/.claude/plans/transient-dazzling-conway.md).
