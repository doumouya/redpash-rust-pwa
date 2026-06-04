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
  **cdylib** for `wasm32-unknown-unknown` → `frontend/wasm/data_bg.<hash>.wasm` (~12 MB).
- **The wasm layer is a thin JSON shim over the same engine.** `backend/crates/data/src/wasm.rs` (its own
  doc): *"a thin marshaling layer over JSON in / JSON out — they call the same engine functions the server
  calls (`steps::apply`, `clean::auto_clean`), so the wasm binary's content == the server engine's content."*
  The `#[wasm_bindgen]` wrappers (`rows_to_df(rows_json: &str) -> Result<DataFrame, String>`, etc.) are
  compiled `#[cfg]`-gated for wasm32 only; the `api` rlib never sees them.
- **The boundary is type-erased JSON.** `frontend/wasm/data.js` exports
  `apply_filter(rows_json, params_json) -> string` — JSON string in, JSON string out. No typed structs cross;
  the wrapper parses JSON → Polars internally and serializes back.

## The decisive lesson

A **compile-time-typed** engine means each new object type / step / rule kind is a new typed function the wasm
must export — so adding one requires recompiling and re-shipping the **~12 MB** blob, and the browser surface
can't get a new type until a redeploy. That kills "custom objects day one" on the wasm surface.

A **data-driven** engine inverts it: the wasm exports a *small, stable, generic* set of JSON functions
(`apply_*`, `clean_*`); the *behavior* is data — a TypeDefinition / a `ValidateRule` / a codec id passed across
the JSON boundary and resolved against an open registry. A new type or rule is a row + a JSON payload; **the
wasm blob does not change.** So the registry being data-driven isn't only cleaner — it's the precondition for
[[wasm-replaces-js]] "one engine, two surfaces" to survive an open type set.

(Scope note: the *object* registry itself — `entities`, `type_definitions`, RBAC — is server-side and
DB-backed; it does not run in wasm. What crosses to the browser is the **type-driven data logic** — the
`validate_rules`/`codec_registry` open registries + the field/dtype system. Those are *already* open HashMaps,
so the wasm engine handles a new rule kind with zero recompilation. If they were closed `match`es, every new
rule kind would force a new 12 MB build — the exact tax this skill removes.)

## wasm-bindgen patterns → RedPash

| wasm-bindgen | mechanism | RedPash analog / lesson |
|---|---|---|
| **`JsValue`** | a type-erased, opaque handle to *any* JS value — round-trips without knowing the concrete type | the JSON-string boundary (`apply_filter(rows_json,…) -> string`) + Polars `AnyValue` internally — the boundary is type-erased, so new types need no new typed export |
| **`#[wasm_bindgen]` macro** | generates JS glue per *exported* item ("only pay for what you use") — a codegen export surface | keep the exports **few + generic** (`data/src/wasm.rs`'s handful of `apply_*`); never one export per object type |
| **`crate-type = ["cdylib","rlib"]`** | one crate → rlib (server) + cdylib (wasm) | put the engine + its open registries in *that* dual-target crate so both surfaces share one source (`wasm.rs`: "content == server engine's content") |
| **`wasm_bindgen::intern`** | caches strings repeatedly crossing the boundary | the *third* appearance of the interning lesson (after rustc `Symbol`, Polars internals): interned string keys make a data-driven registry cheap even across the JS boundary |
| **`Closure`** | wraps a Rust callback as a JS-callable, managing the calling convention | callbacks register into a JS-held table — the same register-a-provider shape, at the boundary |
| **JSON / `serde-wasm-bindgen`** | structured data crosses as JSON (or serde-bridged), not field-by-field | `entity_data` JSONB is **boundary-native** — a custom object's data is already the shape that crosses to wasm |

## Bottom line

rustc and Polars prove the registry pattern; **wasm-bindgen proves you have no choice**. Because the `data`
crate is one `cdylib + rlib` engine with a type-erased JSON boundary (all verifiable in-repo:
`data/Cargo.toml:15`, `data/src/wasm.rs`, `frontend/wasm/data.js`), the only way the browser surface keeps up
with an open type/rule set — without re-shipping a 12 MB wasm per type — is to make the type-driven logic
**data, resolved against open registries**. Design the engine's type/rule/codec logic as registries (it
already is for `validate_rules`/`codec_registry`); keep the wasm exports generic and JSON-shaped.
