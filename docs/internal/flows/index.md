---
title: Flows — index
section: Internal
order: 40
last modified date: 2026-05-24
---

# Flows

The **how data moves** — explicit cross-system traces. A flow doc
follows one path through the stack: user gesture → frontend → wire →
backend → storage → response → render. Useful when a system's
boundaries blur and a single subsystem doc can't capture the whole
journey.

| Doc | Path traced |
|---|---|
| [csv-upload-to-render](csv-upload-to-render.md) | rail click → multipart POST → xlsx_to_csv → file write + DB row → /page → table render |
| [step-apply-and-replay](step-apply-and-replay.md) | tools-panel Apply → POST /steps → step persist → next-read replay against base frame |
| [search-omnisearch](search-omnisearch.md) | topbar keystroke → debounced /api/search → grouped-by-kind → location.hash = r.hash |
| [auth-session-prefs](auth-session-prefs.md) | login → /api/me → `prefs` JSON → seedPrefs → first paint with server-of-truth |

Stubs landed 2026-05-24 — content fills as we trace each path during
real debugging or onboarding. A flow doc is most valuable *after* a
bug hit it, when the route is fresh.
