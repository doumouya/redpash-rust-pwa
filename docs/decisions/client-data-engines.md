# Client data engines — roles by job (and the GlueSQL evaluation)

The browser carries data engines by **role**, mirroring the server's
Postgres↔compute split. This record locks which engine does what, and why —
settled by measurement (the GlueSQL native + IndexedDB spikes + a source audit),
not preference. Picking the wrong engine for a job is the trap this record exists
to prevent; changing a role is an Em-level decision, not a refactor.

## The decision (locked)

1. **Polars (wasm) — the WORKING TREE + the COMPUTE engine.** Columnar,
   vectorised. Holds the data rows the user sees; runs every scan / sort /
   aggregate / `score` / clean, plus read-only SQL (`Workbook.sql` → Polars
   `SQLContext`; shipped, client result `==` server, ~3.8× faster on the real
   389k file). Frames are **immutable**. This is the moat vs the JVM market; not
   replaceable on the crunch path.
2. **GlueSQL (wasm, IndexedDB) — the durable MUTATION / VERSION LOG**
   *(evaluated; NOT yet adopted)*. ~1 MB gz. NOT a query engine and NOT the
   working store — it is too slow for either (see findings). Its one fit: a
   **small, incremental, durable write log** — each edit is one tiny
   `INSERT`/`UPDATE` that survives reload. **git-for-data**: GlueSQL records the
   commits (durable, branchable); Polars is the working tree; the bulk dataset
   never enters it — only the diffs do.
3. **Server Postgres — the indexed source-of-record + canonical history.** Real
   indexes, real transactions, the truth. Selective queries over big data, and the
   canonical commit history (`project_steps` generalised to data), resolve here.

> "We don't do calculation with Postgres." Same on the client: GlueSQL records
> change (mutate/persist/version), Polars computes (the working tree), and neither
> replaces the other. Keep heavy compute out of both the log and the database.

## What locked it (the findings)

- **Compute is Polars, decisively** (native spike + size-sweep, `MemoryStorage`,
  all-TEXT, same corpus as the Polars bench): load ~9×, page ~50×, sort ~36× vs
  Polars, and unbounded full-scan aggregates fall off a cliff. GlueSQL cannot
  touch columnar for crunching.
- **No indexes on ANY wasm GlueSQL backend** — confirmed two ways. *Source*
  (gluesql 0.19.0): `MemoryStorage` and `idb-storage` both ship `impl Index {}` /
  `impl IndexMut {}` — empty → unsupported; indexes live only in `sled`/`redb`
  (native, won't wasm). *Runtime* (browser spike): `idb` returns
  `Index::create_index is not supported`. So on the client **every `WHERE` /
  `ORDER BY` / `COUNT` is a full scan** — no off-the-shelf indexed-query path.
- **The two wasm backends split, and neither is a working store.**
  `MemoryStorage` is fast-ish but **ephemeral** (lost on reload) and implements
  `Store + StoreMut + Transaction + AlterTable`. `idb-storage` **persists** but is
  **~100× slower** (1.76 s to load 1000 rows; ~180 s/100k — bulk load is
  impractical) and implements only `Store + StoreMut` (txn/alter/index all empty).
  So: fast-but-ephemeral OR durable-but-slow — there is no persistent fast query
  store. That is *why* the only sound role is the small durable write log.
- **Mutations persist (proven).** Browser spike: wrote 1000 rows, `UPDATE id=5`,
  `DELETE id=6`; after a full reload (fresh wasm, no re-insert) read back **999
  rows + 1 edited**. The capability Polars frames fundamentally lack — and exactly
  what a version history needs.
- **Polars SQL shipped read-only** (`Workbook.sql`). Cost accepted: reaching the
  SQL planner pulls it into the bundle, +~7 MiB raw / +~1 MiB gz.

**Size boundary (GlueSQL `MemoryStorage`, all-TEXT — sweep, wide×20col):**

| rows | load (INSERT) | page (LIMIT) | eq-filter (LIMIT) | sort (LIMIT) | **COUNT WHERE (full scan)** |
|---|--:|--:|--:|--:|--:|
| 1k | 29 ms | 0.8 ms | 1 ms | 3 ms | 35 ms |
| 10k | 276 ms | 8 ms | 12 ms | 33 ms | 319 ms |
| 50k | 1.0 s | 40 ms | 62 ms | 162 ms | **1.6 s** |
| 100k | 1.9 s | 70 ms | 94 ms | 306 ms | **2.7 s** |

Polars @100k for contrast: page ~1.4 ms, sort ~8.7 ms — **50× / 35× faster, and
flat** where GlueSQL climbs linearly. Even `MemoryStorage` (the *fast* backend)
only holds a LIMIT-bounded read snappy to ~50–100k, and any unbounded full-table
aggregate crosses ~1 s by ~40–50k. `idb` (the persistent backend) is ~100× slower
again — which is the whole reason it's a *log*, not a store.

## Use-case guidance

| job | engine |
|---|---|
| scan / sort / aggregate / score / clean / big data | **Polars** (or server) |
| read-only SELECT preview over the open file | **Polars** (`Workbook.sql`, shipped) |
| the working dataset the user queries + edits | **Polars** (working tree) |
| durable edit / version log — small incremental writes, survive reload | **GlueSQL (idb)** — git-for-data |
| canonical history, indexed / selective query over big data | **server Postgres** |

## Status + open measurements

- **Polars read-only SQL console: SHIPPED** (`Workbook.sql` + the window-source
  seam + the editor; commits aedd8a1, a53c9aa).
- **GlueSQL-client: ADOPTED 2026-06-16** — as the **on-device customer-data store**
  (Em's "GlueSQL InnoDB version"): durable + queryable in the user's browser via
  IndexedDB, the data home that keeps customer data OFF our servers. A connector
  pull is a server *conduit* → CSV → the client's GlueSQL ingests a queryable
  table (ETL). **Polars stays the compute/working engine** — GlueSQL is never the
  crunch path, only durable persistence + light SQL over the resident set. Shipped:
  `frontend/wasm-src/gluesql/` → `frontend/wasm/gluesql.js` (~1 MB gz; `ingest_csv`
  / `query` / `drop_table`). See `project-innodb-data-store`.
  *(Supersedes the original scoping below — GlueSQL-idb went from "version-log only,
  not adopted" to the adopted data store; the git-for-data change-log is a future
  role layered atop it.)*
  > ~~NOT adopted — scoped as the git-for-data version-log future; never the query
  > or compute path.~~ (original 2026-06-13 stance)
- **Resolved:** ~~idb-storage index test~~ → no (empty `Index`/`IndexMut`; source
  0.19.0 + browser spike). The single most-important open measurement is closed.
- **Still open** (only if the version-log direction is pursued): a faster durable
  write path (`StoreMut::append` vs INSERT-string); typed schema vs all-TEXT;
  async-in-wasm integration (`wasm-bindgen-futures`, no `block_on`); the commit/diff
  data model bridging GlueSQL ↔ Polars ↔ server `project_steps`.

*Evidence: `experiments/gluesql-spike/RESULTS.md` (native bench + IndexedDB
browser spike) · `experiments/gluesql-wasm/` (3.0–3.4 MB wasm build) · gluesql
0.19.0 source (idb-storage `Index`/`IndexMut` empty). Consistent with
`day-one.md` ("Rust owns data, JS owns pixels"; bytes-immutable + steps-replayed;
the one-`FilterNode`/`QuerySpec` contract).*
