---
title: frontend/scripts/pages/sheetwise.js
source: ../../../../../frontend/scripts/pages/sheetwise.js
owner: Torv
section: Internal · Code · Frontend · scripts · pages
last modified date: 2026-06-05
---

# pages/sheetwise.js

## Purpose

The **SheetWise** page — the SQL console (view 1) + the Connectors view (view 2),
and the whole-app design-language pilot. Mounted by the router at `/sheetwise`
(`main.js` ROUTES → `partials/sheetwise.html` + this module). Ported from the
standalone `frontend/sheetwise.html` it replaced (2026-06-05): the page's own
topbar + theme switcher are gone — the app topbar (`mountTopbar`) carries
brand / nav / theme, and the page follows the **global theme** (token-driven, so
it recolors with every theme).

## Public surface

- `export default function sheetwise(app, { session })` — the router mount
  contract. Scopes all DOM lookups to the mounted `app` node (`$`/`$$` =
  `app.querySelector[All]`), mounts the topbar with `active: "sheetwise"`, then
  wires the two views.
- **View 1 (SQL):** the active SOURCE file is queried as table `t` via
  `POST /api/files/:rid/sql` (read-only substrate); a result is materialized into
  a new TARGET file via `POST /api/files/:rid/sql/materialize`. Cosmetic syntax
  highlight overlay (a transparent `<textarea>` over a highlighted `<pre>` — it
  never parses/executes; the backend allowlist is the real guard).
- **View 2 (Connectors):** pick a connector card → configure source + destination
  (project picker or ＋ New project, default = source DB) → **Create & Pull**
  (`POST /api/projects` for the new-project case, then `POST /api/connectors`
  kind=`mysql`, then `POST /api/connectors/:rid/sync`). The pulled CSV appears in
  SOURCES. Configured connectors list each with a re-**Pull** button; a failed
  pull surfaces the backend error message in an inline `#swConnErr` alert
  (`role="alert"`) instead of vanishing into the console.

## Drift-prone areas

- **Self-contained `api()` helper** (raw same-origin `fetch`, cookie session) —
  kept local rather than `api.js` so the SheetWise-specific 401 message + the raw
  `/api/files/:rid/sql` paths stay identical to the proven standalone path. If the
  app's auth model moves off same-origin cookies, this needs revisiting.
- **Zero-risk model (Em):** a connector copies the source into a CSV; SQL runs on
  the copy. The live source is read-only — never mutate it. The `/sql` allowlist
  rejects `DROP`/`UPDATE` on the CSV; re-pull reproduces it.
- **`innerHTML` is XSS-safe by construction** — every dynamic value goes through
  `esc()` (the highlighter escapes each token; error paths wrap `esc(e.message)`);
  the rest are static strings. Keep new dynamic content escaped.
- **Theme:** the page renders in whatever the global theme is. Until the
  design-language switch-on flips the default + ships the 4-theme picker, that's
  the current default (catppuccin-`dark`); the RedPash-red identity shows when a
  `new-*` theme is active. The page itself hard-codes no palette.

## Related

- [Frontend pillar landing](../../../index.md)
- [main.js](../main.md) — the router that mounts this at `/sheetwise`.
- [topbar.js](../topbar.md) — the shared chrome (`mountTopbar`, the SheetWise NAV entry).
- [files/sql route](../../backend/api/routes/files/sql.md) — the `/sql` + `/sql/materialize` substrate.
- [routes/connectors.rs](../../backend/api/routes/connectors.md) · [mysql_loader.rs](../../backend/api/mysql_loader.md) — the Connectors backend.
