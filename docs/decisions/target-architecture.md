# Target architecture — the durable platform DNA

The durable *shape* of the data model and why it is drawn this way. This is the
WHY behind the structure; the binding line items live in
[day-one.md](day-one.md) (the locked decisions) and the per-table reference
lives in [schema.md](../internal/code/backend/schema.md). This doc complements
both — it names the few load-bearing primitives the whole platform rests on and
explains why the object count stays low.

It is **platform DNA, not RedPash-only**. The shape here — Rust + Polars
backend, Postgres with a **type registry then an entity registry as its first
tables**, a single polymorphic membership edge, a vanilla-JS PWA — is the
skeleton any vertical built on this framework inherits ([vision.md](vision.md),
strategic bet 2: RedPash is the first embodiment of a framework, not the
product). The whole of this design is already running: the source of truth is
[`backend/migrations/20260612000000_init.sql`](../../backend/migrations/20260612000000_init.sql),
a *designed* init (not a `pg_dump` baseline) that bakes in every day-one
decision. Where this doc once read as a plan on the predecessor, it now reads as
the rationale behind what ships.

## The organizing rule — "what goes where" (the 3-bucket rule)

Three buckets decide where any new concept lives. This is the discipline that
keeps the object count low — beat Salesforce on capability without inheriting
its object sprawl, by adding a primitive only for a genuinely new *shape*:

1. **Entity** — gets a `type_definitions` row and an `entities` registry row. A
   top-level thing that can be shared, related to, or referenced
   polymorphically. The builtin set seeded today: **user · company · team ·
   project · file · chart · dashboard · case · connection** (plus any custom
   type, which is *also* just a `type_definitions` row — zero new code).
2. **Edge / child / system row** — no registry row. It *references* entities but
   isn't one: `memberships`, `case_comments`, `project_steps`, `sessions`,
   `user_preferences`, `connector_jobs`, and the observability tables. These
   inherit their reach from a parent and carry a non-entity RID prefix
   (`SES`/`STP`/`CMT`/`EVT`/…) or no RID at all.
3. **Derived view** — no table. `project.stage` (the `project_stages` /
   `file_stages` views), Report, Dashboard-as-rollup: projections over entities,
   never their own stored object. *"Derive, don't store"* — a second storage
   path for one concept is a bug, not a feature.

The payoff is disposability: a new *shape* earns a new entity type; a new
*combination* of existing shapes earns nothing — it is expressed with the
primitives we already have, so it deletes at near-zero cost.

## Spine 1 — the entity registry (the first entity table)

`entities (id, type, created_at)` is the universal object handle.
`type` is a FK into `type_definitions`; `id` is the `<PREFIX>_<32-hex>` RID (see
[redpash-id.md](../internal/code/backend/redpash-id.md)). Every top-level entity
table makes its PK a FK *into* the registry —
`redpash_id text PRIMARY KEY REFERENCES entities(id) ON DELETE CASCADE`. The
registry plays two roles at once:

- **FK target** for polymorphic *associations* — `memberships`, and any future
  edge (comments-on-anything, attachments, watchers) points at `entities.id` and
  cascades safely.
- **Supertype** for subtyped *entities* — the single-table-subtype pattern
  `project_files` uses (`file_type` → csv/chart/dashboard) generalises here.

This is what makes **integrity triggers unnecessary**. Work that older designs
needed per-table triggers or app-side cascades for is now pure FK cascade:

- **One delete path** — delete *through* the registry:
  `DELETE FROM entities WHERE id = $rid` cascades to the subtype row AND to every
  edge that FKs into it. No per-table cleanup. The single helper is
  `db::delete_entity` (`db::delete_entity_and_blobs` adds the on-disk blob sweep
  for files).
- **One create path** — register the entity *first*, then insert the subtype row
  (its PK FKs into the registry), both in one transaction. `db::register_entity`
  is the single helper, so no create path can forget the registry row.

`entities` is the highest-cardinality table (the sum of all entities), but each
row is a thin id/type/created_at triple, PK-indexed and `entities_type_idx`-indexed —
scale-neutral.

### Users and files are entities from birth (the prerelease caveat is gone)

