---
title: frontend/scripts/framework/omni.js
source: ../../../../../../frontend/scripts/framework/omni.js
owner: Torv
section: Internal · Code · Frontend · scripts · framework
last modified date: 2026-06-04
---

# framework/omni.js — Omnisearch component

## Purpose

The site-wide search-with-results widget. The **box is the shared `rp-search` atom**
(not a bespoke class — Em's dedup: search is one atom across topbar/rail/toolbar/settings);
the topbar styles it wide via `.rp-topbar .rp-search`, and the only omni-specific part is the
results dropdown `rp-search-menu`. Lifted out of the topbar so it's a reusable widget (a
command palette could mount it elsewhere). Part of the framework extraction (CAS_37B2E1BF).

## Public surface

- `mountOmni(host, { placeholder })` — turns `host` into the `.rp-search` box (input + `Ctrl K`
  hint + a `.rp-search-menu` results dropdown) and wires everything. Self-registers as `"omni"`.
  ESM; imports the shared `api` (search) + `dom` (`esc`) utilities.

## How it works

- `GET /api/search?q=&limit=20`, debounced 200ms, AbortController to drop stale replies.
  Results are grouped by `kind`; the backend ships a pre-built `#/…` hash per result so
  the click/Enter handler is one line (`location.hash = r.hash`).
- Keyboard: ↑/↓ move the cursor, Enter navigates, Esc closes; **Ctrl/Cmd+K** focuses the
  box (bound once for the app's life). Outside-click closes.
- All user/result content escaped via `esc()` (label/sub/section), match-highlight via
  `rp-search-hl` — no new XSS surface vs the original topbar code.
- CSS: `frontend/styles/framework/omni.css` = the `.rp-topbar .rp-search` context override
  (wide centred pill) + the `rp-search-menu*` results styling. The box base is `rp-search`
  (atoms.css). Self-contained.

## Drift-prone areas

- The input carries `id="rp-omni"` for the Ctrl-K focus target — one omni per page (the
  topbar's). A second mounted omni would duplicate the id; if that ever happens, scope the
  focus to the nearest box.
- Search wire shape (`{ results: [{ kind, rid, label, sub, hash }] }`) is the contract with
  `GET /api/search`; a backend change must update `kindLabel`/`kindIcon` here.
- **Cutover pending**: live pages still render the omni via the old topbar; the cutover
  lands when the topbar cuts over (repoint + delete the legacy `topbar.css` `rp-omni*`,
  whose styling now lives as the `rp-search` atom + the `.rp-topbar` context).

## Related

- [framework/topbar.js](topbar.md) — composes this.
- `frontend/styles/framework/omni.css` — the omni CSS.
- [component-registry](component-registry.md) · [framework index](index.md).
