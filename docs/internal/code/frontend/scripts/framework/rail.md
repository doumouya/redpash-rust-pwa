---
title: frontend/scripts/framework/rail.js
source: ../../../../../../frontend/scripts/framework/rail.js
owner: Torv
section: Internal · Code · Frontend · scripts · framework
last modified date: 2026-06-07
---

# framework/rail.js — the Rail component

## Purpose

The vertical, two-level navigation strip on the left of every "railed" page. A **group** is a
container (a project, a status bucket, a connector); a **tab** is a leaf inside it (a file, a
chart, a facet). It collapses to a 3.75rem icon-only rail.

The rail is **generic + data-driven**: `mountRail(host, config)` emits the entire `rp-rail-*`
DOM from a config of *data + handlers*. A page supplies the config and owns *what each action
does*; the component owns *the structure and the wiring* (the "lego brick"). Live consumers:
**workspace · dashboard · admin-console · sheetwise · database** (cases.js is the last hand-built
holdout, pending cutover). It supersedes the per-page `rt-nav-*`/`rt-group-*`/`rt-tab-*` rails.

## mountRail(host, config) → { el, seg, setGroups }

```js
import { mountRail } from "/scripts/framework/rail.js";

const rail = mountRail(app.querySelector("#myRail"), {
  title: "Projects",
  collapsible: true,
  search: { placeholder: "Search…", onInput: (q) => { state.q = q; refresh(); } },
  chips:  [{ value: "all", label: "All", active: true }, { value: "mine", label: "Mine" }],
  onChip: (v) => { state.chip = v; refresh(); },
  overview:   { label: "Overview", icon: "bi-grid-1x2-fill", active: true },
  onOverview: () => goToLanding(),
  groups: [],                                            // filled by the first setGroups()
  footer: { create: { label: "New project" }, nav: { active: "", session } },
  on: {
    tab:         (tabId, groupId) => openFile(tabId),
    groupToggle: (groupId, collapsed) => { if (!collapsed) loadFiles(groupId); },
    groupRename: (groupId, value)  => renameProject(groupId, value),
    groupHide:   (groupId)         => hideProject(groupId),
    tabRename:   (tabId, value)    => renameFile(tabId, value),
    tabHide:     (tabId)           => hideFile(tabId),
    restore:     (id, kind)        => unhide(id, kind),
    create:      ()                => newProject(),
    visualize:   (tabId)           => location.hash = "#/dashboard?source=" + tabId,  // custom
  },
});
function refresh() { rail.setGroups(buildGroups(), buildHidden(), emptyText); }
```

- **`host` becomes the `.rp-rail` element.** `mountRail` sets `host.className = "rp-rail"` and
  fills its `innerHTML` (head · views-seg · filter · chips · body[overview + groups + hidden] ·
  footer). So the page's partial only needs a bare `<aside id="myRail"></aside>`.
- Self-registers in the component registry as `"rail"`. ESM module.
- Returns `{ el, seg, setGroups(groups, hidden, emptyText) }`:
  - `el` — the rail root (= `host`), for any direct DOM reads (e.g. toggling a chip's
    `is-active`).
  - `seg` — the view-seg controller (`{ set, current }`) when `config.views` was given, else
    `null`.
  - `setGroups(groups, hidden, emptyText)` — **re-renders the body in place** after a data
    change (the everyday call). `emptyText` (optional) renders a `.rp-rail-state` line when
    `groups` is empty (e.g. a filter that matched nothing) — distinct from a load error.
- **One delegated click handler** on the rail root routes every interaction by its
  `data-rail-action` attribute, so the body can be re-rendered freely (`setGroups`) without
  re-binding listeners per element.
- **Generic action dispatch:** any `data-rail-action` not in the built-in switch falls through to
  `on[action]?.(tabId, groupId)`. A page adds a per-row/per-group action just by listing it in a
  tab's `actions` (or a group affordance) + a matching `on{}` handler — no edit to the component.
