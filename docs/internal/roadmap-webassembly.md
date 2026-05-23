---
title: WebAssembly roadmap
section: Internal
last modified date: 2026-05-23
---

# WebAssembly roadmap — every place it's relevant

> **Internal — RedPash team only.** Em's brief: *"I want WebAssembly
> every place where it's relevant."* This doc maps the surface,
> separates direction from sprint, and locks the rules that have to
> hold today so the door stays open whether WASM ships next month or
> in two years. Draft by Gus, 2026-05-23, after Em short-circuited the
> Gus-drafts-inputs / Torv-drafts-doc handshake and asked for the full
> discussion now.

## TL;DR

1. **The data crate is structurally wasm-ready already** — 0
   filesystem calls, 0 threading, 0 async. Pure compute. The JS/Rust
   boundary doc bought this for free.
2. **The shared DTOs are mostly already runtime-neutral** —
   `crates/shared/src/filter.rs` is a tree of leaves; `step.rs` uses
   `serde_json::Value` for op-dependent params; same pattern across
   the resource crates. Workstream #2's `Filter` DTO is **already
   80 % done** in `shared::filter::FilterNode`.
3. **Phase 0 is small, today, and unblocks everything**: reconcile the
   `FilterOp` enum vs. the actual op set in `steps.rs`, gate
   `render.rs` out of wasm builds, and run `cargo check --target
   wasm32-unknown-unknown -p data` to produce the binary-size number
   that decides whether phases C–E are even feasible.
4. **The cliff is Polars-on-wasm binary size** — until we have that
   number, every phase past B is opinion, not plan.
5. **Three rules bind now** regardless of when (or whether) WASM
   ships: never build a JS data engine; every wire DTO lives in
   `crates/shared/` and is runtime-neutral; keep the `data` crate's
   compute path free of doc-render / server deps.

## 1. Why WASM matters to RedPash

This is not a fashion call. Two concrete reasons it's load-bearing:

**Product:** RedPash's edge is *near-real-time data work on CSVs the
size a competitor sends back the next morning*. The CSV-paste demo
parses 178 rows in <1 ms. The next step — the upload button, the
landing-page "parse any CSV" challenge, the table-preview-before-
upload — runs into a wall: every keystroke round-trips to a server.
Browser-side compute via WASM is the only architecture that keeps
the demo's *feel* (cache-as-persistent-memory) when the input grows
from 178 rows to 178 k.

**Capability:** Em is building a data company. Database internals —
parser, planner, executor, storage — are core craft. The same engine
that runs on the server today should be able to run anywhere a
runtime exists. That's not a future product; it's a competency
ladder. Each rung (cargo check on wasm32 → wasm-callable filter →
in-browser parse → in-browser step engine) is a learning step.

The boundary contract (`docs/internal/js-rust-boundary.md`) already
said *"Rust owns data, JS owns pixels, never build a data engine in
JS."* WASM is the second reason that rule is right. Whatever
runtime we target later, the compute lives in Rust.

## 2. The surface — where WASM is relevant

Ranked roughly by payoff vs. cost.

### High relevance (real product wins)

| Surface | Today (server) | With WASM (browser) | Why it matters |
|---|---|---|---|
| **Filter / sort over a page** | `GET /api/files/:rid/page?filters=...` round-trip | Same `Filter` DTO eval'd in-browser over the loaded page | Instant tab through pages; no round-trip on a UI gesture |
| **CSV / XLSX parse for preview** | `POST /api/demo/parse` + (future) `POST /api/files/upload` | `parse.rs` compiled to wasm; first 100 rows shown locally before the upload commits | The "parse any CSV" demo scales; upload preview without the upload |
| **`cleanness::score`** | Computed server-side after upload | Computed locally before upload | User sees the score *while choosing the file*; the upload is a confirmation, not a discovery |
| **Step preview** (cleaning ops) | `POST /api/files/:rid/steps` commits + returns rows | A `Step::preview(df, params)` wasm call shows the effect without committing | Try-before-commit, the cleaning panel's natural UX |
| **Redtable query builder → AST** | UI clicks → server-side query | Same AST → wasm-Polars in browser, or → SQL on a connected DB later | One AST, three runtimes. The query builder is the core craft. |

### Medium relevance (later, optional)

