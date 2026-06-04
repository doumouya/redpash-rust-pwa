# Postgres → RedPash: the capstone — a data-driven object registry at DBMS scale

rustc, Polars, and wasm-bindgen are exemplars and constraints. **Postgres is the proof** — and the closest of
all, because RedPash *stores in Postgres*, so the registry you're building is a smaller copy of a mechanism that
is already running underneath the app. A database is the most battle-tested kind of system there is, and it does
**not** hardcode its object model: it keeps the entire model — relations, types, columns, functions — as rows in
**system catalog tables**, seeds the builtins from a data file, and adds new objects with an INSERT. `CREATE
TABLE` never recompiles Postgres. That is exactly `type_definitions`/`type_fields`/`register_type`, one level up.

Source: `postgres-rp-master.zip` (upstream PostgreSQL `master`, C). Official manual: the PG 18 PDF Em supplied at
`/mnt/c/Users/edoum/OneDrive/Documents/dbt training/postgresql-18-US.pdf` — **Ch. 53 "System Catalogs"** and
**§8.14 "JSON Types"**. (Em is reimplementing Postgres in Rust — [[experimental-db]] — so this catalog
architecture is one he's studying directly.)

---

## The catalog IS the registry

Every object Postgres knows is a row in a `pg_*` catalog. The three that map 1:1 onto RedPash:

- **`pg_class`** — the **relation registry** (`src/include/catalog/pg_class.h:34`):
  `NameData relname; Oid relnamespace; Oid reltype; char relkind; int16 relnatts;` … Every table / index / view /
  sequence is one row. ↔ **`type_definitions`** (every object type is a row: `type_id`, `rid_prefix`, `is_builtin`, …).
- **`pg_attribute`** — the **field registry** (`pg_attribute.h:39`):
  `Oid attrelid → pg_class; NameData attname; Oid atttypid → pg_type; int16 attnum; bool attnotnull;` … Every
  column is a row keyed by *(relation, name)*. ↔ **`type_fields`** *exactly* (`type_id`, `field`, `data_type`,
  `perm_class`, …). This is the most literal mapping in the whole skill.
- **`pg_type`** — the **type registry** (`pg_type.h:38`):
  `NameData typname; char typtype; char typcategory; regproc typinput; regproc typoutput;` … Every type — builtin,
  composite, enum, domain, **and `jsonb`** — is a row. ↔ the `data_type` / codec system + `type_definitions`.

## Four lessons, each already echoed by the other exemplars

1. **Register = INSERT, never recompile.** `CREATE TYPE`/`DOMAIN`/`ENUM` (`src/backend/commands/typecmds.c`) all
   call `TypeCreate(...)` → `CatalogTupleInsert(pg_type, …)` (`src/backend/catalog/pg_type.c:154/488`); `CREATE
   TABLE` does the same into `pg_class`/`pg_attribute` (`heap.c`). **`TypeCreate` is `register_type`** at DB scale.
   This is the whole thesis stated by the most conservative software in the stack.

2. **Per-type behavior is dispatched through catalog-stored function refs — the Providers pattern.** `pg_type`
   carries `typinput`/`typoutput` (`regproc` → `pg_proc`): the engine looks up a type's I/O *functions* in the
   catalog and calls them; it never `match`es on a hardcoded type list. Same shape as rustc's `Providers`, Polars'
   `ObjectRegistry`, and our `validate_rules`/`codec_registry` — *register a provider, don't grow a `match`.*

3. **Seed the builtins from a data file — the prefill pattern, a 4th time.** `pg_type.dat` is literally "Initial
   contents of the pg_type system catalog" (bool, int4, text, jsonb, …) loaded at bootstrap, then extended at
   runtime by `CREATE TYPE`. ↔ `seed_builtins` seeding the 7 builtin `type_definitions` then accepting custom
   types. (rustc `Symbol::prefill`, wasm-bindgen `intern`, PG bootstrap — the same lesson keeps recurring.)

4. **JSONB is *just another registered type* — the escape hatch, validated.** `jsonb` is a normal row in
   `pg_type.dat` (`jsonb.c` provides its I/O); a typed DB still ships one open, structured, type-erased type for
   "shapes I wasn't told about at design time." ↔ **Hybrid-C**: typed tables for the builtins (`pg_class` rows with
   real columns) + `entity_data` JSONB for custom types — and that JSONB column is *Postgres's own* escape hatch,
   so `entity_data` isn't a workaround, it's using the catalog's intended valve. (Echoes Polars `DataType::Object`,
   wasm `JsValue`.)

## Quick map

| Postgres | source / manual | RedPash | 
|---|---|---|
| `pg_class` (relations are rows) | `pg_class.h:34` · Ch. 53.11 | `type_definitions` |
| `pg_attribute` (columns are rows) | `pg_attribute.h:39` · Ch. 53.7 | `type_fields` (literal) |
| `pg_type` (types are rows; `typinput`/`typoutput`) | `pg_type.h:38` · Ch. 53.64 | type/codec registry + per-type providers |
| `TypeCreate → CatalogTupleInsert` (CREATE = INSERT) | `pg_type.c:195` · `typecmds.c` | `register_type` (INSERT, no recompile) |
| `pg_type.dat` (bootstrap seed) | `src/include/catalog/pg_type.dat` | `seed_builtins` (prefill) |
| `jsonb` is a catalog type | `pg_type.dat`, `jsonb.c` · §8.14 | `entity_data` JSONB / Hybrid-C escape hatch |

## Bottom line

The skill's whole argument — *store the object model as data, dispatch behavior through a registry, add types by
INSERT, keep one type-erased escape hatch* — is not a clever idea to be justified. It is **how the database under
RedPash already works**, proven across decades and every production Postgres on earth. `type_definitions` +
`type_fields` + `register_type` + `entity_data` is "build a small `pg_class` / `pg_attribute` / `pg_type` / `jsonb`
for the app's own objects." When in doubt about the registry design, ask: *how does `pg_catalog` do it?* — then do
that, one level up.
