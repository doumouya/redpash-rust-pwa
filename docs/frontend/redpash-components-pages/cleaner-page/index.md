---
title: Cleaner page (`#/cleaner`)
section: Frontend
order: 14
last modified date: 2026-05-16
---

# Cleaner page (`#/cleaner`)

The data-cleaning workspace. Opens a single file as a server-paginated
redtable, surrounds it with per-file tabs, an undo/redo history, a
17-modal tools panel, a Data Types sidebar, and the live cleanness
score in the header chrome. Every cleaning operation is a server-side
**step** — append-only `project_steps` rows that the backend replays
on every read.

See also: [redtable component](../../redpash-components/redtable.md)
(shared chrome + STATE / schema patterns), [cleanness
score](../../../features/cleanness.md) (the number in the header bar
and the engine behind the cast-suggestion loop), [files API](../../../api/files.md)
(every step / page / encoding / cleanness / snapshot endpoint).

## Files

| File | Role |
|---|---|
| [`partials/cleaner.html`](../../../../frontend/partials/cleaner.html) | DOM landmarks. Hosts the `.rp-rt-panel` (header chrome, tabs, toolbar, body, footer), the `.rp-rtp-tools` side panel (Cleaning Tools / Column Names / String Ops icon grids, Data Types, Encoding, Applied, Join Preparation), the wrapped-CSV banner, and all 17 tool modals as `<div class="modal-overlay" id="modal-tool-*">` siblings. |
| [`styles/pages/cleaner.css`](../../../../frontend/styles/pages/cleaner.css) | Library `@import`s + page-scoped tweaks: glass control overrides, the Data Types panel row styles (`.rp-rtp-dtype-row`, `.rp-rtp-dtype-row--suggest` accent-tint), the wrapped-CSV banner, the cleanness bar fill animation. |
| [`scripts/pages/cleaner.js`](../../../../frontend/scripts/pages/cleaner.js) | The controller (~2700 lines). Owns STATE, all `_render*` functions, every `window.cleaner*` action handler, the tool-modal open/populate/apply pipeline, the page loader, mode toggles, and the inline-cell edit dispatch. |

The tool modals' inline edit logic — `_readToolPayload(toolId)` —
lives in this same `cleaner.js`; the older `scripts/cleaner/tools/*`
module set is a Phase-2 sketch that isn't loaded yet (the active path
uses inline modals, one per tool kind).

---

## STATE shape

```js
{
  rid,         // active file FIL_…
  summary,     // FileSummary (incl. cleanness_pct, encoding, delimiter, …)
  columns,     // ColumnMeta[] (incl. semantic_dtype — drives the Data Types panel)
  steps,       // ProjectStep[] history (applied + undone, in ordinal order)
  project,     // Project containing this file (for the project meta line + status badge)
  files,       // sibling files in the project (tabs are built from this)
  page, pageSize, pageData,      // current page + last /page response
  selected,    // Set<rowIndex> for select mode
  mode,        // null | "edit" | "select" | "delete"
  // … filter predicates, search query, history cursor
}
```

The page is single-file-at-a-time — the active `rid` drives every
render. Tabs let the user jump between files in the same project
without re-mounting the page.

---

## Entry

Two URL forms, dispatched in mount:

- `#/cleaner?file=FIL_…` — **file landing**. Opens that file directly:
  `STATE.rid = fileRid`, fetches file detail + project files + project
  meta, paints chrome, `_loadPage()`.
- `#/cleaner?project=PRJ_…` — **project landing**. `STATE.rid = null`,
  fetches `GET /api/projects/:rid/files` + projects list, paints chrome,
  then calls `cleanerActivateTab("")` so the **Overview** pane is what
  shows up. No file is pre-selected (the previous auto-pick-first-file
  behaviour caused a subtle bug where clicking the first file tab was a
  no-op because `fid === STATE.rid` short-circuited the activator).

The active rid is mirrored to the URL via `history.replaceState` on
every navigation so reload keeps the file (or project Overview) open.

The Overview branch in `cleanerActivateTab("")` also wipes
`STATE.rid` / `summary` / `columns` / `steps` / `page` and re-paints
title, history buttons, applied list, dtype list, encoding picker —
the chrome that remains visible in overview mode must not keep
painting the previously-open file's state. Without this, undo / redo
stayed enabled and Data Types still showed the prior file's columns.

---

