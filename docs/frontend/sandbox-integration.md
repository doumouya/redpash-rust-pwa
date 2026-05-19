---
title: Sandbox integration (live wiring playbook)
section: Frontend
order: 15
---

# Sandbox integration (live wiring playbook)

How the prerelease cleaner page wires the `redpash-components`
sandbox markup to the real backend, and the playbook for migrating
the remaining legacy handlers off `_wireGlobals` into the new
`_installSandboxLiveHandlers` path.

Read this before adding a new `window.cleaner*` handler or touching
`mountSandbox()` — there are conventions that aren't obvious from the
code, and known gotchas that already cost us hours during cell-edit
wiring.

Related:

- [Redtable (app-side integration)](redpash-components/redtable.md) — class names, schema split
- [Cleaner page](redpash-components-pages/cleaner-page/index.md) — file map + STATE shape

---

## The split — sandbox owns DOM, live owns STATE

Every interactive element in the sandbox is wired through **two**
handlers fired from a single inline `onclick`:

```html
<button onclick="spActivateTab(this);cleanerActivateTab('FIL_…')">
```

- `sp*` handlers live in [`frontend/scripts/controls.js`](../../frontend/scripts/controls.js).
  They own the **DOM** — visual flips (`.active` class), animations
  (`.is-entering` / `.is-removing`), local sandbox undo stack.
  These were authored against the standalone `redpash-components`
  demo and assume no backend.
- `cleaner*` handlers live in [`frontend/scripts/pages/cleaner.js`](../../frontend/scripts/pages/cleaner.js).
  They own **STATE + persistence + chrome paint**: fetch from the
  API, mutate `STATE`, call `rpSavePref`, call the `_renderSandbox*`
  functions to repaint header / file tabs / table.

Both fire in source order on the same click. Both succeed. The
sandbox handler gives instant visual feedback; the live handler
catches up with the real data a few hundred ms later.

**Why composite, not unified:** the sandbox helpers (`spDeleteTab`,
`spAddProjectTab`, `spActivateTab`) own animation classes that a full
state-driven repaint would wipe mid-transition. Letting `sp*` drive
the affordances and `cleaner*` drive STATE keeps the animations
intact AND keeps the state model clean.

---

## `mount()` branches between two worlds

[`mount()` at cleaner.js:127](../../frontend/scripts/pages/cleaner.js:127) is the
default export the router invokes. It branches on whether the
sandbox markup is present:

```js
const sandboxStrip = root.querySelector(".rp-rt-proj-tabs-inner");
if (sandboxStrip) {
  await mountSandbox(root, ctx, sandboxStrip);
  return;
}
// …legacy path falls through to _wireGlobals(root)…
```

Today every production cleaner page hits the sandbox branch. The
legacy fall-through is kept for revertability — if the sandbox
markup is rolled back, `_wireGlobals` will install the 55 legacy
handlers and the old `cleaner.live.html` layout will work.

**Implication:** the two sets of `window.cleaner*` handlers never
run in the same session. Duplicated names are source-level
duplication, not a last-wins runtime conflict.

---

## `mountSandbox()` lifecycle — the contract

[`mountSandbox` at cleaner.js:4762](../../frontend/scripts/pages/cleaner.js:4762) runs in
this order. Each step depends on the previous; don't reorder
without reading the comments.

```
mountSandbox(root, ctx, strip)
  1. strip.querySelectorAll(".rp-rt-proj-tab").remove()
     ──┤ drop sandbox demo tabs before any await
  2. STATE.hiddenFiles = new Set(prefs.cleaner_hidden_files)
     ──┤ restore prefs FIRST so the file-tab renderer sees them
  3. _installSandboxLiveHandlers(root)
     ──┤ MUST happen before any inline onclick can fire
  4. parse URL → resolve activePid / fileRid
  5. fetch /projects → projects, projectsByPid
  6. merge prefs.cleaner_open_projects + activePid → openList
  7. STATE.openProjects / activeProjectId / projectMeta = …
     ──┤ mirror EVERY local into STATE so handlers can read it
  8. _renderSandboxProjectTabs(strip, …)
  9. _populateOpenProjectPicker(root, …)
 10. fetch /projects/:pid/files → files, activeFile
 11. STATE.files / project / rid = …
 12. _renderSandboxHeader(root, …)
 13. _renderSandboxFileTabs(root, …)
 14. _paintSandboxTable(root, activeFile) → mirrors detail.summary
     / .columns / .steps into STATE, also mirrors back into STATE.files
 15. _installSandboxLiveHandlers._syncUndoRedoButtons()
```

The **STATE mirror discipline** is critical: any local computed in
`mountSandbox` (or any handler that fetches fresh data) MUST be
assigned to `STATE` before any `window.cleaner*` handler that reads
it can fire. The composite onclick model means a handler can be
invoked the moment a button is clicked — there's no async barrier.

---

## `_installSandboxLiveHandlers(root)` — what it owns

[Defined at cleaner.js:4921](../../frontend/scripts/pages/cleaner.js:4921). One call per
`mountSandbox`. Installs 12 `window.cleaner*` handlers + four
closures shared across them.

### Shared building blocks (defined once, reused by every handler)

| Helper | What it does | When to call |
|---|---|---|
| `_persistHidden()` | `rpSavePref("cleaner_hidden_files", [...STATE.hiddenFiles])` — fire-and-forget. | After mutating `STATE.hiddenFiles`. |
| `_syncUndoRedoButtons()` | Reads `STATE.steps`, sets `disabled` on `[data-sp-undo]` / `[data-sp-redo]`. Exposed via function property: `_installSandboxLiveHandlers._syncUndoRedoButtons`. | After any history mutation. `_afterHistory` already calls it. |
| `_afterHistory(envelope, label)` | The post-mutation refresh. Mirrors `envelope.summary/.columns/.steps` into STATE; mirrors `envelope.summary` into `STATE.files[idx]`; re-paints header, file tabs, table; syncs undo/redo buttons; optional toast. | After every POST that returns a `FileEnvelope` (`/undo`, `/redo`, `/steps`, every tool endpoint). |
| `_refilePicker()` / `_reprojPicker()` | Re-paint the open-file / open-project picker grids from in-memory `STATE.files` / `STATE.projectMeta`. No API round-trip. | After every mutation that changes what's "openable" (close, hide, open). Keeps modals reactive without a re-fetch. |

### The cell-edit dispatcher (once-guarded document listener)

[At cleaner.js:5347](../../frontend/scripts/pages/cleaner.js:5347). A `document`-level
`focusin` / `focusout` pair, guarded by
`_installSandboxLiveHandlers._cellEditInstalled` so re-mount on hash
change doesn't stack listeners.

Two patterns worth copying for similar handlers:

1. **Own dataset key.** Uses `el.dataset.rpCellPrev`, not the
   sandbox's `el.dataset.spPrevText`. Why: `controls.js` has its own
   `focusout` that reads + deletes `spPrevText` before ours fires
   (registration order). Sharing the key would race.
2. **Targeted selector.** Acts only on cells with BOTH
   `[data-row-idx]` and `[data-col-name]`. Those are emitted by
   `_paintSandboxTable` for data cells only — so file-name / project-
   name / column-header edits flow through their own rename paths
   (when those exist) instead of trying to be `set_cell` steps.

---

## Migration playbook — legacy `_wireGlobals` → sandbox

A legacy handler in `_wireGlobals` (lines ~1234–3140) typically:

