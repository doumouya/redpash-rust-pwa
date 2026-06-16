# wasm-bindgen → RedPash: why the registry MUST be data-driven (the two-surface constraint)

rustc and Polars show the registry *patterns*. wasm-bindgen supplies the *constraint that makes a
data-driven registry non-negotiable* — because RedPash's engine ships to two surfaces from one crate, and
a compile-time-typed engine can't follow new types across the wasm boundary without re-shipping the blob.

Repo: https://github.com/wasm-bindgen/wasm-bindgen · RedPash uses `wasm-bindgen = "0.2"`
(`backend/crates/data/Cargo.toml`), built via the `tools/build-*.sh` wasm builds.

---

## The RedPash fact this rests on — "one engine, two surfaces"

- **One crate, two compile targets.** `backend/crates/data/Cargo.toml` → `crate-type = ["cdylib", "rlib"]`.
  The `api` crate links `data` as an **rlib** (server); the wasm build compiles the *same* crate as a
  **cdylib** for `wasm32-unknown-unknown` → `frontend/wasm/` (content-hashed, day-one #7). The polars
  dependency is the `doumouya/polars-rp` fork *precisely* so polars-core compiles to wasm32 (it gates
  tokio off wasm) — the fork exists to keep this dual target real. The `rlib` half is also what runs the
  crate's native `#[test]`/`#[bench]` and what the purity gate (`tools/purity-check.sh`, a wasm32
  `cargo check`) protects: no io/http/threads/time in `data`.
- **The wasm layer is a thin JSON shim over the same engine.** `backend/crates/data/src/wasm.rs` exports
  a single `#[wasm_bindgen] struct Workbook` whose methods (`from_csv`, `page`, `filter_page`, `view`,
  `score`, `sql`, `rows`, `cols`, plus the free `parse_score`) are JSON-string in / JSON-string out and
  call the SAME engine functions the server calls (`data::parse`, `data::view::page`, `data::filter`,
  `data::sort`, `data::sql`, `data::stats`, `data::steps`) — so the wasm binary's content == the server
  engine's content. The frontend's method list is GENERATED from these exports. The exports are
  `#[cfg]`-gated for wasm32 only; the `api` rlib never sees them.
- **The boundary is type-erased JSON.** A `Workbook` method takes/returns a JSON string (e.g.
  `filter_page(offset, limit, query_json) -> Result<String, JsError>`); the page shape
  `{ columns, rows, total }` is byte-identical to what `data::view::page` emits server-side. No typed
  per-object structs cross — the wrapper parses JSON → Polars internally and serializes back.

## The decisive lesson

A **compile-time-typed** engine means each new object type / step / rule kind is a new typed function the
wasm must export — so adding one requires recompiling and re-shipping the blob, and the browser surface
can't get a new type until a redeploy. That kills "custom objects day one" on the wasm surface. The
wasm-bindgen guide makes the underlying code-size argument directly ("Use Trait Objects Instead of
Generic Type Parameters"): monomorphized generics make the compiler emit a fresh copy of the code per
concrete `T`, and "these copies add up quickly in terms of code size" — so a typed-per-type engine
doesn't just force redeploys, it *grows* the blob with every type. Type erasure (one generic JSON
surface) is what keeps it bounded.

A **data-driven** engine inverts it: the wasm exports a *small, stable, generic* surface (the `Workbook`
methods); the *behavior* is data — a step `kind`, a `FilterNode`, a SQL string, a codec id passed across
the JSON boundary and resolved against an open mechanism. A new shaping step or type is a payload, not a
new export; **the wasm blob does not change.** So the registry being data-driven isn't only cleaner —
it's the precondition for [[wasm-replaces-js]] "one engine, two surfaces" to survive an open type set.

(Scope note: the *object* registry itself — `entities`, `type_definitions`, RBAC — is server-side and
DB-backed; it does not run in wasm. What crosses to the browser is the **data-shaping logic** — the steps
pipeline / `FilterNode` / SQL over the device-resident frame. The one canonical `FilterNode` DTO
(`shared/src/filter.rs`, day-one #4) is what lets filter/search/group run client-side at all — the
predecessor's flat-vs-tree split was the only reason it couldn't. Size aside: RedPash's wasm is large
because Polars is large — historically a multi-MB blob — but the claim here is never that the blob is
*small*, only that it stays *stable* across an open shaping/type set, content-hashed per day-one #7.)

## wasm-bindgen patterns → RedPash

| wasm-bindgen | mechanism | RedPash analog / lesson |
|---|---|---|
| **`JsError`/`JsValue`** | a type-erased, opaque handle to *any* JS value — round-trips without knowing the concrete type | the `Workbook` methods return `Result<String, JsError>`; with the JSON-string boundary + Polars `AnyValue` internally, the boundary is type-erased, so new shaping needs no new typed export |
| **`#[wasm_bindgen]` macro** | generates JS glue per *exported* item ("only pay for what you use") — a codegen export surface | keep the export surface **one generic `Workbook`** with a handful of JSON methods; never one export per object type |
| **`crate-type = ["cdylib","rlib"]`** | one crate → rlib (server) + cdylib (wasm) | the engine + its shaping logic live in *that* dual-target crate so both surfaces share one source (`wasm.rs`: "content == server engine's content"); the `polars-rp` fork keeps the cdylib target compilable |
| **JSON boundary (`serde_json`)** | structured data crosses as a JSON string — the whole shape serialized at once, not value-by-value | the page/filter/sql shapes cross as JSON; a custom object's `entity_data` is already the JSON shape — boundary-native |

## Bottom line

rustc and Polars prove the registry pattern; **wasm-bindgen proves you have no choice**. Because the
`data` crate is one `cdylib + rlib` engine with a type-erased JSON boundary (all verifiable in-repo:
`data/Cargo.toml` `crate-type`, `data/src/wasm.rs`'s `Workbook`, the `polars-rp` fork that makes wasm32
compile, the purity gate), the only way the browser surface keeps up with an open type/shaping set —
without re-shipping a multi-MB wasm per change — is to make the data-shaping logic **data, resolved
against open mechanisms**, and keep the wasm exports generic and JSON-shaped. That is what RedPash ships.