| Surface | Why it's medium |
|---|---|
| **Full step engine in browser** | Phases C–D — depends on the parse cliff. Once parse works, the rest of `steps.rs` follows. |
| **`group_by` / aggregation** | Useful for in-browser dashboards. Same DTO, same engine. |
| **`detect_join_keys`** | UX win for the join builder — show match-strength as a hover, no round-trip. |

### Out of scope (NOT WASM-relevant)

| Surface | Why not |
|---|---|
| HTTP routing, auth, sessions | IO + state — server-only by definition. |
| Database access (sqlx, the entire `db.rs`) | The whole point of the boundary. |
| `render.rs` (Markdown + Maud + syntect) | Server-only renderer for `/docs`. Must be gated out of wasm builds — see §5. |
| Events + request_log capture | IO-bound, not compute. The frontend's `event::record` POSTs are already correct. |
| Metrics dashboard aggregation | The `audit.run_diff` style aggregation belongs server-side; the browser reads a summary. |
| Audit tools (`tools/*-audit/audit.js`) | Dev-time Node scripts, not user-facing. (Possible future move to Rust, but unrelated to WASM.) |

### Independent track: the experimental DB

Em's `experimental-db` direction (a from-scratch Rust DB,
SteelDB-patterned) is **independent** of this roadmap. It's a
learning / capability spike living in its own repo. If/when it
exists, it might one day target wasm32 too — but it's not on the
critical path here and shouldn't be conflated with the data-engine
work.

## 3. What's already done (and didn't need to be)

This is what the JS/Rust boundary discipline already bought us:

- **`data` crate has zero IO.** Grep proves it:
  ```
  grep -rn 'std::fs::|::open|::read_to_string|tokio::fs' src/  → 0 hits
  grep -rn 'std::thread|tokio::|rayon|par_iter'           src/  → 0 hits
  ```
  Every byte enters as a buffer the caller supplies; every result
  exits as a `DataFrame` / `String` / serializable struct. That's
  *the* hard part of WASM-readiness, and it's already done.

- **`crates/shared/` has the wire DTOs.** Eleven resources, each with
  its DTO in `crates/shared/src/<resource>.rs`. The frontend reads
  the same JSON the backend writes; both sides serialize via
  `serde_json`. The wasm path would serialize through the same
  layer.

- **`shared::filter::FilterNode` already exists.** Tree-of-leaves
  shape, `serde(untagged)` to switch between leaf and group, value
  is `serde_json::Value` for op-dependent shapes. Workstream #2 will
  *reconcile* this with `steps.rs:740`, not invent it.

- **`shared::step::StepRequest`** uses the same pattern:
  `kind: String` + `params: serde_json::Value`. Adding a new step
  kind needs no DTO change — only the engine's match arm.

## 4. The runtime-neutral DTO inventory

This is the surface that has to be locked down for WASM to be a
runtime swap below the API line rather than a rewrite.

| DTO | Where it lives | Today's state | Gap to runtime-neutral |
|---|---|---|---|
| `FilterNode` / `FilterSpec` / `FilterOp` | `shared::filter` | Tree of leaves, ops as snake_case enum, `value` as `serde_json::Value` | **Op-list drift**: `shared::FilterOp` has `NotContains` that `steps.rs` doesn't; `steps.rs` has `in / not_in / before / after / case_sensitive` that `shared` doesn't. Reconcile both sides to one canonical list (see §7). |
| `StepRequest` | `shared::step` | `kind: String` + `params: Value` | Already neutral. Each step's params shape lives in `steps.rs`'s match arms — could be tightened into per-kind structs later, but the current shape is wasm-friendly. |
| `Sort` (column + direction) | **Inline in `PageQuery`** | Today's sort spec lives in route handlers, not `shared/` | Promote to `shared::sort::Sort = { column, dir: "asc"|"desc", is_date: bool }`. ~10 LOC. |
| `CleannessReport` | `data::clean` | Returned by the demo parser | Move the report struct to `shared::cleanness`. Today the frontend reads ad-hoc fields. |
| `ParseResult` | `routes/demo.rs` inline | The `/api/demo/parse` response | Same — `shared::parse_result::ParseResult`. |
| `GroupSpec` / `JoinSpec` / `DedupSpec` | Not yet — used internally | Reports + future joins UI | Will need DTOs when those UIs ship; design them in `shared/` from day 1. |
| `Envelope<T>`, `Page<T>`, `ApiError` | `shared::lib` | Generic wrappers — already shared | Already neutral. |

