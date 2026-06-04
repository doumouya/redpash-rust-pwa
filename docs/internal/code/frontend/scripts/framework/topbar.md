---
title: frontend/scripts/framework/topbar.js
source: ../../../../../../frontend/scripts/framework/topbar.js
owner: Torv
section: Internal · Code · Frontend · scripts · framework
last modified date: 2026-06-04
---

# framework/topbar.js — TopBar component

## Purpose

The single shared top chrome for every authed page: brand · omnibox · nav (Home /
Workspace / Cases / Monitoring) + theme toggle + sign-out. Part of the framework
extraction (CAS_37B2E1BF). The TopBar was *already* single-source (every page rendered the
identical `mountTopbar`); the framework move makes it a **registered component** and brings
it onto the **`rp-` only** namespace — the nav/theme/signout buttons use the `rp-btn-icon`
atom (was `rt-btn`), the lone namespace miss in the old topbar.

Per Em's spec (`docs/full-component-version.md`): `rp-topbar` is the same everywhere — confirmed.

## Public surface

- `mountTopbar(host, { active, session })` — renders into `host` (`<header id="rp-topbar">`).
  `active` names the current nav entry; `session.is_platform_admin` gates the Monitoring entry
  (CAS_274EDF3B). Self-registers as `"topbar"` in the component registry.

ESM. Imports the shared utilities `api`, `theme`, `dom` (not page-bound).

## How it works

- One DOM build (brand + `.rp-omni` + `.rp-topbar-actions`), then wires: theme toggle (icon
  shows the *current* theme), sign-out (`POST /auth/logout` then reload), and the omnisearch
  dropdown (`GET /api/search`, debounced 200ms, Ctrl/Cmd+K focus). All user/result content
  escaped via `esc()` — no new XSS surface vs the original.
- `rp-btn-icon` atom lives in `frontend/styles/framework/atoms.css` (replicated verbatim from
  `.rt-btn` so the rename is a zero-visual-change cutover).

## Drift-prone areas

- `NAV` is the closed list of authed pages; a new page adds an entry (set `admin: true` to
  gate, `parked: true` for a disabled "coming soon"). No other topbar edit needed.
- **Cutover pending**: the live pages still import `/scripts/topbar.js`; the cutover repoints
  them to `/scripts/framework/topbar.js` + deletes the original + `@import`s the framework atom
  sheet in `main.css`. Gated on the verification lane's `?audit=1` baseline (0 computed-style
  regression). Until then the original coexists and this is sandbox-only.

## Related

- `frontend/styles/framework/atoms.css` — the `rp-btn-icon` atom.
- `frontend/framework-sandbox.html` — renders this as shared chrome.
- [component-registry](component-registry.md) · [framework index](index.md).
- Spec: `docs/full-component-version.md`.
