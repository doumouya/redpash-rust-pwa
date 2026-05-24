---
title: DataSource trait — sketch
section: Internal
order: 36
last modified date: 2026-05-24
owner: Gus
status: sketch
---

# DataSource trait — sketch

> **Status: sketch, not a build.** Em + Gus + Torv aligning on the
> shape of the data-source abstraction before the [[etl-elt-roadmap]]
> workstream picks it up. No code lands from this doc. The trait
> names, method signatures, and capability bits are starting points
> — push back on anything that looks wrong.

## Why this exists

Today RedPash has **one** kind of data source: a CSV/Excel file
parsed into a Polars `DataFrame`, persisted as a `project_files` row,
hydrated on first access via [`routes::files::hydrate`](../../backend/crates/api/src/routes/files.rs).
Every read path (paged rows, distinct values, joins detect, exports)
calls into the same hot frame.

The [[etl-elt-roadmap]] memory commits to growing this:

> "far-future: after flat-files, connect databases directly and evolve
>  into an ETL/ELT tool; own Postgres is the first test target; prefer
>  Rust-native connectors over JVM-backed JDBC"

When that lands, a project will contain **a mix** of:

- CSV / Excel files (current)
- Live Postgres tables
- Google Sheets / Excel-online
- S3 / object-store Parquet
- Remote API JSON endpoints

Each one needs to answer the same questions — *give me rows 0-99
sorted by `created_at` desc filtered by `status='active'`* — but the
backend that answers differs wildly (Polars filter in-process vs a
SQL `WHERE` round-trip vs a REST API paginate-loop).

The Linux VFS solves the exact analogous problem at the kernel boundary:
unify the userspace API behind a stable interface, dispatch to
filesystem-specific implementations through method-pointer tables.
We borrow the **pattern**, not the kernel-specific bits.

## VFS parallel

| VFS abstraction | RedPash analog |
|---|---|
| `super_block` (mounted filesystem instance) | `Source` — one connected data domain (a file, a DB connection, a Sheets workbook) |
| `super_operations` (mount-level ops: sync, statfs, …) | `SourceOps` — connect, describe, capabilities, health |
| `inode` (filesystem object: file, dir, …) | `Entity` — one table-like thing inside the Source (a CSV file, a Postgres table, a Sheet tab) |
| `inode_operations` (per-object metadata ops) | `EntityOps` — meta, schema, acl, open, rename, delete |
| `file` (open handle on an inode) | `Reader` — an active query-execution handle bound to one Entity |
| `file_operations` (read/write/seek/…) | `ReaderOps` — page, summary, distinct, export |
| `dentry` (path→inode cache) | the hydrate cache + ownership-resolved rid lookup we already have |

The key VFS insight we're stealing: **method-pointer indirection
lets multiple implementations coexist without the caller knowing
or caring which one is in play.**

## The three traits

### 1. `Source` — one connected data domain

Lifetime: bound to a connection / file mount. One `Source` instance
might back many entities (a Postgres connection → all tables in that
connection; a CSV upload → one file/one entity).

```rust
trait Source {
    fn id(&self) -> &str;              // RedPash ID (SRC_*)
    fn kind(&self) -> SourceKind;      // enum (LocalFile|Postgres|Sheets|...)
    fn caps(&self) -> Capabilities;    // what this source can push down

    async fn describe(&self) -> Result<SourceDescribe>;
    //   returns: { entities: [{ id, name, kind, schema }, ...] }

    async fn health(&self) -> Result<Health>;
    //   freshness, last_sync, error state — drives the UI's source-status dot
}
```

`SourceKind` is an enum because the set is known at compile time
today and grows by recompile, not by plugin. Switching to
`Box<dyn Source>` is a follow-up if/when third-party plugins land.

### 2. `Entity` — one table-like thing inside a Source

The unit a redtable opens. Today's `project_files` row maps 1:1.

```rust
trait Entity {
    fn id(&self) -> &str;              // RedPash ID — today FIL_*, future TBL_*/SHT_*/...
    fn source(&self) -> &dyn Source;
    fn name(&self) -> &str;
    fn schema(&self) -> Result<Vec<ColumnMeta>>;   // existing shared::file::ColumnMeta

    async fn open(&self, ctx: ReadContext) -> Result<Box<dyn Reader>>;

    // Mutations — Option<…> because some sources are read-only.
    // A Postgres table might support PATCH; a Google Sheet might
    // support row-insert but not column-rename; a REST source
    // returns None for every mutation.
    async fn rename(&self, name: &str) -> Result<()>;
    async fn delete(&self)                -> Result<()>;
}
```

