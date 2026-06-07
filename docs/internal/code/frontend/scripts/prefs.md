---
title: frontend/scripts/prefs.js
source: ../../../../frontend/scripts/prefs.js
owner: Torv
section: Internal · Code · Frontend · scripts
last modified date: 2026-06-05
---

# prefs.js

## Purpose

App-wide preferences. Prefs used to live in **two disjoint places** — a
client-only localStorage set and the server `users.prefs` JSONB blob.
They're now **unified under one user-preference object**: the server
`user_preferences` table (`(user_redpash_id, key)` rows, promoted from
the JSONB column in mig `20260606000001_user_preferences`; the dead
`users.prefs` column dropped in `20260607000001`).

Both stores still hold prefs, but no longer disjointly — the DB
user-pref object is the **source of truth** and localStorage is a synced
**SWR cache** so synchronous `getPref` doesn't block: seeded once at boot
from `/api/me`, write-through to `/api/me/prefs` on every `setPref`.

## Public surface

- `seedPrefs(serverPrefs)` — boot seed (called once from main.js).
- `getPref(key)` — sync cache read; returns the registered default for
  empty / malformed values on registered prefs, `null` for unregistered.
- `setPref(key, value)` — write-through (localStorage + PATCH); enforces
  the registered spec's enum / custom validate.
- `registerPref(spec)` — add a pref to the registry. Idempotent
  (re-registering a key replaces the spec).
- `getPrefSpec(name)` — look up a registered spec for introspection.
- `eachPref(fn)` — iterate every registered spec. Settings v2 reads the
  registry this way.
- `applyAllPrefs()` — push every registered pref with an `attr` to
  `<html data-${attr}=value>` for CSS reflection.

## Open registry

`PREFS` const was replaced by an internal `Map<key, spec>` populated via
`registerPref()` (2026-06-01, Settings v2 step 1, CAS_settings-v2 epic).
Built-in prefs register at module-load in a single contiguous block so
the legacy semantics are preserved exactly. New prefs land via per-page
modules (`frontend/scripts/prefs/<page>-prefs.js`) that call
`registerPref()` at import-time — adding a Settings row becomes one
`registerPref()` call, no edit to settings.js.

Spec fields:

- `key` (required) — pref identifier; matches the localStorage suffix
  + wire-shape key on `/api/me/prefs`.
- `values` — enum allowlist; setPref rejects values not in the list.
- `default` — fallback when storage is empty / malformed / fails enum.
- `attr` — name for `<html data-${attr}=value>` reflection.
- `validate` — custom predicate `(value) => bool`. Used for prefs whose
  shape is too rich for an enum (e.g. JSON objects).
- `migrateFrom` — array of legacy key names; the dual-read window. See
  below.
- `group` / `section` / `control` / `label` / `hint` / `tags` — UI
  fields consumed by Settings v2's registry-driven renderer. Optional;
  absence is fine for prefs that don't surface in Settings.

## Dual-read migration window (`migrateFrom`)

A registered pref whose spec carries `migrateFrom: [legacyKey, ...]`
gets a read-fallback chain:

1. `getPref(newKey)` reads `rp-pref-<newKey>` from localStorage.
2. If empty, reads each `rp-pref-<legacyKey>` in order; first hit wins
   (still subject to the spec's enum / validate).
3. `setPref(newKey, value)` writes the new key AND removes every
   `migrateFrom` legacy alias from localStorage — "touch to migrate".

Per-user, lazy, rollback-safe: a user who never touches the pref keeps
reading from legacy until they do; the new key + legacy key coexist
during the migration window. The server-side rename (one-shot SQL
backfill) is a separate workstream (step 7 of the Settings v2 rollout);
localStorage cleanup survives a rollback of that step.

Use case: kebab-shape migration per [[page-pref-naming]] — every legacy
camelCase key (`workspaceRailView`, `rowsPerPageWorkspace`, …) gets
re-registered under its `<page>-<leaf>` shape with
`migrateFrom: ["workspaceRailView"]` etc., and read-sites switch to the
new key. Dual-read carries the old name forward until the SQL backfill
clears the database side.

## Two pref classes

- **Registered** (via `registerPref`) — validated against the spec's
  enum or `validate` fn; default falls in on empty/malformed; `attr`
  reflection on `<html>` for CSS. Settings v2 renders these.
- **Unregistered** — anything else the server stores
  (`learned_sentinels`, `share_sentinels`, …). Cached as transparent
  passthrough; no validation, no attr reflection. Adding a new server
  pref needs zero code change here — it appears in the next `/api/me`
  boot-seed and `getPref` returns the parsed JSON.

## Drift-prone areas

- **Wire contract** — `user_preferences` table + `/api/me/prefs` PATCH
  protocol. See [`specs/user-preferences.md`](../../../specs/user-preferences.md).
- **`migrateFrom` chain depth** — keep it small. One spec carrying
  three legacy aliases means three `localStorage.getItem` calls per
  read; cheap individually but compounds at scale if every pref grows
  a migration history.
- **Registry ordering on hot-reload** — `registerPref` is idempotent
  but module-level `import` ordering still matters: a per-page module
  that registers before the legacy bootstrap block runs would replace
  a spec the bootstrap then overwrites. Per-page modules MUST import
  from `prefs.js`, not the other way around.
- **`PREFS` const removed** — old external `import { PREFS }` would
  fail at module-load. Verified zero external imports as of 2026-06-01;
  callers use `getPrefSpec(name)` / `eachPref(fn)` instead.
- **Per-surface Cases UI prefs** live here too (`casesDoneWindow`,
  `casesRailGroupBy`, `casesDetailPanel`); future cases-prefs.js
  module will migrate them under the registry-import pattern.
- **`general-theme` enum** carries the four design-language themes
  (`dark`/`light` catppuccin aliases + `new-dark`/`new-light` +
  `catppuccin-mocha`/`catppuccin-latte`, 2026-06-05). Its `values` list
  is in lockstep with `theme.js`'s `THEMES` set, `index.html`'s pre-paint
  validator, and the palette blocks in `tokens.css`. Its `default` is
  **`new-dark`** (the new identity switched on 2026-06-07) and its
  `control` is **`theme-swatch`** (the swatch-grid picker — a live
  per-theme preview card per option, `prefs/controls/theme-swatch.js`).

## Settings v2 rollout reference

This module is step 1 of the 7-step Settings v2 plan (Em-approved
2026-06-01, plan file `~/.claude/plans/transient-dazzling-conway.md`).
Step 2 makes Settings render from this registry; step 6 lands per-page
pref modules with `migrateFrom` aliases; step 7 ships the server-side
SQL backfill. Subsequent steps reuse the registry without changing
this module's surface.

## Related

- [Frontend pillar landing](../../index.md)
- [`specs/user-preferences.md`](../../../specs/user-preferences.md) — wire contract.
- [Settings v2 plan](~/.claude/plans/transient-dazzling-conway.md) — the 7-step rollout this module's open registry foundation enables.
