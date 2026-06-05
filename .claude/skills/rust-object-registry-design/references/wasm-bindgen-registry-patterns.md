# wasm-bindgen → RedPash: why the registry MUST be data-driven (the two-surface constraint)

rustc and Polars show the registry *patterns*. wasm-bindgen supplies the *constraint that makes a data-driven
registry non-negotiable* — because RedPash's engine ships to two surfaces from one crate, and a compile-time-typed
engine can't follow new types across the wasm boundary without re-shipping the blob.

Repo: https://github.com/wasm-bindgen/wasm-bindgen · RedPash uses `wasm-bindgen = "0.2"`
(`backend/crates/data/Cargo.toml:68`), built via `wasm-bindgen-cli 0.2.121` (`tools/build-wasm.sh`).

---

## The RedPash fact this rests on — "one engine, two surfaces"

- **One crate, two compile targets.** `backend/crates/data/Cargo.toml:15` → `crate-type = ["cdylib", "rlib"]`.
  The `api` crate links `data` as an **rlib** (server); `build-wasm.sh` builds the *same* crate as a
  **cdylib** for `wasm32-unknown-unknown` → `frontend/wasm/data_bg.<hash>.wasm` (a **measured ~12 MB** —
  `data_bg.063c25cdcf21.wasm` = 12,321,659 bytes; a repo build fact, Polars is large, *not* a book figure). The
  `rlib` half is also what the book says to keep alongside `cdylib`: it's what runs the crate's native
  `#[test]`/`#[bench]`.
- **The wasm layer is a thin JSON shim over the same engine.** `backend/crates/data/src/wasm.rs` (its own
  doc): *"a thin marshaling layer over JSON in / JSON out — they call the same engine functions the server
  calls (`steps::apply`, `clean::auto_clean`), so the wasm binary's content == the server engine's content."*
  The 7 `#[wasm_bindgen]` exports (`start`, `parse_csv`, `parse_csv_compare`, `apply_filter`, `apply_sort`,
  `auto_clean`, `step_preview` — each `-> Result<String, JsValue>`; `rows_to_df`/`df_to_rows`/`df_metrics` are
  private helpers) are `#[cfg]`-gated for wasm32 only; the `api` rlib never sees them.
- **The boundary is type-erased JSON.** `frontend/wasm/data.js` exports
  `apply_filter(rows_json, params_json) -> string` — JSON string in, JSON string out. No typed structs cross;
  the wrapper parses JSON → Polars internally and serializes back.

## The decisive lesson

A **compile-time-typed** engine means each new object type / step / rule kind is a new typed function the wasm
must export — so adding one requires recompiling and re-shipping the blob, and the browser surface can't get a
new type until a redeploy. That kills "custom objects day one" on the wasm surface. The book makes the underlying
code-size argument directly ("Use Trait Objects Instead of Generic Type Parameters"): monomorphized generics make
the compiler emit a fresh copy of the code per concrete `T`, and "these copies add up quickly in terms of code
size" — so a typed-per-type engine doesn't just force redeploys, it *grows* the blob with every type. Type erasure
(one generic JSON surface) is what keeps it bounded.

A **data-driven** engine inverts it: the wasm exports a *small, stable, generic* set of JSON functions
(`apply_*`, `clean_*`); the *behavior* is data — a TypeDefinition / a `ValidateRule` / a codec id passed across
the JSON boundary and resolved against an open registry. A new type or rule is a row + a JSON payload; **the
wasm blob does not change.** So the registry being data-driven isn't only cleaner — it's the precondition for
[[wasm-replaces-js]] "one engine, two surfaces" to survive an open type set.

(Scope note: the *object* registry itself — `entities`, `type_definitions`, RBAC — is server-side and
DB-backed; it does not run in wasm. What crosses to the browser is the **type-driven data logic** — the
`validate_rules`/`codec_registry` open registries + the field/dtype system. Those are *already* open HashMaps,
so the wasm engine handles a new rule kind with zero recompilation. If they were closed `match`es, every new
rule kind would force a new 12 MB build — the exact tax this skill removes. Size aside: the book's *own* example
wasm is KB-scale (~29 KB release, ~9 KB gzipped after `opt-level="z"` + `wasm-opt`); RedPash's ~12 MB is Polars,
not bloat — the claim here is never that the blob is *small*, only that it stays *stable* across an open type set.)

## wasm-bindgen patterns → RedPash

| wasm-bindgen | mechanism | RedPash analog / lesson |
|---|---|---|
| **`JsValue`** | a type-erased, opaque handle to *any* JS value — round-trips without knowing the concrete type | used in-repo as the wasm error type — all 7 exports return `Result<String, JsValue>` (`JsValue::from_str`, `wasm.rs`); with the JSON-string boundary + Polars `AnyValue` internally, the boundary is type-erased, so new types need no new typed export |
| **`#[wasm_bindgen]` macro** | generates JS glue per *exported* item ("only pay for what you use") — a codegen export surface | keep the exports **few + generic** (`data/src/wasm.rs`'s handful of `apply_*`); never one export per object type |
| **`crate-type = ["cdylib","rlib"]`** | one crate → rlib (server) + cdylib (wasm) | put the engine + its open registries in *that* dual-target crate so both surfaces share one source (`wasm.rs`: "content == server engine's content") |
| **JSON boundary (`serde_json`)** | structured data crosses as a JSON string — the whole field-set serialized at once, not value-by-value | `entity_data` JSONB is **boundary-native**: a custom object's data is already the JSON shape that crosses to wasm. (The crate uses plain `serde_json` String in/out — *not* `serde-wasm-bindgen`; and it uses neither `wasm_bindgen::intern` nor `Closure` — verified 0× in `data/src`.) |

## Bottom line

rustc and Polars prove the registry pattern; **wasm-bindgen proves you have no choice**. Because the `data`
crate is one `cdylib + rlib` engine with a type-erased JSON boundary (all verifiable in-repo:
`data/Cargo.toml:15`, `data/src/wasm.rs`, `frontend/wasm/data.js`), the only way the browser surface keeps up
with an open type/rule set — without re-shipping a 12 MB wasm per type — is to make the type-driven logic
**data, resolved against open registries**. Design the engine's type/rule/codec logic as registries (it
already is for `validate_rules`/`codec_registry`); keep the wasm exports generic and JSON-shaped.
