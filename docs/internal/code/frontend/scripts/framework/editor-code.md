---
title: frontend/scripts/framework/editor-code.js
source: ../../../../../../frontend/scripts/framework/editor-code.js
owner: Torv
section: Internal · Code · Frontend · scripts · framework
last modified date: 2026-06-05
---

# editor-code.js

## Purpose

The **code editor** framework component — a transparent `<textarea>` over a
syntax-highlighted `<pre>` with identical metrics, so the caret/selection track
the rendered tokens. Generalized out of the SheetWise SQL console (was the
page-private `.sw-ed*` / `.tok-*`) so any code / SQL / expression input reuses
ONE component. The highlighter is **cosmetic** — it never parses or executes; the
backend allowlist is the real guard.

## Public surface

- `mountEditorCode(host, opts)` → `{ el, actions, getValue, setValue, focus,
  insertAtCaret, destroy }`. `host` becomes the `.rp-editor` card.
  - `opts`: `{ value, language="sql", placeholder, ariaLabel, bar, hint,
    onInput(value), onRun(value) }`.
  - `onRun` fires on ⌘/Ctrl+Enter; Tab inserts two spaces (never leaves the field).
  - `bar:true` renders a footer bar (`hint` text + an empty `.rp-editor-actions`
    slot, returned as `actions`) — the caller fills the slot with its own
    `rp-btn-icon` buttons and keeps control of their state.
  - `insertAtCaret(text)` — for "click a column to insert it into the query".
- `registerEditorLanguage(name, { keywords, functions, lineComment, strings })` —
  the OPEN language registry. `sql` + `plain` ship built-in; a new language is a
  registration, not a `switch` edit (mirrors the codec / type registries).
- Registered as `"editor-code"` in `component-registry.js`.

## Drift-prone areas

- **XSS-safe by construction.** `highlight()` builds its output from `esc()`'d
  slices only — every token `<span>` wraps escaped source — so the `<pre>`
  `innerHTML` is safe. Keep every new token path escaped.
- **Metric parity.** `.rp-editor-hi` (the `<pre>`) and `.rp-editor-input` (the
  textarea) MUST share padding / font / line-height / wrapping (editor-code.css),
  or the caret drifts off the rendered tokens. Change them together.
- **Cosmetic only.** The tokenizer must never be mistaken for a parser/validator —
  the server's SQL allowlist is the security boundary.

## Related

- [editor-code.css](../../../styles/framework/editor-code.md) *(if present)* — the `rp-editor*` + `rp-tok-*` rules.
- [Frontend framework landing](../../../index.md)
- Consumer: [pages/sheetwise.js](../pages/sheetwise.md) — the SQL console.