**The rule that drops out:** any new request body, response shape, or
query parameter goes through `crates/shared/`. Never inline in
`routes/`. (This is already mostly true — the four DTO gaps above
are the cleanup.)

## 5. Phasing — direction, not sprint

### Phase 0 — bind-now (this week, no behavior change)

The cleanup that keeps the door open. Zero user-facing change.

- Reconcile `shared::filter::FilterOp` ↔ `steps.rs:740` op list. One
  canonical 17-variant enum, used by both sides.
- Add `case_sensitive: Option<bool>` to `FilterSpec`.
- Promote `Sort` and `CleannessReport` to `crates/shared/`.
- Gate `data::render` behind `#[cfg(not(target_arch = "wasm32"))]`
  (or factor into a `data-render` sub-crate the `api` depends on
  directly — leaner separation, slightly bigger change).
- Audit: `rs-audit` adds a `wasm32` build status row.

**Output: zero feature change, clean foundation.** Maybe 200 LOC
total across the workspace.

### Phase A — `cargo check --target wasm32-unknown-unknown -p data` passes

The single load-bearing measurement. One afternoon's work.

- `rustup target add wasm32-unknown-unknown`.
- `cargo check --target wasm32-unknown-unknown -p data` →
  diagnose feature flags, target_arch gates, transitive non-wasm
  crates. Probably 1–3 rounds of "find the dep that doesn't compile,
  feature-flag it, retry."
- Once it compiles, switch to `cargo build --release --target
  wasm32-unknown-unknown` and record the resulting `.wasm` size.

**Output: a number — "data crate on wasm32 = N MB stripped".** That
number decides whether phases C+ ship.

### Phase B — wasm wrappers for the cheap entry points

Once A passes, expose three or four functions as wasm-callable:

- `apply_filter(rows_json, filter_json) → rows_json`
- `apply_sort(rows_json, sort_json) → rows_json`
- `cleanness_score(rows_json) → cleanness_report_json`
- `step_preview(rows_json, step_request_json) → { rows_json, diagnostics_json }`

Pure JSON in, pure JSON out — no Polars types crossing the wasm
boundary, no `wasm-bindgen` serde dance per type. Maybe 150 LOC of
`#[wasm_bindgen]` thin wrappers.

**Output: browser preview-without-roundtrip for the cheap ops.**
Validates the runtime-swap proposition end-to-end on the cheap
surface before committing to phase C's parse cliff.

### Phase C — `parse.rs` on wasm (the parse cliff)

Browser ingests CSV / XLSX without uploading. The Polars-on-wasm
binary-size question gets *real* here:

- A representative CSV (10 k rows × 20 cols).
- Parse + cleanness score in the browser.
- Measure: bundle size, first-parse time, subsequent-parse time.
- Compare to the server round-trip on the same file.

**Output: an honest perf + size delta.** If the bundle is 10 MB and
first-parse is 4 s, phase C is parked. If it's 2 MB and 200 ms,
phase D follows.

### Phase D — full step engine in browser

Dedup, group_by, joins, the whole step engine. Each step's
`apply()` wasm-callable. "The redtable runs offline" — open a
project, work through cleaning steps, commit them in a batch when
network returns. Months out, gated entirely on Phase C measuring
under the cliff.

### Phase E (years out, conditional) — the experimental DB on wasm

