# 0007 — Column drag-reorder cluster (4 layers)

Historical reasoning record. The four bugs below lived in the **predecessor**
codebase (the original `redpash-rust-pwa` that the lean rebuild ports from), in its
page-bound data-table scripts — `frontend/scripts/list-page.js`,
`frontend/scripts/pages/home.js`, and `frontend/styles/table.css`. None of those files
exists on lean: the data table is now the single `redtable` framework component, and the
in-table **column drag-reorder feature that hosted all four bugs was not carried over**.
The lean redtable closes the whole failure class *by construction* — there is no open fix
to apply here. This runbook preserves the WHY because the discipline it produced
(read positional state from the DOM, never from the spec; never `appendChild` in a loop
past framing cells) is exactly what the lean rebuild bakes into the component's contract.

Lean component: [`redtable.js`](../../../frontend/framework/redtable/redtable.js)
(doc: [data-cleaner.md](../code/frontend/data-cleaner.md) §grid). Its header comment is the
canonical framing: *"Data col-keys ONLY (no display-index sentinels); rowKey REQUIRED
(selection lives in closure state keyed by rowKey, never on recycled DOM)."*

## Symptom (predecessor)

Four distinct bugs all sitting on top of the column drag-reorder feature on the Home
tabs. Each surfaced as a different visible symptom; the diagnostic arc peeled them one at
a time.

| Layer | Symptom | Visible on |
|---|---|---|
| 1 | After drag-reorder + paginate / sort / search, every column header showed data intended for a different column | Any Home tab with > 1 page of data |
| 2 | Dragging the FIRST column showed a visually weak / collapsing drop indicator at the table edge | First (and last) column edge |
| 3 | Headers and cells re-mis-aligned by one column after drag-reorder on tabs that declare `spec.hideMeta` | Users / Memberships / Files / Companies / Cases / Projects / Charts |
| 4 | Toggling edit mode tagged the wrong cell `contenteditable` — on Users, "Joined" (a system-generated date) instead of "Job" | Any tab with `editable: true` cols + a custom column reorder |

A meta-note worth keeping for future drag-and-drop work: **Layer 1 was fixable from
static analysis; Layers 2–4 only surfaced from live browser debugging** — the off-by-one
in Layers 3/4 is invisible on paper.

## Root cause

Four distinct mistakes all sitting in the same neighborhood, each a different *kind* of
mistake — but with one common theme: **the DOM structure changed more than the spec did,
and any code that read positional state read it from the spec instead of from the live
DOM.**

| Layer | Mistake class | What was assumed | What was actually true |
|---|---|---|---|
| 1 | State-dependent early-return in `applyColumnOrder` | thead ↔ tbody column-alignment | tbody was painted in *spec* order while thead was in *target* order; both passed individual identity checks, so the early-return short-circuited and left the cells mis-aligned |
| 2 | Insufficient visual escape in the drop indicator | `box-shadow: inset 0.1875rem` reads as "between" anywhere | at a row's edge "between" needs *overhang*, not *inset* — the inset stripe collapses against the table boundary on the first/last column |
| 3 | `appendChild` in a loop past framing cells | "move all of these to the end" == "put them in this order at the end" | each `appendChild` displaces every later child by one; the trailing hide-action sentinel TH walked N positions left and ended at position 0, so thead position N mapped to tbody position N−1 |
| 4 | Spec-position indexing of a reorderable DOM in `decorateEditMode` | `spec.columns[i]` matches `tds[i + offset]` | true only at the exact moment of `tbody.innerHTML =` (before any reorder) — the instant the user dragged, DOM position 4 was no longer `job_title`, so the editable flag landed on the wrong cell ("Joined", a DB-set field) |

Layer 3 is the trailing-sentinel `insertBefore` trap specifically: a row with a leading or
trailing framing cell (select checkbox, hide-action column) must never be re-ordered by
`appendChild`-to-end in a loop — `insertBefore` the trailing sentinel instead so it stays
at the edge.

## How lean closes it (by construction)

The whole cluster is a property of the *predecessor's* page-bound table: a hand-rolled
column-reorder that mutated `<th>`/`<td>` DOM by display index, with framing cells
(select / hide-action) interleaved in the same row, on every Home tab. The lean rebuild
removes each precondition:

1. **One table component, data col-keys only — no display-index sentinels.**
   [`redtable.js`](../../../frontend/framework/redtable/redtable.js) renders every header
   from `cfg.columns` (objects with a `key`) and every cell with
   `td[data-col="<key>"]`. There is no display-index addressing anywhere, so there is no
   "spec position vs DOM position" to drift (Layers 1 + 4 cannot arise). The header
   comment bans the predecessor's fork-A/B duality outright: *"ONE implementation; virtual
   and pager modes are config on the same component."*

