# GlueSQL-over-CSV vs Polars — spike verdict

*"A SQL database you query, not a compute library you call." Literally tried it.
Native `--release`, GlueSQL `MemoryStorage` (the wasm-viable backend), all-TEXT
schema, same corpus as the Polars bench (`results-wide.json`). W=2/K=6 median.*

## The data

| axis | **GlueSQL** (memory) | **Polars** (wasm) | winner |
|---|--:|--:|---|
| **wasm binary** | **3.4 MB / 1.0 MB gz** | 27 MB / 6.0 MB gz | **GlueSQL — 8× / 5.7×** |
| **cold compile** (est. ∝ bytes) | **~11 ms** | ~84 ms | **GlueSQL** |
| load 100k CSV | 1730 ms | 200 ms | Polars ~9× |
| page (`LIMIT 100`) @100k | 75 ms | 1.4 ms | Polars ~50× |
| sort @100k (full) | 310 ms | 8.7 ms | Polars ~36× |
| **`COUNT(*) WHERE`** (full scan) @100k | **3394 ms** | ~free | Polars hugely |
| filter-page / search-page (`LIMIT`) | 75 / 126 ms | 28 / 284 ms | mixed (LIMIT early-stops) |
| **indexes (on wasm storage)** | **NONE** — `MemoryStorage` rejects `CREATE INDEX` | n/a | — |
| **mutations** `UPDATE`/`DELETE` | ✅ works | ✗ frames are immutable | **GlueSQL** |
| **SQL surface** | full DML + DDL + JOIN + txn | read-only SELECT (polars-sql) | **GlueSQL** |

## The six questions, answered

1. **Compiles to wasm32, how small?** ✅ Yes — **3.4 MB / 1.0 MB gz, 8× smaller than Polars.** The startup win is real.
2. **Per-op latency?** Much slower on the analytical ops: load ~9×, page ~50×, sort ~36×, full-scan count catastrophic (3.4s @100k).
3. **The index thesis?** ❌ **Fails on the client.** `CREATE INDEX` is in the SQL surface, but **`MemoryStorage` — the only wasm-compatible backend — doesn't support it.** Indexes live in `sled`/`redb` (filesystem/native, won't wasm). So on wasm, every `WHERE`/`ORDER BY`/`COUNT` is a **full row scan**. (And `LIKE '%x%'` can't use an index in *any* DB — search is always a scan.)
4. **Load cost?** 1.7 s @100k (bulk INSERT through the SQL parser) vs Polars' 0.2 s columnar parse. Amortizes over many queries, but the upload pays it.
5. **Mutations?** ✅ `UPDATE … WHERE` + `DELETE … WHERE` both work — **the capability Polars frames fundamentally lack** (the redtable's edit/delete modes want exactly this).
6. **Types?** CSV → table is **all-TEXT** unless you declare a schema; numeric sort/filter would need an explicit typed `CREATE TABLE` + typed load.

## Verdict — it's not GlueSQL *or* Polars. It's both, by role — exactly your Postgres framing.

> **"We don't do calculation with Postgres."** Right — and the data says do the same here: **GlueSQL is the client's Postgres** (a small, mutable, queryable SQL *store*), and **Polars is the calculation engine** (the heavy analytical compute you *don't* do in the database).

- **GlueSQL wins the database role**: 1 MB gz (near-instant startup), full SQL, and **mutations** — a genuine on-device SQL database, the edge-DB floor, *far* lighter than pglite. The "query, don't compute" mental model is sound and it's real.
- **Polars wins the compute role decisively** — columnar + (native) multi-threaded; 10–50× faster on load/scan/sort/aggregate, and **that speed is the moat vs the JVM market.** Without indexes on wasm, GlueSQL can't touch it for crunching.
- **So the engine doesn't get replaced — it gets a partner.** Light queries over a *reasonable* working set (page/filter/sort where sub-second scans are fine) → GlueSQL SQL. Heavy lifting (clean/`score`/big aggregate/500k scan) → Polars. Persistence + edits → GlueSQL.

## Follow-ons (if the database direction is pursued)

1. **`gluesql-idb-storage` index test** — IndexedDB *might* support `CREATE INDEX` (memory doesn't). If it does, the client gets indexed selective queries (your thesis, recovered) — at the cost of async + persistent-store latency. This is the single most important next measurement.
2. **Faster load** — the 1.7s is SQL-string-INSERT overhead; a direct row-insert / `StoreMut::append` path or a typed bulk-load could cut it materially. Measure.
3. **Typed schema** — declare column types (not all-TEXT) for correct numeric sort/filter + smaller storage.
4. **Async-in-wasm** — GlueSQL is async; wasm needs `wasm-bindgen-futures` (no `block_on`). Real integration cost for the eventual engine.

*Artifacts: `experiments/gluesql-spike/` (native bench) · `experiments/gluesql-wasm/` (3.4 MB wasm build).*

---

## Follow-up: the `gluesql-idb-storage` (IndexedDB) spike — for the *versioning* lane

*Browser (Chrome), wasm = 3.0 MB, real IndexedDB, async. The gating test for
"GlueSQL for update/delete" + the git-for-data direction.*

| question | result |
|---|---|
| **wasm-compiles?** | YES — 3.0 MB (lean; same class as the memory build) |
| **persists across reload?** | **YES** — wrote 1000 rows, `UPDATE id=5`, `DELETE id=6`; after a full page reload (fresh wasm, no re-insert) read back **999 rows + 1 edited**. Durable. |
| **mutations?** | `UPDATE`/`DELETE` work *and persist* |
| **`CREATE INDEX`?** | **UNSUPPORTED** — `Index::create_index is not supported`. idb rejects it too, so NO wasm-viable storage indexes (memory + idb both refuse; indexes are native sled/redb only). |
| **speed** | ~100x slower than memory: **1.76 s to load 1000 rows**, ~1 s to read 2 counts. IndexedDB async-txn-per-write overhead. Bulk-loading a dataset (~180 s/100k) is impractical. |

### What the data says about "GlueSQL for update/delete"

YES — but as the durable MUTATION/VERSION LOG, not the bulk data store. idb is far too
slow to hold the working dataset (and can't index it), but it's fine for small, incremental,
durable writes — which is exactly what a version history is. The granularity the data points to:

- Polars = the fast working copy (query / compute / display). The data rows live here.
- GlueSQL = the change log — each edit is one small `UPDATE`/`INSERT` (a few ms), the log
  IS the commit history, idb makes it survive reload (proven). Server-side `git-storage`
  (or `project_steps` generalized to data) holds the canonical history.

This is git-for-data done right: GlueSQL records the commits (durable, branchable); Polars is
the working tree. Mirrors RedPash's existing `project_steps` (a replayable recipe log),
extended to the data itself. The bulk dataset never goes into idb; only the diffs do.

### Net

`CREATE INDEX` is dead on the client (both storages refuse) -> GlueSQL is NOT the client's
query engine. But it IS the client's durable, mutable version-log store — small writes,
persists across reload, the substrate for branch/diff/revert on data. Use it for the commits,
keep Polars for the working tree, keep heavy compute out of both.