1. Mutates STATE,
2. POSTs to the backend,
3. Calls `_render*` functions that target legacy DOM ids
   (`#cleaner-title`, `#cleaner-tabs-list`, …) that don't exist in
   the sandbox markup.

Step 3 is the reason a legacy handler can't just be re-used as-is.
Sandbox markup uses `[data-cleaner-*]` selectors and CSS classes
like `.rp-rt-proj-tab` / `.rp-rtp-tab` — totally different from the
legacy `#cleaner-tabs-list` id namespace.

### Recipe — moving a handler over

For a handler like `cleanerXxx(arg)`:

1. **Read the legacy version.** Understand what it touches: STATE
   slice, API endpoint, which `_render*` calls.
2. **Write a sandbox-aware version inside `_installSandboxLiveHandlers`.**
   Pattern:
   ```js
   window.cleanerXxx = async (arg) => {
     // 1) STATE mutation (defensive guards on shape — STATE may not
     //    be hydrated when the handler is called from an inline onclick)
     if (!Array.isArray(STATE.xxx)) STATE.xxx = [];
     STATE.xxx.push(arg);
     window.rpSavePref?.("cleaner_xxx", STATE.xxx);   // if persisted

     // 2) Optimistic UI / reactive picker
     _refilePicker();   // or whatever picker reflects this state

     // 3) Optional API call. If it returns a FileEnvelope:
     try {
       const env = await api.post(`/files/${encodeURIComponent(STATE.rid)}/steps`, { … });
       await _afterHistory(env, "Xxx applied");
     } catch (err) {
       toast.error(`Xxx failed: ${err.body?.error ?? err.message}`);
     }
   };
   ```
3. **Wire the partial's `onclick`.** Match the composite pattern if
   there's a sandbox affordance to fire too:
   ```html
   <button onclick="spDeleteTab(this);cleanerCloseProject('PRJ_…')">
   ```
   If there's no sandbox affordance, plain `onclick="cleanerXxx(…)"`.
4. **Don't touch legacy `_wireGlobals`.** It stays as-is for the
   revertability story. Delete it only when `cleaner.live.html` is
   removed.

### What NOT to copy from the legacy version

- `_renderTabs(root)`, `_renderProjectTabs(root)`, `_renderHeaderMeta(root)`,
  `_renderHistoryButtons(root)`, `_renderAppliedList(root)`,
  `_renderDtypeList(root)` — these target legacy DOM ids. The
  sandbox equivalents are `_renderSandboxHeader`, `_renderSandboxFileTabs`,
  `_renderSandboxProjectTabs`. `_afterHistory` already calls all of
  them; in most handlers you only need to call `_afterHistory`.
- `_loadPage(root)` — sandbox uses `_paintSandboxTable(root, activeFile)`,
  also called by `_afterHistory`.
- Full sandbox-strip repaints from inside a click handler. The
  `sp*` helpers (already firing via the composite onclick) own the
  animation; a full repaint wipes `.is-removing` / `.is-entering`
  classes mid-transition.

---

## Handler audit (2026-05-18)

Numbers from the script at the bottom of this doc. Re-run when you
suspect the counts have drifted (after migrating a handler, after
adding a sandbox-only one).

| Bucket | Count | Status |
|---|---|---|
| Defined in `_installSandboxLiveHandlers` only | 13 | New / renamed during sandbox migration |
| Defined in BOTH `_wireGlobals` and `_installSandboxLiveHandlers` | 19 | **Migrated.** Same name in both; sandbox wins for cleaner page mounts. Legacy version stays for revertability |
| Defined in `_wireGlobals` only | 36 | **Still to migrate** (literally — though several have functionally-equivalent sandbox handlers under a different name; see "Functional renames" below) |

Not counted here (not a `window.cleaner*` assignment): the **cell-edit
dispatcher** in `_installSandboxLiveHandlers` (once-guarded
document-level `focusin`/`focusout` pair) — supersedes legacy
`cleanerCellEdit`.

### Sandbox-only (13)

| Sandbox handler | New / renamed from | Notes |
|---|---|---|
| `cleanerOpenSavedSettings` | renamed from `cleanerShowSaved` | Saved-settings rp-modal painter |
| `cleanerOpenHistory` | **new** | History rp-modal painter |
| `cleanerRefresh` | **new** | Toolbar refresh — repaint via `_paintSandboxTable`. 600ms minimum spin so cached fetches don't flash invisibly. |
| `cleanerToggleSync` | renamed from `cleanerToggleLink` | Persists `STATE.linkToolbar`; flashes `.cleaner-synced-glow` on synced controls. |
| `cleanerOpenReportForFile` | renamed from `cleanerNewReportFromFile` | `window.open(#/reports?new=1&source=…)` |
| `cleanerOpenDashboardForProject` | renamed from `cleanerNewDashboardFromFile` | `window.open(#/dashboards?new=1&project=…)` |
| `cleanerScoreFile` | renamed from `cleanerScoreThisFile` | POST `/files/:rid/cleanness` → `_afterHistory` |
| `cleanerSelectAllRows` | renamed from `cleanerSelectAll` | Master checkbox handler |
| `cleanerMaybeBulkDelete` | renamed from `cleanerBulkDelete` | No-op if empty selection; POST `drop_rows` otherwise |
| `cleanerRowClick` | renamed from `cleanerRowSelect` (broader scope — now a mode-aware row dispatcher, not just checkbox toggle) | Single `<tr>` dispatcher: select-mode toggles, delete-mode POSTs `drop_rows` for that row, edit/no-mode no-op. Checkbox has no onclick (native toggle bubbles up, handler re-syncs `cb.checked`). |
| `cleanerSetPageSize` | **new** (≠ legacy `cleanerSetPage`, which is page-nav) | `STATE.pageSize` + `_paintSandboxTable` refetch |
| `cleanerFbDdPick` | **new** | Commits a filter predicate dropdown's picked value into `wrap.dataset.value` + label + closes `.rp-dd-menu`. Pairs with the custom-dropdown conversion (see Migration progress log). |
| `cleanerFbAddPredicate` | replaces sandbox `spFbAddPredicate` | Clones the seed predicate row + resets the custom dropdowns (data-value + label + .is-selected + close menu) — sandbox's clone reset only knew how to handle native `<select>`. |

### Migrated (19 — same name in both)

| Handler | Notes |
|---|---|
| `cleanerActivateTab` | Click a file tab. Paints header from cached `STATE.files` for snappy feel, then `_paintSandboxTable` corrects from `detail.summary`. |
| `cleanerAddFile` | Opens new-project modal pre-filled with current project name. |
| `cleanerApplyFilter` | POSTs `filter_rows` step + pipes the envelope through `_afterHistory`. Reads predicates from each `.rp-rt-fb-row`'s `data-fb-col` / `data-fb-op` wraps + `[data-fb-val]` input. |
| `cleanerClearFilterDraft` | Empties the filter panel back to one fresh-empty seed row — doesn't undo an applied filter (use the toolbar's Undo button for that). |
| `cleanerCloseProject` | × on project tab. Refuses to close the only remaining tab. Calls `_reprojPicker()`. |
| `cleanerExport` | GET `/:rid/export` → blob → `<a download>`. |
| `cleanerHideFileTab` | × on file tab. Adds to `STATE.hiddenFiles`, persists, calls `_refilePicker()`. |
| `cleanerOpenProject` | Picker → push onto `STATE.openProjects` + switch. |
| `cleanerRedo` | POST `/redo`, pipe envelope through `_afterHistory`. |
| `cleanerSaveFilter` | Prompts for a name + persists into `STATE.savedFilters[rid]` + `cleaner_saved_filters` pref. Shows up in the Saved-settings modal next time it opens. |
| `cleanerSetCombo` | Single-active toggle on the AND/OR pair (`.rp-rt-fb-op-toggle`). |
| `cleanerSetPage` | Page navigation. Sets `STATE.page` + re-paints; pager-button onclicks call this. |
| `cleanerShowFileTab` | Re-show a hidden file tab. |
| `cleanerSortBy` | Sort cycle on column-header click. Shift+click chains; alt+shift removes. Persists to `cleaner_sorts` pref; backend `/page` takes the JSON-encoded `sorts` param. |
| `cleanerSwitchProject` | Active-project flip with snapshot save/restore. |
| `cleanerToggleCol` | Hide / show column from the toolbar's columns picker; persists to `cleaner_hidden_cols` pref. Min-1 guard refuses to hide the last visible column. |
| `cleanerToggleRowNums` | Persists `STATE.showRowNums` via `rpSavePref`. |
| `cleanerToggleRowOpen` | Persists `STATE.showOpenLinks` + toggles panel class. |
| `cleanerUndo` | POST `/undo`, pipe envelope through `_afterHistory`. |

