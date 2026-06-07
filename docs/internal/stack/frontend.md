---
title: Stack — Front-End
section: Internal
last modified date: 2026-06-07
---

# Stack — Front-End

The browser half of RedPash: a vanilla-JS PWA shell with **no framework
dependency**. The stack is plain HTML + CSS + ES modules, by deliberate
choice — the same choice that keeps the backend vanilla Rust. A
front-end-framework dependency would couple our 5-year-survivable UI layer to
someone else's release cadence and abstractions; we own ours instead. The
carve-out is narrow: Acorn-style AST parsing is allowed in `tools/*`
static-analysis scripts, never in runtime FE code.

This page is the system-level prose. The per-file deep dives live in the
[code](../code/index.md) survival layer, linked from *Source files* at the
bottom.

## The JS ↔ Rust boundary (locked 2026-05-25)

The single most load-bearing rule on the front end:

> **Rust owns the data. JS owns the pixels.**

- **Rust** — anything that transforms, computes over, or persists actual
  data: parse, encoding sniff, the cleaner steps, type inference, dedup,
  joins, aggregation, cleanness scoring, **filter, sort, export** — plus
  HTTP, DB, auth. The `data` crate's charter: *"anything that touches a row
  or a byte."*
- **JS** — anything that draws, lays out, or responds to a human: rendering,
  the redtable surface, panels and toolbars, routing, interaction, and
  building the ECharts option *from data Rust supplied*. *"Anything that
  touches a pixel."*

If a piece of logic transforms data it is Rust, however convenient JS would
be; if it arranges pixels it is JS, however data-aware it looks. There is
**one** filter, **one** sort, **one** step engine — written once, in Rust;
never build a data engine in JS. A client-side JS data op wouldn't even scale
(it sees only the loaded page, not the dataset), and it would slam shut the
WASM door: the `data` crate is HTTP-agnostic pure compute, so its transform
core is a credible WebAssembly target that runs the *identical code* in the
browser at Rust speed. Keeping the crate pristine keeps that future open.

The two halves meet at exactly **two** kinds of endpoint and nowhere else:
the `/api/…` HTTP routes (JS issues, Rust serves) and the `shared`-crate
DTOs (the request/response shapes — the single vocabulary both sides compile
against). A piece of data logic living in JS, or presentation logic in Rust,
is a boundary violation. This makes the seam auditable: the `js-audit` +
`rs-audit` + crossing-diff triad cross-references the JS side's `/api/…`
calls against the Rust route table and DTO surface, so a dangling endpoint
falls straight out — the JS↔Rust equivalent of an orphan CSS class. One
concern carries **one name** on both sides (`filter.rs` / `filter.js` / the
`Filter` DTO), which turns the file tree itself into the boundary map.

## Boot + routing — `main.js`

The app is a single static file set served by Axum's `ServeDir` (which
returns `index.html` for `/`). Routing is **hash-based**, not the History
API, on purpose: the hash carries the route, so the same static bundle works
offline through the service worker without per-route server config.

`main.js` is the router. `ROUTES` maps each path to `{ partial, script,
auth, admin }`. On boot the app:

1. Arms front-end error capture (`installErrorCapture`) *first*, so a
   boot-time exception still reaches the Events log.
2. Runs one `GET /api/me` (`loadSession`) and immediately
   `seedPrefs(session.prefs)` — see the SWR section below for why timing
   matters.
3. Routes to the current hash. A missing endpoint (404) falls back to a dev
   sentinel session so pages still mount during rebuilds; any other failure
   means "no session".

Mounting a route fetches the partial HTML and dynamically `import()`s the page
module in parallel, drops the HTML into `#app`, then calls the module's
default export with `(app, { session, getSession })`. Auth gates are
client-side **UX gates only** — `auth: true` bounces to `#/login`,
`admin: true` bounces a non-platform-admin to `#/home`. The real
authorization is the backend's `/monitoring/*` + `/admin/*` middleware; the
hash guard just keeps a deep-link from rendering a shell the user can't use.

