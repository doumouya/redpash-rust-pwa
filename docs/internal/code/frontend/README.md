# RedPash frontend — start here

The frontend is a **no-framework, hash-routed SPA** in vanilla ES modules. One
Rust binary serves both the API and the static UI; the data engine runs natively
on the server *and* as wasm in the browser. There is no bundler at dev time — the
browser loads ES modules directly; the release build (`tools/build-fe.mjs`) only
content-hashes and rewrites import URLs.

This is the entry doc for working on the frontend. Read it, then the rest of the
spine as needed:

| Doc | When you need it |
|---|---|
| **README.md** (this) | The shell, routing, the page contract, the three registries, the layering model |
| [`conventions.md`](conventions.md) | Before writing any code: the ui-fork-audit (R1–R9), the CI gates, CSS + tokens, how to add a component |
| [`components.md`](components.md) | The toolbox: the composable grid family, the full component reference, chrome (rail/topbar/omni), responsive |
| [`data-cleaner.md`](data-cleaner.md) | The `workspace` page: orchestrator, catalogs, modes, the report flow, current build state + gotchas |
| [`../backend/README.md`](../backend/README.md) | The API routes the frontend speaks + the data engine (steps / group_by / filter / wasm) — entry to the backend docs (split into `README` / `api-routes` / `data-engine` / `connectors`) |

> Conventions of record live in the `vanilla-web` skill (WSL `~/.claude/skills/vanilla-web/`: `SKILL.md` + `references/redpash.md`). The skill's own rule: **the live source wins over any snapshot** — verify against the actual files, including this doc.

---

## The one-binary, one-`/me` model

`backend/crates/api` serves the API under `/api` and the static `frontend/` tree
as a `ServeDir` fallback (dev root `../frontend`, `no-store`; release serves the
hashed `frontend-dist/`). A **single `GET /api/me`** boots the whole client — it
carries the user, the admin flag, and the resolved settings cascade.

### Entry point — `frontend/index.html`

The only HTML document. It:

- sets `<html data-theme="new-dark">` and runs an inline **FOUC pre-paint** script that reads `localStorage["rp-pref-<key>"]` for `theme`/`density`/`fontsize` and applies them to `document.documentElement.dataset` *before* any CSS loads;
- links `/vendor/bootstrap-icons/bootstrap-icons.css` (self-hosted — icons are `<i class="bi bi-…">`) and `/styles/main.css`;
- provides the mount root `<main id="app" aria-busy="true">` and loads the entry module `<script type="module" src="/framework/boot/main.js">`.

### Boot — `framework/boot/main.js`

```js
installErrorCapture();
registerServiceWorker();
// boot():
const me = await api.get("/me");                       // ONE round-trip
session = { ...me.user, is_platform_admin: me.is_platform_admin };
seedResolved(me.settings, { userRid: me.user.redpash_id });   // seed behavior registry
// re-apply server-corrected theme/density/fontsize
configureRouter({ session, getSession: () => session });
startRouter();
for (const p of allPages().filter((p) => p.built))     // preload built page modules
  import(`/apps/${p.app.id}/${p.id}/${p.id}.js`).catch(() => {});
```

- On `/me` failure → `session = null` → the router bounces to `#/login`.
- `getSession` is a **live getter**, so a later session change is visible to the router and every page.
- Built page modules are eagerly imported (not mounted) so their module-load side effects (registering prefs/policies) populate the registries regardless of nav order; the later lazy `import()` returns the cached module.

---

## The apps registry — `framework/boot/apps.js`

One `APPS` array is the single source the router, the topbar nav, and the launcher
all read. An **app** is an RBAC boundary + a focused nav; a **page** maps by
convention to `/apps/<app>/<page>/<page>.{html,js}`.

| app | flags | landing | built pages (id → label) |
|---|---|---|---|
| `auth` | `hidden` | — | `login` → "Sign in" (`auth:false`) |
| `studio` | `icon:bi-easel` | `#/workspace` | `workspace` → **"Data Cleaner"** (`bi-magic`) |
| `admin` | `admin:true` | `#/org` | `org` → "Organization" (`bi-diagram-3`), `console` → "Console" (`bi-sliders2`), `registry` → "Data Registry" (`bi-database`), `cases` → "Cases" (`bi-kanban`) |
| `settings` | `hidden` | — | `settings` → "Settings" |

