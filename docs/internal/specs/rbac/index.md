---
title: RBAC permission catalog — template
section: Internal
order: 50
last modified date: 2026-05-31
owner: Torv
status: ENFORCED 2026-05-31 — view-rooted model (membership-as-sharing, roles-as-bundles, view-derived writes); see "Permission model". The §2 resolver + reach-aware gates are now SHIPPED across all 5 object types (the earlier "spec-only until the app surface is stable" plan is complete — that was the right call: it landed as one focused post-site pass). Coarse object-level enforcement is live (require_grant on effective reach); per-field atoms remain the v3 custom-role layer. Workstream of record: case CAS_913220A003484841BF98250DD0FEF681.
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
`<entity>.<action>` × separate-scope-qualifier scheme.** The sections
below (Key scheme, View grants, Roles, per-object doc shape) are now
expressed in these terms; the per-object docs follow the
[case.md](case.md) pattern-lock.

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
| `ensure_owner(lookup, caller, label, rid)` | `routes/mod.rs:60` | resolved owner (the `role='owner'` membership) `== caller`; 404 on miss/mismatch (never leaks existence) |
| `company_role(pool, company, user)` | `db/mod.rs:985` | caller's `memberships.role` for a company (owner/admin/member) |
| `UserProfile.role` | `shared/user.rs:41` | platform-tier role string (dev-permissive today) |

The catalog's job: turn "each handler calls ensure_owner or
company_role ad-hoc" into "each handler checks a declared permission
key, and the role→key matrix lives in one place."

---

## Key scheme

View-rooted (per the model above): **`view` is the root atom; create /
update / delete derive from it.** The keys an object exposes:

```
<entity>.view               — see the object        (baseline = own rows)
<entity>.view.all           — see every row          (platform admin)
<entity>.view.field.<name>  — see one field          (field-level, allow-list)
<entity>.view.field.all     — see every field
<entity>.create             — create a row           (⇐ object view + create grant)
<entity>.<field>.update     — edit one field         (⇐ view.field.<name>)
<entity>.delete             — delete a row           (⇐ view.field.all)
```

The *middle* view rungs — see-company / see-project / see-this-record —
are **granted by membership, not by a direct role atom** (see "View
grants via membership"). No `<entity>.view.all` ⇒ you see only the rows
a membership covers. Examples:

- `case.view` — see your own cases (reporter / assignee)
- `case.view.all` — see every case (platform admin)
- `case.view.field.title` — see (and therefore may edit) just the title
- `case.delete` — delete a case (requires `case.view.field.all`)

### View keys (object + field)

Read isn't a verb here — it's the **root**. Each object exposes object-
view + field-view atoms; `read`/`list`/`search` are all the same `view`
grant (the scope decides *which* rows the list returns):

| Atom | Covers | Notes |
|---|---|---|
| `<entity>.view` | the object, baseline | own rows; `list`/`search`/detail all gate on this |
| `<entity>.view.all` | every row | platform admin |
| `<entity>.view.field.<name>` | one field | **allow-list** — a role sees exactly the fields it holds this for |
| `<entity>.view.field.all` | every field | the "see the whole record" atom; required to delete |

The middle row-rungs (`view.company` / `view.project` / per-record) are
membership-granted, never direct atoms (see "View grants via membership").

### Write keys (derived from view)

Writes are not independent permissions — each derives from a view atom:

| Atom | Derives from | Notes |
|---|---|---|
| `<entity>.create` | object `view` (+ a create grant) | all-or-nothing over the create body; no per-field create keys |
| `<entity>.<field>.update` | `<entity>.view.field.<name>` | to edit field X you must see field X; a role can hold a *subset* (e.g. edit `status`+`assignee`, not `priority`) |
| `<entity>.delete` | `<entity>.view.field.all` | you must see the whole record before you can destroy it |

When an object doesn't support a verb (append-only logs have no
`update`/`delete`), the atom simply doesn't exist — the doc omits it and
notes why.

**Auto fields never get keys.** `redpash_id`, `created_at`,
`updated_at`, and any server-assigned field (`reporter_id` set to the
caller, `status` seeded server-side) carry no Create/Update property in
the metadata → no key.

---

## View grants via membership

`view.all` is the only *row-breadth* atom a role carries directly.
Everything narrower — see-company / see-project / see-this-record — is
**granted by a membership**, not by the account role. That's the
sharing engine: a membership `(member, object, role)` applies its
role's atom bundle to the rows in that object's scope, *even when the
account role grants nothing*. The reach, narrowest-to-widest:

| Reach | The caller can view a row when… | Source |
|---|---|---|
| `own` | they hold a membership on the row itself (reporter/assignee/case-team) | `memberships` edge on the row |
| `project` | they hold a membership on the row's project | `memberships` edge on `project_id` |
| `company` | they hold a membership on the row's company | `memberships` edge on `company_id` |
| `all` | their *role* carries `<entity>.view.all` | platform admin |

Reach widens monotonically: `all ⊃ company ⊃ project ⊃ own`, and the
effective view is the **highest** the caller resolves — direct ∪ scope
cascade ∪ team-closure, via the [entity-membership-model](entity-membership-model.md)
§2 resolver. The role bundle attached to that membership decides *which
fields* are visible (the `view.field.*` allow-list) and which writes
derive. Not every object supports every reach — one with no
`company_id` FK can't be reached `company`; each doc lists its reaches.

