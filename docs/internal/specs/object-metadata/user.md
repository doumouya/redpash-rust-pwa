---
title: User — object metadata
section: Internal
order: 42
last modified date: 2026-05-28
owner: Torv
status: draft — per the object-metadata sweep ([index](index.md))
---

# User (USR_)

A RedPash account holder. Created either via Google OAuth on first
sign-in (`upsert_google_user`) or via the dev-permissive admin
endpoint (`POST /api/users`). One user owns many projects, may belong
to many companies via `company_memberships`, and authenticates via the
`sessions` table.

**Backing table:** `users` (migration `20260512000001_init.sql`
+ follow-ups `20260520000001_auth.sql` (added `google_sub`)
+ `20260531000001_user_names.sql` (added `first_name` / `last_name`)
+ `20260606000001_user_preferences.sql` (split prefs into a sibling
  table)
+ `20260607000001_drop_users_prefs.sql` (dropped the `users.prefs`
  JSONB column — prefs now live in `user_preferences`, see
  [user-preference](user-preference.md))).
**DTO:** `backend/crates/shared/src/user.rs`.
**Routes:** `backend/crates/api/src/routes/users.rs` (admin CRUD),
`backend/crates/api/src/routes/me.rs` (self profile + prefs),
`backend/crates/api/src/routes/auth.rs` (Google OAuth start +
callback), `backend/crates/api/src/routes/admin.rs` (paginated list
with sort/filter for the Home Users tab).

---

## Supported calls

| Verb | Wire | Notes |
|---|---|---|
| `create` | `POST /api/users` | Dev-permissive; server assigns `USR_<32hex>`. Body: `{ username, display_name, email? }`. Returns the full `UserProfile`. Conflicts on duplicate `username` → 409 `username_taken`. |
| `create (OAuth)` | `GET /api/auth/google/callback?code=...` | Implicit create-or-find by Google `sub`. Server-generated username (`<email-local>.<rid-suffix>`); no client body. |
| `read (self)` | `GET /api/me` | Session-scoped: returns the caller's `UserProfile` (no client-provided rid). 401 when no session and OAuth is configured; falls back to `state.dev_user` when OAuth is unconfigured. |
| `read (other)` | `GET /api/users/:rid` | Dev-permissive; returns the full `UserProfile`. |
| `update (self)` | `PATCH /api/me` | Sparse update — only declared fields write. `prefs` field is deprecated here; routes through `/api/me/prefs` with a deprecation log. |
| `update (other)` | `PATCH /api/users/:rid` | Dev-permissive sparse update; same field set as `/api/me` minus the prefs path. Conflicts on duplicate `username` → 409 `username_taken`. |
| `delete` | `DELETE /api/users/:rid` | Hard delete. Cascades sessions / company_memberships / project_memberships; owned projects CASCADE → their files CASCADE → blobs are NOT cleaned up (TODO). |
| `list (admin)` | `GET /api/admin/users?page=&size=&sort=&dir=&q=` | Paginated `Page<UserSummary>` for the Home Users tab. LEFT JOIN LATERAL on `company_memberships` adds `org_id` / `org_name` / `org_role` to each row (primary affiliation: owner > admin > member, ties broken by most-recent `joined_at`). |
| `list (dev)` | `GET /api/users` | Unpaginated `Vec<UserProfile>` — Objects-page owner-reassignment picker. No sort param, no filter, no search. Hardcoded `ORDER BY display_name ASC`. |
| `search` | `GET /api/admin/users?q=...` | ILIKE substring on `username` + `display_name` + `email` + `organisation`. Single `$1` reused four times — Postgres caches the compiled pattern. Only on the admin list endpoint, not on `/api/users`. |

---

## Fields

```
redpash_id
  Type:        TEXT / String — format USR_<32 uppercase hex>
  Properties:  Layout
  Description: Primary key. Server-assigned via id::new("USR") on
               POST /api/users or on Google-OAuth first sign-in.
               Never settable by clients.
```

```
username
  Type:        TEXT NOT NULL UNIQUE / String
  Properties:  Create, Update, Sort, Search, Layout
  Description: Handle. Server-derived on Google OAuth
               (`<email-local>.<rid-suffix>`) to avoid collisions.
               Client-settable on dev-create + dev-patch. UNIQUE
               constraint surfaces as 409 `username_taken`.
```

```
email
  Type:        TEXT / Option<String>
  Properties:  Create, Update, Nillable, Sort, Search, Layout
  Description: Email address. Optional on dev-create (Google OAuth
               always supplies it). Hidden by default in the Home
               Users tab (`defaultHidden: true`).
```