## Page topbar (`.rp-rt-topbar`)

A slim row above the `.rp-rtp` workspace wrapper. Same shape and CSS
as the Objects-page topbar (rule lives in `styles/main.css`). Contains
a back-arrow (`cleanerBack()` → `#/objects`) and a static page title
`"Cleaner"`. The previous in-panel back button inside `.rp-rt-header`
was removed as redundant.

The topbar lives **inside** `.rp-rtp` (the gradient workspace
wrapper) so the gradient `var(--bg-step-*)` painted by
`html[data-bg-preview="on"] #page-cleaner` shows through both topbar
and panel as one continuous surface.

## Header chrome (inside the panel)

| Element | ID / class | Source |
|---|---|---|
| Title | `#cleaner-title` | `"Project: <project_name>"` on Overview, `"Project: X — File: <display_name>"` on a file tab. Falls back to `"Project: —"` when no project is loaded. Dropped on Overview entry (see `cleanerActivateTab("")`). |
| Project meta | `#cleaner-proj-meta` | `STATE.project.name` + file count |
| Status badge | `#cleaner-proj-status` | project's status (draft / active / archived / **published** overlay), Catppuccin colors |
| Cleanness bar | `#cleaner-overall-fill` + `#cleaner-overall-pct` | `STATE.project.cleanness_pct ?? STATE.summary.cleanness_pct`, color-toned (green ≥90, yellow ≥70, red below) |
| Undo / Redo | `#cleaner-undo` / `#cleaner-redo` | enabled per `STATE.steps` cursor — reads `s.applied === true/false` (the field is a `bool`, not the legacy `s.status` string the old code looked for). |
| Save view | `#cleaner-save` | persists `colOrder` / `visibleCols` / `rowsPerPage` / `showRowNums` / `dateFmt` via `PATCH /api/me` (`prefs.cleaner_views`); disabled when `STATE.rid` is null. |
| Export | `#cleaner-export` | CSV blob of the current filtered + sorted + visible-columns view |
| `+` | `.rp-rt-add` | opens a hidden multi-select `<input type="file">` (`inp.multiple = true`) and uploads each picked file sequentially via `POST /api/files/upload`; refreshes the strip once and navigates into the last-uploaded file. |

---

## Tab strip

`.rp-rtp-tabs-inner` (`[data-cleaner-file-tabs]`) holds the leading
**Overview** tab + one tab per file in `STATE.files` filtered through
`STATE.hiddenFiles`, plus a trailing **`+`** add-back control. The strip
is a centred flex row — tabs are a fixed 10rem and wrap to a new line
once it fills, with the row centred (equal gutters left / right). The
project-tab strip above it (`.rp-rt-proj-tabs-inner`) shares the same
centred-flex construction and the same `+` picker dropdown.

Each file tab carries:
- A coloured status dot (green ≥90 / yellow ≥70 / red below) reading
  off the file's `cleanness_pct`.
- A **×** close button (`.rp-rtp-tab-x`) — hidden until tab-hover /
  active, stops event propagation. Click → `cleanerHideFileTab(fid)`
  adds the rid to `STATE.hiddenFiles` (persisted to
  `prefs.cleaner_hidden_files`), re-renders the strip, and if the
  closed tab was active falls back to the next visible file (or
  Overview). The file is **not** deleted from the project.

The trailing **`+`** (`.rp-tab-add`, `onclick="spOpenFilePicker(this)"`)
opens an inline picker dropdown (`.rp-tab-add-menu.rp-tab-add-menu--pick`):
a header, a search field (`spFilterTabAdd` live-filters the list as you
type), a scroll-capped (~6-row) list of the project's files that are
currently closed (in `STATE.hiddenFiles`), and a footer row that uploads
more files to the project (`spAddFilesToCurrentProject`). Click a file
row → `spOpenFileFromPicker(rid, name)` un-hides it (`cleanerShowFileTab`
removes the rid from `hiddenFiles`) and opens the tab. When every file is
already open the list shows an empty state — the `+` is **not** disabled.
The menu is `position: fixed`; `_positionAddMenu` anchors it under the
button and clamps it on-screen when the `+` sits near the viewport's left
edge, so it escapes the tab strip's overflow clip. An outside-click
listener dismisses it.

This picker dropdown replaced the old open-file `<dialog>` modal (it and
its open-project sibling were retired); the search field carried over,
the meta-rich pick cards collapsed to plain rows.

