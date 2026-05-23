---
title: UI change process
section: Internal
order: 2
last modified date: 2026-05-23
---

# UI change process

> **Internal — the standard procedure for ANY change that touches
> HTML, CSS, or JS in `frontend/`.** Small changes run the checklist in
> your head; non-trivial ones walk it explicitly. The audits enforce
> most of this mechanically — this doc is the *reasoning*, so the
> audits don't have to be argued with.

Companion docs:
[js-rust-boundary.md](../architecture/js-rust-boundary.md) ·
[frontend-parity-inventory.md](../archive/frontend-parity-inventory.md) ·
[object-model.md](../architecture/object-model.md) ·
incident log: [runbooks/](../runbooks/).

## Before you change anything

### 1. Read disk, not memory

Memory snapshots go stale fast — files get renamed, deleted, or
reshuffled between sessions. Always verify the live tree first:

```sh
git branch --show-current
find frontend -maxdepth 3 -type f \( -name '*.js' -o -name '*.html' -o -name '*.css' \) | sort
```

Re-read the file you intend to touch before planning. *"I remember
this had X"* is a bug pattern.

### 2. Confirm the contract — pixels, not data

Per [`js-rust-boundary.md`](../architecture/js-rust-boundary.md): **JS owns pixels,
Rust owns data.** If the change does anything beyond render /
interact / cache / route, stop and re-check the boundary. Filter,
sort, step, edit-data-content — all Rust.

Every new `/api/…` call is a row in the `crossing-audit` join —
confirm Rust serves a matching route and a `shared` DTO exists. **No
call without a route.**

### 3. Decompose, don't open-end

Express the change as "add or modify *N known components* with a
clear done." If you cannot enumerate it, stop and decompose first.
Open-ended UI work is the tarpit that produced the 26.6k → 1.5k LOC
reset.

If the change affects what a page does, find the page in
[`frontend-parity-inventory.md`](../archive/frontend-parity-inventory.md) —
that's where the line goes.

## While you change it

### 4. Components: reuse, do not invent

Component count stays at the existing N (currently 8 atoms — one
`.css` per atom in `styles/`). Need a size or variant of an existing
component? Use a **BEM modifier** on the existing base:

- `rt-btn` · `rt-btn--sm` · `rt-btn--lg`
- `rt-pred` · `rt-pred--compact`
- `rt-panel` · `rt-panel--inline`

A *new base component* is justified only when no existing one fits —
and then it gets its own dedicated `styles/<name>.css` and a `<link>`
in `index.html`. Adding a component bumps N permanently; treat it as
a decision, not a side effect.

### 5. Naming consistency

One class name per UI concept across the whole stack. `grep '\.rt-btn'`
must return **every** button. Page-prefixed duplicates for the same
idea (`home-btn` *and* `workspace-btn` for the same button) are a bug
— collapse to one.

For concepts that exist on **both** sides of the JS/Rust boundary
(`filter`, `step`, `chart`), apply the shared-noun + layer-verb rule
from [`js-rust-boundary.md`](../architecture/js-rust-boundary.md): same noun in
`filter.js` / `filter.rs` / `Filter` DTO; JS verbs `collect` /
`render`, Rust verbs `compile` / `apply`.

### 6. No mystery CSS

Every `.css` file must be reachable from an explicit
`<link rel="stylesheet">` in `index.html` or a traced `@import` from
`styles/main.css`. The `@import` graph stays **flat** — no nested
third-level chains where a sheet can hide. `css-audit` flags orphan /
dangling sheets; do not bypass.

### 7. Truthful comments

If the change makes a header comment, doc string, or referenced doc
stale, fix it **in the same commit**. No `// removed for X` markers,
no rotted JSDoc. The audits do not catch this — discipline does.

## When removing UI

### 8. Grep the whole codebase

When you delete a class, an id, a partial, a page, or an endpoint,
grep the **entire** repo for the name — HTML, CSS, JS, docs, partials,
server templates. References hide:

- in shared constants and SQL `SELECT` lists,
- in event delegation in adjacent pages,
- in CSS that targets a class no longer in markup,
- in stale references in docs.

Pair every removal with `tools/audit.sh` immediately — `css-audit`
catches a dangling `@import`, `crossing-audit` catches a frontend call
to a now-missing route. See
[`runbook/0002-stale-join-after-drop.md`](runbook/0002-stale-join-after-drop.md)
for the cost of skipping the grep on the data side; the same lesson
applies on the UI side.

## After you change it

### 9. Run `audit.sh`

```sh
sh tools/audit.sh
```

All five audits run. Treat any new red as part of *your* change — fix
it now, before commit. Specifically watch:

- **css-audit:** new orphan stylesheet · new dangling `@import`.
- **html-audit:** new duplicates.
- **js-audit:** new god-object (LOC > 800) · new duplicate symbol ·
  new unreachable module.
- **crossing-audit:** dangling `/api` call · unused Rust route.

### 10. Update the parity inventory

If the change affects what a page does, update
[`frontend-parity-inventory.md`](../archive/frontend-parity-inventory.md). Tick a
TODO bullet, strike a retired one, or add a new line. The inventory
is the rebuild's ship contract — let it drift and "merge back at
parity" becomes unverifiable.

### 11. Verify behavior in a browser

The audits verify *code structure*, not *feature correctness*. Start
the dev server, exercise the golden path **and** the edge cases for
your change, watch for regressions in adjacent features. Type checks
and audits passing ≠ feature works.

## Commit + handoff

### 12. Commit convention

One coherent change per commit. `area: short subject` +
per-file changelog body. No broad checkpoints — small commits are
reversible.

### 13. Push policy

Agents commit on the current branch (`prerelease` or the active
feature branch) but **do not push**. Em confirms, Torv pushes.

### 14. Coordinate cross-lane impact

If the change adds a new endpoint, a new `shared` DTO, or removes
something other lanes might still reference, post a note on the
Internal-Slack board (each contributor writes only to their own file)
so Gus and Torv see it on next pull.

## The escape hatch

If the change can't pass this checklist — if it requires inventing a
new component, smuggling data logic into JS, skipping `audit.sh`, or
removing something without a full-tree grep — **that is the signal to
stop and discuss**, not to push through. Cheap to ask; expensive to
undo.

## When this doc becomes stale

A process doc that drifts from reality is worse than no process doc.
If the audit set changes (a 6th audit lands, or `audit.sh` is split),
if the component count moves past 8, or if a new lane is added — fix
the relevant section here in the same commit. Per **rule 7**, this
doc is subject to its own discipline.
