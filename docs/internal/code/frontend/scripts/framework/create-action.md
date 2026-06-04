---
title: frontend/scripts/framework/create-action.js
source: ../../../../../../frontend/scripts/framework/create-action.js
owner: Torv
section: Internal · Code · Frontend · scripts · framework
last modified date: 2026-06-04
---

# framework/create-action.js — context-aware create-action factory (S4)

## Purpose

ONE context-aware create affordance (manifest **S4**, CAS_37B2E1BF), replacing the
per-page create logic hand-copied across Home (per-tab `createSpec`), Workspace (3
static buttons), and Cases (a bespoke create-case modal). It turns a declarative
`createSpec` into the handler the **rail's create button** fires — the rail owns the
button (`mountRail` `footer.create` + its `on.create` hook, Torv-A's lane); this owns
the **action**.

## Public surface

- `createAction(spec) → () => void` — returns the `on.create` handler. Wire it:
  ```js
  mountRail(host, { footer: { create: { label: spec.label } },
                    on:     { create: createAction(spec) } });
  ```
- `spec`:
  - `{ kind: "route", href }` → `location.hash = href` (e.g. Home Files→Workspace).
  - `{ kind: "modal", title, label, icon, endpoint, fields[], onSubmit?, afterCreate? }`
    → `openModal(...)`; on submit, calls `spec.onSubmit(values, modal)` if given, else
    `api.post(endpoint, values)` (default), then `spec.afterCreate(values)`.

ESM. Imports `openModal` from [modal.js](modal.md). Not a registry component (a factory util,
like editor-registry / type-registry) — imported directly.

## How it works

- Pure dispatch on `spec.kind` (route vs modal; a bare `href` with no `fields` is treated
  as a route). For modal specs it composes the generic [modal](modal.md) and supplies a
  default POST so a page gets a working create with zero extra code — overridable via
  `spec.onSubmit` (the seam to each page's real create flow at cutover).

## Drift-prone areas

- **Render-first / cutover seam**: the default `api.post(endpoint, values)` is a sensible
  baseline; pages with bespoke create flows (Cases POST→navigate-to-detail; Home tab refetch)
  pass `spec.onSubmit` / `spec.afterCreate` when they cut over from their inline create code.
- The factory is the SINGLE place create behavior lives now — adding a create kind (e.g.
  `"wizard"`) is a one-spot edit, not a per-page copy.

## Related

- [modal](modal.md) — the dialog this opens for `kind:"modal"`.
- [rail](rail.md) — owns the create button + `on.create` hook (the integration contract).
- `frontend/framework-sandbox.html` — the Cases-detail rail's create button → `createAction` → modal.
- Manifest: `~/.claude/plans/hi-need-a-plan-golden-treasure.md` (S4) · Spec: `docs/full-component-version.md` (`rp-rail-create`).
