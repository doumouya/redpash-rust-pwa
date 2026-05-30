---
title: Handoff — frontend datatables (Torv)
section: Internal
last modified date: 2026-05-23
superseded-by: none — historical handoff
---

# Handoff — frontend datatables (Torv)

> **Internal — Woz → Torv, 2026-05-23.** Woz is suspended 48h; this
> handoff covers the workspace datatable work so the lane keeps
> moving. Read in order: this doc → [boundary contract](../architecture/js-rust-boundary.md)
> → [parity inventory](frontend-parity-inventory.md) →
> [UI change process](../processes/ui-change-process.md). All paths below are on
> `prerelease`.

## Where prerelease is now

- Merge `4bd6a78` landed `frontend-reset`; reachability fix `27bedcc`
  restored Woz's missing audit.js work; `dd357dd` set `default-run =
  "redpash-api"`. Torv has already pushed to `origin/prerelease`.
- Frontend tree: 12 JS files / 1,859 LOC · 15 CSS files · 6 partials ·
  6 routes (`/login`, `/home`, `/workspace`, `/profile`, `/settings`,
  `/docs`). All audits green.
- Workspace is the only non-stub page worth growing right now. The
  datatable is its core — *everything in this handoff is about
  growing that one surface*.

## The datatable — current state

In [`frontend/scripts/pages/workspace.js`](../../frontend/scripts/pages/workspace.js):

✓ done:
- Rail loads `GET /api/projects` then lazy-loads `/projects/:rid/files`.
- File click fetches `/files/:rid` + `/files/:rid/page` in parallel.
- Renders header + 25 rows. Auto-opens default project's first file.
- 2-level AND/OR filter builder (client-side, see ⚠ below).
- Multi-key shift-click sort (client-side, see ⚠ below).
- Edit / Select / Delete modes (visual only — see ⚠ below).
- Columns dropdown, row-numbers toggle, selection chip with clear-all.
- Refresh button re-fetches the open file.
- Cleaning tools panel (12 tools, `defineTool` factory — see
  [`tools.js`](../../frontend/scripts/tools.js)) → real
  `POST /files/:rid/steps`.
- Designer mode: `file_type === "chart"` files render via ECharts
  from `/charts/:rid`.

⚠ wired but boundary-violating or stubbed:
- **Filter / sort run client-side** over the loaded page only. The
  boundary doc says JS never implements a data engine — these need
  to send a `Filter` AST to Rust.
- **Rows-per-page dropdown changes the label only.** No refetch.
- **No pager** — `#wsPages` exists in the partial, empty.
- **Edit / delete modes are DOM-only.** No PATCH, no step.
- **`wsNewProject` button is `disabled`.** Honest "coming soon" tooltip.

## The four datatable workstreams — prioritized

### 1. Real pagination (highest priority)

The redtable feels broken at >25 rows because there's no way to see
the rest of the data. Smallest-yet-most-visible win.

- Wire `#wsRowsDd` clicks to **refetch** with the new `limit`. Today
  it only updates `#wsRowsLabel`.
- Render `#wsPages` as a real pager — page numbers, prev/next, jump.
  Use existing `.rt-btn` / `.rt-btn--ghost` / `.rt-pill` primitives;
  add `.rt-btn--sm` if you need a smaller variant (BEM modifier, not
  a new component).
- Call shape: `GET /api/files/:rid/page?offset=<n>&limit=<n>`. The
  server already paginates internally (`pageData.total` comes back) —
  confirm the exact query-string contract with Gus before wiring; if
  it's not there yet, that's his lane to add.
- Reset to page 1 on file change.
- Persist `limit` in localStorage (`rp-rows-per-page` key, default
  25). Other pages will want the same pref later.

Estimated: ~80–120 LOC in workspace.js + ~30 LOC of pager CSS.

### 2. Server-side filter + sort — close the boundary violation

`workspace.js` lines ~401-461 (passSearch, passFilter, applySort) run
predicate / comparator logic client-side. Per [boundary contract](../architecture/js-rust-boundary.md):
**delete that JS predicate code** and replace with:

- A serializer that converts the filter UI state to a `Filter` DTO
  matching `steps.rs`'s `build_filter_predicate` shape (op enum:
  `contains | is | not | starts | empty | filled` etc.; see
  `crates/data/src/steps.rs:740` for the canonical shape).
- A serializer for multi-key sort: array of `{column, direction,
  is_date}`.
- Send both to `/page` (Gus to confirm endpoint — likely
  `?sort=` and `?filters=` query params or a POST body).
- Render the rows the server returns. No client-side filtering.

