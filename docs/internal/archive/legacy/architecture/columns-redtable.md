---
title: Columns-as-rows — cleaning tools as a redtable toolbar
section: Internal
order: 12
last modified date: 2026-05-24
owner: Torv
status: spec — implementation in flight
---

# Columns-as-rows

> Em's framing (2026-05-24, chat): *the cleaning tools panel is the
> toolbar of a redtable for columns.* Columns are the rows; "tools"
> are the operations the toolbar runs on selected rows. Same atom
> as the data redtable, applied to a different domain.

## TL;DR

1. **Replace the tools-picker UX with a columns-redtable** inside the
   existing right-side panel. Rows = the file's columns. Cells =
   per-column metadata + statistics.
2. **The 15 tool kinds map to toolbar actions** — edit / select-mode /
   global. Most are mechanical translations.
3. **Same `.rt-surface` atom** as the data redtable; this is the WS#5
   redtable-unification spec's second consumer.
4. **Panel widens to 50vw** when columns mode is on (third state
   after the current 250px / 500px).
5. **Cell-edit guarded by preview** for the dangerous case (cast),
   reusing the existing `POST /files/:rid/cast-preview` endpoint.

## Why this is right (vibe check)

- One mental model: *operations select rows, the toolbar acts on the
  selection.* Identical to the data redtable's edit/select/delete loop.
- The picker → form swap goes away. Today opening Drop nulls means
  "pick a tool, see a form, pick a column." Tomorrow it's "see the
  columns ranked by null %, select dirty ones, click *Drop nulls*."
- The diagnostics surface we built for Drop nulls (`tool.context`)
  IS the columns-redtable in miniature — Em's framing surfaced it.
  The context wasn't a side-feature; it was the interface trying to
  emerge.
- WS#5's redtable atom gets its second real consumer for free.
  Workspace data table + columns table + monitoring lists = three
  configurations of one atom.

## The columns-redtable shape

### Rows
One row per column in the active file, in the file's column order.

### Columns (of the columns-redtable)

