---
title: Replicable feature pattern
section: Internal
order: 54
last modified date: 2026-05-27
owner: Torv
status: stable
---

# Replicable feature pattern

How to build a feature on one page so it can be replicated **exactly**
on another page without re-deriving the design — and how to replicate
it once the original is in place. Codified from the workspace-rail
hide/restore feature (`8d070eb`) and the project-rename → file-rename
replication (`f64e0a2` / `8d070eb`); the same shape generalises to any
per-entity client-side feature.

The earned value: when Em asks the same feature on a second page, the
second build is structural (find the entity, wire three pieces) rather
than design-deciding (where does state live? what does the recovery
UI look like? how does the click delegator route?). Two of those three
have one canonical answer recorded here; the third is the entity-
specific scope work.

## Anatomy — three pieces of a replicable feature

Every page-feature that fits this pattern decomposes into three pieces.
If a proposed feature doesn't fit, it's a candidate for a different
pattern (modal-driven, server-side, schema-changing — those have
different docs).

### 1. Persistence — pinned shape, stable helper

The feature's state lives in a **single well-defined store** accessed
via **one stable helper pair**. The store options, ordered by default
preference:

- **`user_preferences` table** — for per-user, server-side persisted
  state. Use the un-registered prefs path (`getPref(name)` /
  `setPref(name, value)` in `frontend/scripts/prefs.js`): `setPref`
  writes to localStorage + fire-and-forget `PATCH /api/me/prefs`,
  `getPref` reads the cached value. Zero new endpoints, zero schema
  work. See [`specs/user-preferences`](../specs/user-preferences.md)
  for the registry / sparse-PATCH contract.
- **localStorage only** — for ephemeral / device-local state (saved
  chart drafts pre-CHT_-rid, dismissed banner state). Cheaper than
  prefs but doesn't follow the user across devices.
- **A new server resource** — only when the state genuinely belongs
  to the resource being acted on (Case status, File rename → goes
  to `cases` / `project_files` PATCH endpoints). Then the feature
  isn't "client-side" anymore — most of this pattern doesn't apply.

The **pinned shape**: arrays of `{rid, name, ...}` objects per
[[feedback-human-readable-persistence]]. Storing just rids is cheaper
on the wire but forces the recovery UI to re-fetch labels; storing
labels with the rid lets the recovery surface render with zero
network. ~1KB per 100 entries — well under the user_preferences row
budget.

### 2. Action affordance — existing atoms, hover-fade pattern

Buttons, icons, triggers that initiate the feature's action. The
rule: **never invent a new visual atom when an existing one fits.**
[[feedback-compose-atoms-dont-parallel]] is enforced.

For the four common action shapes:

| Intent | CSS atom | Hover behavior |
|---|---|---|
| Hide / dismiss (destructive but reversible) | `.rt-tab-close`, `.rt-group-hide` | `opacity 0 → 1` on parent hover; accent-tint on own `:hover` |
| Edit / rename | `.rt-group-rename`, `.rt-tab-rename` | Same fade pattern; surface-2 background on own `:hover` |
| Add / promote | `.rt-group-add` | Same fade pattern; surface-2 on own `:hover` |
| Restore / unhide | `.rt-hidden-restore` (icon inside `.rt-hidden-item`) | Coloured by accent-2 by default, inherits on parent hover |

All four atoms live in `frontend/styles/rail.css`. If a non-rail page
uses them, either import via `@import` or move them to a shared
sheet (currently they're co-located with the rail because that's
where the pattern was first proven; promotion to `panel.css` is
fine when a second page adopts them).

The **affordance position** is conventional, not flexible:
- Hide × goes at the **far right** of the entity row (destructive
  → rightmost, after the dot/badge).
- Rename pencil goes **between the name and any badge** (edit →
  adjacent to the thing being edited).
- New-entity + goes **into the group head** for in-group adds.

### 3. Recovery / undo surface — collapsible `<details>`

Every reversible action gets a **recovery surface** that lets the
user see what they've done and un-do it without ceremony.

The canonical recovery surface is a `<details>` block at the tail
of the entity list:

```html
<details class="rt-hidden">
  <summary class="rt-hidden-summary">
    <i class="bi bi-eye-slash"></i> Hidden (N)
  </summary>
  <div class="rt-hidden-body">
    <div class="rt-hidden-section">
      <div class="rt-hidden-title">[group label]</div>
      <button class="rt-hidden-item" data-rid="...">
        <span class="rt-hidden-name">[entity name]
          <span class="rt-hidden-meta">· [parent context]</span>
        </span>
        <i class="bi bi-arrow-counterclockwise rt-hidden-restore"></i>
      </button>
      …
    </div>
  </div>
</details>
```

Native `<details>` carries the toggle a11y + open/closed state for
free. The whole `.rt-hidden-item` button is the click target; the
restore icon is visual only. The recovery surface is **only
rendered when ≥1 entry is hidden** — empty-state is no-op.

For features whose recovery doesn't fit a list (e.g. an undo of a
single most-recent action), a **floating toast with "Undo" action**
is the alternate canonical surface. See `ui/toast.js`. Don't invent
a third recovery shape.

## Two load-bearing invariants

If you break either of these, the feature looks like it works but
breaks under realistic use. Both are non-negotiable.

### Invariant 1 — filter at render-time, not fetch-time

The server returns the full set; the client filters at paint time.

```js
function renderBoard(items) {
  const hiddenSet = new Set(getHidden().map((x) => x.rid));
  const visible = items.filter((x) => !hiddenSet.has(x.rid));
  // …paint visible…
}
```

This invariant matters because:
- It keeps the wire simple — no per-feature query params, no server-
  side awareness of client UI state.
- The user's hidden list is portable across pages / queries.
- A future "admin view: show hidden" toggle is one line (skip the
  filter step).
