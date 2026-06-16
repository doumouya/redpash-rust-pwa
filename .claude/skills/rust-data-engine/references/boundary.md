# The boundary — leaving the engine as JSON (server + wasm, one path)

The `data` crate is pure compute; everything that *leaves* it crosses a boundary as **JSON**, via serde, and
the exact same engine functions serve the server (rlib) and the browser (wasm cdylib). Get the boundary right
and the two surfaces stay one codebase. The purity that makes the wasm side possible is **CI-gated** —
`tools/purity-check.sh` runs a `wasm32 cargo check` on every commit.

## The page-shape wire contract — `{ columns, rows, total }`
The one shape both surfaces emit for a window of rows: `view::Page` → `Page::to_json()` →
`{ columns: [name], rows: [[cell|null]], total: usize }`, where each `cell` is the stringified value (aligned
to `columns`) and `total` is the full/relevant row count so the client can show "N of M". `view::page(df,
offset, limit)` is the **one** windowing function; both the server's `/page` handlers and the wasm `Workbook`
call it, so a client-rendered page is byte-identical to a server-rendered one for the same bytes.

## AnyValue → owned → JSON
A `DataFrame` is typed Arrow storage; the wire is JSON. To emit, convert each `AnyValue` to an owned Rust value,
then serialize. The crate's `cell` helper (`view.rs:13`) is the canonical move — and it matches **both** string
variants:

```rust
fn cell(c: &Column, i: usize) -> Option<String> {
    match c.get(i) {
        Ok(AnyValue::Null) => None,
        Ok(AnyValue::String(s)) => Some(s.to_string()),        // borrowed
        Ok(AnyValue::StringOwned(s)) => Some(s.to_string()),   // owned — never omit this arm
        Ok(other) => Some(other.to_string()),
        Err(_) => None,
    }
}
```

`AnyValue` is the right carrier here precisely because it's type-erased — one function handles every column
type, no per-type struct. (`export.rs` does the typed twin: `AnyValue` → a worksheet cell / `serde_json::Value`,
keeping native types for XLSX/JSON export.) See `polars-types.md` for the value model.

## serde — the serialization layer
[crates.io/serde](https://crates.io/crates/serde). The crate is serde-first: `#[derive(Serialize,
Deserialize)]` on the shared DTOs (`FilterNode`, `QuerySpec`, `ReportSpec`, `SortKey` — all in the `shared`
crate), `serde_json` to/from the wire. Inbound, a wasm method `serde_json::from_str`s a JSON string into the
DTO (`FilterNode` / `QuerySpec`); outbound, the result frame goes through `view::page` → `to_json` →
`.to_string()`. Structured data crosses as a JSON **string or value**, never field-by-field manual marshaling.

## The wasm shim — JSON in, JSON out, same engine
`wasm.rs` (`#![cfg(target_arch = "wasm32")]`) wraps the engine for the browser. It is a thin marshaling layer
over JSON in / JSON out — every method calls the **same** engine function the server calls, so the wasm
binary's *content* == the server engine's content. **`start()`** (`#[wasm_bindgen(start)]`) installs
`console_error_panic_hook` so a Rust panic surfaces in the console with file + line + payload.

The surface is **a `#[wasm_bindgen] struct Workbook` (a parsed CSV held resident in browser memory) plus one
top-level `#[wasm_bindgen] fn parse_score`** — NOT a flat list of stateless `parse_csv`/`apply_filter`/
`auto_clean` wrappers (that was the predecessor's shape; it is gone). The `Workbook` methods:

| Method | Calls (same server fn) | Returns |
|---|---|---|
| `from_csv(bytes, tld)` *(constructor, `js_name = from_csv`)* | `parse::from_csv_bytes` | a `Workbook` |
| `page(offset, limit)` | `view::page` | page JSON, `total` = full height |
| `filter_page(filter_json, offset, limit)` | `filter::apply_filter` (deserialize `FilterNode`) → `view::page` | page JSON, `total` = filtered height |
| `view(query_json, offset, limit)` | `search::effective_filter` + `filter::apply_filter` → `sort::apply_sort` → `view::page` (deserialize `QuerySpec`) | page JSON, `total` = post-(filter+search) height |
| `score()` | `dtype::summarize` + `stats::cleanness_report` + `find_sentinels` | the score JSON |
| `sql(query)` | `sql::run_sql` (read-only guard) → `view::page(_, 0, 500)` | first 500 rows of the result |
| `rows()` / `cols()` | `df.height()` / `df.width()` | `usize` |

The top-level `parse_score(bytes, tld)` runs the same upload front door (`parse::from_csv_bytes` →
`dtype::summarize` → `stats::cleanness_report`) and augments the shared score payload with the parse-time
`encoding` + `rescue` diagnostics only the front door knows. Rules:

- The wasm wrappers **only** marshal JSON ↔ `DataFrame` and call existing engine fns. **No logic lives in
  `wasm.rs`** — if you'd write a branch here, it belongs in an engine module both surfaces share.
- The boundary is **JSON strings** (`&str`/`String` in, `Result<String, JsError>` out), not typed structs —
  so adding an operation is a new method that deserializes a `shared` DTO and calls an engine fn.
- The JS method list is **GENERATED** from these `#[wasm_bindgen]` exports (via wasm-bindgen's output), never a
  hand-maintained array — the predecessor's "13-exported-vs-6-wired" drift is *designed out*. If a method is
  exported here, it is callable from JS, full stop.
- The full, authoritative method table (signatures, `total` semantics, the QuerySpec order) lives in the live
  doc [`data-engine.md`](../../../../code/backend/data-engine.md) §wasm — read it rather than trusting a copy.

**Trade-off (named honestly).** JSON-everything is *not* the "Rust and WebAssembly" book's
headline-recommended boundary. The book tells you to **minimize serializing/copying** and to keep large,
long-lived structures **inside wasm linear memory, exposed to JS as opaque handles** — JS calls exported fns on
the handle and gets back only a small copyable result. RedPash deliberately takes the JSON-string boundary
instead, *and* keeps the heavy state resident: a `Workbook` **holds the parsed `DataFrame` in wasm linear
memory** (it IS an opaque handle — JS holds the `Workbook`, never the frame), and each method returns only a
small JSON page. That buys *one-engine-two-surfaces parity* (the wasm path runs the byte-identical server
functions) and simplicity, paying one serialize/copy per call for the window you actually render — not per row
in the frame. That is the documented sweet spot between the two book techniques.

## The pure-compute seam (why this is clean)
No HTTP, no DB, no Axum, no threads, no time in `data` — and it's enforced, not just intended
(`tools/purity-check.sh`). The `api` crate calls a `data::` function and serializes the result; `data`'s
`DataError` enum wraps Polars/IO/parse failures for `api` to map to status codes. That seam is what makes the
crate (a) unit-testable without a server and (b) wasm-compilable at all. When tempted to reach for a request, a
pool, or a status code inside `data` — don't; return data + a `DataError`, and let `api` do the HTTP.