Two cross-cutting atoms wire once at module load and cover every page: the
delegated dropdown handler (`bindDropdown`, so dynamically-rendered triggers
work with no per-page re-sweep) and the service-worker update banner
(`mountSwUpdate`). There is also an `?audit=1` mode that snapshots the
computed styles of the foundation atom catalog on every mount + tab switch —
instrumentation that feeds the UI-snapshot audit pipeline; it is lazy-imported
and best-effort so it can never break a page.

## The shell pattern — `rp-shell` rail + surface

The railed pages (`/home`, `/monitoring`, `/workspace`, `/cases`, `/docs`)
share one outer chain:

```
section.rp-shell > header(topbar) + div.rp-shell-body > [ rail + main.rp-main > div.rp-surface ]
```

The **rail** is the constant two-level navigation (a *group* = a container
like a project or status bucket; a *tab* = a leaf like a file or case;
collapses to an icon-only strip). The **main area shows exactly one surface at
a time** — a list/board **or** a full-bleed detail, never both, never an
overlay competing for the main area's space (locked 2026-05-28). The
board↔detail swap is a mutually-exclusive `hidden` toggle on two `flex:1`
children of the same flex main; the detail surface is flush to the main area's
edges, not a `position:absolute` overlay. The reasoning: an overlay leaves the
list fighting for attention behind it (the exact bug the Cases page shipped
with), and one-surface-at-a-time makes the eventual RBAC visibility logic a
single `hidden` toggle instead of a z-index dance. **Modals are reserved for
create flows + transient confirmations, never for viewing a record** — Em:
"we drastically reduce the use of modals."

The `--wide` modifier opts a data-dense page out of the centred cap; the
`.rt-nav`/rail component is reused across pages with different *semantics*
(static groups on Home/Monitoring, dynamic project/file groups on Workspace).

## The `rp-*` framework atoms

The shell isn't bespoke per page — it's assembled from a **single-source
component layer** under `frontend/scripts/framework/` (CSS twins under
`frontend/styles/framework/`). This is the framework-extraction epic: 6
RedTable implementations / 4 rails / 4 create-actions collapse to **one
each**, so a change to how a row renders or how the rail collapses propagates
to every page at once. Everything here lives in a flat `rp-`-only namespace
(no `__`/`rt-`/`ds-`/`ws-` prefixes), enforced by the `ui-doc-audit` lint.

Two strands share the folder:

- **UI components** — whole components (`rail`, `surface`, `topbar`,
  `redtable`, `table`, `stat`, `chip-row`, `head`, `pager`, `panel`,
  `modal`, …). Each `mount<Component>(host, config)` is generic +
  data-driven: the page supplies a config of data + handlers, the builder
  owns the markup and behavior. Components **compose** (the surface imports
  and calls the head/chip-row/stat/table builders into its slots) rather than
  embed, and self-register via `component-registry.js` so a sandbox + the
  `ui-runtime-audit` can read `list()` to measure coverage.
- **TypeDefinition-driven primitives** — the editors/types strand: a
  `type-registry` caching `/admin/types`, and an `editor-registry` with a
  universal `text` fallback so an unknown editor id silently downgrades
  rather than failing a cell. This is what makes RedPash vertical-agnostic —
  the same primitives render `company`/`case` today and a fake
  `RealEstateListing` tomorrow with zero source changes (backend treats
  `editor` as an opaque string, never validating against an FE-known list).

`page-assembly.js` (`assemblePage(host, spec)`) is the generic assembler that
builds the whole shell chain and mounts registered units from a plain page
spec — the seed of a declarative page-spec runner. The completeness proof is
`frontend/framework-sandbox.html`, which rebuilds the real pages from *only*
registered components before any live page cuts over. Live pages still
hand-build some surfaces with the per-page `list-page.js` builders today;
cutover makes each page a config supplier instead.