### Functional renames — legacy still exists, sandbox has a same-job different-name handler

These count in BOTH the "Sandbox-only" and "Legacy-only" buckets above
because the audit matches on exact handler name. Migration is
*functionally* complete; the rename happened because the new handler's
contract differs (e.g. accepts a button vs an event, returns a
different shape, etc.). Legacy version stays for `_wireGlobals`
revertability.

| Legacy | Sandbox replacement |
|---|---|
| `cleanerShowSaved` | `cleanerOpenSavedSettings` |
| `cleanerToggleLink` | `cleanerToggleSync` |
| `cleanerNewReportFromFile` | `cleanerOpenReportForFile` |
| `cleanerNewDashboardFromFile` | `cleanerOpenDashboardForProject` |
| `cleanerScoreThisFile` | `cleanerScoreFile` |
| `cleanerClearThisFile` | — **dropped** (Clear button removed from toolbar; backend's `hydrate` auto-recomputes cleanness on cache miss + writes it back, so "clear" never persists. Reintroducing it needs a backend change to make `hydrate` respect an explicit NULL.) |
| `cleanerSelectAll` | `cleanerSelectAllRows` |
| `cleanerBulkDelete` | `cleanerMaybeBulkDelete` |
| `cleanerRowSelect` | `cleanerRowClick` (broadened to mode-aware row dispatcher; per-row delete on click in delete mode now lands via the same handler) |

### Legacy-only with no sandbox counterpart — by area (still genuinely pending)

- **Tools panel** (10): `cleanerOpenTool`, `cleanerCastColumn`,
  `cleanerSkipCast`, `cleanerRevertSkipCast`, `cleanerApplyTool`,
  `cleanerToggleToolSect`, `cleanerToolInvalidScope`,
  `cleanerToolInvalidMode`, `cleanerToolInvalidSelectAll`,
  `cleanerToolInvalidAddExtra`
- **Filters** (4): `cleanerAddFilterRow` (sandbox uses
  `cleanerFbAddPredicate` instead), `cleanerLoadSavedFilter`,
  `cleanerDeleteSavedFilter`, `cleanerCreateJoin`
- **Dedup** (1): `cleanerDedupModeChanged`
- **Rows / selection** (2): `cleanerClearSelection` (mostly covered by
  the master-checkbox unchecked path), `cleanerRowDelete` (legacy
  function name; functionally covered by the delete-mode branch of
  the new `cleanerRowClick` dispatcher, which POSTs `drop_rows` for
  a single global index — no need to migrate `_applyDropRows` /
  `_absoluteIndex` since `cleanerMaybeBulkDelete` already handles
  the POST and `_paintSandboxTable` emits global indices directly)
- **Columns** (6): `cleanerColDragStart`, `cleanerColDragOver`,
  `cleanerColDragLeave`, `cleanerColDragEnd`, `cleanerColDrop` (sandbox
  uses the generic `_bindDragReorder` + a `dragend` listener that
  snapshots DOM order into `STATE.openProjects` / `STATE.colOrder`),
  `cleanerBuildColsDropdown` (sandbox uses `_populateColsPicker`)
- **Cell** (1): `cleanerCellEdit` — **superseded** by the cell-edit
  dispatcher in `_installSandboxLiveHandlers`. Safe to drop with
  the rest of `_wireGlobals`.
- **Page / toolbar** (1): `cleanerToggleAddMenu`
- **Page actions** (2): `cleanerBack`, `cleanerSave`

---

## Watch-outs (lessons from the wiring done so far)

- **`mountSandbox` runs on every hash change.** Anything attached to
  `document` (focusin/focusout, keydown, etc.) needs a once-guard or
  it stacks listeners. Pattern: `if (!_installSandboxLiveHandlers._xxxInstalled) { _installSandboxLiveHandlers._xxxInstalled = true; document.addEventListener(…); }`.
- **Don't reuse `el.dataset.spPrevText`.** `controls.js` already
  reads + deletes it in its focusout. Use your own key.
- **`STATE.summary` and `STATE.files[idx]` can drift.** When a
  handler fetches a fresh `/files/:rid` summary, mirror it into
  BOTH. The file-tab strip and picker read from `STATE.files`; the
  header reads from the active-file slot. `_afterHistory` already
  handles this — copy its pattern in any handler that mutates a
  file's metadata.
- **First-data-column needs a leading chrome `<td>`.** controls.js
  enables contenteditable via
  `td:not(.rp-rt-rownum-td):not(:first-child)`. Without a leading
  `.rp-rt-rownum-td`, the first data column would be `:first-child`
  and silently un-editable. `_paintSandboxTable` emits the rownum
  column for this reason.
- **`api.get` / `api.post` already prefix `/api`.** Pass `/files/:rid`,
  not `/api/files/:rid`. `cleanerExport`'s raw `fetch` is the
  exception because it needs the blob handle.
- **`STATE.rid` is null on Overview.** Guard every fetch with
  `if (!STATE.rid) { toast.error("Open a file first."); return; }`
  or your endpoint will get `/files/null/…`.

---

## When to add a new handler vs reuse an existing one

- A new feature that has no legacy equivalent → add to
  `_installSandboxLiveHandlers`, follow the recipe above.
- A button that mirrors a legacy handler → migrate per the playbook;
  resist the urge to add a third name.
- A pure DOM affordance (toggle a class, animate something) that
  doesn't touch STATE or persist → put it in `controls.js` as a
  `sp*` helper; don't add a `cleaner*` for it.
- A handler that needs to refresh chrome after a backend mutation →
  always end with `await _afterHistory(env, "…")`. Don't call
  individual `_renderSandbox*` functions yourself; `_afterHistory`
  is the contract.

---

## Sandbox migration progress — 2026-05-18

Patterns and gotchas surfaced as the sandbox port rolls across pages.
Each item is tagged per-page so a fresh contributor can tell what's
done vs pending at a glance. **Rolling log** — append a new dated
section below as the migration moves forward; don't rewrite historical
entries. Audit-verified status (don't trust the page tags blindly when
the underlying code may have moved on since the entry was written).

**Legend:** ✅ done · 🔄 pending · ➖ N/A

| | Cleaner | Objects | /home |
|---|---|---|---|
| `rpInclude` page-level shell | ✅ | ✅ | ➖ |
| Composite picker click (tag-after-insert) | ✅ | 🔄 | ➖ |
| Modal-shell migration (vendored → `.rp-modal`) | ➖ | ➖ | ✅ |
| `mountXxxSandbox()` + `_installXxxLiveHandlers()` | ✅ | 🔄 | ➖ |
| `.rp-rt-panel` slide-in `transform` reset | ✅ | ✅ | ➖ |
| `openModal` dual-lookup | ✅ | ✅ | ✅ |
| Early-bail on missing sandbox hooks | ✅ | ✅ | ➖ |
| Anchor `.rp-btn` `text-decoration: none` | ✅ | ✅ | ✅ |
| `vertical-align: middle` on inline-flex action cells | ➖ | ✅ | ➖ |
| Mount-snapshot cache-then-correct (sessionStorage) | ✅ | 🔄 | ➖ |
| Native `<select>` → custom `.rp-dd-wrap` widget | ✅ (filter rows) | 🔄 | ➖ |
| Drag-reorder persistence via doc-level `dragend` | ✅ | 🔄 | ➖ |
| Minimum-spin floor on fast async ops | ✅ (refresh 600ms) | 🔄 | ➖ |
| Tool-modal wiring (`cleanerOpenTool` + `cleanerApplyTool` end-to-end) | ✅ | ➖ | ➖ |
| Unified tool-modal positioning (panel-anchored, 30rem slot) | ✅ | ➖ | ➖ |
| Joins panel mount-point selector | ✅ | ➖ | ➖ |

### Pattern: page-level shell + `rpInclude` (cleaner + objects)

*Cleaner ✅ ([cleaner.js:132](../../frontend/scripts/pages/cleaner.js:132)) · Objects ✅ ([objects.js:758](../../frontend/scripts/pages/objects.js:758)) — apply to any new full-bleed page adopting the sub-partial convention.*

The router only loads the route's top-level partial. Nested
`data-include` directives don't recurse without help — each page's
default-exported `mount(root, ctx)` must call
`await window.rpInclude(root)` before doing anything else, or the
page renders empty (`partials/cleaner.html` / `partials/objects.html`
are now thin shells whose child includes load via this call). Mirror
for any new full-bleed page that adopts the sub-partial convention.

### Pattern: modal-shell migration (file-review on /home, 2026-05-18)

*Home ✅ — this entry IS the implementation. Re-use as the migration template for any other vendored modal adopting sandbox chrome.*

The file-review modal (`#modal-ul-review`) was wrapped in the
sandbox `.rp-modal` shell to match cleaner / objects modal chrome
without rewriting the vendored `file-review.js`:

- **Outer `.modal-overlay` kept** — `position: fixed` (modal.css)
  covers the viewport; sandbox's `.rp-modal-overlay` uses
  `position: absolute` and assumes an `.rp-rt-body` host, which
  /home doesn't have.
- **Inner `.rp-modal` + `.rp-modal-hdr` added** — provides the
  sandbox shell + title bar with sandbox close button.
- **IDs preserved** — `file-review.js` looks up `modal-ul-review` /
  `ul-review` / `ul-review-multi` by id; rename them and it breaks.
- **Scoped overrides** (in `home.css` under `.rp-modal--ul-review`):
  width 56rem (sandbox default 28rem is too narrow), `padding: 0;
  gap: 0` (panels carry their own internal padding), neutralized
  `.rp-fr-panel { background: transparent; border: 0; ... }` so the
  panel's own border/bg/radius doesn't paint inside the shell.
- **CSS import** — `home.css` now imports `modals-sandbox.css` so
  the shell classes resolve.

Same pattern is the migration path for any other vendored modal
that should adopt sandbox chrome without rewriting its internals.

### Pattern: objects-page port (Phase 1 visual, state TBD)

*Objects 🔄 Phase 1 (visual chrome) ✅ · Phase 2 (state wiring) pending — mirror the cleaner playbook (`mountObjectsSandbox()` + `_installObjectsLiveHandlers()`).*

`/partials/objects.html` is now a thin shell loading
`/partials/objects/index.html` + the 16-file `objects/` subtree
(proj-tabs, toolbar, filter-panel, 6 × types/{header,table}, modals).
`mount()` calls `window.rpInclude(root)` before anything else.

Live's `_renderTabs(root)` delegates to `window.spRenderObjectTabs`
so the sandbox renderer is single source of truth for the type-tab
strip (`#obj-tabs`). Live's `renderTable(kind)` early-bails when
`tbody = panel.querySelector("[data-rt-tbody]")` is null — the
sandbox per-type tables (`[data-objects-table="<kind>"]`) don't carry
that hook yet, so live silently no-ops and the sandbox demo rows
stay visible.

State wiring for objects (real-data render into the per-type tables,
composite onclick on type-tab close, picker → spAddObjectTab + state
update) hasn't been written. When it is, mirror the cleaner playbook:
`mountObjectsSandbox()` + `_installObjectsLiveHandlers()`, same
shared closures (`_afterTabChange`, `_refilePicker`, etc.), same
composite onclick rules.

### Pattern: composite picker click (proj-tabs + / file-tabs +)

*Cleaner ✅ ([spOpenProjectFromPicker:5771](../../frontend/scripts/pages/cleaner.js:5771), [spOpenFileFromPicker:5860](../../frontend/scripts/pages/cleaner.js:5860)) · Objects 🔄 pending (folds into objects state wiring).*

Picker cards in modals call a single composite function that:

1. `closeModal('open-project'|'open-file')`
2. `spAddProjectTab(strip, name)` / `spAddFileTab(strip, name)` —
   animates `.is-entering`, de-dupes by name
3. If a NEW tab was actually inserted, **tag it** with the backend
   id and rewrite its onclick to the state-aware composite:
   ```js
   newTab.setAttribute("data-sp-project-key", pid);
   newTab.setAttribute(
     "onclick",
     `spActivateTab(this);cleanerSwitchProject('${pid}')`
   );
   ```
4. Run the live state handler (`cleanerOpenProject(pid)` /
   `cleanerShowFileTab(rid) + cleanerActivateTab(rid)`)

Without step 3 the freshly animated tab doesn't know its backend id,
so subsequent clicks / × can't dispatch to the right state handler.

### Gotcha: `.rp-rt-panel` slide-in animation traps fixed positioning

*Cleaner ✅ ([cleaner.css:103-111](../../frontend/styles/pages/cleaner.css:103)) · Objects ✅ — apply to every new per-page `.rp-rt-panel` override.*

Vendored `.rp-rt-panel { animation: rp-rt-slide-in 0.22s … both }`
goes `transform: translateX(4%) → none`. Transient (and sometimes
persistent in browser caches), the non-none transform creates a
**containing block** for any `position: fixed` descendant. Toolbar
dropdowns (`.rp-dd-menu`) compute viewport-relative coords via
`getBoundingClientRect` and write them as inline `top`/`left` — if
the menu's CB is the panel rather than the viewport, the menu
appears `panel.top` below where it should (typically topbar + tabs +
header ≈ 3cm offset).

**Fix:** every per-page `#page-X .rp-rt-panel` override must
explicitly set `animation: none; transform: none`. Cleaner's
override has had this from day one; the objects port hit this bug
and was fixed by mirroring the same lines.

### Gotcha: duplicate scoped selectors silently win

*Cleaner: clean (only additive dupes, no silent overrides) · Objects ✅ (hit + fixed) — re-run the grep after every visual port pass.*

When porting visual styles into a per-page CSS that already has
pre-sandbox rules, two `#page-X .rp-rt-foo` blocks with the same
specificity → later wins. The new sandbox block (added near the top
of the file) gets silently overridden by an old block further down.
The visible bug is a property the user thought they fixed sticking
to the pre-port value. (Objects header / toolbar both hit this.)

**Check after every visual port pass:**
```bash
grep -oE "^#page-(cleaner|objects) [^,{]+" path/to/page.css \
  | sort | uniq -c | sort -rn | head -10
```
Any count ≥ 2 deserves a manual look. Bare-tag unscoped duplicates
(`.rp-rt-toolbar { … }` at the bottom of a per-page CSS) are
usually dead code (the scoped version wins) but still worth
trimming for clarity.

### Gotcha: two `window.openModal`s racing

*All pages ✅ — fixed at the source ([main.js:403-419](../../frontend/scripts/main.js:403)). Keep the dual-lookup when touching modal plumbing.*

`main.js` defines `window.openModal = (key) => …` looking up
`id="modal-{key}"` (legacy auth/contact modals). `controls.js`
defines its own `window.openModal` looking up `id="rp-modal-{key}"`
(sandbox cleaner / objects modals). Module scripts run after
deferred scripts, so `main.js` overwrites `controls.js`'s version
silently — every sandbox modal silently no-ops.

**Fix (already in `main.js`):** the live `openModal` / `closeModal`
now try both id conventions (`rp-modal-{key}` first, fall back to
`modal-{key}`). Esc / outside-click sweeps walk both
`.modal-overlay.open` and `.rp-modal-overlay.open`. Keep this
dual-lookup logic when refactoring; many existing modals on each
side of the convention rely on it.

### Gotcha: live handlers must early-bail on missing sandbox hooks

*Cleaner ✅ (every sandbox renderer guards) · Objects ✅ (`renderTable` early-bails on null `[data-rt-tbody]`) — apply to any legacy handler kept on the sandbox path.*

Legacy `_render*` / `renderTable` / `_wireGlobals` handlers reference
DOM ids that don't exist in sandbox markup (e.g. `#cleaner-tabs-list`,
`[data-rt-tbody]`, `#obj-hdr-meta`). They MUST early-return when the
target query returns null — anything that tries to write
`.innerHTML` on a null target throws and breaks the page mount.

