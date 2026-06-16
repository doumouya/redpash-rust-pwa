# Components, chrome & the responsive system

Every component lives at `framework/<name>/<name>.{js,css}`, imports `el` from
`../boot/dom.js`, exports `mount<Name>(host, cfg)` (builds its own DOM,
`host.append(...)`s it, returns a handle), and ends with
`register("<name>", mount…)`. Each is the **sole owner** of its `.rp-<name>-*`
classes. The common handle floor is `{ el, update(partial), destroy() }`;
deviations are noted.

---

## The composable grid family (the DC2 primitives)

```
workspace-panels  (responsive 3-region frame: left · center · right)
 ├─ left  region ──► side-panel   (tabbed, collapsible, lazy-mount tabs)
 ├─ center region ─► grid-view    ─► [ grid-toolbar? ][ sheet? ][ redtable ]
 └─ right region ──► side-panel
```

### redtable — THE data table
`mountRedTable(host, cfg)`. One implementation; the predecessor's fork-A/B duality
is banned. **Two orthogonal axes:**

| Axis | Values | Meaning |
|---|---|---|
| `mode` | `auto` \| `virtual` \| `pager` | **LAYOUT** — how many rows render (`auto` → virtual past **200** rows, else pager; `pageSize` default 50) |
| `interaction` | `browse` \| `select` \| `edit` \| `delete` | **BEHAVIOR** — what a click does (state class `is-select`/`is-edit`/`is-delete`) |

```js
mountRedTable(host, {
  columns: [{ key, label, dtype?, editor? }], // DATA keys only — never display indices
  rows: [...],                                 // array of objects
  rowKey: (row) => string,                     // REQUIRED — throws if missing
  mode?, pageSize?, interaction?,              // interaction default "browse"
  onRowClick?(row,key), onSelectChange?(keys[]), onRowDelete?(rowKey),
  onCellCommit?(rowKey,colKey,value),
  selectable?: bool,                           // legacy alias for interaction:"select"
  empty?: { title, line, action? },
})
→ { el, update({rows?,columns?}), selection(), clearSelection(), setInteraction(m), destroy }
```

Selection lives in a closure `Set` keyed by `rowKey` (never DOM), so it survives
virtual recycling + repaints. `update({rows})` resets to page 1 and prunes
orphaned selection keys. **One delegated `click` on `tbody`** routes by current
interaction; a `thead` listener drives the tri-state select-all over the *whole*
row set. CSS knob: `--rp-redtable-max-h` (default `60vh`); the table is a flex
column (`.rp-redtable-scroll{flex:1}`) so it fills a sized flex parent.

- **editor-registry** (`redtable/editor-registry.js`) — `register(dtype, factory)` (last-writer-wins) + `editorFor(col)` resolves `col.editor` → `col.dtype` → `"text"` (every column editable). A factory `(td, {value, onCommit}) → {commit, cancel, el}` swaps the cell for `.rp-input.rp-redtable-editor`, commits on blur/Enter, reverts on Esc. Built-ins: `text`, `int`, `float` (numeric `parse` cancels the commit on non-numeric input).
- **virtual-rows** (`redtable/virtual-rows.js`) — internal windowing util (not a registered component): `WINDOW=40 + OVERSCAN=10` rows + two spacer `<tr>`, repaints on scroll via rAF. Its `style.height` writes are the sanctioned R9 measured-geometry allowlist.