- All dynamic content is escaped via `esc()` (XSS-safe); `--mark` is the only `style=` value and a
  CSS custom-property can't execute script.

### Config reference (every section optional)

| key | shape | renders / effect |
|---|---|---|
| `title` | string | `.rp-rail-head` title |
| `collapsible` | bool (default true) | head collapse toggle (→ `mountRailCollapse`) |
| `views` | `{ pref, fallback, options:[{value,label,icon}], onChange }` | `.rp-rail-views` seg (→ `mountRailSeg`) |
| `search` | `{ placeholder, onInput(q) }` | `.rp-rail-filter` > `.rp-search` atom |
| `chips` | `[{ value, label, active }]` | `.rp-rail-chips` > `.rp-chip` atoms |
| `onChip` | `(value) => void` | a chip click |
| `overview` | `{ label, icon, active }` | the pinned `.rp-rail-overview` pseudo-tab |
| `onOverview` | `() => void` | overview click |
| `groups` | `[Group]` | the project/container groups (see below) |
| `hidden` | `[{ title, items:[{ id, kind, name, meta }] }]` | the `.rp-rail-hidden` `<details>` recovery |
| `footer` | `{ upload:{label}, create:{label}, nav:{active, session} }` | `.rp-rail-footer` + footer-nav |
| `on` | `{ tab, tabRename, tabHide, groupToggle, groupRename, groupHide, groupAdd, restore, upload, create, …custom }` | event handlers |

**Group** = `{ id, name, mark, initials, count, collapsed, renamable, hidable, addLabel, tabs:[Tab] }`.
**Tab** = `{ id, name, icon, dot, actions, title, ghost, active, busy, renamable, hidable }`.

## The data-model contract (the load-bearing idea)

`mountRail` re-renders the **whole body** on every `setGroups`. So the page does **not** do DOM
surgery — it holds a *data-model* and rebuilds the config from it:

- The page keeps state like `cachedProjects`, `filesByGroup` (Map id→items), `expanded` (Set),
  `uploadGhosts`, plus the hidden prefs.
- A `buildGroups()` maps that state → the `groups` array; `buildHidden()` → the `hidden` array.
- Any change (load, filter, rename, hide, upload) mutates the state then calls
  `refreshRail() = rail.setGroups(buildGroups(), buildHidden(), emptyText)`.

This single contract is *why* lazy-load, search/chip filtering, hide/restore, and ghost uploads
all work without per-element wiring. Because the body is rebuilt, any **lightweight** highlight a
page wants between rebuilds (e.g. the active tab) it toggles itself on `rail.el`, and the next
`buildGroups()` must reproduce it (e.g. `active: tab.id === activeId`) so a rebuild keeps it.

## Groups, tabs & lazy-load

`groupHTML` emits, per group: a `.rp-rail-group-head` (caret · mark · name · count · rename ·
hide) and a `.rp-rail-group-body` (the tabs + an optional add button).

- **Expand state is `.expanded`** (NOT `.is-collapsed`). `rail.css` hides the body via
  `.rp-rail-group:not(.expanded) .rp-rail-group-body { display:none }`. `groupHTML` renders
  `.expanded` by default and omits it only when `group.collapsed` is true; the `group-toggle`
  action toggles the class and then fires `on.groupToggle(groupId, collapsed)`.
- **Lazy-load pattern:** start each group `collapsed` with `tabs: []`. On expand, `on.groupToggle`
  fetches that group's children, stores them (`filesByGroup.set(id, items)`), and calls
  `refreshRail()` so `buildGroups()` now renders the tabs. **Invalidate on re-expand** —
  `filesByGroup.delete(id)` before the fetch — so a collapse→re-expand re-pulls the list and
  external writes (a connector, another tab) become visible without a full reload.
- **Count badge:** `group.count` shows the server's roster count until the children load, then the
  rendered tab count (`buildGroups` swaps it once `filesByGroup.has(id)`).

### Group caret / chevron

The caret is `<i class="rp-rail-group-caret bi bi-chevron-down">`. `rail.css` rotates it for the
collapsed state:

