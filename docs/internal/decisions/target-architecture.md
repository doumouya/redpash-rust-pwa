---
title: Decision — target architecture
section: Internal
last modified date: 2026-06-07
---

# Decision — target architecture

The durable shape of the data model and why it's drawn this way. Most of what
this decision proposed has **shipped** — the live schema in
`backend/migrations/20260529000000_init.sql` (a verified `pg_dump` of the
prerelease DB, consolidating the old 001–038 migrations) is the source of
truth. Where this doc once read as a plan, it now reads as the rationale behind
what's already running, plus the one piece (time-partitioning) that is still
deferred.

This is **platform-layer DNA, not RedPash-only**: the suite of apps shares the
same skeleton — Rust + Polars backend, Postgres with the **Entity Registry as
the first table**, vanilla-JS PWA. "Achieve more with less; organized
engineering; avoid unnecessary addition" — a performing monolith as the edge.

## The organizing rule — "what goes where"

Three buckets decide where any new concept lives. This is the rule that keeps
the object count low (the [object model](object-model.md) discipline — beat
Salesforce on capability without inheriting its object sprawl):

1. **Entity** — gets a registry row. A top-level thing that can be shared,
   related to, or referenced polymorphically. Today: **company · project ·
   case · team**.
2. **Edge / child / system** — no registry row. It *references* entities but
   isn't one: memberships, comments, project_files, sessions,
   user_preferences, and the observability tables.
3. **Derived view** — no table at all. Report, Dashboard, chart: discriminator
   values or projections over entities, never their own object.

The payoff is disposability: a new *shape* earns a new entity type; a new
*combination* of existing shapes earns nothing — it's expressed with the
primitives we have. That's what lets us delete features at near-zero cost.

## Entity Registry — the supertype (the FIRST table)

`entities (id, type, created_at)` is the universal object handle. Every
top-level entity table makes its PK a FK into the registry
(`redpash_id TEXT PRIMARY KEY REFERENCES entities(id) ON DELETE CASCADE`). The
registry plays two roles at once:

- **FK target** for polymorphic *associations* — `memberships.object_redpash_id`
  (and any future edge: comments-on-anything, attachments, watchers) points at
  `entities.id` and cascades safely.
- **Supertype** for subtyped *entities* — the single-table-subtype pattern
  `project_files` uses (`file_type` → csv/chart/dashboard) generalises here.

The registry is what makes **triggers unnecessary**. Integrity that older
designs needed per-table triggers or app-side cascades for is now pure FK
cascade:

- **Delete pattern** — delete *through* the registry:
  `DELETE FROM entities WHERE id = $rid` cascades to the subtype row AND to
  every edge that references it. One delete path for all entities, no per-table
  cleanup. `delete_entity` is the single helper.
- **Create pattern** — register the entity *first*, then insert the subtype row
  (its PK FKs into the registry), both in one transaction. `register_entity` is
  the single helper so no create path forgets it.

**Scope note vs. the original plan:** the registry covers only the types that
*are* polymorphically referenced today — company, project, case, and `team`.
Users and files are deliberately **not** registered: nothing points at them
polymorphically yet, so paying the registry cost for them would be premature.
They join the registry the day something does — open-ended by design, not
enumerated up front.

**Scale:** `entities` is the highest-cardinality table (sum of all entities),
but a thin id/type/created_at row, PK-indexed — scale-neutral.

## Unified Membership — one table replaces five SF objects

`memberships` is the consolidation: the old `company_memberships` +
`project_memberships` are gone, replaced by one polymorphic m:n access edge
keyed `(object_redpash_id, user_redpash_id)`. The same row shape grants access
to a company, a project, a case, or a team — `object_redpash_id` just points at
a different registry row.

Two invariants this design buys at the DB level:

- **No orphan rows.** `object_redpash_id → entities.id ON DELETE CASCADE` plus
  `user_redpash_id → users ON DELETE CASCADE` means the phantom-access RBAC
  leak (a membership surviving its deleted object) is *impossible*, with no
  trigger to maintain.