`ReadContext` carries the resolved user + session state for ACL
gating (RBAC's eventual hook, per [[rbac-corporate-ready]]).

### 3. `Reader` — an open handle bound to an entity

The thing the redtable + cleaner + designer reads from. Drops
when the session ends (or sooner, under cache pressure).

```rust
trait Reader {
    async fn page(&mut self, query: Query) -> Result<Page<Row>>;
    //   Query is the redtable AST — filter / sort / search / pagination.
    //   Matches the existing [[redtable-query-builder]] shape.

    async fn distinct(&self, col: &str, q: Option<&str>, limit: usize)
        -> Result<DistinctResult>;
    //   the primitive we just shipped (commit 34445ce) generalized
    //   to any source.

    async fn summary(&self) -> Result<EntitySummary>;
    //   columns + row_count + stats.

    async fn export(&self, format: ExportFormat) -> Result<Bytes>;
    //   CSV/Excel/JSON — bytes ready to stream to the client.
}
```

## Capability declaration

Sources don't all support the same operations. The redtable's
query AST gets compiled differently per backend depending on what
can be **pushed down** vs what we have to do **locally**.

```rust
#[derive(Default, Clone, Copy)]
struct Capabilities {
    push_filter:    bool,   // WHERE / equivalent — Polars yes, Sheets no
    push_sort:      bool,   // ORDER BY / equivalent
    push_limit:     bool,   // LIMIT/OFFSET / pagination
    push_search:    bool,   // ILIKE / fulltext / equivalent
    push_join:      bool,   // can join two entities server-side
    push_aggregate: bool,   // GROUP BY / equivalent
    write:          bool,   // mutations allowed?
    schema_evolves: bool,   // can columns change while we're reading?
}
```

When a capability is false, the AST executor falls back to:

- **page the entity locally**, then apply the unsupported op in
  Polars in-process. Costs RAM but works.

The CSV/Excel source has every push-down set to `true` because we
hydrate the whole frame already and Polars handles it natively.
The Postgres source sets everything true. The Sheets source sets
`push_filter=false push_sort=false` — every read is a row-range
paginate, filters happen client-side after the page lands.

This is the load-bearing piece: **the query planner reads `caps()`
and routes work to the right side**. Without it the abstraction
falls apart on the first source that can't push down something
expensive.

## Migration path

Not a refactor we do now. Sequencing when it does land:

1. **Phase 0 (today):** one source kind (local file). The traits
   above don't exist; `routes::files::*` calls `data::*` directly.
   This works.

2. **Phase 1 (when second source kind needs to land):** introduce
   the three traits. Local file becomes the first impl. The
   existing `routes::files::*` paths refactor to go through
   `Reader` operations instead of direct `data::*` calls. No
   external behaviour change — same wire shape.

3. **Phase 2:** add the second source (per [[etl-elt-roadmap]],
   own Postgres is the test target). Capability flags differentiate;
   the query planner reads them; the redtable behaves the same on
   either source.

4. **Phase 3+:** Sheets, S3, API endpoints land as new `SourceKind`
   variants without touching the caller surface.

The Phase-1 refactor is the only cost. Phase 0 → 1 should land
*before* Phase 2 starts so the second source has a stable interface
to plug into, not a moving target.

## What this doc explicitly DOESN'T commit to

Per [[refactor-decompose]] and [[no-code-debt]]:

- **No new Rust code lands from this doc.** It's a sketch.
- **No new wire DTO.** Existing `Page<Row>`, `ColumnMeta`,
  `DistinctResult` shapes are the canonical wire — the trait
  layer slots underneath them, doesn't replace them.
- **No timeline.** Lands when ETL/ELT becomes a real workstream,
  not before.
- **No plugin / dynamic-dispatch architecture.** Static enum
  dispatch for the lifetime of v1. Plugins are a future-future
  concern.
- **No source-discovery / registry mechanism.** Sources are
  registered by hand in code when their kind variant lands.
- **No ACL enforcement spec.** The `ReadContext` parameter is the
  hook RBAC will read from when [[rbac-corporate-ready]] lands;
  what the actual policy looks like belongs in that spec, not
  this one.

## Open calls for Torv (FE-side implications)

The query AST + the `caps()` map are the load-bearing FE concerns:

1. **Does the redtable need to know `caps()`?** Or is the push-down
   decision fully server-side and the FE just sends the AST?
   *(My read: fully server-side. The FE shouldn't change behaviour
   per source — same controls, same response. The planner hides
   it.)*

2. **Source-status surface.** If a Sheets source goes stale
   (sync failed, token expired), the redtable needs a UI affordance
   to surface that without breaking the read. Maps to a
   `Source::health()` indicator dot somewhere on the file rail.

3. **Writes-disabled sources.** When `caps().write=false`, the
   workspace's edit/select/delete modes need to render disabled
   with a tooltip ("read-only source: Google Sheet"). That's a
   per-page-mount check, not per-tool.

Push back on any of the three traits, the cap shape, or the
phase sequencing. The point of this doc is to find the disagreements
*before* Phase 1 picks it up.

— Gus