Em's `[[experimental-db]]` direction, if it ever exists, gets the
wasm runtime for free if the DB itself is built on the same hygiene
(no IO in the engine; storage is the caller's concern). Strictly
independent of phases 0–D; mentioned here only so the surfaces stay
aligned in everyone's head.

## 6. The cliffs — what we'll only know once we measure

| Cliff | Why it matters | How to measure |
|---|---|---|
| **Polars-on-wasm binary size** | Bundle delivered to every visitor's browser | Phase A; output the stripped .wasm size |
| **Polars feature matrix on wasm32** | `lazy` + `regex` + `dtype-full` may pull non-wasm crates transitively | Phase A's diagnose-and-feature-flag loop |
| **SIMD + threads availability** | Polars parse perf without SIMD is multi-x slower; wasm-threads needs SharedArrayBuffer + CORP/COEP headers, Chromium-only without setup | Phase C — measure parse time on a representative file with and without `RUSTFLAGS='-C target-feature=+simd128'` |
| **`#[wasm_bindgen]` ergonomics for JSON** | Either every DTO needs a `Tsify` derive or we serialize through `serde_json::Value` and pay copy cost | Phase B — pick the pattern once, stick with it |

None of these are blockers — they're *measurements that determine
which phases ship*. Treating them as opinion-driven now would be
exactly the trap [[data-decides]] warns against.

## 7. What binds now (the rules)

Three rules survive whether WASM ships next month or never:

1. **Never build a JS data engine.** Filter / sort / aggregate /
   dedup / group / parse all live in Rust. The frontend serializes a
   DTO and renders rows. Workstream #2's deletion of `passFilter` /
   `passSearch` / `applySort` is the canonical example of "what
   client-side data code should be deleted, not refactored." Same
   rule, second reason.

2. **Every wire DTO lives in `crates/shared/` and is runtime-neutral.**
   That means: plain `serde::Serialize/Deserialize`, no Polars types
   in the wire shape, op-dependent values via `serde_json::Value`,
   no `#[cfg(...)]` gates that would split server / wasm parsing.
   Already mostly true; close the four gaps in §4.

3. **`data` crate's compute path stays free of doc-render / server
   deps.** No `pulldown-cmark`, `syntect`, `gray_matter`, `maud`,
   `sqlx`, `tokio`, `reqwest` reachable from the modules that run on
   wasm32. Render-side is server-only, gated out. Anything that
   *might* run on wasm32 is in a path that compiles on wasm32.

A fourth, slightly softer rule that follows from §4:

4. **Every step kind has a pure `preview(df, params) -> (df,
   diagnostics)`** alongside its committing `apply()`. Same
   signature regardless of runtime. The browser calls `preview`;
   the server `apply`s when the user commits. This makes "try
   before commit" a property of the engine, not a UX layer.

## 8. Audit chain upgrade

Two audit signals fall out of this work:

- **`rs-audit`**: add `wasm32 build status` (yes/no/size) row. One
  trend line per session — exactly the audit-cadence-rule signal
  shape (small + regular). Lands as soon as Phase A succeeds.
- **`crossing-audit`**: add a *runtime axis*. Today it tracks
  JS↔Rust crossings as language; later it should also track which
  Rust functions are reachable from which runtime (server,
  wasm-browser, both). A "data crate fn reachable from server only"
  finding is the early warning that a non-wasm dep crept in. Maybe
  a half-day audit upgrade once Phase A lands and there's a clear
  reachability set to compare.

Both fit `[[cleaning-cadence]]` — edge-case findings trigger small
cleaning passes. WASM-readiness becomes a tracked metric like CSS
reachability, not a hope.

## 9. Open spikes (commands, not opinions)

Concrete things to run next session:

```bash
# spike 1 — the measurement
rustup target add wasm32-unknown-unknown
cargo check --target wasm32-unknown-unknown -p data 2>&1 | tee /tmp/wasm-check.log

# spike 2 — what doesn't compile
grep -E '^error' /tmp/wasm-check.log | sort -u   # the diagnose loop

# spike 3 — the size (once spike 1 passes)
cargo build --release --target wasm32-unknown-unknown -p data
wc -c backend/target/wasm32-unknown-unknown/release/libdata.rlib
# (then wasm-opt strip + size, once we wire a wasm-bindgen entry)
```

These three commands produce the data §6's cliffs need. Anything we
decide *before* running them is opinion. The whole point of phasing
A first is that A is small enough to be a one-day spike that
unblocks the rest of the discussion.

## 10. What I'd want a sign-off on

Three calls, each blocking different downstream work:

1. **Op-list reconciliation between `shared::FilterOp` and
   `steps.rs:740`** — workstream #2 can't ship cleanly until this
   lands, regardless of WASM. Trivial, ~30 LOC. Whose lane?
2. **Gating vs. splitting `render.rs`** — `#[cfg(not(target_arch
   = "wasm32"))]` is the cheap option; a `data-render` sub-crate is
   the cleaner one. Vote.
3. **When to actually run Phase A** — needs a free afternoon, gates
   everything else. Could be next session if it's a priority, or
   parked behind the datatable workstreams.

Calls 1 and 2 can be made on the board without Em's involvement
(Gus + Torv); call 3 wants Em's "yes, take an afternoon for this."

— Gus, 2026-05-23
