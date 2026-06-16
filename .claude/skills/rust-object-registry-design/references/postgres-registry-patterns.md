# Postgres → RedPash: the capstone — a data-driven object registry at DBMS scale

rustc, Polars, and wasm-bindgen are exemplars and constraints. **Postgres is the proof** — and the
closest of all, because RedPash *stores in Postgres*, so the registry it shipped is a smaller copy of a
mechanism already running underneath the app. A database is the most battle-tested kind of system there
is, and it does **not** hardcode its object model: it keeps the entire model — relations, types,
columns, functions — as rows in **system catalog tables**, seeds the builtins from a data file, and adds
new objects with an INSERT. `CREATE TABLE` never recompiles Postgres. That is exactly
`type_definitions`/`type_fields`/`entity_data`, one level up.

Source: the PostgreSQL `master` tree (C). Official manual: PostgreSQL 18 — **Ch. 53 "System Catalogs"**
and **§8.14 "JSON Types"**. (Em is reimplementing Postgres in Rust — [[experimental-db]] — so this
catalog architecture is one he studies directly.)

---

## The catalog IS the registry

Every object Postgres knows is a row in a `pg_*` catalog. The three that map 1:1 onto RedPash:

- **`pg_class`** — the **relation registry** (`src/include/catalog/pg_class.h`):
  `NameData relname; Oid relnamespace; Oid reltype; char relkind; int16 relnatts;` … Every table /
  index / view / sequence is one row. ↔ **`type_definitions`** (every object type is a row: `type_id`,
  `rid_prefix`, `is_builtin`, `grid_served`, `scope_parents`, …).
- **`pg_attribute`** — the **field registry** (`pg_attribute.h`):
  `Oid attrelid → pg_class; NameData attname; Oid atttypid → pg_type; int16 attnum; bool attnotnull;` …
  Every column is a row keyed by *(relation, name)*. ↔ **`type_fields`** *exactly*
  (`PRIMARY KEY (type_id, field)`, `ordinal`, `data_type`, `perm_class`, …). This is the most literal
  mapping in the whole skill — and note RedPash *also* derives extra display fields straight from
  `information_schema.columns` for the read-only registry types (`objects::registry_display_fields`),
  i.e. it reads the live `pg_attribute` equivalent to show the whole object.
- **`pg_type`** — the **type registry** (`pg_type.h`):
  `NameData typname; char typtype; char typcategory; regproc typinput; regproc typoutput;` … Every
  type — builtin, composite, enum, domain, **and `jsonb`** — is a row. ↔ the `data_type` codec id on
  `type_fields` + `type_definitions`.

## Four lessons, each already echoed by the other exemplars

1. **Register = INSERT, never recompile.** `CREATE TYPE`/`DOMAIN`/`ENUM` (`src/backend/commands/
   typecmds.c`) all call `TypeCreate(...)` → `CatalogTupleInsert(pg_type, …)` (`src/backend/catalog/
   pg_type.c`); `CREATE TABLE` does the same into `pg_class`/`pg_attribute` (`heap.c`). **`TypeCreate`
   is "a new `type_definitions` row"** at DB scale. RedPash ships exactly this: a new custom type is an
   INSERT into `type_definitions` (+ `type_fields`), no recompile — the `/api/objects/:type` handler and
   `/api/types` metadata pick it up live. This is the whole thesis stated by the most conservative
   software in the stack.

2. **Per-type behavior is dispatched through catalog-stored function refs — the providers pattern.**
   `pg_type` carries `typinput`/`typoutput` (`regproc` → `pg_proc`): the engine looks up a type's I/O
   *functions* in the catalog and calls them; it never `match`es on a hardcoded type list. Same shape as
   rustc's `Providers` and Polars' `ObjectRegistry`. RedPash's generic handler dispatches off the
   `type_definitions` row (storage via `type_cache::builtin_table`/`org_builtin`, RBAC via the generated
   cascade, fields via `type_fields`) — *register a row, don't grow a `match`*.

3. **Seed the builtins from a data file — the prefill pattern, a 4th time.** `pg_type.dat` is literally
   "Initial contents of the pg_type system catalog" (bool, int4, text, jsonb, …) loaded at bootstrap,
   then extended at runtime by `CREATE TYPE`. ↔ the init migration's `INSERT INTO type_definitions …`
   seeding the 9 builtins, then accepting custom types as rows. (rustc `Symbol::prefill`, wasm-bindgen
   `intern`, PG bootstrap — the same lesson keeps recurring.)

4. **JSONB is *just another registered type* — the escape hatch, validated.** `jsonb` is a normal row in
   `pg_type.dat` (`jsonb.c` provides its I/O); a typed DB still ships one open, structured, type-erased
   type for "shapes I wasn't told about at design time." ↔ **Hybrid-C**: typed tables for the builtins
   (`pg_class` rows with real columns) + `entity_data` JSONB for custom types — and that JSONB column is
   *Postgres's own* escape hatch, so `entity_data` isn't a workaround, it's using the catalog's intended
   valve. (Echoes Polars `DataType::Object`, the wasm JSON boundary.)

## Quick map

| Postgres | source / manual | RedPash |
|---|---|---|
| `pg_class` (relations are rows) | `pg_class.h` · Ch. 53 | `type_definitions` |
| `pg_attribute` (columns are rows) | `pg_attribute.h` · Ch. 53 | `type_fields` (literal) + `information_schema`-derived display fields |
| `pg_type` (types are rows; `typinput`/`typoutput`) | `pg_type.h` · Ch. 53 | `data_type` codec id + per-type dispatch |
| `TypeCreate → CatalogTupleInsert` (CREATE = INSERT) | `pg_type.c` · `typecmds.c` | a new `type_definitions` row (INSERT, no recompile) |
| `pg_type.dat` (bootstrap seed) | `src/include/catalog/pg_type.dat` | init migration `INSERT INTO type_definitions` (the 9 builtins) |
| `jsonb` is a catalog type | `pg_type.dat`, `jsonb.c` · §8.14 | `entity_data` JSONB / Hybrid-C escape hatch |

## Bottom line

The skill's whole argument — *store the object model as data, dispatch behavior through a registry, add
types by INSERT, keep one type-erased escape hatch* — is not a clever idea to be justified. It is **how
the database under RedPash already works**, proven across decades and every production Postgres on earth.
`type_definitions` + `type_fields` + `entity_data` is "a small `pg_class` / `pg_attribute` / `pg_type` /
`jsonb` for the app's own objects" — and in the lean rebuild it is shipped, not aspirational. When in
doubt about a registry change, ask: *how does `pg_catalog` do it?* — then do that, one level up.