## Preferences — SWR cache + FOUC-safe boot

User prefs use a **two-layer SWR model**: the server `user_preferences` table
is the source of truth; the client `localStorage` (`rp-pref-<name>`,
always JSON-encoded) is a write-through cache so `getPref(name)` is
**synchronous** and first paint sees source-of-truth values instead of
defaults. Three exports do the work in `prefs.js`:

- `getPref(name)` — sync read. Registered prefs validate against an enum +
  fall back to a default; unregistered (server-originated) prefs pass through
  JSON-parsed.
- `setPref(name, value)` — **optimistic three-stage commit**: write
  localStorage (sync), reflect to `<html data-<attr>>` if CSS-driven (sync),
  then fire-and-forget `PATCH /api/me/prefs`. A failed PATCH doesn't fail the
  user action and isn't retried — it self-reverts on the next boot's
  `seedPrefs`, because the server doesn't know about it.
- `seedPrefs(serverPrefs)` — called **once** inside `loadSession()`, *after*
  the `/api/me` response lands and *before* any page mounts. This is the
  ordering that guarantees a route's first render reads source-of-truth, not
  the prior session's cache. Cross-device sync is free: a second device's
  cache is overwritten by the server state on sign-in.

The registry (`PREFS`) is intentionally permissive — it governs only UI prefs
that need enum validation + `<html>` data-attr reflection (`density`,
`fontSize`, `rowsPerPage`, `showRowNumbers`, `showStageDots`). Everything
else (`learned_sentinels`, `share_sentinels`, future feature toggles) is a
transparent passthrough that appears in `/api/me`'s `prefs` object and caches
automatically — **adding a new server-side toggle needs zero client change**.

First paint is FOUC-safe: a tiny inline `<script>` in `index.html` runs
*before any module loads* and applies the visual prefs (`theme`, `density`,
`fontSize`) to `<html>` data attrs, so the CSS evaluates against the right
sizing on first paint with no flash. `theme.js` is historically split out but
behaves like the other UI prefs.

## Why no framework

The deliberate vanilla choice is the same disposability bet as the rest of the
stack: a framework layer is debt that locks our most-rewritten layer to an
external abstraction. We instead own the shell, the router, the atom library,
and the prefs cache — small, legible, deletable. The audit tools encode the
rules (boundary, namespace, atom coverage, doc drift) so drift fails a tool,
not the user; a UI bug behind a stray `display:none` gets the same rigor as a
backend join bug, because from the user's seat they are the same failure.

## Source files

Per-file survival docs under [code/](../code/index.md):

- [frontend/scripts/main.js](../code/frontend/scripts/main.md) — the hash router + boot.
- [frontend/scripts/prefs.js](../code/frontend/scripts/prefs.md) — the prefs SWR cache.
- [frontend/scripts/theme.js](../code/frontend/scripts/theme.md) — the split-out theme pref.
- [frontend/scripts/api.js](../code/frontend/scripts/api.md) — the `/api/…` client (the JS side of the boundary).
- [frontend/scripts/dom.js](../code/frontend/scripts/dom.md) · [dropdown.js](../code/frontend/scripts/dropdown.md) · [sw-update.js](../code/frontend/scripts/sw-update.md) — shared atoms wired in `main.js`.
- [frontend/scripts/framework/](../code/frontend/scripts/framework/index.md) — the `rp-*` component + TypeDefinition-primitive layer (index).
- [framework/component-registry.js](../code/frontend/scripts/framework/component-registry.md) — single-source component register/discover.
- [framework/page-assembly.js](../code/frontend/scripts/framework/page-assembly.md) — the shell-chain assembler.
- [framework/surface.js](../code/frontend/scripts/framework/surface.md) · [rail.js](../code/frontend/scripts/framework/rail.md) · [topbar.js](../code/frontend/scripts/framework/topbar.md) — the shell components.