```css
.rp-rail-group:not(.expanded) .rp-rail-group-caret { transform: rotate(-90deg); }
```

So with the **`bi-chevron-down` base**: open group → caret points **down (south)**; collapsed
group → rotated −90° → points **`>` (right)**. The base icon **must** be `chevron-down` to match
this rule — emitting `chevron-right` (as an earlier pass did) points the wrong way (right when
open, up when collapsed). See Drift-prone (D0' caret fix).

## Group marks — `style="--mark"`

Each group gets a coloured rounded square (initials inside) for at-a-glance scanning.

- `groupHTML` emits `<span class="rp-rail-group-mark" style="--mark:<colour>">INITIALS</span>`.
- `mark` is **any CSS colour** — a hex (`#89b4fa`), or a theme token (`var(--rp-info)` /
  `var(--rp-mauve)` / `var(--rp-teal)` / `var(--rp-peach)`). `rail.css` consumes it with
  `.rp-rail-group-mark { background: var(--mark, var(--rp-surface-2)); }`.
- Initials come from `group.initials`, or are derived as the first 2 letters of `group.name`
  (`markInitials`).
- **Stable colour:** key the colour to the project's index in the *unfiltered* roster (not the
  filtered list), so searching/chip-filtering doesn't reshuffle the surviving groups' colours.
- Legacy: `rail.css` still carries a name-keyed `.rp-rail-group-mark[data-c="blue|mauve|teal|…"]`
  palette (the old hand-built rails + the landing cards use `data-c`); those rules override the
  `--mark` background when present. New code uses `--mark`.

## Search + ownership chips