- **Enforcement keys off `role` only.** `role` is the 4-tier
  `owner/admin/member/viewer` enum. The descriptor is cosmetic — and here the
  shipped schema **diverges from the original two-field plan**: the proposed
  `display_name` + `relationship_attribute` pair collapsed into a single
  `context_role` text column (holds "Reporter"/"Case Owner" on cases,
  "CEO"/"Department" on company/project rows, NULL when there's no business
  label). One descriptor, never branched on.

**Ownership is a membership, not a column.** The original plan kept
`projects.owner_id` and deferred folding it in. That fold **shipped**: there is
no `owner_id` column anywhere — a project's owner is a `memberships` row with
`role='owner'`, and a user's home project is `users.default_project_id`
(`ON DELETE SET NULL`). Owner-checks are a `JOIN memberships … role='owner'`.

**What deliberately stays a typed FK:** `cases.assignee_id` /
`cases.reporter_id`. They're 1:1 *workflow* references, not m:n *access* edges;
folding them into a cosmetic descriptor would make "who's assigned?" depend on
free text and lose the single-assignee + typo guarantees. Memberships earns its
keep on access grants only.

## RBAC pre-staging — teams + user lifecycle

Two additions ride on the baseline that the original direction didn't name,
both pre-staging the RBAC model in [rbac.rs](../code/backend/api/rbac.md):

- **`teams`** — company-scoped, entity-registered (so memberships can FK a team
  the same way they FK a project). Unused by application code today; it exists
  so the team-inheritance access model lands without a schema migration later.
- **`users.status`** (`active/suspended/archived`) — account lifecycle for the
  RBAC scrub-retain work.

This is the [disposability](object-model.md) principle in practice: register
the entity type now (cheap, scale-neutral), wire the behaviour when the real
consumer arrives. The future role→permission layer
(`role_grants(object_type, role, capability)`) resolves the same role *name* to
different capabilities per scope, with effective access as an additive,
order-independent set union — which is precisely why unifying the role *names*
across object types is safe. Parked until the surface is stable.

## Cases — `case_categories` unique fix (shipped)

The old single `UNIQUE(parent_id, name, company_id)` failed to dedup root
categories (NULL `parent_id` isn't equal to itself) or global categories (NULL
`company_id`). The shipped fix is two partial-unique indexes over
`COALESCE(company_id, '')` — one `WHERE parent_id IS NULL` (roots), one
`WHERE parent_id IS NOT NULL` (sub-categories) — which actually dedup the NULL
cases.

## Observability — partition by time (STILL DEFERRED)

The one part of this direction **not yet implemented.** `events`,
`request_log`, and `db_query_log` are intended to become
`PARTITION BY RANGE (occurred_at/at)` (monthly), so data-lifecycle is
`DROP TABLE old_partition` instead of `DELETE` + VACUUM bloat. No migration
adds partitioning today; the retention story is still delete-based. The
partition key must be in each PK when this lands (e.g.
`events (redpash_id, occurred_at)`). Treat this as the open item of this
decision.

## Why this is the right altitude

Every choice here serves the same long-game: a **one-time framework cost** (the
registry, the unified edge, the organizing rule) that buys decade-scale savings
the market won't pay for on day one. Competitors abstract at the wrong layer —
a new object per vertical, a trigger per relation. We abstract at the
polymorphic-supertype layer once, and every future edge (comments, watchers,
attachments, new entity types) inherits cascade-safe integrity and RBAC for
free. That's the "O(1) in an O(Y log N) market" bet, made concrete in the
schema.

## Source files

- [entities.rs](../code/backend/api/db/entities.md) — the registry helpers
  (`register_entity` / `delete_entity`) and the create/delete invariants.
- [db/mod.rs](../code/backend/api/db/mod.md) — the unified-`memberships`
  queries (access checks, the cross-object membership UNION, owner-checks).
- [db/projects.rs](../code/backend/api/db/projects.md) — project create/delete
  through the registry; ownership-as-membership; `default_project_id`.
- [rbac.rs](../code/backend/api/rbac.md) — the role/teams/status pre-staging
  this schema feeds.
- [id.rs](../code/backend/api/id.md) — the `<PREFIX>_<hex>` id scheme that
  tags every registry row by type.
- [shared/company.rs](../code/backend/shared/company.md) — the membership /
  member-list wire DTOs (the `context_role` descriptor on the wire).
