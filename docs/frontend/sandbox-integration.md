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
| Defined in `_installSandboxLiveHandlers` only | 12 | New / renamed during sandbox migration |
| Defined in BOTH `_wireGlobals` and `_installSandboxLiveHandlers` | 12 | **Migrated.** Same name in both; sandbox wins for cleaner page mounts. Legacy version stays for revertability |
| Defined in `_wireGlobals` only | 43 | **Still to migrate** (literally — though several have functionally-equivalent sandbox handlers under a different name; see "Functional renames" below) |

Not counted here (not a `window.cleaner*` assignment): the **cell-edit
dispatcher** in `_installSandboxLiveHandlers` (once-guarded
document-level `focusin`/`focusout` pair) — supersedes legacy
`cleanerCellEdit`.

### Sandbox-only (12)

| Sandbox handler | New / renamed from | Notes |
|---|---|---|
| `cleanerOpenSavedSettings` | renamed from `cleanerShowSaved` | Saved-settings rp-modal painter |
| `cleanerOpenHistory` | **new** | History rp-modal painter |
| `cleanerRefresh` | **new** | Toolbar refresh — repaint via `_paintSandboxTable` |
| `cleanerToggleSync` | renamed from `cleanerToggleLink` | Persists `STATE.linkToolbar` |
| `cleanerOpenReportForFile` | renamed from `cleanerNewReportFromFile` | `window.open(#/reports?new=1&source=…)` |
| `cleanerOpenDashboardForProject` | renamed from `cleanerNewDashboardFromFile` | `window.open(#/dashboards?new=1&project=…)` |
| `cleanerScoreFile` | renamed from `cleanerScoreThisFile` | POST `/files/:rid/cleanness` → `_afterHistory` |
| `cleanerClearScore` | renamed from `cleanerClearThisFile` | DELETE `/files/:rid/cleanness` → `_afterHistory` |
| `cleanerSelectAllRows` | renamed from `cleanerSelectAll` | Master checkbox handler |
| `cleanerMaybeBulkDelete` | renamed from `cleanerBulkDelete` | No-op if empty selection; POST `drop_rows` otherwise |
| `cleanerRowClick` | renamed from `cleanerRowSelect` (broader scope — now a mode-aware row dispatcher, not just checkbox toggle) | Single `<tr>` dispatcher: select-mode toggles, delete-mode POSTs `drop_rows` for that row, edit/no-mode no-op. Checkbox has no onclick (native toggle bubbles up, handler re-syncs `cb.checked`). |
| `cleanerSetPageSize` | **new** (≠ legacy `cleanerSetPage`, which is page-nav) | `STATE.pageSize` + `_paintSandboxTable` refetch |

### Migrated (12 — same name in both)

| Handler | Notes |
|---|---|
| `cleanerActivateTab` | Click a file tab. Paints header from cached `STATE.files` for snappy feel, then `_paintSandboxTable` corrects from `detail.summary`. |
| `cleanerAddFile` | Opens new-project modal pre-filled with current project name. |
| `cleanerCloseProject` | × on project tab. Refuses to close the only remaining tab. Calls `_reprojPicker()`. |
| `cleanerExport` | GET `/:rid/export` → blob → `<a download>`. |
| `cleanerHideFileTab` | × on file tab. Adds to `STATE.hiddenFiles`, persists, calls `_refilePicker()`. |
| `cleanerOpenProject` | Picker → push onto `STATE.openProjects` + switch. |
| `cleanerRedo` | POST `/redo`, pipe envelope through `_afterHistory`. |
| `cleanerShowFileTab` | Re-show a hidden file tab. |
| `cleanerSwitchProject` | Active-project flip with snapshot save/restore. |
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
| `cleanerClearThisFile` | `cleanerClearScore` |
| `cleanerSelectAll` | `cleanerSelectAllRows` |
| `cleanerBulkDelete` | `cleanerMaybeBulkDelete` |
| `cleanerRowSelect` | `cleanerRowClick` (broadened to mode-aware row dispatcher; per-row delete on click in delete mode now lands via the same handler) |

### Legacy-only with no sandbox counterpart — by area (still genuinely pending)

- **Tools panel** (10): `cleanerOpenTool`, `cleanerCastColumn`,
  `cleanerSkipCast`, `cleanerRevertSkipCast`, `cleanerApplyTool`,
  `cleanerToggleToolSect`, `cleanerToolInvalidScope`,
  `cleanerToolInvalidMode`, `cleanerToolInvalidSelectAll`,
  `cleanerToolInvalidAddExtra`
- **Filters** (8): `cleanerAddFilterRow`, `cleanerClearFilterDraft`,
  `cleanerSaveFilter`, `cleanerLoadSavedFilter`, `cleanerDeleteSavedFilter`,
  `cleanerCreateJoin`, `cleanerSetCombo`, `cleanerApplyFilter`
- **Dedup** (1): `cleanerDedupModeChanged`
- **Rows / selection** (2): `cleanerClearSelection` (mostly covered by
  the master-checkbox unchecked path), `cleanerRowDelete` (legacy
  function name; functionally covered by the delete-mode branch of
  the new `cleanerRowClick` dispatcher, which POSTs `drop_rows` for
  a single global index — no need to migrate `_applyDropRows` /
  `_absoluteIndex` since `cleanerMaybeBulkDelete` already handles
  the POST and `_paintSandboxTable` emits global indices directly)
- **Columns** (8): `cleanerColDragStart`, `cleanerColDragOver`,
  `cleanerColDragLeave`, `cleanerColDragEnd`, `cleanerColDrop`,
  `cleanerSortBy`, `cleanerBuildColsDropdown`, `cleanerToggleCol`
- **Cell** (1): `cleanerCellEdit` — **superseded** by the cell-edit
  dispatcher in `_installSandboxLiveHandlers`. Safe to drop with
  the rest of `_wireGlobals`.
- **Page / toolbar** (2): `cleanerSetPage` (pagination button click —
  not the same as rows-per-page; `cleanerSetPageSize` covers the
  latter), `cleanerToggleAddMenu`
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
