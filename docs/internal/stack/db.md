---
title: Stack — DB
section: Internal
last modified date: 2026-06-07
---

# Stack — DB

The persistence layer is a single **Postgres** database, reached through
`sqlx` from the `api` crate. There is no ORM and no second store — Postgres is
the source of truth for every persisted object. The in-process `DashMap` caches
in `AppState` (parsed CSV frames, avatar bytes, the type registry) are derived
views that refill from Postgres or disk on a cache miss; none of them are
durable.

## Connection posture

`AppState::init` (`backend/crates/api/src/state.rs`) opens one `PgPool`
(`max_connections = 8`, 5 s acquire timeout) from the `DATABASE_URL` env var —
the binary refuses to start if it is unset (see `backend/.env.example`). The
pool is `Arc`-cloned into every Axum handler via `State<AppState>`, so handlers
never open their own connections; they borrow from the shared pool.

Startup order is load-bearing and runs once, in this sequence:

1. **Migrate** — `sqlx::migrate!("../../migrations").run(&db)` applies any
   pending migrations. The path is relative to the `api` crate's manifest dir,
   so the migrations actually live at **`backend/migrations/`** (not under the
   crate). `sqlx::migrate!` embeds them in the binary at build time, so the
   shipped binary carries its own schema — no external migration tool at deploy.
2. **Load the type registry** — `TypeDefCache::load` reads the seeded
   `type_definitions` / `type_fields` / `type_scope_roles` rows into an
   immutable in-memory cache. Order is migrate (which *seeds* those rows) → load,
   never the reverse.
3. **Bootstrap** — `bootstrap::run` ensures the dev user + their default
   project exist, so a fresh DB is immediately usable in local dev.

## Migrations

Migrations are timestamp-named `YYYYMMDDHHMMSS_<slug>.sql` files applied in
filename order. `20260529000000_init.sql` is a **consolidated baseline**: it was
derived from a verified `pg_dump --schema-only` of the live prerelease DB
(folding the historical migrations 001–038), so it is byte-faithful to what the
running code expects — every view, trigger, function, and index is preserved.
A small set of deliberate `-- CHANGE:` deltas ride on top of that faithful base
(e.g. the `entities.type` discriminator gaining `team`, the membership
`context_role` collapse). Everything after the baseline is a normal forward
migration. sqlx wraps each file in a transaction automatically — no manual
`BEGIN`/`COMMIT`.

When you change the schema, add a new timestamped file; do not edit a migration
that has already shipped. The generated per-object schema docs (below) are
re-derived from the live DB, so they pick up the change after a regeneration —
they are not hand-maintained.

## The RedPash-ID scheme

Every persisted row's primary key is a **RedPash-ID** (RID): a 3-letter
uppercase type prefix, an underscore, and a 32-char uppercase hex body — e.g.
`CAS_701CF65E…`, 36 chars total. The body is a `Uuid::new_v4().simple()`
upper-cased (122 bits of randomness), produced by the one-function
`id::new(prefix)` in `backend/crates/api/src/id.rs`. There are no internal
UUID/serial PKs hiding behind the RID — the RID *is* the primary key, so it is
what appears in every API URL, log line, frontend hash route, and JSONB
cross-reference. The prefix makes an object's type readable at a glance
anywhere it shows up.

Why a raw UUID body and not the old Crockford-base32-with-checksum scheme: RIDs
are never hand-typed (they live in URLs and copy buttons), so a transcription
checksum buys nothing, and the negligible v4 collision probability means we
never retry on PK conflict. RIDs are issued by the inserting handler — the PK
column is `TEXT` with no DB default, so a row cannot exist without one, and no
code ever updates a RID after insert.

There is **no validation function** and no checksum to verify: an invalid RID
simply misses its index and the query returns no row, which handlers map to a
404. URL `:rid` params are matched case-sensitively against the stored uppercase
value; the app never normalises case.

### Prefixes are data, not an enum

The prefix → object-type mapping used to be hardcoded in Rust. It now lives in
**data**: the `type_definitions` table carries one row per type with its
`rid_prefix`, and `TypeDefCache` (loaded at startup) resolves `CAS_…` → `case`,
`USR_…` → `user`, `CON_…` → `connection`, and so on. Correspondingly
`entities.type` moved from a *closed* `CHECK (type IN (...))` to an FK on
`type_definitions` — **a new object type is a row insert, not a schema
migration**. This is the open-ended/disposability posture applied to the type
system: builtins are seeded byte-identically from the former code-side
registries (guarded by a parity test), and a user-defined type can be added at
runtime. Builtins may share a prefix (file and dashboard both use `FIL_`); the
prefix uniqueness index is partial so only user prefixes are forced unique.

### The `entities` supertype

`entities` is the polymorphic supertype: every registered subtype RID
(company / project / case / team) is also recorded as a row in `entities`, and
the subtype table's `redpash_id` FKs into `entities.id` `ON DELETE CASCADE`. The
create path inserts the `entities` row *first*, inside the same transaction as
the subtype insert (the FK requires it), via the shared `register_entity`
helper; deletion runs against `entities` and cascades the subtype row plus every
polymorphic edge (e.g. the unified `memberships` join) out in one statement.
This is what lets RBAC and relations FK to one stable `entities.id` regardless of
the concrete object type.

## Where the per-object schemas live

This page is the posture and the ID/migration model; it does not restate the
column lists. The authoritative per-object schema (column / type / nullability /
default) is **generated** from the live DB and lives one-doc-per-object under
[`../db/schemas/`](../db/schemas/index.md), alongside hand-written field
semantics and per-object RBAC. The RBAC entity ↔ membership model is under
[`../db/rbac/`](../db/rbac/index.md).

## Source files

- [`../code/backend/api/id.md`](../code/backend/api/id.md) — RID generation (`id::new`).
- [`../code/backend/api/state.md`](../code/backend/api/state.md) — pool init, migrate + cache-load ordering.
- [`../code/backend/api/type_cache.md`](../code/backend/api/type_cache.md) — the data-driven prefix → type registry.
- [`../code/backend/api/bootstrap.md`](../code/backend/api/bootstrap.md) — first-run dev user + default project.
- [`../code/backend/api/db/index.md`](../code/backend/api/db/index.md) — the query layer (`db::*` helpers, `register_entity`).