> The Data Cleaner's route/file id is **`workspace`** (`#/workspace`, files at `apps/studio/workspace/`); its visible label is "Data Cleaner". The id is historical — renaming it is a mechanical sweep, deliberately not done.

Helpers: `allPages()` flattens every page with its owning `app` attached;
`pageById(id)`; `appsFor(session)` (the launcher view — drops `hidden`, drops
`admin` unless `is_platform_admin`, drops apps with policy `app.<id>.enabled ===
false`, requires ≥1 `built` page); `landingFor(session)` (**there is no Home
page** — first visible app's landing, else first built page, else `#/settings`).

A page is hidden three ways: the `hidden` app flag, the `built` flag (unbuilt
pages never produce a route — no stubs), and admin-gating + the
`app.<id>.enabled` policy kill-switch. `registries.test.js` exercises all four.

---

## Routing & the page contract — `framework/boot/router.js`

Hash router: `#/<page-id>` → match `allPages()` by id → fetch the partial +
import the module.

`mount()` flow:
1. `session = ctx.getSession()`, `page = targetPage()`.
2. **UX redirect guards** (the backend remains the real boundary): unknown route → `landingFor`; needs-auth & no session → `#/login`; admin app & not admin → `landingFor`; on `login` while authed → `landingFor`.
3. `aria-busy=true`; call the previous page's `destroy?.()` (a throwing destroy is swallowed so it can't block nav).
4. unbuilt page → plain "not built yet" text.
5. else, in parallel: `fetch("<base>.html")` + `import("<base>.js")`, then `app.innerHTML = html` and `const handle = await mod.default(app.firstElementChild ?? app, ctx)`, storing `handle.destroy`.

### The page module contract

```js
// /apps/<app>/<page>/<page>.js
export default async function mount(root, ctx) {
  // root: the partial's root element (app.firstElementChild)
  // ctx:  { session, getSession }   — ctx.getSession() returns the live session
  const page = assemblePage(root, { /* spec */ });
  // …mount data components into page.section(key)…
  return { destroy: () => { /* tear down what you mounted */ } };
}
```

The partial is a **one-line root**, e.g. `workspace.html`:

```html
<div class="pg-studio-workspace" data-pg="root"></div>
```

So a page is **spec + handlers** — almost no literal markup. It calls
`assemblePage` for the shell and mounts data components into the returned section
hosts. It returns `{ destroy }`; the router calls it before the next mount (real
teardown). The 2,700-line page modules of the predecessor are structurally
impossible here.

### `assemblePage(host, spec)` — `framework/page-assembly/page-assembly.js`

Builds a whole railed page from a pure spec — topbar → (rail?) → surface — and
hands back the section hosts.

```
spec = {
  session, activePageId,
  rail?: { active?, onRailTab?, overview?, search? } | false,  // false opts out (pre-auth)
  title, meta?, actions?,            // surface head
  sections: [{ key, title?, layout? }],
}
→ { el, topbar, rail, surface, section(key), destroy() }
```

The rail mounts on **every authed page** (`session && rail !== false`), its
content fetched from `GET /api/rail/<activePageId>`; the page passes only
overrides. `section(key)` returns the `.rp-surface-section-body` host to mount
into; `surface.update({title, meta})` drives the header later (e.g. a row count
learned after data loads).

Canonical minimal page (`org.js`):

```js
export default async function mount(root, ctx) {
  let objList = null;
  const page = assemblePage(root, {
    session: ctx.getSession(), activePageId: "org", title: "Organization",
    rail: { active: "user", onRailTab: (tab) => { /* re-render */ } },
    sections: [{ key: "main" }],
  });
  objList = mountObjectList(page.section("main"), { type: "user" });
  return { destroy: () => { objList?.destroy(); page.destroy(); } };
}
```

---

## The three registries — "X is data"

