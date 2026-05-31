---
title: Dashboard — permission catalog
section: Internal
order: 63
last modified date: 2026-05-31
owner: Torv
status: enforced 2026-05-31 — object-level gate live: view=require_view (+is_public widen); update/delete=require_grant(effective>=Admin) (owner via project scope); set_favorite stays owner-only (personal pin); is_public publish coarsened to the object gate. The per-field atoms below are the v3 custom-role target. RBAC catalog sweep ([index](index.md))
---

# Dashboard (FIL_ kind=dashboard) — permissions

Permission keys + default grant matrix for the Dashboard object — a
**derived-view** object: a `project_files` row with
`file_type='dashboard'`, `spec = {template_id, widgets[]}`. Derived from
[dashboard metadata](../object-metadata/dashboard.md); see the
[catalog template](index.md) for the key scheme + role tiers.

**View reaches Dashboard supports:** `project_redpash_id` → the
File-style scope chain (`own` · `project` · `company` · `all`). Same
table as csv File + Chart; it **inherits File's view reaches** but
carries its own atoms because the wire differs per kind (widget-spec
PUT, sparse meta PATCH). It is a `FIL_` kind row.

> Per [index](index.md#view-grants-via-membership): `view.all` is the
> only row-breadth atom a role carries directly. The middle reaches
> (`project` / `company`) are **membership-granted** on the row's
> `project_redpash_id` / company, never direct role atoms; `own` = the
> caller holds a membership on the dashboard row itself.

One extra wrinkle: Dashboard has an `is_public` field — a per-row
visibility flag that *widens view beyond the reach chain*. A public
dashboard is viewable by anyone authenticated regardless of project
membership, and `is_public=true` drives the project's **published**
status (see Notes).

---

## 1. Atoms

View-rooted (per [index](index.md#key-scheme)): `view` is the root,
writes derive from it. `read`/`list`/`search` are all `dashboard.view`
— the reach decides *which* dashboards the list returns.

### View atoms

| Atom | Covers | Reach | Notes |
|---|---|---|---|
| `dashboard.view` | the dashboard (detail / list / search) | own · project · company · all (+ public) | the reach chain OR `is_public=true` (any authenticated caller); `own` = the caller holds a membership on the dashboard row |
| `dashboard.view.all` | every dashboard | all | platform admin |
| `dashboard.view.field.<name>` | one field | inherits the row reach | **allow-list**, one per readable field: `title` · `description` · `spec` · `is_favorite` · `is_public` · `folder`. Standard bundles hold `view.field.all`; *subsetting fields is a custom-role (v3) feature* |
| `dashboard.view.field.all` | every field | own · project · company · all | the "see the whole record" atom; **required to delete** |

### Write atoms (derive from a view atom)

| Atom | Derives from | Reach | Notes |
|---|---|---|---|
| `dashboard.create` | object `dashboard.view` | — (no row yet) | body `{ project_id, title, spec }` |
| `dashboard.title.update` | `dashboard.view.field.title` | own · project · company · all | |
| `dashboard.description.update` | `…field.description` | own · project · company · all | |
| `dashboard.spec.update` | `…field.spec` | own · project · company · all | template + widgets — the dashboard builder's output (widget-spec PUT) |
| `dashboard.is_favorite.update` | `…field.is_favorite` | own | per-user pin — a personal flag; only the owner toggles their own |
| `dashboard.is_public.update` | `…field.is_public` | own · company · all (**owner-tier**) | **publish** — widens view to all + drives the project's published status; owner / company-admin / platform-admin only — see Notes |
| `dashboard.folder.update` | `…field.folder` | own · project · company · all | organising bucket |
| `dashboard.delete` | `dashboard.view.field.all` | own · company · all | not project-viewers — see Notes |

**No atoms for:** `redpash_id`, `file_type` (fixed `dashboard`),
`project_redpash_id` (no v1 move), computed fields, timestamps —
auto / server-assigned.

---

## 2. Grant matrix

Default role-bundle → atom mapping. Cell = the **reach** the bundle
grants (or `—`). Columns: platform `admin`; the company membership
bundles `co:owner`/`co:admin`/`co:member`/`co:viewer`; and `dash-mem` —
a membership on the row's project, which resolves at `project` (or
`own` for owner-only writes). Wider reach wins on union; `dash-mem`
resolves on `member_redpash_id`. Mirrors [file.md](file.md) /
[chart.md](chart.md).

| Atom | plat:admin | co:owner | co:admin | co:member | co:viewer | dash-mem |
|---|---|---|---|---|---|---|
| `dashboard.view` | all | company | company | company | company | project |
| `dashboard.view.field.all` | all | company | company | company | company | project |
| `dashboard.create` | ✓ | ✓ | ✓ | ✓ | — | ✓ |
| `dashboard.title.update` | all | company | company | — | — | project |
| `dashboard.description.update` | all | company | company | — | — | project |
| `dashboard.spec.update` | all | company | company | — | — | project |
| `dashboard.is_favorite.update` | all | — | — | — | — | own |
| `dashboard.is_public.update` | all | company | — | — | — | own |
| `dashboard.folder.update` | all | company | company | — | — | project |
| `dashboard.delete` | all | company | — | — | — | own |

Mirrors [File](file.md) / [Chart](chart.md), plus the two per-row
flags: `is_favorite` is strictly the owner's personal pin (`own` only);
`is_public` (publish-to-all) is owner / company-owner / platform-admin
— a deliberate sharing act, narrower than a content edit. **Delete**
needs `view.field.all` + the delete atom: owner / company-owner /
platform-admin, never a `co:admin`/`co:member` content editor.

---

## 3. Notes

- **`is_public` widens view past the reach chain and drives publish.** A
  dashboard with `is_public=true` is viewable by any authenticated user,
  member or not — `dashboard.view` resolves true via the public flag
  even without a reach grant. This flag also drives the project's
  **published** status. It is the one place a per-row flag overrides
  membership scoping; enforcement checks `is_public OR reach-grant`.

- **Publishing is the gated act, not viewing the published.** Anyone
  can *view* a public dashboard; only owner / company-owner /
  platform-admin can *flip* `is_public` (`dashboard.is_public.update`).
  Company admins can edit content but not publish (publishing is a
  visibility/sharing decision reserved for the owner tier).

- **`is_favorite` is personal.** It's the caller's own pin on the
  dashboard — `own` only, never granted to admins (favoriting someone
  else's view for them is meaningless).

- **Widgets reference Charts/Reports.** A dashboard's `spec.widgets[]`
  chart-refs resolve through [Chart](chart.md)'s view atoms at render
  time — seeing a dashboard doesn't auto-grant its widget sources; a
  widget the caller can't view renders an error tile (per the designer
  load path), not a leak.

- **Same File reaches, dashboard atoms.** Like Chart, the view reaches
  are File's; only the atoms (widget-spec PUT, sparse-meta PATCH) differ
  — the doc carries its own atoms because the wire contract differs per
  kind.
</content>
</invoke>
