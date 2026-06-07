---
title: frontend/scripts/framework/rail.js
source: ../../../../../../frontend/scripts/framework/rail.js
owner: Torv
section: Internal · Code · Frontend · scripts · framework
last modified date: 2026-06-07
---

# framework/rail.js — Rail component (B1)

## Purpose

The vertical two-level navigation strip on every railed page: a **group** = a
container (project / status bucket), a **tab** = a leaf (file / case). Collapses
to a 3.75rem icon-only rail. The framework rail is **generic + data-driven** —
`mountRail(host, config)` emits the entire `rp-rail-*` structure from a config of
data + handlers, so a page just supplies the config and the builder owns the
structure and behavior (the "lego brick"). Part of the framework extraction
(CAS_37B2E1BF); the consolidation of the per-page rails the live app still
hand-builds with `rt-nav-*`/`rt-group-*`/`rt-tab-*`.

## Public surface

- `mountRail(host, config)` → `{ el, seg, setGroups(groups, hidden, emptyText?) }`.
  `host` becomes the `.rp-rail`. Self-registers as `"rail"`. ESM; composes
  `mountRailCollapse`/`mountRailSeg` ([rail-controls.js](../rail-controls.md)) and
  the `esc` util. `setGroups` re-renders the body in place after a data change;
  pass `emptyText` to show a `.rp-rail-state` line when `groups` is empty (e.g. a
  filter that matched nothing — distinct from a load error).

### Config (every section optional)

| key | shape | renders |
|---|---|---|
| `title` / `collapsible` | string / bool | `rp-rail-head` + collapse toggle |
| `views` | `{ pref, fallback, options:[{value,label,icon}], onChange }` | `rp-rail-views` seg |
| `search` | `{ placeholder, onInput(q) }` | `rp-rail-filter` > `rp-search` atom |
| `chips` / `onChip` | `[{value,label,active}]` / fn | `rp-rail-chips` > `rp-chip` atom |
| `overview` / `onOverview` | `{label,icon,active}` / fn | `rp-rail-overview` pinned tab |
| `groups` | `[{id,name,mark,initials,count,collapsed,renamable,hidable,addLabel,tabs:[…]}]` | `rp-rail-group` + `rp-rail-tab` |
| `hidden` | `[{title,items:[{id,kind,name,meta}]}]` | `rp-rail-hidden` `<details>` |
| `footer` | `{upload:{label},create:{label},nav:{active,session}}` | `rp-rail-footer` + `rp-rail-footer-nav` |
| `on` | `{tab,tabRename,tabHide,groupToggle,groupRename,groupHide,groupAdd,restore,upload,create, …custom}` | event handlers |