Switching tabs (`cleanerActivateTab(fid)`):
- If the target rid is in `hiddenFiles`, it's un-hidden first (user
  explicitly opening it overrides the closed state) and the strip
  re-renders.
- Optimistic `.active` class flip on the tab strip.
- **Snapshot the leaving tab's per-file toolbar prefs** (rows-per-
  page, search query, sort chain, mode, page index) into
  `STATE.filePrefs.set(prevRid, …)` so re-entering that tab later
  restores them — see *Per-file toolbar prefs* below.
- Drop `overview-active` from `#page-cleaner` so CSS swaps the
  visible chrome block (`data-cleaner-view="file"` vs `"overview"`)
  back to the file view.
- `replaceState` URL to `?file=…`, `GET /api/files/:rid`, update
  STATE, repaint chrome, **`_loadFilePrefs(root, newRid)`** to
  rehydrate the new tab's prefs + sync the toolbar widgets, then
  `_loadPage()`.

**Overview tab** — `#cleaner-ov-toolbar` + `#cleaner-ov-table`,
both **sibling chrome blocks** of the file-view (same nesting level
under the panel, not inside the outer `.rp-rt-table-wrap`). When
`cleanerActivateTab("")` fires, it snapshots the leaving file's prefs,
wipes `STATE.rid`/`summary`/`columns`/`steps`/`page` so the chrome
that stays visible (header + Data Types + Encoding + Applied list)
doesn't paint the previously-open file, then calls
`_renderOverview(root)` which paints the toolbar HTML into
`#cleaner-ov-toolbar` and the thead+tbody into `#cleaner-ov-table`.

Both halves use the library's `rp-rt-toolbar` / `rp-rt-body` /
`rp-rt-table-wrap` / `rp-rt-table` classes natively — no `.ov-rt-*`
namespace anymore. CSS gates visibility on
`#page-cleaner.overview-active` flipping which `data-cleaner-view`
block is visible, so the cleaner is "one panel with two
interchangeable bodies, both built from library primitives."

Per-row affordances on the Overview: row click switches the active
file tab via `_ovRowClick`, no-ops in edit / select / delete modes
(those modes own the click affordance). Mode-gating now reuses the
panel's `rp-rt-mode-*` classes — the old parallel `[data-ov-mode]`
system is gone.

---

## Toolbar

Same library chrome as the Objects page (filter funnel, `<input
class="rp-rt-search">` directly, rows-per-page pill, chain-link
toggle, mode icon-button triplet — see *Per-file toolbar prefs*), with
two extras: the **fix-wrapped banner** (`#cleaner-fix-wrapped`)
appears above the table when `_detectWrappedCsv()` flags the active
file — clicking it opens `modal-unwrap-csv` which previews the
parsed-vs-re-split shape and applies a single `unwrap_csv` step on
Apply.