Shorthand in the matrices: `case.view@company` = "view Cases whose
company the caller is a member of."

---

## Roles (atom bundles)

A **role** is a bundle of the view/write atoms above + the unit of
assignment — atoms are never granted to a user directly. A role is
applied two ways, and the effective grant set is their **union**:

- **globally** — the account's platform role (`users.role`), or
- **scoped** — attached to a `memberships` edge, applying the bundle to
  the rows in that membership's object scope (the sharing engine).

The same standard bundle (`owner`/`admin`/`member`/`viewer`) is reused
across scopes; `context_role` on the edge is the human label, the
`role` tier is the bundle. Custom roles/objects/fields arrive in the
multi-tenant phase — the standard bundles ship first.

### Platform role — `users.role` (applied globally)
Today dev-permissive (everyone resolves admin-view).

| Role | Bundle intent |
|---|---|
| `admin` | platform operator — `*.view.all` on every object (the `/admin/*` + `/monitoring/*` surfaces) |
| `user` | standard end-user — view comes from membership scopes + own rows |

### Membership role — `memberships.role` (applied scoped)
The bundle a membership applies to its object's rows. `owner > admin >
member > viewer` (CHECK in mig 007). The *same* tiers serve company,
project, case, and team objects (the polymorphic edge):

| Role | Bundle intent (within the membership's scope) |
|---|---|
| `owner` | full view (incl. `view.field.all` → delete) + member management |
| `admin` | manage scoped rows; cannot transfer/delete the scope object itself |
| `member` | view scoped rows; write only rows they also hold a membership on |
| `viewer` | view scoped rows (read-only); no write atoms |

### Case Team Member — membership extends to case instances (Em 2026-05-29)

Case-level collaborators are **Case Team Members** in the UI (modeled on
Salesforce's
[CaseTeamMember](https://developer.salesforce.com/docs/atlas.en-us.object_reference.meta/object_reference/sforce_api_objects_caseteammember.htm)
— a member linked to a case with a role whose *AccessLevel* governs
case access). In the backend they are **not** a separate table: they're
rows of the **general Membership object** — the same unified `memberships`
table — extended with a `case`
scope (the edge `(object=case_rid · member · role · context_role)`,
where `member` is a user or a team). So membership.md specs ONE
polymorphic Membership object spanning company / project / case / team,
not separate tables; the UI labels the case-scoped variant "Case Team
Member."

**Resolved by the view-grants model:** the instance-level grant —
"cases the caller is a team member of" — *is* the `own` reach now
(see "View grants via membership"): `own` = "the caller holds a
membership on the row itself," which covers reporter/assignee **and**
case-team membership uniformly. No separate `team` scope needed — the
edge model made every reach (own/project/company) a membership lookup,
so case-team falls out as the `own` rung. Generalizes to any object
that grows an explicit member list.

---

## Per-object catalog document shape

Every standard object gets one
`docs/internal/specs/rbac/<entity>.md` with these sections:

### 1. Header
Object name + RID prefix, one-line summary, link back to the object's
[metadata doc](../object-metadata/index.md), and which **view reaches**
the object supports (driven by its FK columns — e.g. no `company_id` ⇒
no `company` reach).

### 2. Atoms
The object's view atoms (object `view` + `view.all` + the
`view.field.*` allow-list, one per readable field) and the derived
write atoms (`create`, per-field `<field>.update`, `delete`). A table:

| Atom | Derives from | Reach | Notes |
|---|---|---|---|

### 3. Grant matrix
The default **role-bundle → atom** mapping. Rows are atoms (view /
view.all / view.field.* / create / field.update / delete), columns are
the role bundles (platform admin / membership owner·admin·member·viewer
/ unauthenticated). Each cell is the **reach** the bundle grants for
that atom (`own` / `project` / `company` / `all`), or `—` for no grant.
Writes inherit the reach of the field-view they derive from.

### 4. Notes
Object-specific authorization quirks the matrix can't express — last-
owner guards, server-forced fields, self-vs-other action splits
(membership leave vs remove), soft-FK audit rows that outlive deletes.

---

## Conventions

- **File naming:** `docs/internal/specs/rbac/<entity>.md` — same slug as the object-metadata doc.
- **Atoms are derived, not invented.** Every atom traces to a readable field (a `view.field.*`) or a verb in the metadata's Supported calls (`create`/`delete`). Writes derive from a view atom; if an atom has no metadata source, fix the metadata or drop the atom.
- **Views root everything.** No standalone `read`/`list`/`search`/UI-visibility keys — they're all the object `view`; writes derive from view (see Key scheme). Don't reintroduce action-first keys.
- **The grant matrix is the default policy, not a hard ceiling.** Per-company custom role bundles are a v3+ / multi-tenant concern; the catalog pins the *shipped defaults*.
- **Reaches are closed** (`own` / `project` / `company` / `all`, all but `all` membership-granted). A new reach needs a model + index update first.
- **Append-only objects** (Event, Step) have no `create`-by-user / `update` / `delete` atoms — view only. Note it explicitly.
- **Derived-view objects** (Chart, Dashboard, Report — all `project_files` rows) inherit File's view reaches but carry their own atoms since the wire contract differs per kind.

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