### grid-toolbar — data-driven control strip
`mountGridToolbar(host, { controls, onAction(id, ctx), state })`. A **spec of
controls**; holds no behavior of its own (toggle-group exclusion etc. are the
consumer's job).

| `kind` | spec fields | behavior |
|---|---|---|
| `search` | `id, placeholder?, onInput(q)` | reports `onAction(id, {value:q})` |
| `button` | `id, icon, label?, title, variant?, when?(state)` | `when=false` ⇒ hidden + disabled |
| `toggle` | `id, icon, title, group?, active?(state)` | `aria-pressed`; `active` re-eval'd on update |
| `menu` | `id, icon, label?, title, items:[{id,label,icon}]` | item reports `onAction(it.id, {menu: spec.id})` |
| `chip` | `id, label(state), visible?(state)` | status chip (e.g. "3 selected") |
| `sep` | — | divider |

`update({state?, controls?})` — `controls` ⇒ full re-render, else re-eval the
`when`/`active`/`visible`/`label` predicates against the new `state`. One delegated
`click` matched by `[data-gtb]`. Handle also: `setActive(id,on)`, `setDisabled(id,off)`.

### grid-view — the thin composer
`mountGridView(host, { toolbar?: {controls,onAction,state}, table: {…redtable cfg…}, sheet?: Node })`.
Stacks `[toolbar?][sheet?][redtable]`; omit `toolbar` and it's just the redtable
(the Report-preview case). Handle: `{ el, table, toolbar, setSheet(node), update({rows?,columns?,state?}), destroy }`
— `update` fans out (rows/columns → `table.update`, state → `toolbar.update`). The
`.rp-gridview-table` slot is `flex:1; min-height:0` so the redtable fills it.

### side-panel — tabbed, collapsible inline panel
`mountSidePanel(host, { side:"left"|"right", tabs:[{id,label,icon, mount(bodyHost)→{update?,destroy?}}], active?, collapsed?, onTab?, onToggle? })`.
**Lazily mounts a tab's content on first show** and caches the handle (switching
back is instant; never re-mounts). Handle: `{ el, body(id), setActive(id),
setOpen(bool), toggle(), tab(id)→handle|null, destroy }`. **Not responsive
itself** — workspace-panels owns the drawer. Width is driven by the parent region.

### workspace-panels — responsive 3-region frame
`mountWorkspacePanels(host)` — **takes no config**. Returns
`{ el, left, center, right, togglePanel(side), setPanelOpen(side,bool), isOpen(side), destroy }`.
The consumer mounts a side-panel into left+right and a grid-view into center.

- **≥ 80rem (`--rp-bp-lg`):** a CSS grid `var(--rp-wsp-left-w,18rem) minmax(0,1fr) var(--rp-wsp-right-w,18rem)` — panels are inline columns.
- **< 80rem:** single center column; left/right become **fixed off-canvas drawers** (`min(20rem,85vw)`) over a **shared scrim**; opening one closes the other; scrim-click closes. Event-driven via `matchMedia` (classList-only, no width polling); crossing back to wide drops drawer state.

Knobs: `--rp-wsp-left-w`, `--rp-wsp-right-w` (default `18rem`).

---

## Framework component reference (everything else)