Pattern: `const el = root.querySelector(...); if (!el) return;` at
the top of the handler. Already applied to `_renderTabs`,
`renderTable`, the cell-edit dispatcher. Apply to any other handler
you keep on the legacy path that the sandbox markup obsoletes.

### Gotcha: anchor `.rp-btn` shows browser-default underline

*All pages ✅ — fixed at the library source [`components/glass-btn.css:40`](/home/mansa/redpash-components/components/glass-btn.css). Apps inherit automatically via the redpash-components imports.*

`<a class="rp-btn">` (per-row action buttons, topbar nav anchors)
gets `text-decoration: underline` from UA defaults. The base
`.rp-btn` rule in `glass-btn.css` didn't reset it, so a faint line
painted under icon glyphs. **Fixed at the source**:
`glass-btn.css .rp-btn { text-decoration: none; }`. Cleaner anchor
buttons elsewhere if they look off.

### Gotcha: `vertical-align` on inline-flex action cells

*Objects ✅ — apply if any other page introduces per-row action clusters.*

`<td>` with `vertical-align: middle` doesn't center inline-flex
children at the cell midline — inline-flex defaults to baseline,
which for icon-only content sits at the bottom edge. **Fix
(in `objects-sandbox.css`)**: explicit `vertical-align: middle` on
`.rp-rt-actions` AND `.rp-btn-xs`. Apply the same recipe to any
new per-row action cluster.

