---
title: frontend/scripts/framework/omni.js
source: ../../../../../../frontend/scripts/framework/omni.js
owner: Torv
section: Internal · Code · Frontend · scripts · framework
last modified date: 2026-06-04
---

# framework/omni.js — Omnisearch component

## Purpose

The site-wide search box + results dropdown (`rp-omni`). Lifted out of the topbar so
it's a **reusable widget in its own right** — the topbar composes it, and a command
palette could mount it elsewhere (the same "don't bury reusable widgets in a parent"
rule as the comment view). Part of the framework extraction (CAS_37B2E1BF).

## Public surface

- `mountOmni(host, { placeholder })` — turns `host` into the `.rp-omni` box (search
  input + `Ctrl K` hint + results dropdown) and wires everything. Self-registers as
  `"omni"`. ESM; imports the shared `api` (search) + `dom` (`esc`) utilities.

## How it works

- `GET /api/search?q=&limit=20`, debounced 200ms, AbortController to drop stale replies.
  Results are grouped by `kind`; the backend ships a pre-built `#/…` hash per result so
  the click/Enter handler is one line (`location.hash = r.hash`).
- Keyboard: ↑/↓ move the cursor, Enter navigates, Esc closes; **Ctrl/Cmd+K** focuses the
  box (bound once for the app's life). Outside-click closes.
- All user/result content escaped via `esc()` (label/sub/section), match-highlight via
  `rp-omni-hl` — no new XSS surface vs the original topbar code.
- CSS: `frontend/styles/framework/omni.css` (`rp-omni*`, ported verbatim) — self-contained.

## Drift-prone areas

- The input carries `id="rp-omni"` for the Ctrl-K focus target — one omni per page (the
  topbar's). A second mounted omni would duplicate the id; if that ever happens, scope the
  focus to the nearest box.
- Search wire shape (`{ results: [{ kind, rid, label, sub, hash }] }`) is the contract with
  `GET /api/search`; a backend change must update `kindLabel`/`kindIcon` here.
- **Cutover pending**: live pages still render the omni via the old topbar; the cutover
  lands when the topbar cuts over (repoint + delete legacy `topbar.css` `rp-omni*`).

## Related

- [framework/topbar.js](topbar.md) — composes this.
- `frontend/styles/framework/omni.css` — the omni CSS.
- [component-registry](component-registry.md) · [framework index](index.md).