| Col | Source | Notes |
|---|---|---|
| `#` | row index | The file's column position. |
| **Name** | `ColumnMeta.name` | Cell-edit → `rename_column` step. |
| **Datatype** | `ColumnMeta.dtype` + sniff-mismatch badge from `semantic_dtype` | Cell-edit (enum) → `cast` step, guarded by [cast-preview](#cast-preview). |
| **Nulls** | derived `null_pct × summary.row_count` | Sortable. Three-band colour: ≥50% red, ≥10% amber. |
| **% Null** | `ColumnMeta.null_pct` | Sortable. Same bands. |
| **Unique %** | `ColumnMeta.unique_pct` | High → likely key; low → likely enum. |
| **Sample** | `ColumnMeta.sample` | One representative value. |

All fields come from the existing `/api/files/:rid` envelope — no new
endpoint needed for the read path.

### Selection model
- **Checkbox per row**, header check toggles all (same atom as the
  data redtable).
- **Selection chip** in the toolbar shows count + clear-all.
- Toolbar actions branch by mode: edit / select / global (see below).

## Toolbar mapping — 15 tools → toolbar actions

| Tool kind today | Toolbar mode | Action shape |
|---|---|---|
| `rename_column` | **edit** | Cell-edit on the Name column. Enter → `rename_column` step. |
| `cast` | **edit** | Cell-edit on the Datatype column (enum dropdown). Pick → `cast-preview` → if clean, `cast` step; if failures, surface "N cells will become null. Apply?" |
| `drop_nulls` | **select** | Selected rows → button "Drop nulls in selected" → one `drop_nulls` step per column (or one step accepting `columns: [...]` if engine supports). |
| `fill_nulls` | **select** | Selected rows → button "Fill nulls…" → modal sheet for strategy + value → `fill_nulls` step. |
| `drop_columns` | **select** | Selected rows → toolbar **Delete** → `drop_columns` step with `cols: selected`. |
| `filter_columns` | **select** | Selected rows → button "Keep only selected" → `filter_columns` step. |
| `replace_text` | **select** (one) | One row → button "Replace text…" → modal sheet → `replace_text` step. |
| `change_case` | **global** | Toolbar button "Values case…" → modal (lower/upper) → `change_case` step. |
| `fix_invalid` | **select** | Selected rows → "Fix invalid…" → modal (sentinels + replacement) → `fix_invalid` step. |
| `join_columns` | **select** (≥2) | Selected rows → "Concatenate…" → modal (sep + new name) → `join_columns` step. |
| `split_column` | **select** (one) | One row → "Split column…" → modal (sep + keep original) → `split_column` step. |
| `format_dates` | **select** (one) | One row → "Format dates…" → modal (fmt + on_incomplete) → `format_dates` step. |
| `snake_case_columns` | **global** | Toolbar button "Snake-case names". No selection, no dialog. |
| `replace_in_names` | **global** | Toolbar button "Replace in names…" → modal (find + replace) → `replace_in_names` step. |
| `unwrap_csv` | **global** | Toolbar button "Unwrap CSV". Disabled when `summary.col_count !== 1`. |

### Selection-count gating

- ≥1 row required: drop_nulls, drop_columns, filter_columns, fix_invalid, fill_nulls
- exactly 1 row: replace_text, split_column, format_dates
- ≥2 rows: join_columns
- no rows: snake_case, replace_in_names, change_case, unwrap_csv

Toolbar buttons render disabled when the selection size is wrong for
the action.

## Dialog tools — modal sheets

Some actions need parameters beyond the selected rows. They open a
**modal sheet** — small in-panel form (not a full overlay), reusing
the existing `FIELDS` renderers (`column`, `enum`, `text`, `boolean`,
`multicolumn`).

| Tool | Sheet fields | Notes |
|---|---|---|
| Fill nulls | strategy (enum) · value (text, conditional) | Selected cols pre-populated. |
| Replace text | find · replace · is_regex | Column from selected row, not a field. |
| Fix invalid | sentinels · replacement | Selected cols pre-populated. |
| Concatenate columns | sep · new_name | Cols from selected rows in order. |
| Split column | sep · keep_original | Column from selected row. |
| Format dates | fmt · on_incomplete | Column from selected row. |
| Replace in names | find · replace | No selection needed. |
| Change values case | mode | No selection needed. |

Sheets render as a small panel above the columns-redtable, like
today's per-tool form. Apply / Cancel buttons. On apply: same
`runStep` lifecycle, table refetches, selection clears.

## Cell-edit semantics

### Name
Click → contenteditable, Enter commits → `rename_column { from, to }`.
Empty / unchanged → no-op. Conflicting name (duplicate of another
column) → server returns 400 with `kind="invalid_spec"`; surface
inline.

### Datatype (cast-preview)
Click → enum dropdown of supported target dtypes. Pick:

1. **Preview first**: `POST /files/:rid/cast-preview` with
   `{ column, to }`. Server returns `{ ok_count, fail_count, sample_fails }`.
2. **If `fail_count == 0`**: apply `cast` step immediately. Cell
   re-renders.
3. **If `fail_count > 0`**: open a small confirm sheet — "*N cells
   won't parse — they'll become null. Apply?*" + show the first few
   failing values. User confirms → `cast` step OR uses `fix_invalid`
   first.

This is the only edit path that needs a preview; rename is reversible
via undo, every other action is a deliberate step.

## Panel + UX details

- **Panel widens to 50vw** when columns mode is on. Three states now:
  - default closed: 0
  - `.open`: 250px (the picker, only for backwards compat during
    transition — could be removed once columns mode lands)
  - `.has-columns`: 50vw (the columns-redtable)
- **Toggle**: existing `#wsToolsToggle` (bi-tools). Same button, the
  new surface is what opens.
- **Panel name** stays "Tools" — it's still where you operate on the
  file's shape; the control surface just changed.
- **History panel** stays orthogonal — steps over time, not columns.
  Mutually exclusive with the columns panel on the right side, same
  as today's tools/history mutex.

## What stays / what dies

### Stays
- The 17-step engine (no new step kinds needed; existing ones cover
  every toolbar action).
- `runStep(kind, params, label, opts)` in tools.js — the apply
  lifecycle.
- The `FIELDS` renderers — reused by the modal sheets.
- The data redtable in the main body — unchanged.

### Dies
- The tool-picker list (`renderList`, `.rt-tool-list`, `.rt-tool-item`).
- The picker → form-swap UX (`openForm` / `closeForm` as they exist).
- The per-tool `context` renderer we just shipped — its content moves
  into the columns-redtable itself (Drop nulls' null-table IS the
  redtable now).
- The `has-form` 500px panel state — replaced by `has-columns` at 50vw.

The `tool.handleAction` dispatch can be repurposed as `toolbar.handleAction`
for the columns-redtable toolbar buttons — same shape.

## Build order — smallest shippable slices

Each slice ships independently; user can use the old picker until the
final slice flips the default.

1. **Slice A**: Stand up the columns-redtable as a *new view* inside
   the panel, behind a flag (a second toggle on the toolbar, or
   shipped only on dev). Read-only, no actions. Validates the layout
   + the data binding from `activeColumns + activeSummary`.

2. **Slice B**: Wire the **global actions** (snake_case, replace_in_names,
   change_case, unwrap_csv). They don't need selection or per-cell
   work — cheapest to wire, lets the redtable demonstrate value
   immediately.

3. **Slice C**: Wire the **select-mode multi-column actions** that
   don't need a dialog (drop_columns, filter_columns, drop_nulls).
   Selection model copied from the data redtable.

4. **Slice D**: Wire the **modal sheet** for Fill nulls. Validates
   the sheet pattern; the other dialog tools follow the same shape.

5. **Slice E**: Port the remaining dialog tools (Replace text, Fix
   invalid, Concatenate, Split, Format dates, Replace in names,
   Change values case).

6. **Slice F**: Edit mode — Name cell (rename_column) first; ship.

7. **Slice G**: Edit mode — Datatype cell with cast-preview
   confirmation. The trickiest slice; ships last because the preview
   UX needs care.

8. **Slice H**: Flip the default — `#wsToolsToggle` opens columns
   mode. Retire the picker + form-swap code (`renderList`,
   `openForm`, `closeForm`, `.has-form`).

Each slice keeps the audit green and bumps the SW version.

## Open calls (revisit during build)

- **Editing column rows vs. workspace data rows.** Cell-edit
  semantics in the data redtable means `set_cell` (one data cell).
  Cell-edit in the columns redtable means metadata change. Two
  different domains; the SAME `editable` cell affordance with
  different `onCellEdit` callbacks. Need to make sure the cell-edit
  contract in the redtable atom is parameterised, not assumed to
  hit `set_cell`.

- **Selection chip placement**. Data redtable has it inline in the
  toolbar. Columns redtable's chip needs the same affordance, same
  selector — probably a shared atom (`.rt-sel-chip`).

- **Whether the columns redtable shares the existing `.rt-toolbar`**
  CSS or gets its own. Probably shares; the toolbar atom is what
  the unified surface is about.

## Linked

- [redtable-unification.md](redtable-unification.md) — WS#5's atom
  framing this consumes.
- [js-rust-boundary.md](js-rust-boundary.md) — every action ships as
  a step; the engine stays in Rust.
- [filter-dto.md](../specs/filter-dto.md) — predicate shape; not
  directly used by these toolbar actions, but the search field on
  the columns redtable could later filter columns via the same DTO
  shape if it grows beyond name-substring match.
- The Drop-nulls context (commits `0fae274` / `b3f4496` / `dd78a52`)
  — the slice that surfaced the framing.