### Pattern: mount snapshot (sessionStorage cache-then-correct)

*Cleaner ✅ ([cleaner.js `_CLEANER_MOUNT_SNAPSHOT_KEY`](../../frontend/scripts/pages/cleaner.js)) — extend to objects when its mount path gets the same flash on reload.*

Reload felt slow because `mountSandbox` runs N sequential fetches
(`/projects` → `/projects/:pid/files` → `/files/:rid` + `/page`)
before painting any chrome — user sees empty strips + "—" placeholders
for ~500-1000ms even though they're returning to the same view they
just had.

Fix: snapshot the chrome `STATE` slice (`projectMeta`, `openProjects`,
`activeProjectId`, `files`, active `rid`, `summary`) to `sessionStorage`
at end of `mountSandbox` + `cleanerActivateTab` + `cleanerSwitchProject`.
At top of next `mountSandbox` (after handlers install + sync), read
the snapshot, restore `STATE`, paint project tabs + file tabs + header
synchronously **before** the fetches start. Fetches run in parallel
and overwrite within a few hundred ms (the standard `_paintSandboxTable`
correction-pass picks up any drift).

**Discipline:**
- **Per-mount overwrite** is the invalidation — no TTL, no per-resource
  cache busting. Every successful mount snapshots fresh truth.
