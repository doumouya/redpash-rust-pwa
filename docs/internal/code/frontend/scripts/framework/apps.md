---
title: frontend/scripts/framework/apps.js
source: ../../../../../../frontend/scripts/framework/apps.js
owner: Torv
section: Internal · Code · Frontend · scripts · framework
last modified date: 2026-06-07
---

# framework/apps.js — App registry (multi-app model)

## Purpose

The **app registry** — the single source of truth for RedPash's multi-app model
(Informatica's "My Services"). RedPash is a set of apps switched from a launcher;
an app is both an **RBAC boundary** and a focused topbar (its nav shows only its
own pages). This module holds the data; [topbar.js](../topbar.md) +
[app-switcher.js](app-switcher.md) render it. Adding an app, or moving a page
between apps, is a **one-place edit** here.

The Slice A registry maps each app to **today's** pages (no page-splits yet):

| App | `id` | RBAC | Pages |
|---|---|---|---|
| Home | `home` | — | (none — the "My Services" grid IS the page) |
| Studio | `studio` | — | Workspace · SheetWise |
| Admin | `admin` | `admin:true` → `is_platform_admin` | Monitoring |
| Support & Docs | `support` | — | Docs · Cases |

Later slices add new pages in place (a one-line edit to the relevant `pages`
array): Admin gets `admin-console` + `database` (**Slice B**), Studio gets
`dashboard` (**Slice D**).

## Public surface

- `APPS` — the ordered `App[]` (launcher order). An `App` is
  `{ id, name, icon, landing, admin?, pages:AppPage[] }`; an `AppPage` is
  `{ id, hash, icon, label }`.
- `appForPage(pageId)` → the `App` that owns a page id (the `active` value a page
  passes to `mountTopbar`). Utility pages (profile / settings) belong to no app →
  falls back to the **Home** app, so their topbar is just the launcher. Consumed
  by [topbar.js](../topbar.md) to render the per-app nav.
- `appsFor(session)` → the apps a session may enter; admin apps require
  `session.is_platform_admin`. Consumed by [app-switcher.js](app-switcher.md) so
  the Admin tile only shows for platform admins.

## How it works

- **App = RBAC boundary.** The `admin:true` flag is the only gate today; both the
  page-nav (`appForPage` → only its pages render) and the launcher
  (`appsFor` filters) read the same flag, so the boundary is declared once.
- **Pure data, no DOM.** ESM module exporting the array + two pure selectors; the
  rendering lives entirely in the two consumers.

## Drift-prone areas

- **Add/move a page here, not in a page's mountTopbar.** The topbar
  self-determines its app from `active` via `appForPage`, so a page never names
  its app — moving SheetWise from Studio to another app is a one-line edit to the
  `pages` arrays.
- **RBAC gate is the `admin` flag only** (→ `is_platform_admin`). A new RBAC
  dimension (e.g. per-app roles) extends `appsFor`, not each consumer.

## Related

- [topbar.js](../topbar.md) — renders the active app's per-page nav (`appForPage`).
- [app-switcher.js](app-switcher.md) — the launcher menu (`appsFor`).
- [framework index](index.md) · [component-registry](component-registry.md).