| Component | Purpose | Mount signature → handle | Notes |
|---|---|---|---|
| **atoms** | leaf builders (return raw nodes, **no handle**) | `button(cfg)` · `chip(cfg)` · `input(cfg)` · `badge(cfg)` · `spinner()` · `kbd(label)` | `register("atoms", null, {builders:[…]})` |
| **menu** | dropdown, one document-level delegated listener | `mountMenu(host, {trigger, items})` → `{el,update,destroy}` | `items=[{label,icon?,onSelect,selected?}\|{sep:true}\|{label,heading:true}]` |
| **field** | labeled form row around any control | `mountField(host, {label,help?,control,inline?,bare?})` → `{el,update({error}),destroy}` | |
| **select** | single-choice over native `<select>` | `mountSelect(host, {options:[{value,label}],value,onChange})` → `{el,update,destroy}` | a11y/keyboard/mobile free |
| **modal** | create + confirm-destructive only | `openModal({title,body,actions})` → `{el,close}`; `confirmModal({…})` → `Promise<bool>` | action `onClick` gets `{close}` |
| **card** | content tile (`<a>`/`<button>`/`<div>`) | `mountCard(host, {title,sub?,href?,onClick?,body?})` → `{el,update(){},destroy}` | no-op update |
| **chip-row** | single-select tab strip over `atoms.chip` | `mountChipRow(host, {items:[{value,label}],value,onChange})` → `{el,update,destroy}` | |
| **empty-state** | title + line + ONE action | `mountEmptyState(host, {title,line,action?})` → `{el,update(){},destroy}` | the empty state IS onboarding |
| **toast** | transient feedback (optimistic-UI partner) | `toast({message,tone?,action?,ttl?})` → `{el,destroy}` | **no `update`**; ttl 6000ms w/action else 3000ms |
| **settings-form** | renders pref/policy **registrations** | `mountSettingsForm(host, {defs,get(key),set(key,value)})` → `{el,update,destroy}` | one renderer for Settings + Console |
| **surface** | content frame (title/meta/actions + named sections) | `mountSurface(host, {title,meta?,actions?,sections:[{key,title?,layout?}]})` → `{el,section(key),update({title?,meta?}),destroy}` | meta span always present |
| **stat** | KPI tile + strip | `mountStat(host, {label,value,tone?,sub?})`; `mountStatStrip(host, {stats:[…]})` → `{el,handles,…}` | |
| **score-badge** | the cleanness score + breakdown popover | `mountScoreBadge(host, {score, report?})` → `{el,update,destroy}` | report = {completeness,type_consistency,value_hygiene,row_uniqueness,structural} |
| **uploader** | drop zone + file picker | `mountUploader(host, {label?,hint?,accept?,onFile(file)})` → `{el,busy(bool),update(){},destroy}` | accept defaults `.csv,.tsv,.txt` |
| **steps-panel** | cleaning history + undo/redo | `mountStepsPanel(host, {steps:[{kind,params,applied}],canUndo,canRedo,onUndo,onRedo})` → `{el,update,destroy}` | undone steps render `.is-undone` |
| **perm-cell** | cycling permission cell (`"" → "r" → "rw"`) | `mountPermCell(host, {value,onChange(next)})` → `{el,update,destroy}` | optimistic; page owns persistence |
| **filter-panel** | builder UI for the shared FilterNode tree | `mountFilterPanel(host, {columns,value?,onApply(node),onClear()})` → `{el,update({columns,value}),destroy}` | value cell adapts to the op |
| **filter-node** | PURE FilterNode ⇄ rows logic (no DOM) | exports `PRED_OPS`, `VALUELESS_OPS`, `RANGE_OPS`, `LIST_OPS`, `blankRow`, `rowComplete`, `rowToPred`, `assembleFilter`, `decomposeFilter`, `predToRow` | unit-tested independently |
| **joins-wizard** | multi-file join flow (calls `detect()` on mount) | `mountJoinsWizard(host, {detect():Promise, onExecute(body):Promise, onCancel()})` → `{el,update,destroy}` | body = `{other_file,left_keys,right_keys,join_type,materialize_as?}` |
| **object-list** | generic object-table page body | `mountObjectList(host, {type, onActiveChange?})` → `{el,update({type}),current(),destroy}` | columns/cells from the type registry, rows from `/api/objects/<type>` |
| **omni** | the topbar omnisearch pill | `mountOmni(host, {placeholder?})` → `{el,focus,destroy}` | **no `update`**; over `GET /api/search` |
| **topbar** | toggle · omnisearch · per-app nav + launcher | `mountTopbar(host, {session,activePageId,onToggleRail?})` → `{el,update(){},destroy}` | nav derives from the apps registry |
| **rail** | the page's left nav (data-driven) | `mountRail(host, config)` → `{el,setGroups(groups,hidden,emptyText),setActive(id),toggleCollapse(want?),destroy}` | bespoke handle — **no `update`** |
| **report-builder** | group-by + measures form | `mountReportBuilder(host, {columns,aggFns,onRun,onClear})` → `{el,update({columns}),destroy}` | emits `{groupBy:[key], measures:[{col,fn}]}` |

### The atoms (leaf building blocks)
`atoms.js` exports **plain builder functions returning a DOM node** (no
mount/handle). Higher-level components compose them rather than re-declaring `rp-`
markup (R8).
- **`button({label?, icon?, variant?:'accent'|'ghost'|'danger', size?:'sm', onClick, disabled, type, title?, ariaLabel?})`** — icon + no label → square icon-only button (`.rp-btn--icon`); always give it a `title`/`ariaLabel`.
- **`chip({label, active, onClick})`** — the selection primitive behind `chip-row`.
- **`input({placeholder, value, type, onInput, onEnter})`** — `onInput(value)` on input, `onEnter(value)` on Enter.
- **`badge({label, tone?})`**, **`spinner()`**, **`kbd(label)`**.

---

## Chrome — assembled by `assemblePage`

```
.rp-shell             flex column, height:100%
 ├─ rp-topbar         fixed-height band (--rp-topbar-h)
 └─ rp-shell-body     flex row, flex:1
     ├─ rp-rail       left nav (--rp-rail-w) — or off-canvas drawer when narrow
     └─ rp-surface    content frame (flex:1)
```

The topbar and rail share `--rp-bg` with no border between them (one continuous
dark frame); the lighter surface floats inside. *(There is no `pager` component —
pagination lives inside redtable.)*

### Topbar — `mountTopbar(host, {session, activePageId, onToggleRail?})`
A 3-column grid `1fr auto 1fr`:
- **Lead:** the **sidebar toggle** (`bi-layout-sidebar`) — only when `onToggleRail` is supplied (its click runs `rail.toggleCollapse()`).
- **Center:** **omnisearch** (`mountOmni`, only when `session`).
- **Right:** the active app's built pages as **icon links** (`a.rp-topbar-nav-icon`, `is-active` on current) + the **app launcher** (`mountMenu`) listing other visible apps.