- **URL hash match guard** — restore only when `snap.hashUrl ===
  location.hash`. Different URL = different project/file → fall
  through to normal fetch flow (don't paint stale).
- **`sessionStorage` scope** (per tab + origin) avoids cross-user
  pollution on shared machines; closed tab kills the snapshot.
- **Table contents NOT snapshotted** — too big to serialize for
  5k-row pages (~5MB), and the rows go stale fastest. Table body
  shows "Loading…" placeholder until `_paintSandboxTable`'s fetch
  resolves. Separate "table window" cache lands later (config-driven
  prefetch of 10k rows = 2 pages at max page size).

### Pattern: native `<select>` → custom `.rp-dd-wrap` widget

*Cleaner ✅ filter predicate rows ([filter-panel.html](../../frontend/partials/cleaner/filter-panel.html), [cleanerFbDdPick / cleanerFbAddPredicate](../../frontend/scripts/pages/cleaner.js)) — mirror anywhere the open popup needs to match the toolbar's frosted-glass treatment.*

Native `<select>` popups are OS-rendered — `.rp-dd-menu.open` styling
(frosted glass + opacity transition) only applies to the custom
`.rp-dd-wrap` widget used by the toolbar dropdowns. To get the
matching look on form selects, convert the markup:

```html
<!-- before: native -->
<select class="rp-rt-fb-col" data-fb-col>
  <option value="">Column…</option>
  <option value="...">...</option>
</select>

<!-- after: custom -->
<div class="rp-dd-wrap rp-rt-fb-col" data-fb-col data-value="">
  <button type="button" class="rp-rt-fb-dd-btn" onclick="spDdToggle(this)">
    <span data-dd-lbl>Column…</span>
    <i class="bi bi-chevron-down"></i>
  </button>
  <div class="rp-dd-menu" role="menu">
    <!-- .rp-dd-item per option, painted by JS -->
  </div>
</div>
```

**Contract changes when converting:**
- **Chosen value** moves from `select.value` to `wrap.dataset.value`.
  Apply-time readers (`_collectFilterDraft` etc.) read the new
  location.
- **Visible label** lives in `[data-dd-lbl]` inside the trigger
  button — pickers update both the data attr and the label text.
- **Item click** needs a custom handler (`cleanerFbDdPick`) that
  sets `wrap.dataset.value` + label + marks `.rp-dd-item.is-selected`
  + closes the menu.
- **Clone reset** for "Add row" handlers can't reuse sandbox
  `spFbAddPredicate`'s `select.selectedIndex = 0` — needs a
  custom handler (`cleanerFbAddPredicate`) that resets `data-value`
  + label + clears `.is-selected` + closes any open menu.
- **CSS** for the trigger button (`.rp-rt-fb-dd-btn`) needs the same
  glass recipe the library applies to form selects, with chevron
  laid out via `display: flex; justify-content: space-between`.

Inside a transformed parent (filter panel slide-in), the menu's
`position: fixed` will land 1m below the trigger — see the next
gotcha for the scoped-override fix.

### Pattern: drag-reorder persistence via doc-level `dragend`

*Cleaner ✅ project tabs + column headers — mirror anywhere the user can drag-reorder elements whose order needs to outlive the session.*

Two implementation models for tab/column reorder persistence:

1. **Objects-style: inline `ondrop` per tab + state array as source of
   truth.** `spDropObjectTab` splices `window.spObjectTabs` + persists
   + re-renders. Works because the state is sandbox-owned.
2. **Cleaner-style: generic `_bindDragReorder` (controls.js) handles
   the visual DOM reorder, then a document-level `dragend` listener
   snapshots the new DOM order back into `STATE` + persists.** Better
   fit for module-scope state — one listener catches any drag-end
   regardless of which strip or table it happened in.

Cleaner's model (in `_installSandboxLiveHandlers`, once-guarded):

```js
document.addEventListener("dragend", () => {
  // Project tabs: walk .rp-rt-proj-tabs-inner, read each tab's
  // data-sp-project-key into new STATE.openProjects + rpSavePref.
  // Column headers: walk thead, read each th's text into
  // STATE.colOrder + rpSavePref.
});
```

**Discipline:**
- **Compare before write** — only update STATE + persist when the
  new order actually differs (avoids spurious persists on no-op
  drags / clicks).
- **Use existing prefs** when possible (`cleaner_open_projects`
  already existed for "which projects are open"; reorder just changes
  the array order in-place).
- **File-tab reorder is in-session only** — would need a new
  per-project pref structure (`cleaner_file_tab_order = { pid: [rid] }`)
  to persist across reload. Out of scope for the first cut.

### Gotcha: backend `hydrate()` auto-recomputes cleanness on cache miss

*Cleaner: Clear button + `cleanerClearScore` handler dropped from toolbar — no clean fix without backend changes.*

`db::clear_file_cleanness` writes `cleanness_pct = NULL` in the DB +
invalidates `state.files` cache. But the very next read triggers
`hydrate()` ([files.rs:1130+](../../backend/crates/api/src/routes/files.rs)),
which **always recomputes cleanness** on cache miss + writes it back
to the DB. So a "clear" never persists — it survives only as long
as the in-memory cache stays empty (single tick).

Frontend symptom: user clicks Clear → backend returns `cleanness_pct:
null` → header briefly shows "—" → `_paintSandboxTable`'s subsequent
`/files/:rid` fetch hits `hydrate` → recomputed cleanness reappears
within ~100ms. User sees the score "didn't clear".

Workaround: drop the Clear button. Reintroducing it needs a backend
change to make `hydrate` either:
- Skip the recompute when DB has explicit NULL, OR
- Persist a separate "user_cleared" flag that hydrate respects.

### Gotcha: filter panel `transform` creates CB for fixed dropdowns

*Cleaner ✅ ([cleaner.css `.rp-rt-filter-panel .rp-dd-menu`](../../frontend/styles/pages/cleaner.css)) — same root cause as the `.rp-rt-panel` slide-in trap, scoped to the filter panel.*

After converting native `<select>` to custom `.rp-dd-wrap` widgets
in the filter panel's predicate rows, the dropdowns opened ~1m
below their triggers. Root cause: `.rp-rt-filter-panel` has
`transform: translateX(-100%)` for its slide-in animation
([filter-panel-sandbox.css](../../redpash-components/components/filter-panel-sandbox.css)),
which makes the panel a **containing block** for `position: fixed`
descendants. `spDdToggle`'s `_positionDdCenter` writes viewport-coord
inline `top`/`left` — the menu interprets them as panel-relative,
landing at panel-top + 300px instead of viewport-top.

**Fix** (scoped to filter panel only — toolbar dropdowns work fine
because the cleaner panel already has `animation: none; transform:
none`):

```css
.rp-rt-filter-panel .rp-dd-menu {
  position: absolute !important;       /* not fixed */
  top: calc(100% + 0.25rem) !important; /* below the wrap */
  left: 0 !important;
  right: auto !important;
  min-width: 100%;
}
```

`!important` is needed because `_positionDdCenter` writes inline
`top`/`left` that beat external CSS specificity. `.rp-dd-wrap` is
already `position: relative` per library, so absolute positioning
hangs the menu off the wrap correctly. Same trick works for any
custom-dropdown widget that ends up inside a transformed parent.

## CSS import-layer cleanup — 2026-05-19

Phase 0 / 1 / 2 of a structural sweep that removed the per-page CSS
duplication that made the sandbox port's selector cascades drift
page-to-page. The pre-cleanup picture: every full-bleed page
(`landing` / `home` / `cleaner` / `objects` / `reports` / `profile`)
re-imported `shell.css` + `glass-btn.css` + `modals-sandbox.css`
itself, re-declared the same slate-cobalt token block ×3 (dark +
pinned-light + system-light @media), and hardcoded the same page-bg
gradient — and `.rp-btn` was defined twice (library glass-btn +
app `buttons.css`), `.rp-modal` was defined twice (library
modals-sandbox + app `modal.css` BEM). Symptom: buttons looked
different on settings vs cleaner, modals looked different on
reports.live vs cleaner, and `--accent` was catppuccin sky on
landing/home but cobalt blue on cleaner/objects.

### Pattern: hoist shared library components to main.css

*All full-bleed pages ✅ — apply the same recipe to any future
sandbox-style page.*

When two CSS files define the same base selector — e.g. app's
`styles/components/buttons.css` `.rp-btn` and library's
`components/glass-btn.css` `.rp-btn` — whichever loads later wins,
and load order is per-page (different pages import different files).
The cleanup: pick a side per selector, hoist the winning version to
`main.css`, and strip the colliding declarations from the other side
(keep only what's unique).

For `.rp-btn` and `.rp-modal` the library versions are canonical;
the app files now hold only their unique modifiers:

```css
/* main.css — single source of truth */
@import "/vendor/redpash-components/components/glass-btn.css";
@import "/vendor/redpash-components/components/modals-sandbox.css";
@import "/styles/components/buttons.css";  /* only --primary/--ghost/--danger/--sm */
@import "/styles/components/modal.css";    /* only dialog.rp-modal--glass + .modal-actions */
```

Page CSS files no longer `@import` either. Page-scoped overrides
(`#page-cleaner .rp-btn { … }`) still win because their specificity
(0,1,0,1) beats the global rule (0,0,1,0).

### Pattern: inline shell.css's body chrome under `body[data-chrome="full"]`

*All full-bleed pages ✅ — adopt the same pattern if a new page
needs full-viewport chrome.*

The library's `shell.css` was originally documented as "opt-in
per-page (landing only)" but every sandbox-ported page started
@importing it. The combination — `*, *::before, *::after { margin:
0; padding: 0 }` + `html, body { overflow: hidden }` + `body {
display: flex; flex-direction: column }` — broke any non-sandbox
page that imported it transitively and forced every full-bleed page
to remember to load it.

Hoisted into `main.css`, scoped to the existing `body[data-chrome=
"full"]` attribute the router already sets:

```css
body[data-chrome="full"] {
  overflow: hidden;
  display: flex;
  flex-direction: column;
  transition: background 0.25s, color 0.25s;
  -webkit-font-smoothing: antialiased;
}
html:has(body[data-chrome="full"]) { overflow: hidden; }
```

`:has()` scopes the html-element overflow to full-bleed pages only,
so pre-sandbox pages (settings / docs / dashboards / not-found)
keep browser-default scroll. The library's `reset.css` already
handles the universal margin/padding zero globally, so that part
of shell.css doesn't need to be re-inlined.

### Pattern: theme-aware tokens as single source of truth

*All full-bleed pages ✅ — use a token whenever a value duplicates
across pages.*

Each of cleaner / objects / reports / profile used to hardcode the
same `linear-gradient(160deg, #020b18 0%, …)` gradient as `background:`
on its page root, plus a parallel light-mode override (`html[data-
theme="light"] #page-X`) with the Arctic-blue version, plus the
`@media (prefers-color-scheme: light) html[data-theme="system"]
#page-X` for system-mode-light. That's 3 gradient declarations × 4
pages = 12 occurrences of two distinct gradients.

Replaced with a single token in `main.css`:

```css
:root {
  --rp-bg-app: linear-gradient(160deg, #020b18 0%, #0b1a35 45%, #0f1a45 100%);
}
html[data-theme="light"]                                       { --rp-bg-app: linear-gradient(160deg, #dbeafe 0%, #eff6ff 55%, #e0e7ff 100%); }
@media (prefers-color-scheme: light) { html[data-theme="system"] { --rp-bg-app: linear-gradient(160deg, #dbeafe 0%, #eff6ff 55%, #e0e7ff 100%); } }
```

Each page now references the token once:
`background: var(--rp-bg-app);`. Theme switching is a single
variable swap; no per-page rule needs to know about themes.

Same pattern applied to the 20-token slate-cobalt palette
(`--bg`, `--surface`, `--over0`, `--over1`, `--text`, `--sub`,
`--muted`, `--border`, `--hover`, `--selected`, `--accent`,
`--active-bg` + the 8 `--rp-*` alias mirrors). The block lives under
`body[data-chrome="full"]` in `main.css` with parallel light /
system-light overrides. Page-specific extras (cleaner's
`--rt-pager-h`, profile's `--red`/`--green`/`--yellow`) stay
scoped to their page CSS — the hoist only covers the shared core.

### Pattern: catppuccin `--accent` fold-in

*All full-bleed pages ✅.*

`main.css` carried a small `--accent: #89b4fa` rebind block scoped
to `body[data-chrome="full"]` — a workaround for library surfaces
(hero gradients, social-button hovers, auth-modals) that compose
`var(--accent)` expecting the catppuccin sky. After the cleanup the
slate-cobalt palette block (above) already binds `--accent: #60a5fa`
at the same scope. Deleted the rebind; the four sandbox-ported
pages always had a higher-specificity cobalt override that beat the
catppuccin rebind, so the only places it was visible were landing
and home — moving them to cobalt is intentional and matches the
"all full-bleed pages share one palette" goal.

### Gotcha: service-worker `cacheFirst` masks CSS changes

*All pages ✅ — bump `CACHE_VERSION` whenever `main.css` or any
hoisted-global import changes.*

The service-worker (`frontend/service-worker.js`) uses `cacheFirst`
for static assets and **discards the revalidate fetch** (despite
its "stale-while-revalidate" comment). Without a `CACHE_VERSION`
bump, the new `main.css` sits behind a stale cached copy in the
user's browser indefinitely. The user can't see CSS edits even
after a hard refresh until the SW is updated.

Bump `CACHE_VERSION` (`v418` → `v419` etc.) and the install handler
calls `skipWaiting()` + activate handler deletes the old caches.
Two reloads to actually take effect (first reload installs+activates
new SW; second reload uses it). Skip the dance with
Cmd/Ctrl+Shift+R (hard reload bypasses SW for that fetch).

---

## Cleaning-tool modal wiring — 2026-05-19

The 17 tool modals in `partials/cleaner/modals/tool-*.html` were
visually complete but functionally inert — every commit button just
called `closeModal('tool-X')`, form inputs used `data-sp-*` attrs the
live reader doesn't read, and column pickers showed hardcoded French
sample names instead of the file's actual columns. The backend
dispatcher (`cleanerApplyTool` + `_readToolPayload`) was
production-ready; only the markup-to-handler wiring was missing.

This wiring sweep landed the full end-to-end path: panel button →
`cleanerOpenTool` populates the modal from `STATE.columns` and opens
it anchored to the tools panel → user fills the form → commit button
fires `cleanerApplyTool` → `_readToolPayload` collects values via
`[data-tool-*]` selectors → POST `/files/:rid/steps` → backend replays
the step → response flows through `_afterHistory`-equivalent
re-render (`_renderTitle` / `_renderHeaderMeta` / `_renderOverallCleanness`
/ `_renderHistoryButtons` / `_renderAppliedList` / `_renderDtypeList`
/ `_renderTabs` / `_loadPage`) → toast.

### Pattern: tool-modal three-layer disconnect

*Cleaner ✅ — apply the same recipe to any new tool added later.*

When a sandbox-ported modal "doesn't work," check these three layers
in order. Any one of them breaks the whole flow silently:

| Layer | Symptom of break | Where it lives |
|---|---|---|
| **Modal open** | Panel button does nothing, or modal opens with hardcoded sample columns | `partials/cleaner/tools-panel.html` button `onclick` must call `cleanerOpenTool('tool-X', this)` (NOT `openModal`). cleanerOpenTool gates on `STATE.summary`, calls `_populateToolModal`, then `openModal`, then `_positionToolModal`. |
| **Form contract** | Modal opens with real columns but commit button validation toast says "Pick a column" / "Cannot be empty" / etc. | Modal `<input>` / `<select>` / mount points must use `data-tool-*` attributes matching what `_readToolPayload(toolId)` reads. `data-sp-*` from the sandbox demo is NOT read. Generic mount points: `[data-tool-cols]` (single-col select, auto-painted), `[data-tool-checklist]` (multi-col list, auto-painted), `[data-tool-find]` / `-replace` / `-value` / `-new-name` / `-sep` / `-into` (text inputs), `[data-tool-case-mode]` / `-fill-mode` / `-date-fmt` / `-date-incomplete` / `-invalid-scope` / `-invalid-mode` / `-dedup-mode` (selects). |
| **Commit dispatch** | Commit button is wired but does nothing in console — no toast, no XHR. | Button must call `cleanerApplyTool('tool-X')` and that handler must be installed on the **sandbox** path. Same trap as `cleanerOpenTool` earlier — handlers defined inside `_wireGlobals` (legacy) never reach the sandbox mount. Re-install in `_installSandboxLiveHandlers`. |

### Gotcha: tool handlers were legacy-only

*Cleaner ✅ — already fixed for cleanerOpenTool / cleanerApplyTool /
cleanerToolInvalidScope/Mode/SelectAll/AddExtra / cleanerDedupModeChanged.
Re-check any new tool-related handler you add.*

The legacy `_wireGlobals(root)` installer (lines ~1234-3140 in
`cleaner.js`) is full of `window.cleanerX = …` definitions that the
sandbox path never reaches because `mountSandbox` skips _wireGlobals
entirely. Every time a tool-modal button references a
`cleaner*` handler in inline `onclick`, double-check it's also installed
inside `_installSandboxLiveHandlers`. The Migrated handler audit
section above is the source of truth for what's on each path; tool-
related handlers (cleanerOpenTool, cleanerApplyTool, cleanerCastColumn,
cleanerSkipCast, cleanerRevertSkipCast, cleanerDedupModeChanged,
cleanerToolInvalidScope/Mode/SelectAll/AddExtra) are explicitly
mirrored on the sandbox path.

The bodies are byte-identical copies — closures over `root` work
because `_installSandboxLiveHandlers` takes the same `root` parameter
as `_wireGlobals`. Top-level helpers the handlers call
(`_populateToolModal` / `_readToolPayload` / `_positionToolModal` /
`_renderTitle` / `_loadPage` / etc.) are module-scoped functions, so
they're always accessible regardless of which installer ran.

### Pattern: unified tool-modal positioning

*Cleaner ✅ ([cleaner.js `_positionToolModal`](../../frontend/scripts/pages/cleaner.js)) — apply to any panel-anchored modal family.*

Tool modals open in a single fixed slot (left edge of the tools panel,
top-aligned to the panel) regardless of which button in the panel
grid the user clicked. Implementation:

- `cleanerOpenTool` calls `_positionToolModal(toolId, btn)`.
- `_positionToolModal` finds the modal overlay via dual lookup
  (`rp-modal-${toolId}` || `modal-${toolId}`) and the inner panel
  (`.rp-modal` || `.modal`).
- Adds `.is-popover` to the overlay — drops the dim backdrop, aligns
  to top-left of the parent body (library's
  `.rp-modal-overlay.is-popover` in `modals-sandbox.css`).
- Reads `.rp-rtp-tools.getBoundingClientRect()` (the tools panel, not
  the button) so every tool lands in the SAME slot regardless of
  which button was clicked. Falls back to button rect if the panel
  isn't found.
- Anchors to LEFT of the panel edge with a 12px gap. Clamps to
  viewport.
- All tool modals also share a unified `width: min(30rem, 92vw)` via
  CSS scoped to `#page-cleaner .rp-modal-overlay.is-popover .rp-modal`
  in `cleaner.css`. Per-modal `rp-modal-{sm,md,lg}` sizing classes are
  overridden so the slot doesn't "breathe" between tools.

The "no anchor button" branch (e.g. the inspect-suggestion chain
where one tool modal opens another with no anchor) clears the
`.is-popover` class so the modal recenters and the dim backdrop comes
back — that flow is a deliberate "navigation" affordance, not a
spatial-context one.

### Gotcha: legacy `_render*` family targets dead DOM ids

*Cleaner ✅ — applies to ANY post-mutation refresh you add on the sandbox path.*

This is THE systemic source of "I have to refresh the page before
the component updates" symptoms. The legacy render family
(`_renderTitle` / `_renderHeaderMeta` / `_renderHistoryButtons` /
`_renderTabs` / `_renderOverallCleanness` / `_renderAppliedList` /
`_renderDtypeList` / `_loadPage`) all target legacy DOM ids
(`#cleaner-undo`, `#cleaner-redo`, `#cleaner-title`, etc.) that **do
not exist** in sandbox markup. They each `if (!el) return;` early-bail
silently when they don't find their target. The state mutation
SUCCEEDS (STATE.steps gets the new entry, etc.) but no DOM update
happens — so on next mount the UI looks fresh, but in the same
session, components like the undo button stay disabled.

The sandbox has a purpose-built `_afterHistory(envelope, label)`
closure inside `_installSandboxLiveHandlers` ([cleaner.js:5317](../../frontend/scripts/pages/cleaner.js)) that does the right
thing:

```js
const _afterHistory = async (envelope, label) => {
  if (!envelope) return;
  STATE.summary = envelope.summary;
  STATE.columns = envelope.columns ?? [];
  STATE.steps   = envelope.steps   ?? [];
  // mirror the active file's STATE.files slot…
  _renderSandboxHeader(root, proj, activeFile, STATE.files || []);
  _renderSandboxFileTabs(root, STATE.files || [], activeFile);
  await _paintSandboxTable(root, activeFile);
  _syncUndoRedoButtons();                  // ← THIS is what enables undo/redo
  if (label && window.toast?.success) window.toast.success(label);
};
```

**Rule:** every POST-then-refresh path on the sandbox should pipe
the FileEnvelope through `_afterHistory(env, label)`, NOT through
the legacy render calls. That includes:

- `cleanerApplyTool` (every tool's Apply path)
- `cleanerUndo` / `cleanerRedo` (already correct)
- `applyUnwrapCsv` (banner-fix flow — still uses legacy renders,
  needs migration if it's ever invoked from sandbox)
- Any cast / encoding / sentinel-learn flow that POSTs a step
  and expects the chrome to refresh

If you're tempted to call `_renderHistoryButtons(root)` on a sandbox
path: don't. It targets `#cleaner-undo` / `#cleaner-redo` (legacy
ids). Use `_syncUndoRedoButtons()` or `_afterHistory(env)` instead.

### Gotcha: dual modal-id lookup needed everywhere

*Cleaner ✅ ([cleaner.js `_populateToolModal`, `_positionToolModal`, `_readToolPayload`, `_refreshDedupPreview`, `cleanerToolInvalidSelectAll`, the consent gate in `cleanerApplyTool`](../../frontend/scripts/pages/cleaner.js)) — re-grep after every modal port.*

Sandbox modals use `id="rp-modal-${toolId}"` (rp- prefix). Legacy
modals use `id="modal-${toolId}"`. Any function that looks up a
modal by id needs to try BOTH:

```js
const m = document.getElementById(`rp-modal-${toolId}`)
       ?? document.getElementById(`modal-${toolId}`);
```

Same dual-lookup pattern as `window.openModal` itself in main.js.
Without this, the sandbox markup is silently invisible to the function,
which then either no-ops (silent) or fails an `if (!m) return null`
guard. Symptom is usually "modal renders fine but the action does
nothing."

The handler that caught this latest: `_readToolPayload` was looking up
`modal-${toolId}` and returning `null` for every sandbox tool modal,
so every commit button silently failed. The fix is one line per
lookup; the affected functions are listed above.

---

## Re-running the handler audit

Drop this into a file and run with `python3` against the current
`cleaner.js` to refresh the counts in the audit table above.

```python
import re
from collections import Counter, defaultdict

src = open('frontend/scripts/pages/cleaner.js').read()
lines = src.split('\n')

fn_stack, brace_depth, contexts = [], 0, []
for i, line in enumerate(lines, 1):
    code = re.sub(r'//.*$', '', line)
    code = re.sub(r'"[^"]*"|\'[^\']*\'|`[^`]*`', '', code)
    m = re.search(r'\b(?:async\s+)?function\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(', code)
    if m: fn_stack.append((m.group(1), i, brace_depth))
    h = re.match(r'\s*window\.(cleaner[A-Z][A-Za-z]*)\s*=', line)
    if h: contexts.append((i, h.group(1), fn_stack[-1][0] if fn_stack else 'TOP'))
    brace_depth += code.count('{') - code.count('}')
    while fn_stack and brace_depth <= fn_stack[-1][2]:
        fn_stack.pop()

print('window.cleaner* by enclosing function:')
for ctx, n in Counter(c for _,_,c in contexts).most_common():
    print(f'  {ctx}: {n}')
seen = defaultdict(list)
for ln, nm, ctx in contexts: seen[nm].append((ctx, ln))
dups = {n: v for n, v in seen.items() if len(v) > 1}
print(f'\nDuplicated handlers: {len(dups)}')
for n in sorted(dups):
    print('  ' + n + ' -> ' + ', '.join(f'{c}:L{l}' for c,l in dups[n]))
```
