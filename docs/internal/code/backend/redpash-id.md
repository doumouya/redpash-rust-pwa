# RedPash-ID — `<PREFIX>_<32-hex>`, the PK on every row

RedPash-IDs (RIDs) are the primary key of every persisted row that matters: every
API `:rid` path parameter, log line, frontend route fragment (`#/workspace?file=FIL_…`),
and JSONB cross-reference uses them. There is **no separate internal integer/UUID PK** —
the RID *is* the PK (`redpash_id text PRIMARY KEY`, no DB default; the inserting handler
supplies it).

Source: [`id.rs`](../../../../backend/crates/api/src/id.rs). The minting scheme is
byte-identical across `main`, `prerelease`, and `lean`; this doc was **restored on lean**
— it had lived at `docs/db/redpash-id.md` on `main` and was dropped in the graduation.

## Format

```
FIL_5F3C7A21D8E94B6E92A1C0F4B3D7E0A2
^^^ ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
│   └─ 32-char UUID v4 (simple form, uppercase hex)
└── 3-char object-type prefix + `_` separator
```

| Segment | Length | Charset | Purpose |
|---|---|---|---|
| Prefix | 3 | `A–Z` | the object type (`FIL`, `USR`, …) — globally **unique per type** (day-one #1) |
| Separator | 1 | `_` | visual breakpoint; never appears in the body |
| Body | 32 | `0-9A-F` | `Uuid::new_v4().simple()`, upper-cased |

**36 chars, always uppercase, URL-safe, never reused.** The prefix makes the type
obvious at a glance in a log line or a URL.

## Generation

```rust
// backend/crates/api/src/id.rs
pub fn new(prefix: &str) -> String {
    let raw = Uuid::new_v4().simple().to_string().to_ascii_uppercase();
    format!("{prefix}_{raw}")
}
```

`Uuid::new_v4()` draws 122 bits of system randomness; `.simple()` renders 32 hex chars
(no dashes); `.to_ascii_uppercase()` upper-cases. 122 bits ⇒ collision is negligible, so
**there is no uniqueness-retry on PK conflict** — `id::new` is called once and inserted.

### Two mint paths

1. **Dedicated handlers** call `id::new("LITERAL")` for builtins with their own create
   flow: [`pipeline.rs`](../../../../backend/crates/api/src/pipeline.rs) (`FIL`/`CHT`/`DSH`/`ATT`),
   [`messaging.rs`](../../../../backend/crates/api/src/messaging.rs) (`CHN`/`MSG`),
   [`cases.rs`](../../../../backend/crates/api/src/cases.rs) (`CAS`/`CMT`),
   [`db.rs`](../../../../backend/crates/api/src/db.rs) (`USR`/`PRJ`/`SES`/`STP`),
   [`event.rs`](../../../../backend/crates/api/src/event.rs) (`EVT`).
2. **The generic registry** mints by the *type's* `rid_prefix` —
   [`objects.rs:109`](../../../../backend/crates/api/src/objects.rs): `let rid =
   id::new(self.rid_prefix(type_id)?)`. So `POST /api/objects/:type` allocates a
   correct-prefix RID for any registered type — the org-builtins (company / team /
   connection / preference) **and any future custom type** — with zero per-type code.
   This is the "database as a framework" payoff: a new type's IDs Just Work the moment
   its `type_definitions` row exists.

## The prefix registry

Prefixes are **globally unique per type** — day-one decision #1. The canonical source is
`type_definitions.rid_prefix` (a `UNIQUE` column); adding a type is a seed row, never a
migration on the PK (the column is `TEXT`).

### Registered entity types (recorded in `entities`, RBAC-eligible)

| Prefix | Type | Backing table | scope_parents |
|---|---|---|---|
| `USR` | user | `users` | — |
| `CMP` | company | `companies` | — |
| `TEM` | team | `teams` | company |
| `PRJ` | project | `projects` | company |
| `FIL` | file (csv) | `project_files` (`file_type='csv'`) | project |
| `CHT` | chart | `project_files` (`file_type='chart'`) | project |
| `DSH` | dashboard | `project_files` (`file_type='dashboard'`) | project |
| `CAS` | case | `cases` | company, project |
| `CON` | connection | `connections` | — |
| `CHN` | channel | `channels` | — |
| `MSG` | message | `messages` | channel |
| `PRF` | preference | registry (`entity_data`) | — |

`FIL` / `CHT` / `DSH` share **one** table (`project_files`, keyed by `file_type`) yet each
has its OWN prefix — exactly the trap day-one #1 closes (below).

### Non-entity prefixes (child / log / session rows — NOT in `entities`)

Minted by `id::new` but not registered types: no `type_definitions` row, no
`register_entity`, not RBAC objects in their own right — they inherit reach from a parent.

| Prefix | Row | Parent | Site |
|---|---|---|---|
| `SES` | session | user | `db::create_session` |
| `STP` | project step | file | `db::add_steps` / `pipeline.rs` |
| `CMT` | case comment | case | `cases::post_comment` |
| `EVT` | audit/event row | actor | `event::record` |
| `ATT` | case attachment | case | `pipeline.rs` (attachments) |

## Day-one #1 — why a unique prefix per type

> RID prefixes are unique per type. The predecessor shared `FIL_` between file and
> dashboard and resolved by registry ordinal — a permanent trap for anyone minting or
> parsing ids. — [`decisions/day-one.md` #1](../../../decisions/day-one.md)

Because every prefix is unique, `object_kind(rid)` is a 3-char prefix → type HashMap
lookup with **no disambiguation**
([`type_cache.rs`](../../../../backend/crates/api/src/type_cache.rs)). Parsing, routing,
and the polymorphic `memberships` edge all rely on that; a shared prefix would reintroduce
the ambiguity day-one #1 closed.

## Why UUID v4 and not Crockford base32 (how we picked it)

The historical Django predecessor used a 13-char Crockford-base32 id with an embedded
checksum — good for *hand-transcription*. The Rust rebuild deliberately switched to a raw
UUID v4 body because:

- **IDs are never typed by humans.** They live in URLs and copy-buttons; with no
  transcription, the checksum has no value to pay 13-char density for.
- **Collision is negligible** (2⁻¹²² per insert) — removing the uniqueness-retry-on-
  conflict the checksum scheme needed.
- **No new code.** `Uuid::new_v4()` ships with the `uuid` crate already in the workspace —
  no custom generator, no random-byte handling, no alphabet table to maintain.

The trade-off is length (36 vs 13 chars); they still fit a URL segment with no encoding,
and the prefix earns its keep in logs.

## The entities-registry handshake

For a *registered* type, the create path inserts the `entities` row FIRST, in the same
transaction as the subtype row, via the shared
[`db::register_entity(tx, rid, type)`](../../../../backend/crates/api/src/db.rs) helper —
the subtype's `redpash_id → entities.id` FK requires the registry row to exist already.
Delete goes the other way: `DELETE FROM entities WHERE id = $1` cascades the subtype row
and every edge that FKs into the registry. See [`schema.md`](schema.md) (Spine 1).

## Assignment · validation · URLs

- **Assigned at insert**, by the handler — never a DB default. `redpash_id` is `NOT NULL
  PRIMARY KEY` with no default, so a row can't exist without one, and it never changes
  after insert (no `UPDATE redpash_id` anywhere).
- **No validation function** (there's no checksum to verify). A malformed RID simply
  misses the index and returns no row → `AppError::not_found` (leak-free 404). If upfront
  validation is ever wanted: length 36, `[A-Z]{3}` + `_` + `[0-9A-F]{32}` (~10 lines, no
  regex needed).
- **Case-sensitive in URLs** — the column stores uppercase; the frontend never lowercases
  or trims and the backend never normalises (`/api/files/FIL_…`, `#/workspace?file=FIL_…`).
  A lowercased paste 404s.
