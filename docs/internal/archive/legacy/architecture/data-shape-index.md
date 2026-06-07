---
title: Data-shape index — architecture
section: Internal
order: 19
last modified date: 2026-05-24
owner: Torv + Gus (joint)
status: sketch — alignment, not implementation
---

# Data-shape index

> **Status: alignment artifact, not a deliverable.** This doc records
> the architectural picture Torv + Gus + Em landed on 2026-05-24
> after a chain of conversations (joins UI → filter predicates →
> distinct-values endpoint → column-index primitive → 3-redtable
> reuse → PWA-FS sketch → DataSource trait). No code lands from it.
> Implementation sequences out of the polish + auth-audit lanes;
> this doc shapes the picture both lanes will eventually serve.

## §1 — Single mental model for data-shape access

The load-bearing sentence: **the workspace's foundational data model
isn't "the file" — it's a *data-shape index* with three orthogonal
projections, accessed through a uniform abstraction every surface
shares.**

That's the picture. Every consequence in this doc derives from it.

The picture is honest about its boundary: this is a **data-plane**
abstraction. Control-plane endpoints (admin lists, monitoring stats,
preference reads, `/api/me`) stay plain REST — they're cheap,
short-lived, and don't share the open-handle / eviction / mtime-
cache lifecycle that makes the data-shape index valuable. Forcing
control planes into the same abstraction is ceremony without
benefit; the index earns its complexity where it actually helps.

### What this doc is NOT

- A schema change. Existing wire DTOs (`Page<T>`, `ColumnMeta`,
  `DistinctResult`, `FileEnvelope`) stay canonical.
- A rewrite. The picture composes additively over the existing
  hydrate cache + route surface; call sites don't move.
- A universal religion. Data planes only. Control planes stay
  REST.
- A timeline commitment. The picture lands when concrete consumers
  pull on it (per [[refactor-decompose]]); not before.

### Related docs