- `search: { placeholder, onInput(q) }` → a `.rp-rail-filter` containing the shared `.rp-search`
  atom (a plain filter box — no results dropdown; that's omni-specific). `onInput` receives the
  trimmed query.
- `chips: [{ value, label, active }]` + `onChip(value)` → `.rp-rail-chips` of `.rp-chip` atoms
  (e.g. All / Personal / Shared / Company). `mountRail` does **not** toggle the chip's `is-active`
  for you — the page does it in `onChip` (`rail.el.querySelectorAll(".rp-rail-chips .rp-chip")
  …classList.toggle("is-active", c.dataset.chip === v)`).
- **The page filters, not the component.** Both handlers update the page's filter state and call
  `refreshRail()`; `buildGroups()` applies the predicate (ownership token + name match). When the
  filter hides every group, pass `emptyText` to `setGroups` so the rail shows a "No projects
  match …" line instead of a blank body.

## Overview pinned tab

A pinned pseudo-tab at the top of the body (the page's "landing/board" entry).

- `overview: { label, icon, active }` → `<div class="rp-rail-overview"><button class="rp-rail-tab"
  data-rail-action="overview">…</button></div>`. `onOverview()` fires on click.
- `active` reflects whether the surface is currently on the landing. Because `setGroups` re-renders
  the overview from `config.overview`, keep `config.overview.active` in sync (mutate it before a
  rebuild), and toggle the live `.active` class for the in-between lightweight case.

## Inline rename

Project- and file-rename use the built-in `inlineRename` (no page UI needed):

- The `group-rename` / `tab-rename` affordance swaps the name span for an `<input>`
  (`.rp-rail-{group,tab}-name-editing`), selects the text, and **commits on Enter or blur**,
  **reverts on Esc**. An empty or unchanged value reverts silently.
- On commit it calls `on.groupRename(groupId, value)` / `on.tabRename(tabId, value)` with the new
  value. The **page handler owns the side-effects** — the PATCH (`/projects/:id` `{name}` /
  `/files/:id` `{display_name}`), any cache invalidation, and a `refreshRail()` so the new name +
  derived mark initials repaint.

## Hide + hidden-recovery

A per-user declutter (a pure display hide — never a data/RBAC cut).

- `group-hide` / `tab-hide` affordances fire `on.groupHide(groupId)` / `on.tabHide(tabId)`. The
  page persists the hidden id to a pref (e.g. `rail_hidden_projects` / `rail_hidden_files`, each
  `{rid, name, project?}` so the recovery UI can label it), then `refreshRail()` (and
  `buildGroups`/`buildHidden` exclude/list it).
- `hidden: [{ title, items:[{ id, kind, name, meta }] }]` renders a tail `<details
  class="rp-rail-hidden">`. Its summary shows **`<i bi-eye-slash> Hidden (N)`** where `N` is the
  total items across all sections (projects + files). Each item is a `.rp-rail-hidden-item`
  carrying `data-restore-id` + `data-restore-kind`.
- Clicking an item fires `on.restore(id, kind)` → the page un-hides the pref + `refreshRail()`.

## Ghost-upload tab states

In-flight uploads appear as placeholder ("ghost") tabs in the target group.

- A tab with `ghost: "queued" | "active" | "done" | "failed"` renders the `.rp-rail-tab-ghost`
  base (dimmed, pointer-events:none) plus a state modifier (`-ghost-active` shimmers,
  `-ghost-done`, `-ghost-failed` red). `busy: true` adds `.is-busy` + a `.rp-rail-tab-spinner`.
  `title` sets a hover tooltip (e.g. a failed upload's error message).
- **Pattern (workspace):** seed a ghost per file with `state:"queued"` in `uploadGhosts` →
  `refreshRail()`; upload sequentially, flipping the current ghost to `"active"` then
  `"done"`/`"failed"` and `refreshRail()` each step; after the batch, drop the succeeded/queued
  ghosts, keep the **failed ones ~6s** (their `title` is the error) then clear, and reload the
  group's real files. Ghost ids are inert (`on.tab` ignores them).

## Footer — create / upload / nav

`footer: { upload, create, nav }` renders `.rp-rail-footer`:

- `upload: { label }` → a glass `.rp-btn-icon--glass` `[data-rail-action="upload"]` → `on.upload()`.
  (Workspace deliberately omits this — its Upload lives in the data toolbar; the rail-foot is just
  Create.)
- `create: { label }` → a glass create button `[data-rail-action="create"]` → `on.create()`
  (e.g. New project / New dashboard / New connector). The `create-action` helper can drive the
  label.
- `nav: { active, session }` → the shared `.rp-rail-footer-nav` utility cluster: a Settings link,
  the theme-toggle + sign-out (`footerUtilitiesHTML()` + `wireFooterUtilities(host)` after render,
  shared with [footer-utilities.js](footer-utilities.md)), and a Profile avatar (initials from the
  session). `active` highlights the matching item.

## Affordance glyphs are bare `<span>`s

The per-row affordances — `rename`, `hide`, and `actions` (e.g. workspace's "Visualize") — render
as bare `<span class="rp-rail-{tab,group}-rename" data-rail-action="…">`, **not** `<button>` and
**not** `rp-btn-icon`. Reasons: the tab itself is a `<button class="rp-rail-tab">`, so an affordance
`<button>` inside it is invalid nested-button HTML; and `rp-btn-icon` is a 2rem `min-width`/padded
icon button that breaks the tight tab row. The `.rp-rail-{tab,group}-{rename,hide,visualize}` atoms
are 1.25rem hover-fade glyphs that style a `<span>` directly (matching the hand-built
Monitoring/cases rails). The delegator routes them via `data-rail-action`.

## Collapse + view-seg (composed helpers)

- **Collapse:** `config.collapsible !== false` wires `mountRailCollapse(host, [data-rail-action=
  collapse])` — toggles `.compact` on the rail (icon-only 3.75rem) + swaps the chevron.
- **View-seg:** `config.views` wires `mountRailSeg(segEl, { pref, fallback, onChange })` — a
  persisted segmented toggle whose buttons carry `data-rail-seg`; `onChange(value)` is the page's
  to act on (swap the rendered groups / surface). Both helpers live in
  [rail-controls.js](../rail-controls.md) (class-agnostic, deduped before the framework existed).

## Consumers

`workspace` (the rich rail — rename/hide/recovery, overview, per-row Visualize, upload ghosts,
deep-link, prewarm), `dashboard` (lean — charts/dashboards), `admin-console`, `sheetwise` (with the
SQL↔Connectors view-seg + connector groups), `database`. **cases.js** still hand-builds its rail
(pending cutover; its `rp-cases-rail-board` folds into `overview` then).

## Drift-prone areas

- **Group expand state is `.expanded`, NOT `.is-collapsed`** (fixed 2026-06-05, found when SheetWise
  became `mountRail`'s first live consumer). The earlier `is-collapsed` toggle was a no-op against
  the CSS — every group rendered with its body hidden. The hand-built workspace rail had always
  added `.expanded` manually, so the bug only surfaced once a page mounted the *component*.
- **Footer is folded into the rail here.** The live app also has [rail-footer.js](../rail-footer.md)
  (mounted separately); the framework re-unifies it. Both compose
  [footer-utilities.js](footer-utilities.md) for theme/sign-out, so the two paths can't drift; the
  legacy file retires at the shell cutover.
- **Mark/dot render fix (D0', 2026-06-07)**: `groupHTML` emitted the mark as `style="--mark"` with
  an *empty* span and `tabHTML` emitted the dot as `style="--dot"`, but `rail.css` styled the mark
  only via `[data-c]` and the dot only via `.is-clean/.is-warn/.is-dirty` — so every `mountRail`
  mark rendered as a blank colourless square and dots were invisible (latent — page-verify checks
  classes/console, not the mark's colour). Fixed by `rail.css` `background: var(--mark)`,
  `groupHTML` filling `initials`, and `tabHTML` emitting the dot as the `.is-*` class. Repaired
  admin-console + sheetwise marks too.
- **Affordance-glyph regression (D0', 2026-06-07, runbook 0020)**: workspace was the first page to
  use **per-tab** rename/hide/actions, exposing that they were emitted as
  `<button class="rp-btn-icon rp-rail-…-rename">` — invalid nested `<button>` + oversized. Fixed by
  emitting bare `<span>`s (above) — match the hand-built Monitoring/cases rails, which always
  rendered fine.
- **Caret base must be `chevron-down` (D0', 2026-06-07, runbook 0020)**: `groupHTML` emitted
  `chevron-right` against a CSS rotate-when-collapsed rule written for `chevron-down`, so the caret
  pointed the wrong way. Same base-icon-vs-CSS mismatch class as the affordance + mark bugs.
- **Studio adoption (D0', 2026-06-07)**: dashboard then workspace migrated off their hand-built
  rails onto `mountRail`, joining admin-console / sheetwise / database. The recurring lesson: a
  framework component's UNEXERCISED path is a latent trap (marks, caret, per-tab affordances were
  all latently wrong until a page exercised them) — adopting it on a richer page is a verification
  event; adversarially diff vs the hand-built rail it replaces + eyeball real pixels.
- The two composed helpers live OUTSIDE `framework/` (`rail-controls.js`); they were deduped before
  the framework existed and stay class-agnostic.

## Related

- [framework/rail.css](../../../../../../frontend/styles/framework/rail.css) — the rail's CSS source
  (structure, the `--mark` background, the caret rotate, the `.is-*` dots, the ghost states, the
  `rp-rail-views` seg). CSS files have no atomic doc — the source is the reference.
- [rail-controls.js](../rail-controls.md) — collapse + view-seg behaviors it composes.
- [rail-footer.js](../rail-footer.md) — the legacy footer nav it supersedes.
- [footer-utilities.js](footer-utilities.md) — the shared theme/sign-out the footer composes.
- [create-action.js](create-action.md) — drives the footer create button's label.
- Runbook [0020](../../../../runbooks/0020-d0-mountrail-adoption.md) — the D0' adoption + the
  regressions it surfaced. [component-registry](component-registry.md) · [framework index](index.md).
