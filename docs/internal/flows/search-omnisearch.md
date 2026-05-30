---
title: Omnisearch keystroke → navigate
section: Internal
order: 43
last modified date: 2026-05-24
status: filled
---

# Flow: Omnisearch keystroke → navigate

User types in the topbar input → debounced fetch → server queries
two indexes → grouped results land → user picks one → router
navigates. End-to-end target p95 is <100ms on the wire.

## The trace

1. **User**: types into `#rp-omni` (topbar input) or hits
   `Ctrl/Cmd+K` to focus + type.
2. **`topbar.js` keystroke handler**:
   - Schedules a `setTimeout(query, 200)` (debounce).
   - Cancels any prior pending timeout.
   - Cancels any *in-flight* fetch via `inflight.abort()` (out-
     of-order safety).
3. **After 200ms**, the debounced `query()`:
   - Reads the input value, trims, encodes (`URLSearchParams`).
   - Creates a new `AbortController` for this call.
   - `api.get("/search?q=...&limit=20", { signal })`.
4. **api.js**: standard fetch wrapper; sends the cookie; reads
   the response or throws on non-2xx.
5. **Outer middleware**: `request_id_mw` mints `req_<uuid>` →
   `capture_mw` snapshots the timer.
6. **Route** (`routes::search::search`):
   - `resolve_user_rid(state, headers)` (401 if no session).
   - Trim `q`; empty → return `{ q: "", results: [], ms }` with
     no DB hit. (Lets the frontend fire on every keystroke
     cheaply.)
   - Run **projects query** — ILIKE on
     `name` + `description`, user-scoped (caller has a `memberships`
     row on the project), prefix-match boost via
     `CASE`, `LIMIT 5`.
   - Run **files/charts/dashboards query** — single CTE with
     `ROW_NUMBER() OVER (PARTITION BY file_type)` to cap each
     kind at 5 inside SQL; ILIKE on `filename` +
     `display_name`; same user-scoping via the parent project.
   - Compose `Vec<SearchResult>` in order: projects first, then
     files/charts/dashboards by `file_type` ascending. Truncate
     to caller's `limit` (default 20).
   - Build each `hash` per kind:
     - project → `#/workspace?project=PRJ_…`
     - file / chart / dashboard → `#/workspace?file=<RID>`
7. **Capture middleware**: `request_log::record(GET, "/search",
   200, duration_ms, request_id)` fire-and-forget. The route is
   stored as `/search` (post-`/api`-strip).
8. **Response** lands at the client:
   ```json
   { "q": "cata", "ms": 7,
     "results": [
       { "kind": "project", "rid": "PRJ_…", "label": "catalog produits",
         "sub": "", "hash": "#/workspace?project=PRJ_…" },
       { "kind": "file", "rid": "FIL_…", "label": "catalogue_produits_clean",
         "sub": "in catalog produits", "hash": "#/workspace?file=FIL_…" }
     ] }
   ```
9. **`topbar.js` paints the dropdown**:
   - Iterates `results`. Inserts a section header on every
     `kind` transition (since the backend already kind-groups
     the array order). Section label = `kindLabel(kind)` —
     auto-pluralized for unknown kinds.
   - Per-row icon: `kindIcon(kind)` map; unknown kind →
     `bi bi-dot`.
   - Match highlight: first case-insensitive substring of `q`
     in each row's `label` + `sub` gets wrapped in
     `<span class="rp-omni-hl">`. Lightweight client-side
     pass — server doesn't ship match positions.
   - First row gets `is-active`; arrow keys cycle.
10. **User picks one** — either click or hits Enter on the
    active row.
11. **Click handler** (`mousedown`, not `click`, so it fires
    before the outside-handler closes the dropdown):
    ```js
    function navigate(r) {
        location.hash = r.hash;
        closeDropdown();
        omni.blur();
    }
    ```
12. **The hash change** triggers the router's `hashchange`
    listener in `main.js` → `navigate()` → fetches the
    partial → mounts the page (Workspace if it's a project /
    file hash). The Workspace mount reads the `?project=`
    / `?file=` query and auto-opens that entity.

## Three race conditions handled

1. **Stale replies** — out-of-order responses from earlier
   keystrokes. Mitigation: `inflight.abort()` on every new
   keystroke. The browser fetch promise rejects with
   `AbortError`; api.js's wrapper recognizes it and drops
   silently.
2. **Echo correlation** — the response carries the `q` it was
   for. The dropdown checks `response.q === current_input_value`
   before paint; if they differ, drop the response. Belt-and-
   braces with the AbortController.
3. **Outside-click vs row-click** — `mousedown` on the
   dropdown fires before the document-level `mousedown`
   listener that closes the dropdown. So clicking a row
   navigates rather than being swallowed by the close.

## Keyboard map

| Key | Behavior |
|---|---|
| `Ctrl/Cmd+K` (global) | Focus the omni input. Pre-existing pattern; bound once at app boot. |
| `↓` / `↑` | Cycle the active row (wraps at edges). `scrollIntoView({block:"nearest"})` keeps the active row in view. |
| `Enter` | Navigate to `active_row.hash`. |
| `Esc` | Close the dropdown + blur the input. Doesn't clear the input. |

## Latency budget

Target: <100ms p95 from keystroke to dropdown paint.

- Debounce 200ms eats the first 200ms — the budget below is
  *post-debounce*.
- Network round-trip on localhost: ~5ms.
- Server: 2 SQL queries, both index-hitting; ~5-10ms total at
  current data volumes.
- Frontend paint: ~5ms (~20 DOM nodes for a typical 5-row
  response).

Observed `ms` in the response (server-side compute) hovers
around 2-15ms on the dev DB; total wall time on the client
typically <50ms post-debounce. Plenty of headroom.

## Cross-refs

- Endpoint + wire DTO + query strategy:
  [omnisearch](../subsystems/omnisearch.md).
- Search-result shape:
  [shared::search](../subsystems/omnisearch.md#wire-dto-module--sharedsearch).
- The capture chain (request_log + events on errors):
  [events-and-logs](../subsystems/events-and-logs.md).
