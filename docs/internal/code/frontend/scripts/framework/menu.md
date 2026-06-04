---
title: frontend/scripts/framework/menu.js
source: ../../../../../../frontend/scripts/framework/menu.js
owner: Torv
section: Internal · Code · Frontend · scripts · framework
last modified date: 2026-06-04
---

# framework/menu.js — Menu component (the toggle-click dropdown)

## Purpose

The toggle-click **dropdown**: a trigger button declares `data-dd="<panelId>"`
and a sibling `.rp-menu` panel carries `id="<panelId>"` plus `.rp-menu-item`
rows. This is the single largest porting gap of the RedTable toolbar — its four
dropdowns (rows, columns, export, …) ship **dead** without the delegate that
opens them. Ported from [dropdown.js](../dropdown.md) (`bindDropdown`) into the
framework layer (CAS_37B2E1BF): **one** delegated document click handler drives
**every** menu on the page, so newly-rendered `[data-dd]` buttons work with no
per-page wiring.

## Public surface

- `bindMenu()` — wire the single delegated document handler. Idempotent
  (module-level singleton); cheapest call site is app boot. ESM.
- `mountMenu(host, config)` → `{ el, panel, trigger, close() }`. Emits the
  `rp-menu-wrap > trigger + rp-menu` structure from a config and ensures the
  delegate is wired. Self-registers as `"menu"`. Composes the `esc` util for
  every dynamic value.

### Config (`mountMenu`)

| key | shape | renders |
|---|---|---|
| `id` | string (auto if omitted) | the `data-dd` ↔ panel `id` link |
| `trigger` | `{ label, icon, className }` | the toggle button (defaults to an `rp-btn`; `className` lets a caller swap in `rp-btn-icon` / a toolbar pill) |
| `items` | `[{ label, icon, value, selected, tick, dataset, disabled }]` | `.rp-menu-item` rows; `selected` adds the accent state, `tick` adds the trailing `.rp-menu-tick` checkmark |
| `dataKey` | string (default `"value"`) | the `data-<dataKey>` attribute on each item |

Item clicks are **not** wired by the builder — the consumer subscribes via its
own delegated handler keyed off `data-<dataKey>` (the live-toolbar pattern); the
builder owns the DOM, the caller owns what each item does.

## How it works

- **One delegated document handler** (`bindMenu`) implements the three behaviors
  verbatim from the legacy `bindDropdown`:
  1. **Trigger click** → toggle that panel's `.open`, closing every other open
     panel first (**mutex** — one open at a time). `stopPropagation` so the
     click doesn't bubble to step 3 and immediately re-close.
  2. **Item click** inside an open panel → the consumer's handler runs first
     (bubble phase fires children-first), then this handler closes the panel
     (click-to-dismiss).
  3. **Click anywhere else** → close every open panel (outside-click).
- **Mutex/outside-click sweep is two-namespace.** The selector closes both
  `.rp-menu.open` **and** `.rt-dd.open`, so `bindMenu` can drive a legacy-classed
  panel too — letting it fully supersede `bindDropdown` once `main.js` swaps the
  boot call, with no legacy panels stuck open during the cutover window.
- **XSS-safe**: every dynamic value in `mountMenu` passes through `esc()` — same
  pattern as [rail.js](rail.md) / [omni.js](omni.md). Extra `data-*` keys are
  caller-supplied config identifiers, not user content; their values are escaped.

## Drift-prone areas

- **Coexistence with the live `bindDropdown`.** Until `main.js` swaps its boot
  call from `bindDropdown` to `bindMenu`, BOTH delegates are on `document`. Two
  document handlers reacting to the same click would double-close, so the swap
  (not an add) is the cutover step. The two-namespace `OPEN_SEL` is what makes
  the single `bindMenu` a safe drop-in replacement.
- **Trigger is NOT part of the atom.** The `data-dd` button composes a button
  atom (`rp-btn` / `rp-btn-icon` / a toolbar pill); the menu atom owns only the
  wrap (positioning context), the absolute panel, and the item rows.
- **Not the autocomplete.** `.rt-ac` (autocomplete.js) is a separate focus-driven
  atom deliberately NOT classed `.rt-dd`, so the document delegate never fights
  its focus/blur semantics. It is out of scope for the menu port.
- **State class names kept verbatim.** `.open` (panel) and `.selected` (item) are
  ported as-is rather than de-BEM'd to `.is-*`, because the delegate + every
  consumer toggle them by those exact names — renaming would be a behavior change,
  not zero-visual-change.

## Related

- [framework/menu.css](../../../styles/framework/menu.md) — the menu's CSS (`rp-menu-wrap` / `rp-menu` / `rp-menu-item` / `rp-menu-tick`, + the `.rp-pred-multi` item override).
- [dropdown.js](../dropdown.md) — the legacy `bindDropdown` it supersedes.
- [component-registry](component-registry.md) · [framework index](index.md).
