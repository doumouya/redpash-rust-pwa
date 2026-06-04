# The boundary — leaving the engine as JSON (server + wasm, one path)

The `data` crate is pure compute; everything that *leaves* it crosses a boundary as **JSON**, via serde, and the
exact same engine functions serve the server (rlib) and the browser (wasm cdylib). Get the boundary right and the
two surfaces stay one codebase.

## AnyValue → owned → JSON
A `DataFrame` is typed Arrow storage; the wire is JSON. To emit, convert each `AnyValue` to an owned Rust value,
then serialize. The crate's `av_to_owned` (e.g. `routes/group.rs:189`) is the canonical move:

```rust
fn av_to_owned(v: AnyValue) -> Option<String> { /* AnyValue::String(s) => s.to_string(), Int64(n) => …, Null => None */ }
```

`AnyValue` is the right carrier here precisely because it's type-erased — one function handles every column type,
no per-type struct. (This is the value-level twin of the object registry's `entity_data` JSONB; see
`polars-types.md` + the `rust-object-registry-design` skill.)

## serde — the serialization layer
[crates.io/serde](https://crates.io/crates/serde). The crate is serde-first: `#[derive(Serialize, Deserialize)]`
on every DTO, `serde_json` to/from the wire. Structured data crosses as a JSON **string or value**, never
field-by-field manual marshaling. Inbound: `serde_json::from_str` into a `Vec<serde_json::Map<String, Value>>`
(see `wasm::rows_to_df`), then build the `DataFrame`. Outbound: rows → `Vec<Map>` → `serde_json::to_string`.

## The wasm shim — JSON in, JSON out, same engine
`wasm.rs` (`#[cfg(target_arch = "wasm32")]`) wraps the engine for the browser: `rows_to_df(rows_json: &str) ->
DataFrame`, `apply_filter(rows_json, params_json) -> String`, `auto_clean(...)`. Its own doc says it best: *"a thin
marshaling layer over JSON in / JSON out — they call the same engine functions the server calls, so the wasm
binary's content == the server engine's content."* Rules:

- The wasm wrappers **only** marshal JSON ↔ `DataFrame` and call existing engine fns. No logic lives in `wasm.rs`.
- The boundary is **JSON strings** (`String` in/out), not typed structs — so adding an operation is a new generic
  wrapper, never a recompile-per-type. (This is the `wasm-bindgen` two-surface constraint from the object-registry
  skill, applied: keep exports few + JSON-shaped.)
- `serde` + `serde_json` are the only marshaling; `console_error_panic_hook` (in `wasm::start`) surfaces panics as
  real `console.error`.

## The pure-compute seam (why this is clean)
No HTTP, no DB, no Axum in `data`. The `api` crate calls a `data::` function and serializes the result; `data`'s
`Error` enum wraps Polars/IO/parse failures for `api` to map to status codes. That seam is what makes the crate
(a) unit-testable without a server and (b) wasm-compilable at all. When tempted to reach for a request, a pool, or
a status code inside `data` — don't; return data + a crate `Error`, and let `api` do the HTTP.
