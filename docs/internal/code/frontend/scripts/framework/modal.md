---
title: frontend/scripts/framework/modal.js
source: ../../../../../../frontend/scripts/framework/modal.js
owner: Torv
section: Internal · Code · Frontend · scripts · framework
last modified date: 2026-06-04
---

# framework/modal.js — generic overlay modal

## Purpose

One generic dialog (head + field form + foot) that dedups the bespoke `.rp-modal-*`
dialogs hand-built across the app (cases-create, home-create, settings-chart,
monitoring). Support component for **S4 create-action** (CAS_37B2E1BF). The CSS atom
(`.rp-modal-*`) already lives in `styles/modal.css`, is already `rp-`-compliant, and
is loaded by `main.css` — so this is a **JS-only** component that composes those
classes plus the `rp-btn-icon` / `rp-btn` atoms (the legacy dialog markup used
`rt-icon-btn` / `rt-btn`; the framework version uses the atoms).

## Public surface

- `mountModal(host, opts)` — render the dialog **visible** into `host` (sandbox /
  embedded). Self-registers as `"modal"`.
- `openModal(opts)` — the **overlay**: append a dialog to `<body>`, wire ESC /
  backdrop / close / cancel dismissal, focus the first field, return `{ el, close }`.
  This is what `create-action.js` calls for `kind:"modal"` specs.
- `modalHTML(opts, idBase)` — the shared inner markup builder.

`opts`: `{ title, fields[], submitLabel, submitIcon, cancelLabel, onSubmit(values, modal), onClose }`.
A `field` = `{ key, label, required, placeholder, type ('text'|'email'|'url'|'textarea'|'select'), options[], rows, hint, autocomplete }`.

ESM. Imports `register` + `esc`.

## How it works

- `modalHTML` builds backdrop + body[head(title + `rp-btn-icon` close) + form(fields →
  `rp-modal-field` label+control + an error slot + foot(cancel `rp-btn--glass` + submit
  `rp-btn-icon--accent`))]. Field controls switch on `type` (input / textarea / select).
- `wire()` binds `[data-modal-dismiss]` → close and form submit → `readValues(form)` →
  `await opts.onSubmit(values, {el, close})` → close (a thrown error shows in the inline
  `.rp-modal-error`, dialog stays open).
- **SECURITY**: every title/label/placeholder/hint/option is `esc()`'d before innerHTML;
  field VALUES are read from the live inputs' `.value` on submit (never interpolated); the
  error message uses `textContent`.

## Drift-prone areas

- **CSS lives in `styles/modal.css`** (legacy location, already `rp-`-compliant) — at the
  cutover it relocates to `frontend/styles/framework/modal.css` and the live bespoke
  dialogs (cases/home/settings/mon) delete their copies + delegate here. No CSS port was
  needed (the classes were already the framework namespace).
- **Concatenation footgun** (already bit this file once — `Create caseNaN`): never put a
  bare `+ '<str>'` on its own line after another `+`-led line; the leading `+` unary-coerces
  the string to `NaN`. Caught by the sandbox render, not static checks.
- The entity-picker field type (user picker) is NOT ported — `select`/`input`/`textarea`
  only; a picker field is a later editor-registry tie-in.

## Related

- [create-action](create-action.md) — calls `openModal` for `kind:"modal"` create specs.
- `frontend/styles/modal.css` — the `.rp-modal-*` CSS (already rp-; relocates to framework/ at cutover).
- Atoms composed: `rp-btn-icon` / `rp-btn` ([atoms](../../styles/...)) · [component-registry](component-registry.md) · [framework index](index.md).
