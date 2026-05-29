---
title: RBAC permission catalog — template
section: Internal
order: 50
last modified date: 2026-05-29
owner: Torv
status: design / brainstorm 2026-05-29 — reframed to a view-rooted model (membership-as-sharing, roles-as-bundles); see "Permission model". The lower sections + per-object matrices are the older flat model, pending reconciliation. NO enforcement code exists yet, by design: RBAC is the single post-site pass — one wrong rule compromises the whole system, so it stays a doc brainstorm until the app surface is stable.
---

# RBAC permission catalog

The canonical enumeration of RedPash permission keys, derived from the
[object-metadata specs](../object-metadata/index.md). One catalog doc
per standard object lists the keys that object exposes + the default
role→key grant matrix. Downstream surfaces (the `/api/me` permissions
payload, route-gating middleware, FE element gating) read this catalog
instead of re-deriving authorization rules per handler.

Em 2026-05-28/29: the object model was documented first (object-
metadata sweep) precisely so permissions could be **derived from a
stable model** rather than invented per route. This catalog is that
derivation. Enforcement code comes after the catalog is signed off —
the doc is the spec the code generates against.

**This is a spec, not enforcement.** Today's app is dev-permissive
([[redpash-stage]] — solo-dev / localhost / pre-prod): every caller
resolves through `resolve_user_rid` to the dev_user and `ensure_owner`
is the only live gate. The catalog defines what enforcement WILL
check; nothing here changes runtime behavior until the enforcement
slices land.

---

## Permission model (the organizing principle)

Reframed by Em 2026-05-29. **This supersedes the flat
`<entity>.<action>` × separate-scope-qualifier scheme** in the sections
below — those + the per-object grant matrices are being reconciled to
this model.

**Axiom — view-rooted, least privilege.** Every operation is gated by
the ability to *see* the thing. You can't update or delete a record (or
a field) you can't view. `view` is the foundation; `create` / `update` /
`delete` derive from it.