This is the biggest behavioral cleanup in the workspace. It is also
the one most worth **coordinating with Gus first** — he flagged a
unified predicate compiler (his audit #11). Don't build a JS-side
client and a Rust-side server in two unrelated shapes; pick the
shared `Filter` DTO with him on the board before writing the
serializer.

Estimated: ~80–100 LOC added (serializer + integration), ~60 LOC
deleted (`passSearch` / `passFilter` / `applySort` JS predicates).

### 3. Save edits + deletes — through the step engine

Per the [boundary doc](../architecture/js-rust-boundary.md), data-content edits are
**cleaning steps**, not plain PATCH:

- **Cell edit** (single value) → `POST /files/:rid/steps` with
  `kind: "set_cell"`, `params: { row, column, value }`. The step
  engine already supports this (`steps.rs:305`).
- **Row delete** → step with `kind: "drop_rows"`, `params: {
  indices: [...] }`. Already supported (`steps.rs:71`).
- **Bulk select-then-delete** → one `drop_rows` step with the indices
  list. Single step → one entry in `project_steps`, one undo
  reverses the whole batch — that's the right granularity.

Edit-mode UX today: `contenteditable=true` on cells, Enter commits +
blurs. Wire the blur to fire the `set_cell` step (debounce if a user
tabs through several cells — batch into one `set_cell` per cell, not
one giant batch, so undo is per-cell).

**Distinct from data edits — out of step engine:** if/when you add
"rename file" / "edit file description," those are *metadata* PATCH
calls (`PATCH /files/:rid`), NOT steps. Same distinction Woz raised
in the boundary review (amendment #3).

Estimated: ~60–80 LOC for the wiring.

### 4. Search field — what it should be

The `#wsRowSearch` input today does client-side `cell.includes(q)`
over loaded rows. Two paths:

- **Quick & in-scope:** keep it as a *page-local* convenience — make
  it visually distinct ("filter within this page") and keep the
  client-side string match. Acceptable because it's not a *data
  engine*, it's a view filter, and it's bounded to the loaded rows.
  Mark in the placeholder text so the user knows the scope.
- **Bigger move:** make it a synonym for a filter over a synthetic
  `(all columns)` field — sends through the same `Filter` DTO as
  workstream 2. Bigger UX implication; only do it after #2 lands.

Lean toward the quick path; the user only needs the dataset-wide
search when filtering specific columns, which the panel already does.

## What's NOT in this handoff (intentionally)

- **Chart builder UI** (vs the existing render-only path) — the next
  big workspace feature after datatables. Skip for now.
- **File upload** — would be the wsNewProject + drag-drop work.
- **History / undo UI** — `POST /files/:rid/undo` + `/redo` exist;
  wiring the surface is its own slice.
- **Project CRUD** — `wsNewProject` disabled stays disabled until #1
  and #2 land.
- **Stage rename** (`import→new`, `report→design`) — two-line edit in
  `home.js:11` and `workspace.js:18`, do it as a freebie anytime
  you're in either file.

## How to do the work safely (the discipline)

- **Per the [UI change process](../processes/ui-change-process.md)**: read disk
  before planning, run `sh tools/audit.sh` after every change, BEM
  modifiers not new components, no mystery CSS, grep before removing.
- **Team-coord system:**
  - Stamp your name in `Internal-Slack/.agent` at session start
    (Woz tripped over this twice — it now reads `Woz`; flip to `Torv`
    when you start).
  - Declare what you're touching in
    `Internal-Slack/presence/Torv.md`. `node tools/team/board.js`
    shows overlaps.
  - Post heads-up to your channel (`Internal-Slack/Torv.md`) before
    grabbing the workspace.js file — Gus and I will be reading.
- **Conflicts on shared files:** if the next merge has a conflict on
  a file both branches touched, run `git diff --merge-base
  <branch-a> <branch-b> -- <file>` on **both sides** before resolving.
  Never wholesale `--theirs` / `--ours` on a multi-author file.
  ([Woz's 2026-05-23 mistake — 161 LOC silently dropped.](frontend-reset-merge-report.md))
- **Tools panel as the pattern:** the `defineTool` factory in
  `frontend/scripts/tools.js` is the proven shape for a parametrized
  UI section — picker + form + apply + status. The pager and the
  filter serializer can use the same field-type renderers.

## Where to find me — and when

Woz suspended through 2026-05-25. Suspension-end report at
[`woz-2026-05-25-suspension-report.md`](woz-2026-05-25-suspension-report.md).
Until then: Torv owns frontend datatables; Gus owns backend / the
`Filter` DTO for workstream #2; Em decides scope and order.

— Woz, 2026-05-23
