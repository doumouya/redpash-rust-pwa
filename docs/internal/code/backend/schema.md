# Schema — Postgres as a registry, never a data store

The database holds the **model**, never the customer's rows. Cell values live on
disk (`<data_dir>/files/<rid>.bin`, immutable) and in the browser; Postgres holds
ids, shapes, counts, the type registry, and the RBAC/audit substrate. Every
schema decision is a locked entry in
[`docs/decisions/day-one.md`](../../../decisions/day-one.md), carried verbatim
into the init migration's header
([`init.sql:1`](../../../../backend/migrations/20260612000000_init.sql)).

The design rests on **two spines** — the entity registry and the polymorphic
membership edge — plus a **type registry** that turns "a new object" into a row,
not a migration. Everything else is a typed subtype table, a sparse override, or
a derived view.

---

## Spine 1 — the entity registry (`entities`)

```sql
CREATE TABLE entities (id text PRIMARY KEY, type text REFERENCES type_definitions, created_at …);
```
[`init.sql:69`](../../../../backend/migrations/20260612000000_init.sql)

**Every top-level object's PK FKs into `entities` `ON DELETE CASCADE`** (day-one
#2: users AND files are registered from birth). This is the day-one decision the
whole model hangs off:

- **One polymorphic id space.** A RID is `<PREFIX>_<32-hex>`; the prefix is
  globally unique per type (#1), so `object_kind(rid)` is a prefix→type HashMap
  lookup with no disambiguation
  ([`type_cache.rs:132`](../../../../backend/crates/api/src/type_cache.rs)).
- **One delete path.** `delete_entity` does `DELETE FROM entities WHERE id = $1`
  ([`db.rs:60`](../../../../backend/crates/api/src/db.rs)); the FK cascade clears
  the subtype row, every membership edge, and all downstream rows — zero
  per-table triggers, polymorphic edges cascade-safe for free.
- **One join point.** Both ends of a membership are `entities(id)`, so a user, a
  team, or any object can sit on either side of an access edge.

The invariant lives in the db helper layer, not the schema:
`register_entity` runs **first, in the same tx** as the subtype insert
([`db.rs:45`](../../../../backend/crates/api/src/db.rs)), and creates always go
through it (e.g. `insert_project` at
[`db.rs:261`](../../../../backend/crates/api/src/db.rs)).

---

## The type registry — a new type is a row

`type_definitions` ([`init.sql:19`](../../../../backend/migrations/20260612000000_init.sql))
is the catalog every consumer reads at boot
([`type_cache.rs:57`](../../../../backend/crates/api/src/type_cache.rs)):

- `rid_prefix` (UNIQUE, #1), `display_name`/`_plural`, `rail_icon`, `ordinal`
  (wire order), `grid_served` (is it a datatable), `is_builtin`.
- `scope_parents jsonb` — **the RBAC cascade declared as data** (#6). Each entry
  names a column (on the subtype table for builtins, or the literal
  `scope_parent_id` for customs) whose value is a parent entity the grant
  resolver climbs. `TypeDefCache::load` compiles these rows into **one**
  `parent_edges` SQL fragment shared by every RBAC query — the recursive CTE in
  `rbac_with_clause` ([`type_cache.rs:141`](../../../../backend/crates/api/src/type_cache.rs)).
  One declaration, every consumer; the cascade knowledge exists in exactly one
  place and it came from the DB.

`type_fields` ([`init.sql:38`](../../../../backend/migrations/20260612000000_init.sql),
PK `(type_id, field)`) is the per-type field catalog:

- `ordinal` (wire order), `data_type` (an **open codec id, not an enum**),
  `perm_class` (CHECK: `standard | collaborative | owner_grade | personal |
  readonly`), `options`, `rel_type`/`rel_multi` (typed relations), `validate`.
- **Store inputs, derive the rest** — per-role read/write cells come from
  `perm_class` in Rust (`PermClass::cells`), never persisted, so seeds can't
  drift. `label` ([`type_fields_seed.sql:11`](../../../../backend/migrations/20260613000001_type_fields_seed.sql)),
  `field_group` + `scope` ([`preference_type.sql:20`](../../../../backend/migrations/20260613000002_preference_type.sql))
  were added for presentation / the preference type.

Builtin types keep typed tables; the **one** place `type_id → (table, pk)` is
known is `builtin_table` ([`type_cache.rs:42`](../../../../backend/crates/api/src/type_cache.rs)) —
extend it in the same commit as a schema change. Customs need no entry (they
live in `entity_data`).

The seed of nine builtin types is at
[`init.sql:432`](../../../../backend/migrations/20260612000000_init.sql)
(`user company team project file chart dashboard case connection`); `preference`
(#95, `grid_served=false`) is added by
[`preference_type.sql:27`](../../../../backend/migrations/20260613000002_preference_type.sql).
`chart`/`dashboard` are registry types so RIDs resolve and field metadata
serves, but they are **`project_files` rows** (file_type slices), never separate
tables.

---

## Spine 2 — the polymorphic membership edge (`memberships`)

```sql
PRIMARY KEY (object_redpash_id, member_redpash_id, role, context_role)
```
[`init.sql:201`](../../../../backend/migrations/20260612000000_init.sql)

**The entire RBAC layer AND the org chart are this one table.** Both ends are
`entities(id)`, so team grants, team nesting, and multi-role-per-object are one
fact. `role` is the enforced tier (CHECK: `owner | admin | member | viewer`);
`context_role` is **free-text display only** (#9) — no enforcement or identity
path may branch on it. The wide PK is deliberate: one principal can hold many
roles on one object.

There are **no `owner_id` columns anywhere** — ownership is a membership row.
App-layer invariants (`db.rs`): the creator's owner edge is auto-granted in the
create tx (`grant_owner`, [`db.rs:145`](../../../../backend/crates/api/src/db.rs))
— "there is no object without an owner" — and `user_sole_owner_objects`
([`db.rs:69`](../../../../backend/crates/api/src/db.rs)) blocks scrubbing a user
who would strand an object. A TOCTOU backstop trigger enforces
one-department-per-member-per-company
([`init.sql:216`](../../../../backend/migrations/20260612000000_init.sql)); the
app surfaces the clean 409.

---

## The polymorphic store (`entity_data`) vs. typed tables

Hybrid-C: builtins keep typed tables, **custom types live in one open JSONB
store** behind the generic `/api/objects/:type` handler.

```sql
CREATE TABLE entity_data (
  object_id text PRIMARY KEY REFERENCES entities ON DELETE CASCADE,
  type_id …, owner_id text REFERENCES users, scope_parent_id text REFERENCES entities, data jsonb …);
```
[`init.sql:284`](../../../../backend/migrations/20260612000000_init.sql)

- `data` is the open field bag; `owner_id` is the row's owner (also a membership
  edge, for the masking path).
- `scope_parent_id` is a **real FK** (#3). The create-time IDOR guard is the
  policy layer — a caller-supplied parent must be reachable at ≥ Member reach
  ([`objects.rs:97`](../../../../backend/crates/api/src/objects.rs)) — but the FK
  makes a dangling/foreign parent **unrepresentable** even for direct-DB writes
  and future code paths. The list reach clause keys off it
  ([`objects.rs:332`](../../../../backend/crates/api/src/objects.rs)).

Typed builtin subtype tables (all PK-FK into `entities`): `users`
([`init.sql:84`](../../../../backend/migrations/20260612000000_init.sql),
Google `sub` identity, scrub-and-retain deletion), `companies`/`teams`
([`init.sql:124`](../../../../backend/migrations/20260612000000_init.sql)),
`projects` ([`init.sql:145`](../../../../backend/migrations/20260612000000_init.sql)),
`cases` ([`init.sql:251`](../../../../backend/migrations/20260612000000_init.sql)),
`connectors` ([`init.sql:325`](../../../../backend/migrations/20260612000000_init.sql)),
`channels`/`messages` (the messaging builtins — a channel = a scoped entity, a
message = an entity scoped to its channel, so chat reuses the RBAC cascade with no
new authorization; [`messaging.sql:34`](../../../../backend/migrations/20260618000000_messaging.sql),
see [`messaging.md`](messaging.md)).
Supporting non-entity tables: `sessions` (self-GC on read,
[`db.rs:334`](../../../../backend/crates/api/src/db.rs)), `user_preferences`,
`user_sentinels`, `field_permissions` (sparse per-field overrides, defaults
derive from `perm_class`), `company_rbac` (append-only versioned contract),
`case_comments`, `case_attachments` (metadata-only, NOT an entity,
[`case_priority_attachments.sql:17`](../../../../backend/migrations/20260617000000_case_priority_attachments.sql)),
`channel_reads` (per-`(channel,user)` read cursor → unread counts).

---

## The file pipeline tables

A Project is a folder; a File is a File — `csv | chart | dashboard`
discriminated by `file_type`, **no reports/dashboards tables, ever** (the locked
2-entity model).

`project_files` ([`init.sql:158`](../../../../backend/migrations/20260612000000_init.sql)):
metadata only — `storage_path` (empty for chart/dashboard), `row_count`,
`col_count`, `cleanness_pct`, `encoding`, `columns_meta` (storage + semantic
dtype), `spec` (chart/dashboard config), `source_file_id` (lineage),
`is_public`/`is_favorite`. **Bytes never enter Postgres**: the visible frame is
always base-parse + replay of applied steps. The **one write path** is
`pipeline::upload_csv`; `insert_file` is module-private to it
([`pipeline.rs:243`](../../../../backend/crates/api/src/pipeline.rs)) — there is
no public `db::insert_file`, so the bypass the predecessor's connectors hit is
impossible by visibility, not convention.

`project_steps` ([`init.sql:182`](../../../../backend/migrations/20260612000000_init.sql),
UNIQUE `(file_id, ordinal)`): the non-destructive edit log. `kind` is an **open
string** (the `data::steps::apply` registry); `applied` toggles undo/redo (flip,
re-replay). `cleanness real` ([`step_cleanness.sql:8`](../../../../backend/migrations/20260615000000_step_cleanness.sql))
makes each step carry the score AS OF that step — the log **is** the score
trajectory (ordinal 0 = the upload baseline). Every upload writes an `original`
genesis step at ordinal 0 ([`pipeline.rs:276`](../../../../backend/crates/api/src/pipeline.rs)),
which `undo_step` pins by identity (`kind <> 'original'`,
[`db.rs:517`](../../../../backend/crates/api/src/db.rs)).

**Derived views** ([`init.sql:393`](../../../../backend/migrations/20260612000000_init.sql)),
derive-don't-store made executable: `file_stages`
(publish > design > clean > new, per file — a real cleaning step required, the
genesis excluded by [`file_stages_exclude_genesis.sql:8`](../../../../backend/migrations/20260615000001_file_stages_exclude_genesis.sql))
and `project_stages` (max stage of its files). Project stage and per-role cells
are never columns.

---

## System tables (NOT entities)

These record platform ops, carry no `register_entity` row and no RBAC cascade,
and are gated at the handler (platform-admin, leak-free 404).

- **Observability** ([`init.sql:349`](../../../../backend/migrations/20260612000000_init.sql)):
  `events` (id+at PK), `request_log`, `db_query_log` — all **time-partitioned by
  range at birth** (#8) with a `DEFAULT` partition; retention is meant to be DROP
  PARTITION, never DELETE. Writes are fire-and-forget from the app. `events` is
  also the case-activity store (`context->>'case'`, indexed) — never a parallel
  activity table.
- **The `audit` schema** ([`audit_monitoring.sql:23`](../../../../backend/migrations/20260617000001_audit_monitoring.sql)):
  a separate schema for the in-app audit trail behind the Monitoring page.
  `audit.run` (one row per audit-suite run: `payload` = the whole audit.json,
  `stats` = the human summary), `audit.finding` (the exploded
  `{file,line,rule,msg}` projection, PK `(run_id, finding_key)`), and the
  `audit.run_diff(cur, prev)` function that classifies each finding by
  `(kind, finding_key)` presence + severity delta into
  new/fixed/regressed/improved/unchanged. `tool` has **no CHECK** on purpose —
  the suite grows; a closed enum would force a migration per new tool.

---

## Conventions

- **Migrations** are one consolidated `init` + focused follow-ups, each header
  carrying the WHY (timestamp-named `YYYYMMDDHHMMSS_topic.sql`, applied in that
  order). Idempotent seeds use `ON CONFLICT DO NOTHING` against the shared dev DB.
- **Migrate on boot**: `sqlx::migrate!("../../migrations")` runs first in
  `AppState::new`, then `TypeDefCache::load` reads the freshly-seeded registry
  ([`state.rs:74`](../../../../backend/crates/api/src/state.rs)). The db helper
  layer uses **non-macro sqlx** throughout, so the crate builds without a live
  `DATABASE_URL`.
- **Derive, don't store.** Per-role field cells, project/file stage, global
  learned sentinels, report/dashboard are all derived. A second storage path for
  one concept is a bug, not a feature.

## Staged — codec shipped, consumer pending

- **Connector secret encryption.** The AEAD codec **is now live**:
  `crypto.rs` (`encrypt_secret`/`decrypt_secret`, AES-256-GCM, `v1:<base64(nonce‖ct‖tag)>`
  under `REDPASH_MASTER_KEY` + optional `_PREV`) with field-agnostic **dual-key rotation**
  (`rotate_value_in_place`, driven by the `redpash-rotate-secrets` bin). What's still
  unwired is the *consumer*: the connector **loader** that would write/read
  `connectors.config` is a gap (`api-route:connectors`; see [`connectors.md`](connectors.md)
  and the capability ledger), and `connector_jobs` (async sync) has no runner. So a
  plaintext secret in `connectors.config` is still "a Phase-4 audit failure, not a
  convention" ([`init.sql:320`](../../../../backend/migrations/20260612000000_init.sql)) —
  the encryption to enforce it now exists.
- **Retention.** The `redpash-retention` bin **now runs** the zero-risk pass: GC expired
  `sessions` (a plain `DELETE` — not partitioned) and reap **orphan blobs**
  (`<data_dir>/{files,attachments}/<rid>.bin` with no registry row, past a 1-hour
  in-flight grace). Still deferred: **DROP-PARTITION rotation** for
  `events`/`request_log`/`db_query_log` — they ship with a single `_default` partition,
  so real time-window retention needs a partitioning migration first (privacy F-C; see
  [`../../../privacy/assessment-2026-06-16.md`](../../../privacy/assessment-2026-06-16.md)).
