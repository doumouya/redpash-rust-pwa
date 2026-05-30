---
title: Company — object metadata
section: Internal
order: 43
last modified date: 2026-05-30
owner: Torv
status: draft — per the object-metadata sweep ([index](index.md))
---

# Company (CMP_)

The multi-tenancy boundary. A user belongs to zero or more companies
via the unified `memberships` table (rows whose `object_redpash_id`
points at a company entity); projects are either company-scoped
(`projects.company_id` set) or personal (`company_id = NULL`).
Company memberships hold one of three roles (`owner` / `admin` /
`member`) — enforced at the company route layer — with a last-owner
guard so a company always has at least one owner.

**Backing table:** `companies` (migration `20260521000001_companies.sql`).
**DTO:** `backend/crates/shared/src/company.rs`
(`Company` + `CompanySummary` + `CompanyMember`).
**Routes:** `backend/crates/api/src/routes/companies.rs` (CRUD +
member sub-routes), `backend/crates/api/src/routes/admin.rs`
(paginated list for the Home Companies tab).

The unified `memberships` table is documented separately on
[membership](membership.md) — composite-key join (PK
`(object_redpash_id, user_redpash_id)`), no `redpash_id`, never
URL-addressable.

---

## Supported calls

| Verb | Wire | Notes |
|---|---|---|
| `create` | `POST /api/companies` | Server assigns `CMP_<32hex>`. Body: `{ name, slug? }`. Slug auto-derived from name if omitted; always suffixed with 6 hex chars from the RID so it's unique by construction (no collision retry). Creator is seeded as `owner` in the same TX via `create_company`. |
| `read` | `GET /api/companies/:rid` | Returns the base `Company` shape. Membership-gated: `require_member` rejects non-members with 404 (existence not leaked). |
| `update` | `PATCH /api/companies/:rid` | Sparse — `name` / `slug` / `avatar_url`. Dev-permissive (no membership / role gate). Slug PATCH passes through `slugify` server-side. Duplicate slug → 409 `slug_taken`. |
| `delete` | `DELETE /api/companies/:rid` | Dev-permissive. Cascades the company's `memberships` rows (via the entities registry); `projects.company_id` is `SET NULL` so company-scoped projects survive as personal. |
| `list (self)` | `GET /api/companies` | Returns `CompanyList { items: Vec<CompanySummary> }` — every company in the system; non-member rows surface with `my_role: null`. Hardcoded ordering, no filter / page params today. |
| `list (admin)` | `GET /api/admin/companies?page=&size=&sort=&dir=&q=` | Paginated `Page<CompanySummary>` for the Home Companies tab. `member_count` + `my_role` both resolved via correlated subqueries against `memberships` (keyed on `object_redpash_id = c.redpash_id`) — `my_role` joins the caller's own membership `role` per company (the caller is resolved from the session; NULL when they're not a member). |
| `search` | `GET /api/admin/companies?q=...` | ILIKE substring on `name` + `slug`. Single `$1` reused. |
| `list members` | `GET /api/companies/:rid/members` | Returns `Vec<CompanyMember>` — the membership rows joined with the user's profile (display_name / username / avatar_url) so the members list renders without a second lookup. |
| `add member` | `POST /api/companies/:rid/members` | Body: `{ user_id, role }`. Owner-only for granting `role: 'owner'`. Existing membership UPSERTs to the new role. Emits `company_member_add`. |
| `change role` | `PATCH /api/companies/:rid/members/:user_id` | Body: `{ role }`. Owner-only for promoting to `owner`. Last-owner demotion blocked. Emits `company_member_role_change`. |
| `remove member` | `DELETE /api/companies/:rid/members/:user_id` | Self-leave or admin-remove. Last-owner removal blocked. Emits `company_member_leave` (self) or `company_member_remove` (other-actor). |

---

## Fields

```
redpash_id
  Type:        TEXT / String — format CMP_<32 uppercase hex>
  Properties:  Layout
  Description: Primary key. Server-assigned via id::new("CMP").
               Never settable by clients. Hidden by default in the
               Home Companies tab (defaultHidden: true).
```

```
name
  Type:        TEXT NOT NULL / String
  Properties:  Create, Update, Sort, Search, Layout
  Description: Display name. Required on Create. Free-text, no
               length cap. Renders inline with the slug pill in
               the Home Companies tab.
```

```
slug
  Type:        TEXT NOT NULL UNIQUE / String
  Properties:  Update, Sort, Search, Layout
  Description: URL-safe handle. Server-derived on Create from
               name (or from an explicit `slug` field), always
               suffixed with a 6-char hex tail from the RID so
               it's unique by construction. UNIQUE constraint
               surfaces as 409 `slug_taken` on PATCH conflicts.
               Not a Create-property — clients can hint via the
               optional `slug` field but the server reserves
               final authority. Hidden by default in the Home
               Companies tab.
```

```
avatar_url
  Type:        TEXT / Option<String>
  Properties:  Update, Nillable, Layout
  Description: URL to a company logo / avatar image. Hidden by
               default in the Home Companies tab.
```