The three inline modes (`rp-rt-mode-edit` / `rp-rt-mode-select` /
`rp-rt-mode-delete`) work exactly as in [the redtable doc](../../redpash-components/redtable.md#mode-classes--edit--select--delete) —
edit-mode dblclick swaps a cell for a `text` / `bool` / `enum` /
`select` / `open` editor and dispatches the change. The mode toggles
are **icon buttons** (`<button class="rp-rt-icon-btn"
data-rt-mode="…" aria-pressed="…">`) — same vocabulary as the cleaner
Overview + Objects page. `rtToggleMode` reads `.is-active` on the
button, flips `aria-pressed`, and walks `.rp-rt-icon-btn[data-rt-
mode]` siblings to enforce the one-at-a-time invariant.

### Header title — `_renderTitle`

Header reads `[📂 folder-icon] [project name] — [📄 file-icon] [file
name]`. Both names are anchors:

- **Project name** → `#/objects?tab=projects` (Objects browse).
- **File name** → `#/objects?tab=files`.

When STATE.rid is null (Overview tab), the file half is dropped
entirely so the title reads `[📂] [project name]` only. Icons use
`bi-folder2-open` + `bi-file-earmark-text` — same iconography as the
Objects-page tab strip uses for those kinds.

### Per-file toolbar prefs (`STATE.filePrefs`)

Each file tab keeps its own rows-per-page, search query, sort chain,
mode, and current page index — without snapshot/rehydrate, changing
any of those on one tab leaks into every other open tab. Mechanism:
- `STATE.filePrefs` is a `Map<rid, {pageSize, page, q, sorts, mode}>`.
- On tab leave: `_saveFilePrefs(prevRid)` snapshots the current values.
- On tab enter: `_loadFilePrefs(root, newRid)` rehydrates from the
  snapshot (defaults for never-visited tabs) and calls
  `_syncToolbarToState` + `_applyPanelMode` to repaint the rows
  label, dropdown checkmark, search input value, and mode-button
  active state.

**Chain-link toggle** (`#cleaner-link-toolbar`, icon button right
after the rows-per-page pill). When ON, search + rows-per-page stick
across file tabs (the snapshot/restore helpers skip those two fields,
so the active values just carry through). When OFF (default), they're
per-tab. Mode + sort + page stay per-tab regardless — mode is
data-mutation-risky and sort is schema-dependent. Pref persisted to
`prefs.cleaner_link_toolbar`.

### Rows-per-page + 5k cap

Dropdown items: **10 / 25 / 50 / 100 / 500 / 1500 / 3000 / 5k (max)**.
The old "All rows" option is gone — at ~85k DOM nodes (5k × 17
columns) the browser handles select-mode flips smoothly; the old
pinned 100k cap froze the page when the user toggled select. The
`_clampPageSize` helper enforces the 5k cap; legacy filePrefs values
above the cap clamp down on load. Label format: `5k` for ≥5000, raw
integer otherwise.

### Page cache (`_pageCache`, LRU 12)

Keys responses by `${rid}:${page}:${pageSize}:${JSON(sorts)}:${q}` so
tab-switches within the same params reuse the cached payload instead
of paying the 3 s round-trip on a 5k-row page. Auto-invalidates
per-file via `_fileStepsRev` — every step apply / undo / redo
increments the applied-steps count, which `_loadPage` detects and
drops the rid's cached pages before consulting the cache. No
per-step-callsite bookkeeping required.

### Pagination

`[data-rt-pages]` slot in the panel's paging footer, scoped to
`data-cleaner-view="file"` so the Overview hides it (Overview is
fully client-side paginated). `_renderPaging(root, totalPages)`
paints a Django-style smart window via `_smartPageNums`:
`total ≤ 7` lists every page, else
`[< 1 … cur-1 cur cur+1 … last >]` with literal "…" gap spans.
`cleanerSetPage(n)` validates against `STATE.pageData.pages` before
applying — stale clicks (e.g. on a `>` painted before a filter
shrunk the result) clamp instead of overshoot.

---

## Tools panel (`#cleaner-tools-panel`)

A right-aligned column of grouped collapsible tool sections. Each
section is a header (label + chevron) + a single-column list of
labeled icon buttons. **17 tool modals** in three logical groups:

| Section | Tool buttons → modal |
|---|---|
| **Cleaning Tools** | `tool-dedup` · `tool-fill` · `tool-invalid` · `tool-dates` · `tool-droprows` |
| **Column Names** | `tool-inspect` · `tool-rename` · `tool-snake` · `tool-replacenames` · `tool-changecase` · `tool-filtersel` · `tool-dropcols` |
| **String Ops** | `tool-split` · `tool-joinco` · `tool-removetext` · `tool-find` · `tool-replacetext` |

Plus the standalone **`modal-unwrap-csv`** triggered by the
fix-wrapped banner.

The library `.rp-rtp-ct-btn` defaults to circular icon-only buttons
in a 2-column grid; cleaner.css overrides scoped to `#cleaner-tools-panel`
restyle them as full-width horizontal pills with `bi-magic` icon +
`<span class="rp-rtp-ct-btn-lbl">` label (the tool name, taken from
the `title=` attribute by an in-tree script). Reasons: (1) less
unused vertical space, (2) icon-only buttons required tooltip-hover
to identify each action.

Section headers carry `onclick="cleanerToggleToolSect(this)"` which
toggles `.open` on the header + its next sibling body — library CSS
handles the chevron rotation + body display-flip. Because the panel
is on the **right** of the table, a cleaner-css override rotates the
collapsed chevron `+90deg` (▶ pointing toward the panel's outer edge)
instead of the library default `-90deg` (◀ which would point into the
table).

### Modal pipeline

1. **Open** — `window.cleanerOpenTool(toolId, btn)`:
   - Finds `#modal-<toolId>` in the partial.
   - Calls `_populateToolModal(toolId)` — pre-fills column selects (`[data-tool-cols]`), checklists (`[data-tool-checklist]`), subtitles (`[data-tool-sub]`), dtype tables (`tool-inspect` only).
   - Calls `openModal(toolId)` + `_positionToolModal(btn)` — popover-anchored to the trigger button, auto-flips right if it would clip.
2. **Apply** — `window.cleanerApplyTool(toolId)`:
   - `_readToolPayload(toolId)` walks the modal's inputs → `{ kind, params }` (per-tool reader; validates and toasts errors, returns `null` on failure).
   - `closeModal(toolId)` optimistically — form values stay in the DOM if the POST fails.
   - `POST /api/files/:rid/steps` with the payload → response carries the new `summary` / `columns` / `steps` plus a `last_op` with `rows_before`, `rows_after`, `cells_changed`.
   - Re-renders title, meta, cleanness bar, history buttons, applied list, dtype list, tabs, then reloads the page.
   - Success toast — `"{kind} · +N rows"` / `"{kind} · -N rows"` / `"{kind} · N cells"` / `"{kind} · applied"` depending on which counters the backend filled in.

### The `tool-invalid` exception — surface what's actually there + learn

`tool-invalid` is the one Cleaning Tools modal that doesn't rely on the
user knowing what to type. On open it fires
`GET /api/files/:rid/sentinels?extra=<learned + ad-hoc>` (see
[api/files.md](../../../api/files.md#get-apifilesridsentinels)) — a
backend scan of every string column for the canonical sentinel
vocabulary (`N/A` / `?` / `null` / `unknown` / `—` / `nan` / `#N/A` /
…) **plus the user's learned set**. Each *distinct cell value as
found* (preserving casing) becomes a checkbox row with its total
count and the columns it appears in:

> `[x] NA  ·  2,943 cells  ·  in 3 columns`
> `[x] ??? [global]  · 14,997 cells · in 2 columns`
> `[x] NDISPO [learned] · 412 cells · in 1 column`
> `[x] ----   [submitted] · 7 cells · in 1 column`

The first three rows ship pre-ticked so a one-click "Fix values" is
meaningful even before the user reads anything. Rows whose canonical
form isn't in the built-in `SENTINELS` set carry one of three
provenance chips:

| Chip | Meaning |
|---|---|
| **learned** (accent) | In the user's `prefs.learned_sentinels` and **not shared** (their consent is `false` or `null`) |
| **global** (green) | Promoted to `global_sentinels` (≥2 distinct users have flagged it) — every user gets it automatically |
| **submitted** (muted) | The user has shared it (`share_sentinels === true`) but it hasn't hit the 2-user threshold yet; tooltip reads *"Submitted — will join the global vocabulary after 1 more user flags it"* |

The modal also exposes:

- **Don't see it? Add a custom value** — free-text input + Add (or
  Enter). `cleanerToolInvalidAddExtra` pushes the typed value into a
  per-modal `_toolInvalidAdhoc` set and re-scans. If the value isn't
  actually in the file, the row never appears and a `toast.info`
  explains; if it is, it appears at the right position by count.
- **Scope** — `all string columns` (default) vs `a single column…`.
- **Replace with** — `Empty (null)` (default) vs `A custom value…`.

### Consent gate on first custom Apply

The first time the user picks a custom (non-built-in, non-already-
learned) sentinel and clicks Fix values, **before** the step runs
`cleanerApplyTool('tool-invalid')` opens `#modal-sentinel-consent`:

> **Help RedPash get smarter?**
> You just flagged `???` as junk. Share that with every RedPash user
> so we catch it automatically in their files too.
> *We share only the placeholder string itself, never any of your
> data. A placeholder joins the shared vocabulary once at least one
> other user has independently flagged it too.*
> `[Share & continue]  [Just for me]  [Cancel]`

The handler is a one-shot Promise (`_askSentinelConsent`) that
resolves `accept | decline | cancel`. The choice PATCHes
`prefs.share_sentinels` (true / false) and is sticky — never asked
again. Cancel aborts the whole Apply; the other two proceed.

### Apply path + the learning loop

Apply sends one `fix_invalid` step with `{ sentinels: [picked, …],
columns?: [one], replacement?: "…" }`. **Any picked sentinel whose
canonical form is neither built-in nor already learned is pushed into
`prefs.learned_sentinels` via `rpSavePref` in the same handler** —
so the next file the user opens scans for it automatically without
re-typing. The full scan extras union is:

```
built-in `SENTINELS` ∪ session.global_sentinels ∪ prefs.learned_sentinels ∪ this-session ad-hoc
```

When `prefs.share_sentinels === true`, the server-side PATCH `/api/me`
handler ALSO inserts each new canonical into `sentinel_submissions`.
Once 2 distinct users have submitted the same value, the
`global_sentinels` view promotes it — every user's next `/api/me`
bootstrap will return it in `global_sentinels`, and their next
hydrate / cleanness recompute will dock it as junk.

The learning is therefore *both* personal (immediate, sticky for the
user) and shared (asynchronous, sticky for everyone once the
threshold is met). See [features/cleanness.md](../../../features/cleanness.md#user-extended-sentinel-set--the-learning-loop)
for the scoring side, and [api/me.md](../../../api/me.md) for the
consent + bootstrap contract.

### The `unwrap_csv` exception

Files where every row is one quoted field containing the *real*
delimited content (the `dossier.csv` pathology) get a one-click
recovery: `cleanerApplyTool` for `unwrap-csv` POSTs a single
`unwrap_csv` step which the backend re-parses + re-types in one shot.
The detector (`_detectWrappedCsv`) runs on every file load and only
surfaces the banner when the heuristic flags the file.

The Rust `unwrap_csv` step does a **defensive unquote** on each value
before re-emitting + re-parsing: strips a balanced outer `"…"` pair
and unescapes doubled `""` → `"`. Without it, the inconsistent
wrapping pattern (some lines `"…"`, some bare) left some values still
wrapped in `"…"` after Polars' first parse, and the second parse saw
those as single-field quoted blobs — producing a frame with a mix of
quoted + unquoted columns. The Django version stripped every `"`
brutally; ours uses the parser as the second-stage normaliser.

---

## Data Types sidebar

`#cleaner-dtype-list`, painted by `_renderDtypeList(root)` on every
file load + every step apply. One row per column. The row reads two
fields off `ColumnMeta`:

- `dtype` — *storage* type (what Polars parsed it as)
- `semantic_dtype` — *intent* (sniffed by [`data::dtype::sniff_semantic_type`](../../../../backend/crates/data/src/dtype.rs))

When they disagree on a string-stored column (`prix_ht string →
float`, `disponible string → bool`, `date_maj string → date`), the row
renders as an accent-tinted **suggest row** (`.rp-rtp-dtype-row--suggest`)
with two explicit icon buttons:

- **✓ confirm** (`.rp-rtp-dtype-confirm`, green hover) — runs
  `window.cleanerCastColumn(col, dtype)` (see flow below).
- **✗ dismiss** (`.rp-rtp-dtype-dismiss`, red hover) — runs
  `window.cleanerSkipCast(col)`: adds the column name to a per-file
  Set stored in `localStorage` (key `rp-dtype-skip-${FIL_RID}`).
  Dismissed columns disappear from the suggestion stream for THIS
  file only — `CODE_POSTAL` dismissed in `clients_raw.csv` doesn't
  bleed to `dossier.csv`.

A dismissed column renders as a `.rp-rtp-dtype-row--kept` row — name
+ italic `kept as text` label + a small **↻ revert**
(`.rp-rtp-dtype-revert`) that pulls it back into the suggestion
stream via `window.cleanerRevertSkipCast(col)`.

### Cast flow (`cleanerCastColumn`)

1. **Dry-run** — `POST /api/files/:rid/cast-preview { column, dtype }`.
   Backend re-runs the same `data::steps::apply("cast", …)` against
   the cached frame WITHOUT persisting, diffs source vs result, and
   returns `{ total, would_null, samples: [...] }` (samples = up to 5
   distinct source values that would null).
2. **Zero-null** → applies the cast silently via `_applyCastStep`.
3. **Non-zero null** → populates + opens **`#modal-cast-confirm`** — a
   styled modal (matches the unwrap-csv modal shell) with yellow
   warning icon, title `"Confirm cast — N value(s) will become null"`,
   subtitle showing `N of TOTAL`, a mono pre-block listing the
   samples, footer Cancel + Apply. The Apply button's onclick is
   re-bound per open so a stale (column, dtype) from a previous open
   can't fire. Apply → `_applyCastStep` (same path as the no-prompt
   case).
4. **Apply** posts the cast step, refreshes the full chrome, and
   re-runs `_loadPage`. Cells that don't natively cast (`€995.83` →
   float fails) come back as null — but the user already saw which
   ones they'd lose. The loop (suggest → dirt-up the score on cast →
   `remove_text`/`replace_text` → re-cast) is the cleanness story:
   see [`features/cleanness.md`](../../../features/cleanness.md).

Matched / already-typed / genuine-string rows render as a read-only
`.rp-rtp-dtype-row` — just the column name and the storage dtype, no
affordance.

---

## Encoding picker

`#cleaner-encoding-select` — a select of common encodings (Auto-detect,
UTF-8, UTF-16 LE, windows-1252, ISO-8859-1, …). On change,
`setCleanerEncoding(value)` POSTs `/api/files/:rid/encoding`. The
backend validates via `encoding_rs`, evicts the hot-frame cache, and
re-hydrates from disk with the chosen codec. Effective encoding lands
on `STATE.summary.encoding` and shows next to the picker label.

`#cleaner-encoding-note` carries either an empty string or a one-line
hint when the file shows mojibake signs (`Ã©`-style — the same signal
[`encoding_integrity`](../../../features/cleanness.md) uses to dock
the score).

---

## Applied list + history

`#cleaner-applied-list` shows the `STATE.steps` history in ordinal
order — applied steps in normal text, undone steps greyed +
strikethrough. The header count chip (`#cleaner-applied-count`) shows
the number of *applied* steps.

Undo / redo:

- `cleanerUndo` → `POST /api/files/:rid/undo` → flips the highest-ordinal applied step to `applied = false`.
- `cleanerRedo` → `POST /api/files/:rid/redo` → flips the lowest-ordinal un-applied step back to `applied = true`.

Both return the same `FileEnvelope` as a step apply, so the
post-call refresh is identical (`_afterHistory(envelope, label)`).

---

## Join Preparation panel

`#cleaner-join-body` — only shown on the Overview tab
(`data-scope="project"`). Renders one card per pair-of-files using
`GET /api/files/:rid/joins` (overlap-coefficient detection). Each card
surfaces candidate join keys with their overlap score; clicking a
candidate opens the join modal where the user picks the join type
(inner / left / outer) and confirms. Confirming `POST
/api/files/:rid/joins` materialises a new joined CSV as a fresh
`FIL_…` in the project; the tab strip refreshes to include it.

---

## Filter side panel

`#cleaner-filter-panel` — toggled by the toolbar filter button. Same
predicate panel shape as the [Objects page](../objects-page/index.md#filter-side-panel):

- **Header** carries three controls: 🩹 eraser (`cleanerClearFilterDraft`),
  💾 save filter (`cleanerSaveFilter` — placeholder for a named-filter
  store), funnel **Apply** (`cleanerApplyFilter`). Each flashes a
  one-shot animation on click — `rp-rt-anim-wipe` / `rp-rt-anim-glow` /
  `rp-rt-anim-pulse` (keyframes in `main.css`).
- **AND / OR** combinator is an `.rp-rt-fb-op-toggle` pill (the two
  buttons toggle `.is-active`, the active one fills accent + inverse
  text) — replaces the older `<input type="radio">` pair.
- **Predicate row** (`.rp-rt-fb-row`) is a flex column inside a
  bordered accent-washed card. Children in order: ✕ remove button
  (top-right via `align-self: flex-end`), `.rp-rt-fb-selects` 50/50
  grid with the column + op `<select>`s, `.rp-rt-fb-val` value input.
  Hover bumps row background from `accent 10%` → `accent 18%`. Each
  `<select>` / `<input>` picks up an accent border + accent-tint
  background on hover/focus to override the native UA grey hover.
- **Column dropdowns auto-sync** — `_syncFilterRowColumns(root)` is
  called as a side-effect at the end of `_renderDtypeList`. Any path
  that changes `STATE.columns` (file switch, cast/drop/rename steps)
  also rebuilds the `<option>` list on every existing predicate row,
  preserving the previous selection when the column still exists.

Apply: reads each row into `{column, op, value?}`, combinator from the
pill, fires `POST /api/files/:rid/steps { kind: "filter_rows", … }`.
Same downstream path as a tool modal — refresh chrome + `_loadPage`.

---

## Save view

`#cleaner-save` persists the per-file view config — `colOrder`,
`visibleCols`, `rowsPerPage`, `showRowNums`, `dateFmt` — to
`PATCH /api/me { prefs: { cleaner_views: { <FIL_RID>: {...} } } }`.
The filter panel is deliberately excluded (it has its own save
button — folding them together would be a confusing second control
for the same thing). On reload, `_ensureColState(rid)` lazily seeds
the live STATE from the saved view if one exists.

---

## Wired vs stubbed

| Surface | Endpoint | Status |
|---|---|---|
| File summary + columns + steps | `GET /api/files/:rid` | ✅ live |
| Paged rows | `GET /api/files/:rid/page` | ✅ live |
| Project sibling files (tabs) | `GET /api/projects/:rid/files` | ✅ live |
| Step apply | `POST /api/files/:rid/steps` | ✅ live — all 17 tool kinds + `unwrap_csv` + `cast` |
| Cast dry-run preview | `POST /api/files/:rid/cast-preview` | ✅ live — drives the cast-confirm modal |
| Sentinel scan (Fix-invalid modal) | `GET /api/files/:rid/sentinels?extra=…` | ✅ live — `extra=` joins `prefs.learned_sentinels` ∪ `session.global_sentinels` ∪ this-session ad-hoc additions |
| Learned-sentinels persistence | `PATCH /api/me` (`prefs.learned_sentinels`) | ✅ live — pushed via `rpSavePref` whenever the user picks a non-builtin sentinel |
| Sharing consent | `PATCH /api/me` (`prefs.share_sentinels`) | ✅ live — one-time consent modal on first custom Apply; sticky three-state (`null` / `true` / `false`) |
| Shared-vocabulary submission | `PATCH /api/me` server-side side-effect → `sentinel_submissions` | ✅ live — server-side recorder; promotes to `global_sentinels` view at `≥2` distinct users |
| Bootstrap shared vocabulary | `GET /api/me` (`global_sentinels` field on the envelope) | ✅ live — cached in `STATE.globalSentinels` on cleaner mount |
| Undo / Redo | `POST /api/files/:rid/{undo,redo}` | ✅ live |
| Encoding override | `POST /api/files/:rid/encoding` | ✅ live |
| Recompute cleanness on demand | `POST /api/files/:rid/cleanness` | ✅ live |
| Clear cleanness score | `DELETE /api/files/:rid/cleanness` | ✅ live — dev/test convenience |
| Snapshot | `POST /api/files/:rid/snapshot` | ✅ live |
| Joins detect + apply | `GET` / `POST /api/files/:rid/joins` | ✅ live |
| Export | client-side CSV blob of the current view | ✅ live |
| Save view | `PATCH /api/me` (`prefs.cleaner_views`) | ✅ live |
| Hidden tabs persistence | `PATCH /api/me` (`prefs.cleaner_hidden_files`) | ✅ live |
| Cast-suggestion skip set | `localStorage rp-dtype-skip-${FIL_RID}` | ✅ live — per-file, per-browser |
| File rename | `PATCH /api/files/:rid` (`display_name`) inline-edit cell | ✅ live |
| Data Types cast suggestion | `POST /api/files/:rid/steps { kind: "cast" }` via `cleanerCastColumn` | ✅ live |
| Add file (multi-select) | `POST /api/files/upload` per picked file (sequential loop) | ✅ live |

---

## Cache / refresh

Every change to the partial, CSS, or controller triggers a
`service-worker.js` `CACHE_VERSION` bump. Unregister the SW +
hard-refresh — or use Firefox private (the dev server's `ServeDir`
sends no `Cache-Control` headers, so other browsers heuristic-cache
JS aggressively).

---

## Related

- [redtable component](../../redpash-components/redtable.md) — shared chrome + STATE / schema patterns + mode classes.
- [Objects page](../objects-page/index.md) — the canonical schema-driven implementation; many cleaner patterns are descendants.
- [Cleanness score](../../../features/cleanness.md) — the score in the header bar + the engine behind the cast-suggestion loop.
- [Files API](../../../api/files.md) — every endpoint the page hits.
- [File object](../../../objects/file.md) — `ColumnMeta` (incl. `semantic_dtype`) + `FileSummary` DTOs the renders read.
- Library: [`08-cleaner-workspace.md`](/home/mansa/redpash-components/08-cleaner-workspace.md) — the redtable-pro chrome design.