The predecessor deliberately left **users and files out** of the registry on the
theory that nothing referenced them polymorphically *yet*. That was the wrong
call and it cost real capability: *"share one file with one person"* was
inexpressible because a file wasn't an entity its own membership edge could
point at, so file RBAC rode a special-cased cascade arm instead of the uniform
edge. [Day-one #2](day-one.md) reverses it: **users and files are registered
entities from birth.** The seed in the init migration carries `user` (`USR`) and
`file`/`chart`/`dashboard` (`FIL`/`CHT`/`DSH`) as `type_definitions` rows, and
`users.redpash_id` / `project_files.redpash_id` both FK into `entities`. There is
no "joins the registry the day something points at it" deferral — everything
top-level is in from the start, so every edge and every reach rule is uniform.

## Spine 2 — the unified membership edge (one table, the whole RBAC layer)

`memberships` is the single polymorphic m:n edge that is simultaneously the
**access layer and the org chart**. It replaces what a Salesforce-shaped model
spreads across five-plus objects (company membership, project membership, team
membership, role assignment, sharing rules). **Both ends are entities:**

```
PRIMARY KEY (object_redpash_id, member_redpash_id, role, context_role)
object_redpash_id → entities(id) ON DELETE CASCADE
member_redpash_id → entities(id) ON DELETE CASCADE
```

Because *both* `object_redpash_id` and `member_redpash_id` FK into `entities`,
the same row shape grants a **user** access to a company, project, file, or
case — and grants a **team** access to the same — so team grants, team nesting,
and multi-role-per-object are all one fact in one table. The wide PK is
deliberate: one principal can hold several roles on one object.

Two invariants this buys at the DB level:

- **No orphan rows.** Both FKs cascade on delete, so the phantom-access leak (a
  membership surviving its deleted object — or its deleted user) is
  *impossible*, with no trigger to maintain.
- **Enforcement keys off `role` only.** `role` is the 4-tier
  `owner / admin / member / viewer` enum (`CHECK`-constrained). `context_role` is
  a free-text descriptor (`"Reporter"`, `"CEO"`, `"Department"`, or `''`) that is
  **display only** — [day-one #9](day-one.md) makes it law that *no enforcement
  or identity path may ever branch on it*. The predecessor string-keyed reporter
  resolution on a context label, so renaming the label broke identity; that class
  of bug is closed by construction here.

**Ownership is a membership, not a column.** No *typed* entity table
(`projects`, `project_files`, `companies`, `teams`, `cases`) carries an
`owner_id` column — a project's (or any such object's) owner is a `memberships`
row with `role='owner'`, auto-granted to the creator in the same create tx
(*"there is no object without an owner"*) via `db::grant_owner`. The one
`owner_id` column in the schema is on `entity_data` (the custom-object store): a
denormalized convenience FK that the create path sets *alongside* the
authoritative `grant_owner` edge in the same tx — so even there, enforcement and
the resolved-owner display key off the `role='owner'` edge, never the column
(`objects.rs::builtin_view` resolves owner from the first owner membership
exactly because the typed tables have no such column). A user's home project is
`users.default_project_id` (`ON DELETE SET NULL`), and `is_default` on a project
is **derived** from it. Owner-checks are a `JOIN memberships … role='owner'`.

**What deliberately stays a typed FK:** `cases.reporter_id` / `cases.assignee_id`.
They are 1:1 *workflow* references, not m:n *access* edges; folding them into the
cosmetic descriptor would make "who's assigned?" depend on free text and lose the
single-assignee + typo guarantees. Membership earns its keep on access grants
only — case *access* still flows through `memberships`, case *identity* through
the typed columns.

The single department backstop (`enforce_one_department` trigger) is the one
exception to "the registry removes triggers": it only closes a TOCTOU race the
app layer already guards (one direct department per member per company); the
clean 409 is surfaced in Rust, the trigger is the race-safe floor.

## The cascade is data, not code (day-one #6)

The RBAC reach cascade — *"a file is reachable via membership on the file, its
project, or the project's company"* — is declared as **data** in
`type_definitions.scope_parents` (e.g. `file → ["project_id"]`,
`case → ["company_id","project_id"]`). The grant-resolver SQL and the admin EDGES
introspection are *generated* from those rows at type-cache load, so the two
surfaces (mint + resolve) cannot drift. The predecessor kept three hand-synced
copies of the cascade behind a "keep in sync" comment — exactly the closed-list
rigidity the registry arc deletes. Adding a type's cascade arm is a seed-row
edit, never a code change. The lean reach predicates that consume it live in
[`objects.rs`](../internal/code/backend/objects.md) (the generic `REACH` /
`CASE_REACH` clauses) and [`rbac.rs`](../internal/code/backend/rbac.md).

## Single-table-subtype — why one `project_files`, three RID prefixes

`file`, `chart`, and `dashboard` are three registry types with three *unique*
RID prefixes (`FIL` / `CHT` / `DSH`, [day-one #1](day-one.md)) that share **one**
backing table — `project_files`, discriminated by `file_type`. There are no
`reports` or `dashboards` tables, ever. The subtype rows carry their own RID
prefix (so RIDs resolve unambiguously and `type_definitions` serves per-type
field metadata) while the storage is one table with a `CHECK (file_type IN
('csv','chart','dashboard'))`. This is the entity-registry supertype pattern
applied to the data-work objects: a Dashboard is a *file with `file_type =
'dashboard'`*, its `spec` JSONB the only thing that differs. The
[day-one #1](day-one.md) unique-prefix rule is what lets these coexist in one
table without the predecessor's `FIL`-shared, ordinal-disambiguated trap.

## Custom objects — the framework payoff

[`entity_data`](../internal/code/backend/objects.md) is the single open JSONB
store behind the generic `/api/objects/:type` handler. A custom type gets full
CRUD + RBAC + audit with **zero new code** — the whole "framework, not product"
thesis made concrete. Its `scope_parent_id` is a **real FK** into `entities`
(`ON DELETE SET NULL`, [day-one #3](day-one.md)): the create-time reach check (the
CAS_DD6F55FB IDOR guard, which requires ≥ Member reach on a caller-supplied
parent) is the *policy* layer, and this FK makes a dangling or foreign parent
*unrepresentable* even for direct-DB writes and future code paths — defence in
depth, not either/or. Builtin org objects (user/company/team) keep their typed
tables and dispatch onto the same wire shape; customs stay on the `entity_data`
path. Both share the same `REACH` clause, so they cannot diverge.

## Observability is time-partitioned at birth (day-one #8)

`events`, `request_log`, and `db_query_log` are `PARTITION BY RANGE (at)` from
the init migration, each with a `DEFAULT` partition and the partition key folded
into the PK (`PRIMARY KEY (id, at)`). This was the predecessor's **acknowledged
open item** — it shipped DELETE-based retention and never circled back, so VACUUM
bloat accreted. Lean closes it by construction: data-lifecycle is
`DROP PARTITION`, never `DELETE`, and writes are fire-and-forget (failures
swallowed) so observability can never block a request. This is the one place the
prerelease "still deferred" caveat used to live; it is **done** here.

## Why this is the right altitude

Every choice serves the same long game: a **one-time framework cost** (the type
registry, the entity registry, the unified edge, the cascade-as-data, the
3-bucket rule) that buys decade-scale savings the market won't pay for on day
one. Competitors abstract at the wrong layer — a new object per vertical, a
trigger per relation, a hand-written dispatch per type. We abstract at the
polymorphic-supertype layer **once**, and every future edge (comments, watchers,
attachments, new entity types, whole new verticals) inherits cascade-safe
integrity and RBAC for free. That is the *"O(1) in an O(Y·log N) market"*
compression of the one-time-framework-cost bet ([vision.md](vision.md)), made
concrete in the schema.

## Source files

- [`20260612000000_init.sql`](../../backend/migrations/20260612000000_init.sql) —
  the designed schema; every section header carries the WHY.
- [schema.md](../internal/code/backend/schema.md) — the per-table reference (the
  two spines + the type registry, table by table).
- [objects.md](../internal/code/backend/objects.md) — the generic
  `/api/objects/:type` registry handler, the `REACH` clauses, and the IDOR guard.
- [rbac.md](../internal/code/backend/rbac.md) — the role/reach resolver the
  membership edge and the cascade-as-data feed.
- [redpash-id.md](../internal/code/backend/redpash-id.md) — the
  `<PREFIX>_<32-hex>` id scheme that tags every registry row by type.
- [cases.md](../internal/code/backend/cases.md) — the typed workflow FKs
  (reporter/assignee) that deliberately stay off the membership edge.