- The full data is in memory if any other feature needs it (search,
  count, exports).

If you find yourself sending hidden-rids to the server as a query
param, you've broken this invariant — back up and re-think.

### Invariant 2 — bubble-suppression at delegator boundaries

Both action affordances and recovery items typically live **inside**
a parent click-target (cards open detail; tabs load files; group
heads expand/collapse). The pattern: a delegator at the container
level checks `e.target.closest(specific-action-selector)` first; if
it matches, handle it and `return` — never let the click bubble to
the parent's handler.

```js
container.addEventListener("click", (e) => {
  // FIRST: check every action child, return after handling.
  const hideBtn = e.target.closest(".rt-group-hide");
  if (hideBtn) { hideOne(...); return; }

  const renameBtn = e.target.closest(".rt-group-rename");
  if (renameBtn) { enterRename(...); return; }

  const restoreItem = e.target.closest(".rt-hidden-item");
  if (restoreItem) { unhideOne(...); return; }

  // ONLY THEN: parent click-target.
  const head = e.target.closest(".rt-group-head");
  if (head) { toggleExpand(...); return; }
});
```

For **inline-editing** features (rename), there's a second flavour:
the editable element receives focus and the user clicks inside it to
position the cursor. The pattern: `e.stopPropagation()` on `mousedown`
+ `click` events of the editable element itself, so the parent
button's click handler doesn't re-fire while typing.

```js
span.addEventListener("mousedown", (e) => e.stopPropagation());
span.addEventListener("click",     (e) => e.stopPropagation());
```

Breaking this invariant means hiding a thing also opens it, restoring
one also fires the parent action, and typing in a rename input also
toggles the surrounding container. All silent bugs — they look like
"sometimes the click doesn't work" rather than "always broken."

## Replication checklist

When replicating a feature from page A to page B, walk this checklist
in order. Skipping a step is how features drift apart visually and
behaviourally.

1. **Identify the entity** on page B that's the analogue of page A's
   acted-on entity (case → project; comment → file; …).
2. **Define the pref key** — `<entity-plural>_hidden`,
   `<entity>_renamed_drafts`, etc. Use a name that's grep-able and
   doesn't collide.
3. **Pin the value shape** — `[{rid, name, parent?}]`. Match page A
   if the analogue is direct; deviate only with a reason.
4. **Copy the helper trio** — `getX()` / `addX(entry)` / `removeX(rid)`
   — into page B's module. They're 15 lines; copying is cheaper than
   importing across page boundaries and prevents one page's helper
   changes from silently affecting another.
5. **Add the affordance** using the existing CSS atom (hide × via
   `.rt-tab-close` pattern; rename pencil via `.rt-tab-rename`).
   Position per the affordance-position convention.
6. **Wire the delegator** with the bubble-suppression invariant — each
   branch ends in `return`. New branches go **before** the parent
   click-target branch.
7. **Add the recovery surface** using the `.rt-hidden-*` atom set.
   Place at the tail of the entity list. Only render when ≥1 entry
   is hidden.
8. **Verify the filter happens at render-time**, not fetch-time
   (Invariant 1).
9. **No `CACHE_VERSION` bump** — the service worker is install-only; a normal refresh shows the change.
10. **One commit per replication** — `area(page): replicate <feature>
    from <page-A>` — naming the source page makes the diff trivially
    reviewable.

## Case studies

### Workspace rail → cases page (hide/restore)

- **Page A**: `frontend/scripts/pages/workspace.js` — `8d070eb`,
  projects + files via the rail rendering. Two pref keys
  (`rail_hidden_projects`, `rail_hidden_files`) because two entity
  types share one rail.
- **Page B**: `frontend/scripts/pages/cases.js` — pending Woz, recipe
  posted on `Woz.md` 2026-05-27 22:13. One entity type → one pref
  key (`cases_hidden`). Recovery surface candidate placements: 6th
  kanban lane, page-head chip, or board-corner toggle — Woz's call.

### Project rename → file rename

- **Page A**: project rename pencil in `f64e0a2` —
  `enterProjectRename(group, span)`, PATCH `/api/projects/:rid {name}`.
- **Page B**: file rename pencil in `8d070eb` —
  `enterFileRename(tab, span)`, PATCH `/api/files/:rid {display_name}`.

Replication ratio: ~90% of `enterFileRename` is `enterProjectRename`
with two substitutions (the wire endpoint + the canonical-value path
on the response). The contenteditable lifecycle, the bubble-
suppression, the Esc/Enter/blur commit branches, the optimistic
write + revert-on-failure — all unchanged.

## When NOT to replicate

The pattern doesn't fit every cross-page feature. Anti-patterns:

- **Server-state features** (case status flow, file dirtiness) — these
  need real schema, not user_preferences. Different doc.
- **Cross-entity features** (a "favorite that lives on a project but
  the favorite-affordance is on the file tab") — single-entity scope
  is the precondition for this pattern. Cross-entity needs design
  work.
- **One-shot actions with no reversible state** (export, download,
  copy-link) — there's no recovery surface to build; just an action
  button.
- **High-frequency state** (cursor position, selection) — the
  fire-and-forget PATCH cadence is fine for ~1 write per user action,
  not for continuous tracking. Use localStorage only or in-memory.

If a proposed replication trips any of these, write it up as a new
pattern doc next to this one, named after its load-bearing primitive.

## Reference

| Commit | What it shipped |
|---|---|
| `f64e0a2` | First inline-rename — project pencil. |
| `8d070eb` | Pattern v1 full surface — file rename + hide/restore for projects & files; CSS atoms `.rt-hidden-*` in `rail.css`. |
| `Woz.md 22:13` | Recipe message that became this doc. |