```
display_name
  Type:        TEXT NOT NULL / String
  Properties:  Create, Update, Sort, Search, Layout
  Description: Friendly UI label — drives avatar initials, kanban
               cards, rail chips. Backfilled from the OAuth claim
               `name` on first sign-in.
```

```
first_name
  Type:        TEXT / Option<String>
  Properties:  Update, Nillable
  Description: Structured given name (added mig 017). Optional;
               pre-2026-05-22 rows backfilled from the first token
               of `display_name`. NOT exposed on POST /api/users
               (created-via-OAuth or seeded later via PATCH).
```

```
last_name
  Type:        TEXT / Option<String>
  Properties:  Update, Nillable
  Description: Structured family name. Same backfill story as
               first_name; same Create absence.
```

```
avatar_url
  Type:        TEXT / Option<String>
  Properties:  Update, Nillable, Layout
  Description: URL to an avatar image. Server populates it on
               Google OAuth from the `picture` claim. Hidden by
               default in the Home Users tab.
```

```
job_title
  Type:        TEXT / Option<String>
  Properties:  Update, Nillable, Sort, Layout
  Description: Free-text role label. Inline-editable in the Home
               Users tab (only clean-text column; the row template
               flags it `editable: true`).
```

```
organisation
  Type:        TEXT / Option<String>
  Properties:  Update, Nillable, Sort, Search, Layout
  Description: Free-text affiliation. DISTINCT from the typed
               `company_memberships` relationship — this is a
               profile bio field the user types; `org_name` (a
               hydrated read-only field below) is the canonical
               company affiliation joined from the membership row.
               Hidden by default; surfaced as the column label
               "Profile org" to disambiguate from "Org".
```

```
use_case
  Type:        TEXT / Option<String>
  Properties:  Update, Nillable
  Description: Free-text intent ("data cleaning", "ETL", "BI"…)
               captured at onboarding. Not surfaced on the Home
               Users tab today.
```

```
plan
  Type:        TEXT NOT NULL DEFAULT 'free' / String
  Properties:  Update, Sort, Layout
  Description: Billing-plan label. NOT a Create-property — every
               new user lands on 'free'. No DB-side CHECK
               constraint today (informal enum, see "Enum
               constraints" for the conventional values).
```

```
locale
  Type:        TEXT NOT NULL DEFAULT 'en' / String
  Properties:  Update
  Description: BCP-47 locale tag for the user's preferred language.
               Consumed by the i18n loader on session restore.
               No client-settable on Create; defaults to 'en'.
```

```
google_sub
  Type:        TEXT / Option<String>
  Properties:  Nillable
  Description: Google OAuth `sub` (subject) claim — the stable
               per-account identifier. Server-only field;
               never on the `UserProfile` DTO. Partial UNIQUE
               index `users_google_sub_idx WHERE google_sub IS
               NOT NULL` (bootstrap users with NULL sub coexist
               with OAuth-created rows).
```

```
prefs
  Type:        JSONB / serde_json::Value
  Properties:  (none directly — see User-Preference object)
  Description: Carried on the `UserProfile` DTO as a JSON blob
               folded in at SELECT time via a correlated subquery
               over `user_preferences` (one row per key). The
               original `users.prefs` JSONB column was dropped
               in mig 024; writes go via PATCH /api/me/prefs.
               See [user-preference](user-preference.md) for the
               key registry + write semantics.
```

```
created_at
  Type:        TIMESTAMPTZ NOT NULL DEFAULT now() / chrono::DateTime<Utc>
  Properties:  Sort, Layout
  Description: Auto-set on INSERT. Default sort key on the admin
               list endpoint. Surfaced as the "Joined" column on
               the Home Users tab.
```

```
updated_at
  Type:        TIMESTAMPTZ NOT NULL DEFAULT now() / chrono::DateTime<Utc>
  Properties:  (none — internal)
  Description: Auto-bumped on every UPDATE by the route handler
               (no DB trigger). Never client-settable; not
               surfaced on the Home Users tab.
```

### Hydrated read-only fields

These appear on the admin-list `UserSummary` shape (in the JSON
response) but aren't columns on `users` — they come from the LEFT
JOIN LATERAL on `company_memberships` in `routes/admin.rs::list_users`
(only one row per user, primary affiliation: owner > admin > member,
ties broken by most-recent joined_at). NOT present on the bare
`UserProfile` returned by `/api/me` or `/api/users` — that DTO
carries the full `memberships: Vec<UserMembership>` array instead
(see Relationships below).