The architectural bet, stated verbatim atop `pref-registry.js`: *"UI is data
(component-registry), objects are data (type-registry); this makes BEHAVIOR
data."* Each registry is a lookup table some surface renders itself from, so
adding a component / object-type / setting is a **registration**, not a page edit.
A fourth structure (the apps registry above) applies the same idea to navigation.

| Registry | File | "X is data" | Source of values |
|---|---|---|---|
| **UI** | `registry/component-registry.js` | components self-register `mount` fns; the sandbox renders all of them (the completeness proof) | code (self-registration at module load) |
| **Objects** | `registry/type-registry.js` | object shapes (fields, perms, order) come from the server | `GET /api/types`, cached |
| **Behavior** | `registry/pref-registry.js` | every pref/policy is a registration; Settings + Console render from them | settings cascade from `/api/me`; defs from the `preference` type |
| **Apps/pages** | `boot/apps.js` | routes/nav/launcher read one `APPS` array | static array + `app.<id>.enabled` policy |

**UI** — `register(name, mount, meta = {})` (warns "one owner only" on a dup),
`getComponent(name)`, `listComponents()`. Every framework component calls
`register("<name>", mount<Name>)` at the bottom of its module. The
`framework-sandbox.html` renders every registered component from fixtures and
asserts the count — see [`conventions.md`](conventions.md).

**Objects** — `getTypes()` caches one in-flight `GET /api/types` promise (a
failed fetch nulls the cache so it retries); `invalidate()` clears it (the Admin
Console calls it after a field-perm write — re-derive, never patch locally);
`typeById(id)`. Wire shape: `{ types: [{ type_id, display_name, rid_prefix,
grid_served, fields: [{ key, label, data_type, perm_class, field_group, scope,
ordinal, cells: {owner,admin,member,viewer} }] }] }`.

**Behavior** ("the third framework") — definitions in code (now: the fields of
the builtin `preference` type), *values* in the backend `settings` table,
resolved server-side (platform → role → user) and seeded at boot. The cascade
(`getPref`): `resolved[key]` → localStorage mirror (`rp-pref-*`) → registered
`default` → `undefined`. `setPref(key,value)` is **optimistic**: write + mirror +
`applyDocumentPref` + notify, then fire-and-forget `PUT
/api/settings/user/<rid>/<key>`. `setPolicy(scopeType, scopeId, key, value)` for
admin scopes. `prefDefs(scope)` maps the `preference` type's fields → the
settings-form shape (Settings renders `prefDefs("user")`, the Console renders
`prefDefs("platform")`).

---

## The layering model — `rp-` owns the framework, `pg-` owns pages

The single rule that keeps the app from forking the way its predecessor did
(137 same-class CSS divergences). Enforced by the ui-fork-audit (full rules in
[`conventions.md`](conventions.md)):

- **Components** live at `framework/<name>/<name>.{js,css}`. The `.css` is the **sole owner** of its `.rp-<name>-*` classes. A component owns ALL its markup; config is data + callbacks (never DOM/HTML passed in). It self-registers and exposes `mount<Name>(host, cfg) → { el?, update, destroy }`.
- **Pages** live at `apps/<app>/<page>/<page>.{html,js,css}`, get framework markup ONLY via `mount*()`, and root every CSS selector at `.pg-<app>-<page>`. Page CSS may **read** `--rp-*` vars but never sets framework classes or styles `.rp-*`.
- **A new look is a framework commit, never a page override.** Need a variant? Add a knob/option to the component.

### Shared primitives — `framework/boot/`

- **`dom.js`** — `el(tag, attrs = {}, ...children)`: `class` sets `className`; an `on<Event>` function key adds a listener; `null`/`undefined` attrs are skipped; children flatten + text-wrap. `esc(v)` HTML-escapes. Build DOM with `el()` + `textContent`, never untrusted `innerHTML`.
- **`api.js`** — the one fetch wrapper. All paths prefixed `/api`; JSON in/out; `FormData` sent as-is; **401 → `location.hash = "#/login"`**; non-ok throws an `Error` with `.status`/`.body`. Methods: `api.get/post/put/patch/del/upload`.
