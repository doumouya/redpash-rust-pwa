---
title: frontend/scripts/framework/rail.js
source: ../../../../../../frontend/scripts/framework/rail.js
owner: Torv
section: Internal · Code · Frontend · scripts · framework
last modified date: 2026-06-04
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

- `mountRail(host, config)` → `{ el, seg, setGroups(groups, hidden) }`. `host`
  becomes the `.rp-rail`. Self-registers as `"rail"`. ESM; composes
  `mountRailCollapse`/`mountRailSeg` ([rail-controls.js](../rail-controls.md)) and
  the `esc` util. `setGroups` re-renders the body in place after a data change.

### Config (every section optional)

| key | shape | renders |
|---|---|---|
| `title` / `collapsible` | string / bool | `rp-rail-head` + collapse toggle |
| `views` | `{ pref, fallback, options:[{value,label,icon}], onChange }` | `rp-rail-views` seg |
| `search` | `{ placeholder, onInput(q) }` | `rp-rail-filter` > `rp-search` atom |
| `chips` / `onChip` | `[{value,label,active}]` / fn | `rp-rail-chips` > `rp-chip` atom |
| `overview` / `onOverview` | `{label,icon,active}` / fn | `rp-rail-overview` pinned tab |
| `groups` | `[{id,name,mark,count,collapsed,renamable,hidable,addLabel,tabs:[…]}]` | `rp-rail-group` + `rp-rail-tab` |
| `hidden` | `[{title,items:[{id,kind,name,meta}]}]` | `rp-rail-hidden` `<details>` |
| `footer` | `{upload:{label},create:{label},nav:{active,session}}` | `rp-rail-footer` + `rp-rail-footer-nav` |
| `on` | `{tab,tabRename,tabHide,groupToggle,groupRename,groupHide,groupAdd,restore,upload,create}` | event handlers |

A tab takes `{ id, name, icon, dot, ghost:'active'|'done'|'failed', active, busy, renamable, hidable }`.

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
  [omni.js](omni.md); no new surface. (`--mark`/`--dot` go into a `style=` attr;
  `esc()` neutralises the quote so the attribute can't break out, and a CSS
  custom-property value can't execute script.)

## Drift-prone areas

- **Footer is folded into the rail here.** The live app splits the utility nav
  into [rail-footer.js](../rail-footer.md) (mounted separately, class
  `rp-rail-footnav`); the framework re-unifies it as part of the rail
  (`rp-rail-footer-nav`). The legacy file + the `footnav` name retire at the
  shell cutover — until then the two coexist (the framework twin, like topbar/omni).
- **Cutover pending**: live pages still build their own `rt-nav-*` rails. At
  cutover, each page becomes a config-supplier; Cases' `rp-cases-rail-board`
  folds into `rp-rail-overview` then.
- The two helpers it composes live OUTSIDE `framework/` (`rail-controls.js`);
  they were deduped before the framework existed and stay class-agnostic.

## Related

- [framework/rail.css](../../../styles/framework/rail.md) — the rail's CSS (incl. the `rp-rail-views` seg, ported from `rt-seg--rail`).
- [rail-controls.js](../rail-controls.md) — collapse + seg behaviors it composes.
- [rail-footer.js](../rail-footer.md) — the legacy footer nav it supersedes.
- [component-registry](component-registry.md) · [framework index](index.md).