```
org_id
  Type:        TEXT / Option<String>
  Properties:  Nillable
  Description: company_memberships.company_id of the user's primary
               affiliation. NULL when the user belongs to no company.
```

```
org_name
  Type:        TEXT / Option<String>
  Properties:  Nillable, Sort, Layout
  Description: companies.name JOINed from the membership. Drives
               the "Org" chip on the Home Users tab. Sort uses the
               JOINed column with NULLS LAST (members without an
               affiliation sort to the tail regardless of dir).
```

```
org_role
  Type:        TEXT / Option<String>
  Properties:  Nillable, Sort, Layout
  Description: company_memberships.role of the primary affiliation
               ('owner' / 'admin' / 'member'). Drives the role
               chip on the Home Users tab.
```

---

## Enum constraints

`plan` has **no DB-side CHECK** today — the column is `TEXT NOT NULL
DEFAULT 'free'` and the application accepts any string. Conventional
values surfaced in the UI:

`plan ∈ { free, pro, team, enterprise }` — informal. Drives the plan
chip in the Home Users tab (`planChip()` renderer in home.js); chip
styling falls through to a neutral pill for any unknown value.

`org_role` (hydrated from `company_memberships.role`) carries the
canonical role set: `{ owner, admin, member }`. The CHECK lives on
the `company_memberships` table — see [membership](membership.md).

No CHECK on `username`, `email`, or `locale` (free-text). Email
format validation is intentionally NOT done server-side today; the
OAuth provider validates on its end, and dev-create users bypass.

---

## Relationships

```
projects.owner_id → User (USR_)
  Cardinality:  N:1 (a User owns many Projects)
  On delete:    CASCADE (deleting a user drops their owned projects
                + cascades to files + steps via the project FK chain)
  Hydrated as:  — (not joined back onto User; surfaced on Project's
                owner_display_name + owner_username instead)
```

```
sessions.user_redpash_id → User (USR_)
  Cardinality:  N:1 (a User has many Sessions, one per device/cookie)
  On delete:    CASCADE
  Hydrated as:  — (sessions are server-internal; not exposed on
                User's wire shape)
```

### Inverse relationships

```
User has many CompanyMembership rows
  Backing:       company_memberships (composite PK on
                 (company_id, user_redpash_id))
  Cardinality:   1:N
  On delete:     CASCADE (deleting a user removes their memberships)
  Surfaced as:   memberships: Vec<UserMembership> on UserProfile
                 (only the `/api/users` list endpoint joins them in;
                 single-row fetchers like /api/me + GET /api/users/:rid
                 emit the field with `#[serde(default)]` = empty Vec)
                 See [membership](membership.md).
```

```
User has many UserPreference rows
  Backing:       user_preferences (composite PK on
                 (user_redpash_id, key))
  Cardinality:   1:N
  On delete:     CASCADE
  Surfaced as:   prefs: serde_json::Value on UserProfile, folded in
                 at SELECT time. See [user-preference](user-preference.md).
```

```
Case.reporter_id → User and Case.assignee_id → User
  See [case](case.md) — N:1 each, SET NULL on user delete (cases
  outlive the user for audit).
```

```
Project.owner_id → User
  See [project](project.md) — N:1, CASCADE on user delete.
```

```
File-typed project_files rows reachable via owned projects
  No direct FK to users; ownership flows User → Project → File.
```

---

## Audit events

| `kind` | Emitted on | Context shape |
|---|---|---|
| `user_create` | `POST /api/users` | `{ user, username }` |
| `user_create` | `GET /api/auth/google/callback` first-sign-in branch | `{ user, username, source: "oauth" }` |
| `user_update` | `PATCH /api/users/:rid` | `{ user, fields: [<names>] }` — bundled list of fields that changed |
| `me_update` | `PATCH /api/me` | `{ fields: [<names>] }` — same bundled shape, caller is implicit |
| `user_delete` | `DELETE /api/users/:rid` | `{ user }` (level=warn) |
| `auth_login` | `GET /api/auth/google/callback` (returning user) | `{ user, source: "oauth" }` |
| `auth_logout` | `POST /api/auth/logout` | `{ user }` |
| `unauthenticated` | any 401 path | `{}` |
| `forbidden` | any 403 path | `{ user }` (caller resolved) |
| `oauth_disabled` | auth start when env vars unset | `{}` |
| `dev_login_disabled` | `POST /api/auth/dev-login` when gate off | `{}` |

Pref-mutation events (`pref_update` etc.) live on the
User-Preference object — see [user-preference](user-preference.md)
for that lane. Membership-mutation events live on Membership.
