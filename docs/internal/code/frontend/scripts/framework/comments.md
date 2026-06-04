---
title: frontend/scripts/framework/comments.js
source: ../../../../../../frontend/scripts/framework/comments.js
owner: Torv
section: Internal · Code · Frontend · scripts · framework
last modified date: 2026-06-04
---

# framework/comments.js — Comment-view component

## Purpose

One reusable **comment thread + rich composer** — the framework component for the
4th-iteration "comment view" in the port manifest (CAS_37B2E1BF, group **B5**). A
**de-cased** port of the Cases comment view: Em — *"We could decide to use a Comment
view somewhere else one day, don't specify rp-cases"* — so every legacy
`rp-cases-comment-*` / `rp-cases-composer-*` / `rp-cases-pending-*` / `rp-cases-msg-*`
class becomes generic `rp-comment-*` / `rp-composer-*`. The CSS twin is
`frontend/styles/framework/comments.css` (verbatim port of `cases.css` 959–1412, name
change only).

## Public surface

- `mountComments(host, opts)` — renders the thread + composer into `host`. Self-registers
  as `"comments"` in the component registry. Options (all optional):
  - `comments[]` — `{rid, author_id, author_display_name, created_at, body|bodyHtml,
    is_edited, attachments[]}`; `attachments` = `{name, icon, sizeLabel}`.
  - `me` / `reporterId` / `assigneeId` — mark own comments (edit/delete affordance + tint)
    and the Reporter/Assignee role tag.
  - `composer` (default `true`), `placeholder`, `sendingAs`.
  - **Injectable renderers** (decoupling — no page coupling): `renderBody(cm)`,
    `fmtClock(ts)`, `dayKey(ts)`, `dayLabel(ts)`, each with a safe built-in default.

ESM. Imports only `esc` (`/scripts/dom.js`) + the registry. No cases/page imports.

## How it works

- **Render-first.** Emits the full `rp-comment-*` / `rp-composer-*` DOM from a plain
  `comments` array (thread → per-comment bubble with avatar/head/role/date/body/files/
  actions, day-dividers when the calendar date changes, then the composer). This is the
  markup contract; the sandbox mounts it to prove the view rebuilds from framework parts.
- **Composes shared atoms** (never redefines them): `rp-avatar` (A5) for the author chip —
  the `--sm` size + deterministic `data-c` colour land when A5 folds in
  `rp-cases-user-avatar`; `rp-btn-icon` (A1) for the inline edit-form Save/Cancel (CSS only
  for now). Empty state uses `rp-empty` (A9).
- **SECURITY.** All author/name/date/file fields are `esc()`-ed before `innerHTML`. The only
  raw-HTML path is a comment's `bodyHtml` (rich formatting) — the **caller's pre-sanitized**
  output, same defence-in-depth contract as legacy `cases.js` (`sanitizeRichHtml` runs before
  store and on render). The default `renderBody` escapes plain `body`; the cases cutover
  passes its `sanitizeRichHtml` as `opts.renderBody`.

## Drift-prone areas

- **Behaviour is not wired yet.** This increment is render + markup only. Send / edit / delete
  / @mention-autocomplete / drag-drop attach land at the **cases-detail cutover**, when
  `cases.js` deletes its inline comment builders + delegates to `mountComments` and passes the
  real handlers + `sanitizeRichHtml`. Until then the live Cases page is unchanged; this is
  sandbox-only.
- **A5 dependency.** Comment avatars render via `rp-avatar rp-avatar--sm` + `data-c`; those
  modifiers must exist in `atoms.css` (A5) for full visual fidelity. Structure is correct now;
  colour/size complete when A5 lands.
- **Naming.** `rp-comment-date` = the per-comment timestamp (legacy `…-when`); `rp-comment-day`
  = the day-divider. The composer's accent send button is `rp-comment-send`; the form wrapper
  is `rp-comment-form` (Em's named element).

## Related

- `frontend/styles/framework/comments.css` — the component's CSS (rp- only; not doc'd per the CSS convention).
- `frontend/framework-sandbox.html` — mounts a sample thread (two days, reporter/assignee/own, edited + attachment).
- [component-registry](component-registry.md) · [framework index](index.md).
- Manifest: `~/.claude/plans/hi-need-a-plan-golden-treasure.md` (B5) · Spec: `docs/full-component-version.md`.
- Legacy source being replaced: `frontend/scripts/pages/cases.js` (comment builders) + `frontend/styles/cases.css` 959–1412.