"Pure navigation" — the brand wordmark is gone; theme/settings/sign-out/profile
live in the **rail footer**, not here. Nav derives entirely from `apps.js`.

### Rail — server-driven, two layers
- **Controller `mountAppRail(host, spec, session)`** (`rail/rail-data.js`) — fetches `GET /api/rail/<spec.view>` (reach-filtered groups→tabs tree), caches per-view in an SWR `Map` (`invalidateRail(view)` clears after create/rename/delete), and layers the **local** state the server doesn't carry: per-user hide set + restore drawer, the client filter, deterministic group marks, collapse-persist. Inline rename on `renamable`/`hidable` nodes → `PATCH /projects/<id>` / `PATCH /files/<id>` (optimistic, then invalidate). The page passes only `spec = { view, overview?, onRailTab?, active?, search? }`. The **universal footer** (avatar + Settings + Theme toggle + Sign out) is identical on every page.
- **Component `mountRail(host, config)`** (`rail/rail.js`) — emits all `.rp-rail-*` DOM, sole owner of those classes, ONE delegated click routed by `data-rail-action`. Search box does inline type-ahead with ↑↓ cycling.

**Two independent narrowings:** (1) `.compact` — the desktop icon-only rail (driven
by the topbar toggle, **persisted** as `rail.collapsed`); (2) the `@media` overlay
**drawer** below `--rp-bp-md` (64rem) — the *same* toggle instead drives an
off-canvas drawer + scrim (transient, not persisted). `toggleCollapse(want?)`
branches on `matchMedia("(max-width:64rem)")`.

### Omni — `mountOmni(host, {placeholder?})`
A centered pill over `GET /api/search?q=&limit=20` → `{ q, ms, results:[{kind, rid,
label, sub, hash}] }`. Each result carries a ready `#/…` `hash` (navigate =
`location.hash = r.hash`). Input **debounced 200ms**, each search aborts the
previous via `AbortController`. Results grouped by `kind` into sections; matched
substring highlighted with text nodes (never `innerHTML`). ↑↓/Enter/Esc keyboard;
**Ctrl/Cmd+K** focuses (bound once for the app's life). Width `clamp(16rem, 42vw,
34rem)`.

### Surface — `mountSurface(host, {title, meta?, actions?, sections:[{key,title?,layout?}]})`
Head band (title `h1` + always-present meta span + action buttons) over the
section bodies. `section(key)` returns the host a page mounts into; the meta span
is always rendered so `update({meta})` can fill it later (e.g. a row count).
`layout: "grid"|"row"` per section (never via page CSS).

---

## The responsive system

`tokens.css` is the documented source of truth. Floor target: **iPad Mini
landscape, 1024×768** (`--rp-bp-md`).

| Token | Value | px | Below the breakpoint |
|---|---|---|---|
| `--rp-bp-lg` | `80rem` | 1280 | Data Cleaner side panels overlay (off-canvas drawers) |
| `--rp-bp-md` | `64rem` | **1024** (floor) | the rail also drawers; surface tightens |
| `--rp-bp-sm` | `48rem` | 768 | portrait safety net — per-app nav icons hide |

### The 16px subtlety
Media-query `rem` resolves against the **browser default root (16px)**, so
`64rem media = 1024px`. The document sets **no** explicit `html{font-size}` — the
default root IS 16px; the only root overrides are the fontsize preference
(`html[data-fontsize="sm"]{14px}` / `["lg"]{17px}`), which scale `rem`-sized
*content* but **not** the media-query breakpoint pixels. *(If you recall a "14px
root" — that's only the `sm` preference, not the default.)*

### The shared drawer pattern (one recipe, three breakpoints)
Off-canvas region + scrim, matchMedia event-driven, classList-only (no width
polling, no inline styles):

| Component | Breakpoint | Below |
|---|---|---|
| **Rail** | `--rp-bp-md` (64rem) | sidebar → fixed off-canvas drawer + scrim |
| **Workspace panels** | `--rp-bp-lg` (80rem) | 3-region grid collapses; left/right → drawers over a shared scrim |
| **Topbar** | `--rp-bp-sm` (48rem) | per-app page-nav icons hidden (launcher + toggle + omni stay) |