```
created_at
  Type:        TIMESTAMPTZ NOT NULL DEFAULT now() / chrono::DateTime<Utc>
  Properties:  Sort, Layout
  Description: Auto-set on INSERT. Default sort key on the admin
               list endpoint. Surfaced as the "Created" column.
```

```
updated_at
  Type:        TIMESTAMPTZ NOT NULL DEFAULT now() / chrono::DateTime<Utc>
  Properties:  Sort, Layout
  Description: Auto-bumped on every UPDATE by the route handler
               (no DB trigger). Hidden by default in the Home
               Companies tab.
```

### Hydrated read-only fields

These appear on `CompanySummary` (list responses) but aren't columns
on `companies` — they're computed at SELECT time.

```
member_count
  Type:        INT / u32
  Properties:  Sort, Layout
  Description: `SELECT COUNT(*) FROM memberships WHERE
               object_redpash_id = c.redpash_id`. Subquery alias —
               Postgres allows referring to SELECT aliases in
               ORDER BY, so SORTABLE_COMPANIES["member_count"]
               resolves cleanly. Drives the "Members" column.
```

```
my_role
  Type:        TEXT / Option<String>
  Properties:  Nillable, Layout
  Description: The caller's role in this company ('owner' /
               'admin' / 'member'), or null when they're not a
               member. Caller-relative — joined on BOTH
               GET /api/companies (the self-list endpoint) AND
               GET /api/admin/companies (the Home Companies tab's
               endpoint), each via a correlated subquery keyed on
               the session-resolved caller rid. NOT sortable
               (per-caller value, not a stable DB column for an
               ORDER BY). "My role" column on the Home Companies
               tab is explicitly `sortable: false`.
```

---

## Enum constraints

`role` (on the unified `memberships` join table, not on `companies`
itself):

The table's `role` CHECK is the 4-value set `owner / admin / member /
viewer` (default `member`). For company scope the 3-value set
`{ owner, admin, member }` is enforced at the company route layer
(`viewer` isn't offered for companies), not by the column CHECK. Role
hierarchy: `owner > admin > member`.

- **Owner-only operations:** grant `owner` role to another member,
  delete the company (when RBAC tightens — dev-permissive today).
- **Owner + admin:** PATCH company metadata, add / remove members,
  change member roles (excluding promote-to-owner).
- **Member:** read-only.

Last-owner guard (enforced in route handlers + `db::company_owner_count`):
- Cannot demote the last `owner`.
- Cannot remove the last `owner` (self-leave or admin-remove).

`name`, `slug` have no CHECK constraints (free-text). `slug` is
slugified server-side via the route's `slugify()` helper before
write.

---

## Relationships

```
projects.company_id → Company (CMP_)
  Cardinality:  N:1 (a Company has many Projects)
  On delete:    SET NULL (company-scoped projects survive as
                personal projects rather than cascading away)
  Hydrated as:  — (project's company affiliation surfaced as
                company_id only; no company_name hydration today)
```

### Inverse relationships

```
Company has many Membership rows
  Backing:       memberships (the ONE polymorphic table; composite
                 PK on (object_redpash_id, user_redpash_id), FK
                 object_redpash_id → entities.id — no company_id
                 column)
  Cardinality:   1:N
  On delete:     CASCADE (deleting a company removes its
                 memberships; the users themselves stay)
  Surfaced as:   GET /api/companies/:rid/members → Vec<CompanyMember>
                 with user profile fields joined. See
                 [membership](membership.md).
```

```
Company has many company-scoped Projects
  Cardinality:   1:N
  On delete:     SET NULL on Project.company_id
  Surfaced as:   — (no /api/companies/:rid/projects endpoint today;
                 the relationship is inverse-only from the schema
                 standpoint)
```

```
Case.company_id → Company
  See [case](case.md) — N:1, SET NULL on company delete.
```

---

## Audit events

| `kind` | Emitted on | Context shape |
|---|---|---|
| `company_create` | `POST /api/companies` | `{ company, slug }` |
| `company_update` | `PATCH /api/companies/:rid` | `{ company, fields: [<names>] }` — bundled list |
| `company_delete` | `DELETE /api/companies/:rid` | `{ company }` (level=warn) |
| `company_member_add` | `POST /api/companies/:rid/members` (new row) | `{ company, user, role }` |
| `company_member_role_change` | `PATCH /api/companies/:rid/members/:user_id` (role change) | `{ company, user, role, prev_role }` |
| `company_member_leave` | `DELETE /api/companies/:rid/members/:user_id` (self-actor) | `{ company, user }` |
| `company_member_remove` | `DELETE /api/companies/:rid/members/:user_id` (other-actor) | `{ company, user, removed_by }` |

The split between `company_member_leave` (self) and
`company_member_remove` (other-actor) is deliberate — the activity
feed renders them differently ("Jane left" vs "Jane removed Bob")
and a future RBAC layer needs to distinguish self-initiated from
admin-initiated departures.