- [[redtable-unification]] (WS#5) — one atom, N consumers. This
  doc is the *data* layer underneath that atom — same uniformity
  story, one level down.
- [[columns-redtable]] — Table 1 of the 3-table model shipped as
  a feature. Spec describes it as a UI; this doc describes it as
  one projection of the index.
- [[datasource-trait]] — the **backend half** of the VFS borrow
  (Source / Entity / Reader). This doc's PWA-FS section is the
  **frontend half**. Both spec sketches; both land when ETL/ELT
  becomes a real workstream.
- [[rbac-corporate-ready]] — the workstream this enables. The
  data-plane FS layer provides one of two RBAC enforcement
  choke-points (the other is `ensure_owner` for control planes;
  the [[auth-audit]] tool ensures consistency).
- [[js-refactor-targets]] — the LRU + column-index work that
  lands the first concrete consumer.

## §2 — The 3-redtable model

Three orthogonal projections of any data source. Each is a
redtable in its own right (rows + cols + cells); each has its
own consumers; each gets the same `.rt-surface` atom from
[[redtable-unification]].

### Table 1 — Columns × stats (one row per field)

| Field | Type | Source |
|---|---|---|
| name | string | `ColumnMeta.name` |
| dtype (storage) | string | `ColumnMeta.dtype` |
| semantic_dtype | string | `ColumnMeta.semantic_dtype` |
| null_pct | f32 | `ColumnMeta.null_pct` |
| unique_pct | f32 | `ColumnMeta.unique_pct` |
| sample | string | `ColumnMeta.sample` |
| sentinel_count | u32 | sentinel scan (existing) |

**Wire shape:** already in `FileEnvelope.columns: Vec<ColumnMeta>`.
No new endpoint.

**Consumers:**
- ✓ Cleaning Tools panel ([[columns-redtable]])
- ✓ Filter UI dtype-aware ops (predicate UI v688)
- ✓ Designer chart-source picker
- → Future: report builder column picker, autocomplete value coercion

### Table 2 — Columns × distinct values (N tables, one per field)

| Field | Type | Notes |
|---|---|---|
| value | string | distinct stringified |
| (count) | u32 | implicit ordering — top-N-by-frequency, see [[joins-lane]] |

**Wire shape:** `GET /api/files/:rid/uniques?col=X&q=&limit=N`
returning `{ values, total, truncated }`. Live as of `34445ce`.

**Consumers:**
- ✓ Cleaner filter-dropdown (legacy)
- → In flight: filter predicate autocomplete (eq/neq/contains/
  starts_with/ends_with)
- → In flight: chip-picker for `in` / `not_in` ops
- → Future: search-bar autocomplete, designer enum-axis picker,
  joins overlap detector (already uses the underlying primitive)

**Cap:** `MAX_UNIQUE = 5000` per column. Semantically meaningful
because top-N-by-frequency = the values most likely to be typed.
ID columns hit the cap; for those, autocomplete is least useful
anyway (user pastes, doesn't browse). Joins detection is
*strengthened*, not weakened, by the frequency ordering — see
[[joins-lane]].

### Table 3 — Rows × quality flags (one row per file row)

| Field | Type | Source |
|---|---|---|
| row_idx | u32 | the absolute row index |
| is_fully_null | bool | existing `FileSummary.fully_null_rows` projection |
| n_nulls | u8 | count of null cells in this row |
| has_sentinel | bool | row contains a known sentinel value |
| is_duplicate | bool | exact-row dedup signal |
| dup_group | Option<u32> | duplicate cluster id (for showing groups) |

**Wire shape:** TBD — partial today (`fully_null_rows` lives on
`FileSummary`; other flags don't exist). Full shape lands when
the row-quality consumers force it.

**Consumers:**
- ✓ Drop-fully-null-rows tool (live, reads `fully_null_rows`)
- → Future: dedupe tool, fix-invalid tool's row-quality scoring,
  joins filter-aware base (skip bad rows from join input), reports
  row-exclusion ("exclude rows with > N nulls")

**Compute cost:** unmeasured. Needs a probe analogous to
[[joins-lane]]'s `audit_distincts` before locking the cache shape
or preload strategy. Stress-bin spec (§8) covers this.

### Universal reuse — "add a button, unlock a feature"

The 3-table model isn't workspace-specific. Any table surface
anywhere in the app (Home's Files / Users / Charts / Memberships /
Steps lists; Monitoring's Events / Runs / Findings; future
sources from [[datasource-trait]]) reuses the same three
projections. Adding a toolbar button on a surface = wiring it
to read from the corresponding table. The data primitive is
universal; only the consumer changes.

This is why the `.rt-surface` atom matters. One UI atom × one
data primitive × N surfaces = a multiplicative gain on every
new tool that lands.

## §3 — Memory budget framework

The 3-table model is only valuable if it stays resident in
predictable bounds. Three pressure points, each with a measurement
gate and a degradation tier.

### Per-surface resident ceiling

Each surface has its own budget — not a global cap. Workspace
files dwarf admin lists because of Table 2's distinct-values
weight.

| Surface | Per-entry weight | Realistic resident |
|---|---|---|
| Workspace file | ~3MB (stats + distincts + row-quality) at P99 | 8 files × 3MB = 24MB |
| Home admin list | ~500KB (light stats + low-cardinality distincts) | 6 lists × 500KB = 3MB |
| Monitoring list | similar to Home | 6 lists × 500KB = 3MB |
| Other surfaces | marginal | <5MB combined |

**Total ceiling:** ~30–50MB resident at the high end. Comfortable
for desktop; marginal on mobile Safari (aggressive tab-eviction);
unknown on low-end devices. The stress-bin (§8) measures the
breaking points before we lock the caps.

### Breaking-point scenarios

Each warrants a probe in the stress-bin:

1. **Single huge file** (e.g. 10M rows × 200 cols)
   - Table 2: 5k cap saves us (200 cols × 5k × ~20 bytes ≈ 20MB)
   - Table 3: 10M rows × 4-byte-flag-mask = 40MB (worst case)
   - Per-file cost ≈ 60MB. Big files = LRU pressure.

2. **Many open tabs.** 8 files × big-file-cost = LRU-eviction
   territory. Eviction must be graceful.

3. **Concurrent users on the same Postgres node.** Backend
   hydrate-cache memory × N sessions. The data-plane FS layer
   needs eviction signals server-side too — not just FE.

4. **Refresh mid-preload.** Network drops or user F5s while
   distincts/row-quality are still computing. Partial cache + finish
   in background, or restart cold? Stress-bin runs both.

5. **Slow network.** Preload must NEVER block table render. The FS
   layer's read paths return cached data immediately + refresh in
   background.

### Degradation tiers

When the budget breaks, the system stays usable — just loses the
zero-latency property:

| Tier | Trigger | Behavior |
|---|---|---|
| **Hot** | Index fits resident, all queries hit cache | Zero-network instant tool activation |
| **Warm** | Some tables evicted | First tool to need an evicted projection re-fetches on demand (today's behavior) |
| **Cold** | Even the in-memory frame is gone | Hydrate from disk + recompute (current backend behavior on a cold cache) |
| **Degraded** | Backend can't compute (memory pressure, source unreachable) | Tool buttons stay functional via fallback (per-column scans), surface a "computed locally — slow" hint per [[datasource-trait]] `executed_locally` |

The high-availability promise is "**feel instant when it fits**" —
not "guarantee instant or crash". Tool buttons stay functional in
degraded mode; only the latency property collapses.

### Eviction policy

- **FE side:** LRU=8 over file entries. Confirmed against
  `audit_distincts` data — 8 × P99 = ~5.5MB resident, with
  headroom for the chip-picker's selection state. Per
  [[joins-lane]].
- **Backend side:** hydrate-cache eviction is unbounded today
  (no policy). Stress-bin §8 measures the prod shape; eviction
  policy lands as part of the PWA-FS pilot (§4).
- **Handle refcount = eviction signal.** Open inodes (via FE
  handles) aren't eligible for eviction; close → eligible. Falls
  out of the FS abstraction naturally.

## §4 — PWA-FS sketch (data-plane scope)

The frontend half of the VFS borrow. Mirror of [[datasource-trait]]
(the backend half). Two halves compose into one VFS-shaped story:
AST flows FE → FS → server → DataSource → cache → back through FS.

### What we borrow (and what we don't)

Borrow the **shape**:
- Single uniform namespace — every data plane has one address
- Method-pointer indirection — backends swap behind one API
- Lifecycle tied to handle open/close — eviction falls out
- Permission check at one boundary — RBAC choke-point

Borrow the **vocabulary** (50 years of dev mental models come free):
- Path notation: `/projects/PRJ_xyz/files/FIL_abc/_index/distincts/col_name`
- inode metadata struct: `{ rid, owner_uid, project_id, mtime, size, blob_kind, perms }`
- mount registry: which path prefix routes to which backend
- stat(): preflight metadata read without payload
- open / close / refcount: handle lifecycle

**Don't borrow POSIX semantics.** No offset-based reads, no blocking
syscalls, no integer fds. The FS API is async/Promise-based; "open"
returns a JS handle with a `close()` for refcount tracking; paths are
strings; operations are RedPash-shaped (`fs.page(path, query)`),
not POSIX-shaped (`read(fd, buf, n)`).

**Mantra: JS-ergonomic, Unix-flavoured.**

### Path notation

```
/projects/PRJ_xyz                                   — project (control plane, NOT in FS)
/projects/PRJ_xyz/files/FIL_abc                     — file root (data plane, inode)
/projects/PRJ_xyz/files/FIL_abc/data                — paged rows
/projects/PRJ_xyz/files/FIL_abc/_index/stats        — Table 1
/projects/PRJ_xyz/files/FIL_abc/_index/distincts/{col} — Table 2 (N entries)
/projects/PRJ_xyz/files/FIL_abc/_index/row_quality  — Table 3
/projects/PRJ_xyz/files/FIL_abc/_meta               — inode (stat target)
```

`_index` and `_meta` are reserved prefixes (similar to `.git`):
they live within the file's namespace but aren't user-visible
listings.

### FS API surface (FE module sketch)

```js
// /scripts/fs.js
export async function open(path) -> Handle  // increments refcount
export async function stat(path) -> InodeMeta  // no payload read
export async function page(path, query) -> Page<Row>  // AST is cache key
export async function distinct(path, q, limit) -> DistinctResult
export async function read(path) -> Bytes  // raw blob (rare)
export async function close(handle) -> void  // decrements refcount; eligible for eviction at 0
```

The handle is opaque (a Symbol or integer); module-level WeakMap
holds the refcount + inode metadata.

### Mount registry

Path prefix → backend resolver:

| Prefix | Backend |
|---|---|
| `/projects/*/files/*/data` | `/api/files/:rid/page` |
| `/projects/*/files/*/_index/stats` | `FileEnvelope.columns` (no separate endpoint) |
| `/projects/*/files/*/_index/distincts/*` | `/api/files/:rid/uniques?col=...` (live, `34445ce`) |
| `/projects/*/files/*/_index/row_quality` | TBD (Table 3 wire) |
| `/projects/*/files/*/_meta` | `HEAD /api/files/:rid` (TBD — stat shape) |

Mount registry is **static at v1** (compile-time map in `fs.js`).
Dynamic mounts (plugins, user-added sources) are a future
concern — covered by [[datasource-trait]]'s `SourceKind` enum on
the backend, with FS-side resolver entries added when each
SourceKind lands.

### Pilot mount: column-index migration

Per the sequence agreed with Gus (his 21:15 post):

1. Column-index ships as-is — `/scripts/joins.js` autocomplete +
   chip-picker against `/uniques` directly. Plain `api.get`, no
   FS abstraction yet.
2. Auth-audit ships (Gus's lane).
3. This doc (§5-7 land from Gus, §8-9 from joint).
4. Stress-bin runs; budget locks.
5. **FS API designed against the now-real column-index consumer.**
   Concrete: "the autocomplete needs to open a distincts inode,
   call distinct() with a query string, get a refcounted handle
   it can close on dropdown-blur." That requirement shapes the
   API; we don't guess.
6. **Pilot mount: refactor column-index INTO the FS.** If the
   API composes naturally, ship; if it doesn't, learn cheap.
7. Migration of other caches (workspace `sourceCache`, joins
   picker state, SW shell, IndexedDB JSONB).
8. RBAC integration (next big workstream).

### What's IN scope vs OUT

| In scope (data plane) | Out of scope (control plane — stay REST) |
|---|---|
| File rows + columns + stats | `/api/me` (session identity) |
| Distinct values per column | `/api/projects` (project list) |
| Row-quality flags | `/api/prefs` (user preferences) |
| Derived indices (join candidates, search results) | `/api/admin/*` (admin endpoints) |
| Chart specs + dashboard widgets | `/api/monitoring/*` (telemetry) |
| Large cached blobs | `/api/events/*` (audit log) |

The boundary: **if it has open-handle lifecycle + eviction
semantics + caching benefits + mtime invalidation, it's in.
Otherwise REST.** Control-plane endpoints aren't "second-class
citizens" in the data model — they just don't fit this
abstraction's shape, and forcing them in is ceremony without
benefit.

## §5 — Inode metadata DTO (backend half)

> **Owner: Gus.** Placeholder — will be drafted in a follow-up
> session covering the server-side stat/preflight DTO, the inode
> struct (rid, owner_uid, parent_id, mtime, size, blob_kind,
> perms), and how it composes with the existing `FileSummary` /
> `FileEnvelope` shapes. The Phase 1 refactor (per
> [[datasource-trait]]) lands this without rewriting call sites.

## §6 — Mount registry resolution + stat/preflight shape (backend half)

> **Owner: Gus.** Placeholder — server-side path resolution
> (path → rid → hydrate), stat preflight endpoint shape
> (`HEAD /api/files/:rid/_meta` returning size + mtime + perms
> without payload), and how the existing `routes::files::hydrate`
> entry point composes with FS-style open/close lifecycle.

## §7 — Derived-index persistence policy (backend half)

> **Owner: Gus.** Placeholder — covers whether derived indices
> (distincts, row-quality, join candidates) recompute on every
> mtime change or carry a version-stamp that survives across
> hydrate-cache evictions. Memory vs CPU tradeoff for big files;
> ties into the stress-bin §8 data.

## §8 — Stress-bin spec (joint)

Per [[build-tools-proactively]] + [[data-decides]]: measure
before locking the architecture. The bin mirrors the
[`audit_distincts`](../../backend/crates/api/src/bin/audit_distincts.rs)
shape — same `bin/` pattern, same JSON-to-audit.run output,
same per-file CSV.

### What we measure

Five scenarios; each outputs P50/P90/P99 latencies + resident-
memory curves over time.

1. **Single huge file** — open a 10M-row × 200-col file, request
   each of the 3 tables sequentially. Measure: compute time per
   table, total resident size, paging behavior.

2. **Many open tabs** — open 8 files (mix of P50 / P90 / P99
   sizes from `audit_distincts`). Measure: total resident, LRU
   eviction frequency, latency on re-access of evicted entries.

3. **Concurrent sessions** — N simulated users, each holding M
   open files. Measure: server-side hydrate-cache memory growth,
   eviction effectiveness, latency under load.

4. **Refresh mid-preload** — start a Table 2 preload, kill the
   request 50% through. Measure: partial-cache vs cold-restart
   recovery time on next request.

5. **Slow-network** — throttle to 3G speeds, repeat scenarios 1+2.
   Measure: table-render latency vs preload latency (preload
   should never block table render).

### Output shape

Mirror `audit_distincts/per-file.csv` + `report.md`:

- **Per-scenario CSV:** scenario_id, run_id, P50_ms, P90_ms, P99_ms,
  resident_mb_at_p50, resident_mb_at_p99, eviction_count,
  cache_miss_pct.
- **Summary report.md:** the 5 distributions + headline numbers +
  the breaking-point thresholds we observed.

### What the data locks

- LRU bound per surface (today's guess: workspace=8, admin=4 —
  data may say otherwise).
- Eager-vs-lazy thresholds (preload Table 1 always; preload
  Table 2 only when scan_ms < threshold; preload Table 3
  never — needs measurement).
- The "computed locally — slow" toast trigger threshold (when to
  show it, when to silently absorb).
- Per-table compute budgets (when to fall back to per-column
  scans instead of bulk-table preload).

### Sequence

Stress-bin runs AFTER the polish-lane + auth-audit ship, BEFORE
the FS API design in §4. Data locks the API shape — without it
we'd guess the budgets and refactor later. Per
[[refactor-decompose]].

## §9 — RBAC integration touchpoints (joint)

The PWA-FS layer is one of two RBAC enforcement choke-points.
The other is `ensure_owner` (existing helper) for control planes.
The [[auth-audit]] tool ensures both are used consistently —
mechanical drift detection, not manual coordination.

### Where RBAC enters the FS

- **`fs.open(path)`** — resolve path → inode → check inode.perms
  against current session. Fail closed (404 if no read perm; no
  leaky "exists but forbidden" signal).
- **`fs.page(path, query)` / `fs.distinct(path, …)` / etc.** —
  delegate to `open` first; mutation methods (future) check
  write-bit too.
- **`fs.stat(path)`** — read-bit gated. Reveals only what the
  user is allowed to know exists.

### Sharing as mount grant

Future: user B sees user A's grant on file FIL_abc as a mounted
subdirectory in B's namespace. Reads of `/shared/from-A/FIL_abc`
resolve to the same inode as A's `/projects/PRJ/files/FIL_abc`
but with B's session evaluated against the grant's permission
bits, not A's ownership.

The grant table (TBD — lives in [[rbac-corporate-ready]]'s
schema design) becomes a "namespace overlay". The FS layer
checks both ownership AND grants when resolving an inode for a
session.

### Auth-audit's two patterns

When [[auth-audit]] catalogs antipatterns, it tracks:

- **`fs.access without ensure_perms`** (data plane) — should be
  0. Every FS entry call goes through the perms check at the
  inode boundary.
- **`Path(rid):` handler without ensure_owner` (control plane)
  — should be 0. Every Rust route that extracts a rid from the
  path checks ownership before the first DB op or `Json(`
  return.

Two enforcement points; one regression net. The pattern catalog
discipline (per [[build-tools-proactively]]) keeps them honest
forever.

### Phase

RBAC integration is the **next named workstream after this doc
lands + auth-audit ships + the column-index FS pilot validates
the abstraction**. Sequence is locked by the alignment in this
doc; the polish lane + auth-audit + this doc together form the
"harden-the-foundation" phase that the RBAC workstream needs
underneath it.

---

## Status check

- §1 (load-bearing sentence + scope) — drafted.
- §2 (3-redtable model) — drafted.
- §3 (memory budget) — drafted.
- §4 (PWA-FS sketch, data-plane scope) — drafted.
- §5 (inode metadata DTO) — Gus, placeholder.
- §6 (mount registry + stat shape) — Gus, placeholder.
- §7 (derived-index persistence) — Gus, placeholder.
- §8 (stress-bin spec) — drafted; cross-edit on next pass.
- §9 (RBAC touchpoints) — drafted; cross-edit on next pass.

Cross-edit pass after §5-7 land. Doc moves out of `status: sketch`
when both halves are reviewed + the column-index FS pilot
validates that the abstraction composes naturally.