A tab takes `{ id, name, icon, dot, actions, title, ghost:'queued'|'active'|'done'|'failed', active, busy, renamable, hidable }`.
- `mark` = any CSS colour (hex / `var(--rp-…)`); the group square fills with it (CSS `background: var(--mark)`) and shows `initials` (or 2 letters derived from `name`).
- `dot` = a **state class** (`"is-clean"`/`"is-warn"`/`"is-dirty"`), not a colour — composes `.rp-rail-tab-dot.<class>`.
- `actions` = extra per-row glyph buttons `[{ action, icon, title, cls? }]`; each routes by its `action` name through `on[action](tabId, groupId)` (the delegator's default case). Workspace's per-row "Visualize" (`→ #/dashboard?source=`) is the first user.
- `title` = an optional hover tooltip on the tab (e.g. a failed-upload ghost's error message).
- **Affordance glyphs are bare `<span>`s, NOT `<button>`/`rp-btn-icon`.** rename/hide/`actions`
  render as `<span class="rp-rail-tab-rename" data-rail-action="…">` (group:
  `rp-rail-group-rename`) — exactly like the hand-built Monitoring/cases rails. The tab itself is
  the `<button class="rp-rail-tab">`, so an affordance `<button>` inside it would be invalid
  nested-button HTML; and `rp-btn-icon` (a 2rem `min-width`/padded icon button) breaks the tight
  tab row. The `.rp-rail-{tab,group}-{rename,hide,visualize}` atoms are 1.25rem hover-fade glyphs
  that style a `<span>` directly. The delegator routes them via `data-rail-action`. See
  Drift-prone (D0', 2026-06-07).

## How it works

- **One delegated click handler** on the rail root routes every action by
  `data-rail-action` (`tab` / `group-toggle` / `tab-rename` / `group-hide` / …),
  so the body can re-render (`setGroups`) without re-binding per element.
- **Collapse** + **view-seg** are delegated to the two class-agnostic helpers in
  `rail-controls.js` (they key off `data-rail-seg` + passed elements, not class
  names) — reused verbatim from the live dedup (2026-05-29).
- **Inline rename**: clicking a rename button swaps the name span for an `<input>`
  (`rp-rail-{tab,group}-name-editing`), commits on Enter/blur, reverts on Esc.
- **Search is one atom**: the filter box is the `rp-search` atom in the `.rp-rail`
  context (a plain filter — no results dropdown; that part is omni-specific).
- All dynamic content is escaped via `esc()` — same XSS-safe pattern as
  [omni.js](omni.md); no new surface. (`--mark` goes into a `style=` attr;
  `esc()` neutralises the quote so the attribute can't break out, and a CSS
  custom-property value can't execute script. The dot is a class token, also escaped.)
- **Generic action dispatch**: any `data-rail-action` not in the explicit switch
  falls through to `on[action]?.(tabId, groupId)`, so a page adds a per-row (or
  per-group) action just by listing it in a tab's `actions` + the matching `on{}`
  handler — no edit to the component. Keeps the rail open-ended.

## Drift-prone areas

- **Group expand state is `.expanded`, NOT `.is-collapsed`** (fixed 2026-06-05, found
  when SheetWise became `mountRail`'s first live consumer). `rail.css` shows the body
  via `.rp-rail-group:not(.expanded) .rp-rail-group-body { display:none }`, so
  `groupHTML` renders `.expanded` by default (omits it only when `g.collapsed`) and
  `group-toggle` toggles `.expanded`. The earlier `is-collapsed` toggle was a no-op
  against the CSS — every mountRail group rendered with its body hidden. The
  hand-built workspace rail had always added `.expanded` manually (`workspace.js`),
  which is why the bug only surfaced once a page mounted the *component*.
- **Footer is folded into the rail here.** The live app splits the utility nav
  into [rail-footer.js](../rail-footer.md) (mounted separately, class
  `rp-rail-footnav`); the framework re-unifies it as part of the rail
  (`rp-rail-footer-nav`). The legacy file + the `footnav` name retire at the
  shell cutover — until then the two coexist (the framework twin, like topbar/omni).
  Since 2026-06-07 `mountRail`'s footer also carries the shared **theme-toggle +
  sign-out** (`footerUtilitiesHTML()` in the markup + `wireFooterUtilities(host)`
  after render), matching [rail-footer.js](../rail-footer.md) — both compose the
  same [footer-utilities.js](footer-utilities.md), so the two footer paths can't
  drift.
- **Mark/dot render fix (D0', 2026-06-07)**: `groupHTML` emitted the mark as
  `style="--mark:…"` with an **empty** span, and `tabHTML` emitted the dot as
  `style="--dot:…"` — but `rail.css` styled the mark only via `[data-c="…"]` and the
  dot only via `.is-clean/.is-warn/.is-dirty`. So every `mountRail` mark rendered as a
  *blank colourless square* and a dot would be invisible (latent — page-verify checks
  classes/console, not the mark's background colour). Fixed by (a) `rail.css`
  `.rp-rail-group-mark { background: var(--mark, …) }` (the `[data-c]` variants still
  override for the name-keyed palette), (b) `groupHTML` filling the mark with
  `initials` (or 2 letters from `name`), (c) `tabHTML` emitting the dot as the
  `.is-*` class. This repaired admin-console + sheetwise marks too.
- **Studio adoption (D0', 2026-06-07)**: `dashboard.js` then `workspace.js` (the rich
  adopter — per-row `actions`/Visualize, `hidden` recovery, rename, `overview` pinned tab,
  upload ghosts) migrated off their hand-built rails onto `mountRail`, joining admin-console
  / sheetwise / database.
- **Affordance-glyph regression (D0', 2026-06-07)**: workspace was the first page to use
  **per-tab** rename/hide/actions, which exposed that `tabHTML`/`groupHTML` emitted those as
  `<button class="rp-btn-icon rp-rail-…-rename">` — invalid (a `<button>` nested inside the tab
  `<button>`) AND oversized (`rp-btn-icon` is a 2rem `min-width`/padded button; the
  `.rp-rail-*-{rename,hide,visualize}` atoms only set 1.25rem `width/height`), so the glyphs
  rendered as oversized boxes that broke the tab row (squeezed the stage dot). Fixed by emitting
  the affordances as bare `<span>`s (no `rp-btn-icon`, no nested button) — exactly like the
  hand-built Monitoring/cases rails, which always rendered fine. The atom CSS styles the span
  directly; no CSS change needed. The path was never exercised until a page mounted the
  *component* with per-tab affordances. Runbook 0020.
- **Cutover pending**: `cases.js` still builds its own rail. At cutover it becomes a
  config-supplier; `rp-cases-rail-board` folds into `rp-rail-overview` then.
- The two helpers it composes live OUTSIDE `framework/` (`rail-controls.js`);
  they were deduped before the framework existed and stay class-agnostic.

## Related

- [framework/rail.css](../../../styles/framework/rail.md) — the rail's CSS (incl. the `rp-rail-views` seg, ported from `rt-seg--rail`).
- [rail-controls.js](../rail-controls.md) — collapse + seg behaviors it composes.
- [rail-footer.js](../rail-footer.md) — the legacy footer nav it supersedes.
- [footer-utilities.js](footer-utilities.md) — the shared theme/sign-out the footer composes.
- [component-registry](component-registry.md) · [framework index](index.md).
