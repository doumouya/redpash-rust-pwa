---
title: frontend/scripts/framework/head.js
source: ../../../../../../frontend/scripts/framework/head.js
owner: Torv
section: Internal · Code · Frontend · scripts · framework
last modified date: 2026-06-04
---

# framework/head.js — Head component (B2)

## Purpose

The object/surface **header bar** that sits at the top of an object detail
surface: a flex row of an optional **object-id RID pill** (click-to-copy), the
object **title** (optionally click-to-edit), and optional right-edge **actions**
(a delete button + a close link). The framework head is **generic + data-driven**
— `mountHead(host, config)` emits the entire `rp-head` structure from a config of
demo-able data + handlers, so a page just supplies the config and the builder
owns the structure and behavior (the "lego brick"). Part of the framework
extraction (CAS_37B2E1BF); the consolidation of the live cases header, which is
authored HTML (`rp-cases-detail-head`) wired imperatively in `cases.js`.

## Public surface

- `mountHead(host, config)` → `{ el, setTitle(title) }`. `host` becomes the
  `.rp-head`. Self-registers as `"head"`. ESM; composes the `esc` util and the
  `rp-mono-pill` / `rp-title` / `rp-btn-icon` atoms. `setTitle` replaces the
  displayed title text in place (e.g. after an async load).

### Config (every field optional)

| key | shape | renders / effect |
|---|---|---|
| `objectId` | string | `rp-object-id` RID pill (`rp-mono-pill.is-copyable` atom), click-to-copy. Omitted = no pill. |
| `title` | string | `rp-title` heading text (`"Loading…"` default). |
| `editable` | bool | title becomes click-to-edit (contenteditable). |
| `onTitleEdit` | `(newTitle) => void` | commit handler (Enter / blur), fires only when the value changed + is non-empty. |
| `onDelete` | `() => void` | renders the `rp-object-delete` trash button + calls this after a `confirm()`. Omitted = no button. |
| `closeHash` | string | renders the `rp-object-close` `<a href=…>`. Omitted = no close link. |
| `shortenId` | `(id) => string` | optional display-shortener; full id stays in the copy payload + the `title` tooltip. |

## How it works

- **Id copy-to-clipboard**: the pill gets `role=button` + `tabindex=0`; click or
  Enter/Space writes the **full** id to `navigator.clipboard`, flashes
  `.is-copied` with the text `Copied`, then restores the shortened display after
  1200 ms (the same affordance the atom's `.is-copyable`/`.is-copied` styles).
- **Title inline-edit** (only when `editable`): clicking the `<h1>` sets
  `contenteditable=plaintext-only`, adds `.is-editing` (the accent ring), focuses
  and select-alls. **Enter** commits, **blur** commits, **Esc** reverts and
  `stopPropagation`s so the page-level global Escape (panel-close) does not also
  fire. Commit calls `onTitleEdit(value)` only when the value changed + is
  non-empty; otherwise the original text is restored.
- **Delete**: clicking the trash button runs `window.confirm()` (interpolating
  the current title) and, on confirm, calls `onDelete()` — the page owns the API
  call + navigation.
- **Close is declarative**: the `<a href=closeHash>` lets the hash router clear
  the detail; there is **no** JS close handler. The `title="Close (Esc)"` only
  documents the Esc alternative, which is a page-level global handler — not this
  component (see Drift-prone areas).
- All dynamic content is escaped via `esc()` — same XSS-safe pattern as
  [rail.js](rail.md) / [omni.js](omni.md); the full id goes into a `title=` attr
  where `esc()` neutralises the quote.

## Drift-prone areas

- **The delete button's shape was a hidden `rt-` dependency — and the first port
  got the wrong atom.** Live, the element is `class="rt-icon-btn rp-cases-detail-
  delete"` — the box came from `.rt-icon-btn` (a **1.75rem square**, 0.375rem
  radius), and `rp-cases-detail-delete` only added `flex-shrink` + the destructive
  hover. The initial port composed the `rp-btn-icon` **base**, but that atom is
  verbatim `.rt-btn` (a **2rem padded pill**, 0.5625rem radius) — a *different*
  legacy shape, so the button silently grew (caught by the adversarial verify).
  The fix: compose **`rp-btn-icon--sq`** — the 1.75rem-square variant added to
  atoms.css that mirrors `.rt-icon-btn`. The destructive-hover tint stays as the
  `.rp-head` context override.
- **The close `<a>` hand-rolled the same square inline** (anchor, not button, so
  no `rt-icon-btn`). It composes `rp-btn-icon rp-btn-icon--sq` (the base covers
  anchor use: `text-decoration:none` + ghost hover; `--sq` the square shape).
- **Accepted atom-normalization on the id pill (verified, minor).** The RID pill
  composes `rp-mono-pill`, whose canonical box differs slightly from the legacy
  `rp-cases-detail-rid` (padding `1px .375rem` vs `.125rem .4375rem`; radius
  `.25rem` vs `.3125rem`; idle colour `--rp-text-dim` vs `--rp-text-mute`). These
  are pre-existing atom deltas from the S-atoms lift, **intentionally inherited**
  so the pill matches the one canonical mono-pill rather than re-forking the
  legacy box — the point of atoms. Not overridden back in `.rp-head`.
- **Esc-to-close is NOT in this component.** It's a global handler elsewhere on
  the page; the title-edit `keydown` deliberately `stopPropagation`s Escape so
  the panel doesn't close mid-edit. The ported close is only the declarative
  `<a href>`.
- **Surface context required.** The head's `flex-shrink:0` + surface bg only read
  correctly inside a `rp-surface` flex column (the live open-case `<aside>`); the
  head is a flex child of that surface, not a standalone block.
- **Cross-page heads fold in as context, not classes.** Modal / shell / doc heads
  are the same conceptual shape (flex row, optional left identity, title, optional
  right actions/meta, bottom border) diverging on align / bg / left / right. At
  cutover these become ancestor-scoped overrides (`.rp-modal .rp-head`,
  `.rp-shell .rp-head`, …) — never parallel `rp-modal-head` / `rp-shell-head` /
  `rp-doc-head` duplicate names. The shell head's count chip would compose the
  `rp-count` atom; the doc head's stamp its own meta element.

## Related

- [framework/head.css](../../../styles/framework/head.md) — the head's CSS (container + the title/delete context overrides).
- [framework/atoms.css](../../../styles/framework/atoms.md) — the composed atoms: `rp-mono-pill` (A10), `rp-title` (A6), `rp-btn-icon--sq` (the 1.75rem-square variant the delete/close use).
- [framework/rail.js](rail.md) — sibling framework component (same builder + `esc()` pattern).
- [component-registry](component-registry.md) · [framework index](index.md).
