---
title: Dashboard — permission catalog
section: Internal
order: 63
last modified date: 2026-05-29
owner: Torv
status: draft — RBAC catalog sweep ([index](index.md))
---

# Dashboard (FIL_ kind=dashboard) — permissions

Permission keys + default grant matrix for the Dashboard object — a
`project_files` row with `file_type='dashboard'`, `spec = {template_id,
widgets[]}`. Derived from [dashboard metadata](../object-metadata/dashboard.md);
scheme in the [catalog template](index.md).

**Scope columns Dashboard carries:** `project_redpash_id` → the
File-style scope chain (`@own` / `@project` / `@company` / `@all`).
Same table as csv File + Chart; own action keys because the wire
differs (widget-spec PUT, sparse meta PATCH).

One extra wrinkle: Dashboard has an `is_public` field — a per-row
visibility flag that *widens read beyond the scope chain*. A public
dashboard is readable by anyone authenticated regardless of project
membership (see Notes).

---

## 1. Keys

| Key | Verb | Scopes | Notes |
|---|---|---|---|
| `dashboard.create` | `POST /api/dashboards` | — | Body `{ project_id, title, spec }`. |
| `dashboard.read` | `GET /api/dashboards/:rid` | own · project · company · all (+ public) | Scope chain OR `is_public=true` (anyone). |
| `dashboard.update` | `PUT` (full) + `PATCH` (sparse meta) | own · project · company · all | Widget-spec write + meta. |
| `dashboard.delete` | `DELETE /api/dashboards/:rid` | own · company · all | Not project-viewers. |
| `dashboard.list` | `GET /api/dashboards` + admin | own · project · company · all | |
| `dashboard.search` | `?q=` | own · project · company · all | |

### Field-update keys

| Key | Field | Scopes | Notes |
|---|---|---|---|
| `dashboard.title.update` | `title` | own · project · company · all | |
| `dashboard.description.update` | `description` | own · project · company · all | |
| `dashboard.spec.update` | `spec` | own · project · company · all | Template + widgets — the dashboard builder's output. |
| `dashboard.is_favorite.update` | `is_favorite` | own | Per-user pin — a personal flag; only the owner toggles their own. |
| `dashboard.is_public.update` | `is_public` | own · company · all | **Publish** — widens read to all. Owner / company-admin / platform-admin only (a sharing decision). |
| `dashboard.folder.update` | `folder` | own · project · company · all | Organising bucket. |

**No keys for:** `redpash_id`, `file_type` (fixed `dashboard`),
`project_redpash_id` (no v1 move), computed fields, timestamps.

---

## 2. Grant matrix

| Key | plat:admin | co:owner | co:admin | co:member | proj:collab | proj:viewer | @own |
|---|---|---|---|---|---|---|---|
| `dashboard.create` | all | company | company | company | project | — | — |
| `dashboard.read` | all | company | company | company | project | project | own |
| `dashboard.list` | all | company | company | company | project | project | own |
| `dashboard.search` | all | company | company | company | project | project | own |
| `dashboard.update` | all | company | company | — | project | — | own |
| `dashboard.delete` | all | company | — | — | — | — | own |
| `dashboard.title.update` | all | company | company | — | project | — | own |
| `dashboard.description.update` | all | company | company | — | project | — | own |
| `dashboard.spec.update` | all | company | company | — | project | — | own |
| `dashboard.is_favorite.update` | all | — | — | — | — | — | own |
| `dashboard.is_public.update` | all | company | — | — | — | — | own |
| `dashboard.folder.update` | all | company | company | — | project | — | own |

Mirrors [File](file.md) / [Chart](chart.md), plus the two per-row
flags: `is_favorite` is strictly the owner's personal pin (`@own`
only); `is_public` (publish-to-all) is owner / company-owner /
platform-admin — a deliberate sharing act, narrower than a content
edit.

---

## 3. Notes

- **`is_public` widens read past the scope chain.** A dashboard with
  `is_public=true` is readable by any authenticated user, member or
  not — `dashboard.read` resolves true via the public flag even
  without a scope grant. This is the one place a per-row flag overrides
  membership scoping; enforcement checks `is_public OR scope-grant`.

- **Publishing is the gated act, not viewing the published.** Anyone
  can *read* a public dashboard; only owner / company-owner /
  platform-admin can *flip* `is_public` (`dashboard.is_public.update`).
  Company admins can edit content but not publish (publishing is a
  visibility/sharing decision reserved for the owner tier).

- **`is_favorite` is personal.** It's the caller's own pin on the
  dashboard — `@own` only, never granted to admins (favoriting
  someone else's view for them is meaningless).

- **Widgets reference Charts/Reports.** A dashboard's `spec.widgets[]`
  chart-refs resolve through [Chart](chart.md)'s read keys at render
  time — seeing a dashboard doesn't auto-grant its widget sources; a
  widget the caller can't read renders an error tile (per the designer
  load path), not a leak.

- **Same File-scope, dashboard-verbs.** Like Chart, the scope chain is
  File's; only the action keys (widget-spec PUT, sparse-meta PATCH)
  differ.