2. **There is no in-table column drag-reorder to break.** Lean does not ship the
   drag-to-reorder-columns interaction that hosted all four bugs. Column *order* is the
   order of `cfg.columns`; a consumer that wants a different order calls
   `handle.update({ columns })` and the component re-renders head + body together from one
   source — never a partial DOM splice. Re-ordering columns is therefore a re-render, not a
   `appendChild`/`insertBefore` dance, so the trailing-sentinel trap (Layer 3) has no
   surface.

3. **Framing cells are built, never spliced.** The select-mode checkbox column and the
   row-number column are prepended as explicit `lead` nodes in `renderHead()` / `rowEl()`
   on each render (`thead.replaceChildren(el("tr", {}, ...lead, ...ths))`); they are not
   mutated in place against data columns. There is no loop that moves data cells past a
   framing cell, so a sentinel can never walk to position 0 (Layer 3).

4. **Selection is closure state keyed by `rowKey`, never DOM state**, and edit mode
   resolves the column from `td.dataset.col` at click time (`beginEdit` reads
   `td.dataset.col` and looks the column up by key), not from a spec index. The "editable
   flag landed on the wrong cell" failure (Layer 4) cannot recur because the edited column
   is identified by its data key, not its position.

5. **Header interaction is server-ordered sort, not client column-shuffle.** Sortable
   headers emit `onSort(col)`; the consumer cycles the direction and re-fetches a
   server-sorted page (`QuerySpec.sort`). The chevron only ever reflects a real server
   order. There is no client-side row re-shuffle that could desync headers from cells
   (Layer 1).

The one visual echo of the predecessor is incidental: lean's
[`redtable.css`](../../../frontend/framework/redtable/redtable.css) still uses
`box-shadow: inset 0.1875rem 0 0 0 var(--rp-danger)` — but on the delete-mode hover of the
*first cell* (`.rp-redtable.is-delete tbody tr:hover td:first-child`), not as a
column-drop indicator. There is no drop indicator to suffer Layer 2's edge-collapse,
because there is no drop.

## The discipline this updates

The reasoning survives even though the code path doesn't. For any future feature that
touches a re-orderable DOM row:

- **Read positional state from the DOM (or from a key), not from the spec.** After any user
  reorder, only the element's own key (`td.dataset.col`, `tr.dataset.key`) tells you the
  current identity; the spec index is the *original* order. The lean redtable bakes this in
  — every cell carries `data-col`, every row carries `data-key`, and edit/select route by
  key.
- **Never `appendChild` in a loop when the parent has framing children to preserve.** If a
  future component ever does need in-place row reordering with leading/trailing framing
  cells (a row handle, a right-edge action column), detect the trailing framing node and
  `insertBefore` it — don't `appendChild`-to-end, which walks the sentinel one slot left
  per iteration. Better: re-render the whole row from the column list (the lean pattern) so
  there's no splice at all.
- **Prefer re-render over partial DOM mutation for order changes.** `update({columns})`
  rebuilding head + body from one source is structurally immune to header↔cell desync; a
  hand-rolled splice is not.
- **Drop indicators need overhang at row edges.** An `inset` box-shadow collapses against
  the row boundary on the first/last column; a column-drop marker needs a pseudo-element
  with negative offsets so it projects past the edge. (Kept here for the day a drag
  interaction returns.)
- **For any drag-and-drop feature, verify live in a browser** — the off-by-one bugs in
  Layers 3/4 were invisible from static analysis. If `chrome-devtools-mcp` is locked,
  switch to Playwright MCP (it forks its own browser per session, no profile contention).

## Linked

- The lean data table that obviates the cluster — [`redtable.js`](../../../frontend/framework/redtable/redtable.js) and [`redtable.css`](../../../frontend/framework/redtable/redtable.css) (doc: [data-cleaner.md](../code/frontend/data-cleaner.md)).
- The per-column clean surface that replaced the predecessor's column toolbar — [`column-manager.js`](../../../frontend/framework/column-manager/column-manager.js) (note: its "sentinels" are data-cleaning sentinel *values* like `N/A`, `-`, `???`, unrelated to the predecessor's display-index sentinel *cells*).
- The sibling historical record for a closed predecessor bug — [0011 — object_kind rid-prefix mis-dispatch](0011-object-kind-prefix-mismatch.md).
- The bug → case → runbook cadence this entry follows is now the **"Case-first by default"** rule in the project [CLAUDE.md](../../../CLAUDE.md) (the standalone `processes/bug-case-runbook-cadence.md` the predecessor referenced was not ported).