**Two composable grant sources.** A caller's effective permissions =
**role baseline ∪ membership grants**. Atoms are never assigned to a
user directly — they're bundled into a **role**, and a role is applied
either globally (the account's role) or scoped (via a membership). Want
a different permission set ⇒ edit a role or create a new one.

1. **Role** — the atom bundle + the unit of assignment. Standard sets
   today (`owner` / `admin` / `member`); **custom roles, custom objects,
   and custom fields arrive in the multi-tenant phase**, once the system
   is validated on the standard sets.
2. **Membership** — the polymorphic Membership object (company /
   project / case-team today; extensible to custom scopes like a "Human
   Resources" team). A membership is `(user, scope, role)`: it applies
   its role's bundle to the records in its scope. **Membership acts as
   ownership / sharing** — it grants access to those specific records
   *even when the account role doesn't*. This is the sharing engine, and
   it's how company-hierarchy visibility works.

**View hierarchy — object + field.**

- *Object view:* `case.view` (own / baseline) → `case.view.all` (admin —
  every record). The middle rungs — `case.view.company`,
  `case.view.project`, and per-record case-team view — are **granted by
  membership, not by a direct role grant.** No `case.view.all` ⇒ you see
  only the cases a membership covers (own / company / project /
  case-team).
- *Field view* (field-level security, **allow-list**):
  `case.view.field.all` (every field) / `case.view.field.<name>` (just
  that field). A role sees exactly the fields it holds `view.field.*`
  for; everything else is hidden. Visibility varies by role — a support
  engineer's role hides customer fields their manager's role sees.

**Writes derive from view.**

- To write field X you must view field X (a field's `*.update` ⇐ the
  matching `*.view.field.X`).
- **Delete a record ⇐ `view.field.all`** — you must see the whole record
  before you can destroy it.
- **Create ⇐ object-level `view`** — you can create in an area you can
  see (when your role/membership also grants create).

**UI surface derives from view.** Tabs, pages, and fields render from
view grants — there is no separate "can see this tab/page" permission.
Hold `case.view` ⇒ the Cases tab renders; hold only
`case.view.field.title` ⇒ the record opens showing just the title.

**Worked example (Em — Support Engineer).** Two memberships, unioned:

- *Support Engineering Team* → `case.view` over the team's queue (all
  cases, assigned or not).
- *Informatica team* → view assigned cases + comment + see shared logs,
  but **no delete** (the role lacks `view.field.all`), and some customer
  fields stay hidden (the role's `view.field.*` subset) that a manager's
  role sees.

**Validation strategy — build up from the atom, never subtract from
admin.** Today the app runs admin / full-access (everything on) for
feature testing. RBAC gets validated in the *inverse* direction: start
from the empty grant set + the single most-granular atom —
`user.view.name` (view one field of one object) — confirm it grants
*exactly* that and nothing more, then add the next atom and re-verify,
building the full set incrementally. You can't prove an access system is
airtight by removing grants from full-access — leaks are invisible that
way; you prove it by adding from zero, each grant tested in isolation as
it lands. That's what makes "one wrong rule" catchable rather than
catastrophic.

---

## What exists today (the baseline this formalizes)

Three enforcement primitives are live; the catalog generalizes them
into one key scheme:

| Primitive | Where | What it checks |
|---|---|---|
| `ensure_owner(lookup, caller, label, rid)` | `routes/mod.rs:60` | `row.owner_id == caller`; 404 on miss/mismatch (never leaks existence) |
| `company_role(pool, company, user)` | `db/mod.rs:985` | caller's `company_memberships.role` for a company (owner/admin/member) |
| `UserProfile.role` | `shared/user.rs:41` | platform-tier role string (dev-permissive today) |

The catalog's job: turn "each handler calls ensure_owner or
company_role ad-hoc" into "each handler checks a declared permission
key, and the role→key matrix lives in one place."

---

## Key scheme

A permission key is:

```
<entity>.<action>[.<field>]
```

evaluated against a **scope** the grant carries (not part of the key
string — see "Scope qualifiers"). Examples:

- `case.create` — may create a Case
- `case.read` — may read a Case (scope decides *which* cases)
- `case.update` — may update a Case (object-level)
- `case.status.update` — may change a Case's `status` field specifically
- `case.delete` — may delete a Case

### Object-action keys

One key per verb in the object's **Supported calls** table:

| Verb | Key | Notes |
|---|---|---|
| `create` | `<entity>.create` | all-or-nothing over the create body |
| `read` | `<entity>.read` | gate on the read/detail GET |
| `update` | `<entity>.update` | object-level update gate (a coarse grant) |
| `delete` | `<entity>.delete` | |
| `list` | `<entity>.list` | gate on the paginated list |
| `search` | `<entity>.search` | usually granted with `list`; split only if an object needs it |

When an object doesn't support a verb (append-only logs have no
`update`/`delete`), the key simply doesn't exist — the catalog doc
omits it and notes why.

### Field-update keys

One key per field carrying the **`Update`** property in the object-
metadata doc:

```
<entity>.<field>.update
```

Field-update keys are the **fine-grained** layer over the coarse
`<entity>.update`. A role granted `<entity>.update` implicitly holds
every `<entity>.<field>.update`; a role can instead be granted a
*subset* of field-update keys to allow editing some fields but not
others (e.g. a `member` may edit `case.status` + `case.assignee` but
not `case.priority`). The enforcement layer checks the field key when
present, falling back to the object key.

**Create is all-or-nothing.** We do NOT mint `<entity>.<field>.create`
keys — the create body is validated as a unit, so `<entity>.create`
covers every `Create`-property field. (Revisit only if a field needs
create-time gating distinct from the row.)

**Auto fields never get keys.** `redpash_id`, `created_at`,
`updated_at`, and any server-assigned field (`reporter_id` set to the
caller, `status` seeded server-side) carry no Create/Update property in
the metadata → no key.

---

## Scope qualifiers

A grant is `(key, scope)`. The scope says **which rows** the key
covers — the row-level dimension RBAC adds on top of the action. Four
scopes, narrowest-to-widest:

| Scope | Predicate | Source column |
|---|---|---|
| `own` | row belongs to the caller | `owner_id` / `reporter_id` / `user_redpash_id == caller` |
| `project` | row is in a project the caller is a member of | `project_id ∈ caller's project_memberships` |
| `company` | row is in a company the caller is a member of | `company_id ∈ caller's company_memberships` |
| `all` | every row | — (platform admin) |

Scope widens monotonically: `all ⊃ company ⊃ project ⊃ own`. A grant at
a wider scope subsumes the narrower ones for that key. Not every object
supports every scope — an object with no `company_id` FK can't be
scoped `company`; the catalog doc lists the scopes each object's keys
can carry.

Written shorthand in the grant matrix: `case.read@company` means
"read Cases whose company the caller belongs to."

---

## Role tiers

Three independent role sources, resolved in priority order
(platform → company → project). The effective grant set is the
**union** across tiers.

### 1. Platform role — `users.role`
App-wide tier. Today dev-permissive (everyone resolves admin-view).

| Role | Intent |
|---|---|
| `admin` | platform operator — `*@all` on every object (the `/admin/*` + `/monitoring/*` surfaces) |
| `user` | standard end-user — object grants come from membership tiers + `@own` |

### 2. Company role — `company_memberships.role`
Scopes grants to rows within a company the caller belongs to.
`owner > admin > member` (CHECK in mig 007).

| Role | Intent |
|---|---|
| `owner` | full control of company-scoped rows + member management |
| `admin` | manage company-scoped rows; cannot transfer/delete the company |
| `member` | read company-scoped rows; write only `@own` |

### 3. Project role — `project_memberships.role` (v3, schema-only today)
Scopes grants to rows within a project. `owner > collaborator >
viewer` (CHECK in mig 007). Inert until RBAC v3 wires
`project_memberships`; the catalog declares the grants now so the
enforcement slice has a target.

| Role | Intent |
|---|---|
| `owner` | redundant with `projects.owner_id`; auto-inserted alongside it when v3 lands |
| `collaborator` | read + write project-scoped rows |
| `viewer` | read project-scoped rows only |

### Case Team Member — membership extends to case instances (Em 2026-05-29)

Case-level collaborators are **Case Team Members** in the UI (modeled on
Salesforce's
[CaseTeamMember](https://developer.salesforce.com/docs/atlas.en-us.object_reference.meta/object_reference/sforce_api_objects_caseteammember.htm)
— a member linked to a case with a role whose *AccessLevel* governs
case access). In the backend they are **not** a separate table: they're
rows of the **general Membership object** — the same abstraction behind
`company_memberships` + `project_memberships` — extended with a `case`
scope (`member · scope_type=case · scope_id=case_rid · role`). So
membership.md (#8 in the sweep) specs ONE polymorphic Membership object
spanning company / project / case, not three tables; the UI labels the
case-scoped variant "Case Team Member."

**Implication (pending Em sign-off):** this introduces an instance-level
grant — "cases the caller is a team member of" — which the closed scope
set (`own` / `project` / `company` / `all`) doesn't express. It needs a
new **`team`** scope (rows where caller ∈ the row's membership), added
to Scope qualifiers per this doc's own "a new scope needs an index
update first" rule. `team` generalizes beyond cases to any object that
grows an explicit member list.

---

## Per-object catalog document shape

Every standard object gets one
`docs/internal/specs/rbac/<entity>.md` with these sections:

### 1. Header
Object name + RID prefix, one-line scope summary, link back to the
object's [metadata doc](../object-metadata/index.md), and which scope
qualifiers the object's keys can carry (driven by its FK columns).

### 2. Keys
The full key list for the object — object-action keys (from Supported
calls) + field-update keys (from `Update`-property fields). A table:

| Key | Derived from | Scopes | Notes |
|---|---|---|---|

### 3. Grant matrix
The default role→key mapping. Rows are keys, columns are the role
tiers (platform admin / company owner / company admin / company member
/ project owner / collaborator / viewer / unauthenticated). Each cell
is the widest scope that role holds for that key, or `—` for no grant.

### 4. Notes
Object-specific authorization quirks the matrix can't express — last-
owner guards, server-forced fields, self-vs-other action splits
(membership leave vs remove), soft-FK audit rows that outlive deletes.

---

## Conventions

- **File naming:** `docs/internal/specs/rbac/<entity>.md` — same slug as the object-metadata doc.
- **Keys are derived, not invented.** Every key traces to a verb in the metadata's Supported calls or an `Update`-property field. If a key has no metadata source, either the metadata is incomplete (fix it first) or the key shouldn't exist.
- **The grant matrix is the default policy, not a hard ceiling.** Per-company role customization (a company defining its own role→grant overrides) is a v3+ concern; the catalog pins the *shipped defaults*.
- **Scope qualifiers are closed** (`own` / `project` / `company` / `all`). A new scope needs an index update first.
- **Append-only objects** (Event, Step) have no `update`/`delete` keys — read/list/search only. Note it explicitly.
- **Derived-view objects** (Chart, Dashboard, Report — all `project_files` rows) inherit File's scope columns but carry their own action keys since the wire contract differs per kind.

---

## Authoring order (Torv's sweep)

Worked example: [case](case.md) — locks the catalog shape.

Then, mirroring the object-metadata authoring order (most-locked
first, derived views last):

1. `user.md` — User (USR_) — platform-role source + self-service fields
2. `company.md` — Company (CMP_) — company-role source + member mgmt
3. `project.md` — Project (PRJ_) — ownership + project-role source (v3)
4. `file.md` — File (FIL_) — the canonical scoped row
5. `step.md` — Step (append-only; no update/delete keys)
6. `comment.md` — Comment (CMT_)
7. `case-category.md` — CaseCategory
8. `membership.md` — Membership (composite key; self-vs-other splits)
9. `event.md` — Event (append-only; read/list only)
10. `user-preference.md` — UserPreference (always `@own`)
11. `chart.md` — Chart (FIL_ kind=chart)
12. `dashboard.md` — Dashboard (FIL_ kind=dashboard)
13. `report.md` — Report (derived view)

Each doc reuses the Case doc's section ordering verbatim. The three
source-of-truth files per object are its metadata doc (keys), its
migration (scope columns + CHECK enums), and its route file (which
gates exist today).

---

## See also

- [object-metadata](../object-metadata/index.md) — the model this catalog derives from.
- [user-preferences](../user-preferences.md) — the pref-storage pattern the `/api/me` permissions payload will extend.
- [[project-rbac-corporate-ready]] — the broader workstream framing (row-level scoping + route gating + `/api/me` permissions payload).
