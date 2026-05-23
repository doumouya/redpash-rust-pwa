---
title: Filter DTO
section: Internal
order: 32
last modified date: 2026-05-24
owner: Gus
status: filled
---

# Filter DTO

The canonical wire shape for row-predicate filters across the
entire app. One enum, one tree, three engine paths that all
honor it.

Source of truth: `backend/crates/shared/src/filter.rs`. Engine
consumers: `backend/crates/data/src/parse.rs::filter_expr`
(query-time `/api/files/:rid/page`),
`backend/crates/data/src/steps.rs::build_filter_predicate`
(persisted `filter_rows` step), and `backend/crates/data/src/wasm.rs::apply_filter`
(browser preview, wraps the steps path).

## Three modules, one DTO

| Layer | Module | Reads / writes |
|---|---|---|
| Wire | `shared::filter` | `FilterNode`, `FilterSpec`, `FilterOp`, `FilterGroup`, `GroupOp` |
| Query-time engine | `data::parse::filter_expr` | walks `FilterNode` → `polars::Expr` for `/page` |
| Step engine | `data::steps::build_filter_predicate` | string-keyed op for `filter_rows` step params |
| Wasm engine | `data::wasm::apply_filter` | JSON in/out; routes to steps engine path |

All three engine sites accept the same enum. The drift between
`shared::FilterOp` and the engines' op support — fixed in commit
`3d29291` — was the source of a long-running bug class where a UI
op didn't have an engine implementation. Doesn't happen anymore.

## `FilterOp` — the canonical 17-variant enum

```rust
#[derive(Serialize, Deserialize, Copy, Clone, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum FilterOp {
    Eq, Neq,
    In, NotIn,
    Contains, NotContains,
    StartsWith, EndsWith,
    Gt, Gte, Lt, Lte, Between,
    Before, After,
    IsNull, NotNull,
}
```

Wire form (snake_case): `eq | neq | in | not_in | contains |
not_contains | starts_with | ends_with | gt | gte | lt | lte |
between | before | after | is_null | not_null`.

Semantics per op:

| Ops | `value` shape | Cast / interpretation |
|---|---|---|
| `eq`, `neq` | scalar (any JSON type, stringified) | column cast to String |
| `in`, `not_in` | array of scalars | OR / AND-of-NEQ reduction over the lowercased column |
| `contains`, `not_contains`, `starts_with`, `ends_with` | string | column cast to String; `case_sensitive` honored where the engine supports it |
| `gt`, `gte`, `lt`, `lte` | numeric (or string fallback for ISO dates) | numeric f64 first, else lexicographic string |
| `between` | `[low, high]` 2-tuple | inclusive; numeric f64 first, else lexicographic-pair fallback |
| `before`, `after` | string (parsed lazily by Polars as Date) | column cast to Date; bogus dates → NULL → comparison false |
| `is_null`, `not_null` | (none) | bypasses cast |

The `in` / `not_in` semantics deliberately mirror set operations:
- empty `in` array → `lit(false)` (nothing matches the empty set)
- empty `not_in` array → `lit(true)` (everything matches the empty
  exclusion)

## `FilterSpec` — one predicate

```rust
pub struct FilterSpec {
    pub col:            String,
    pub op:             FilterOp,
    #[serde(default)] pub value:          Option<serde_json::Value>,
    /// String-op case sensitivity. None = engine's historical default.
    #[serde(default)] pub case_sensitive: Option<bool>,
}
```

`value` is `serde_json::Value` because the op-dependent shape
(string vs numeric vs array vs none) doesn't fit a single Rust
type. Engines pattern-match per op (the table above).

### `case_sensitive` defaults — deliberate asymmetry

| Engine path | Default when `None` | Why |
|---|---|---|
| Query-time (`parse::filter_expr`, `/page`) | `false` (insensitive) | Mirrors the global search behavior every existing UI assumes |
| Persisted step (`steps::build_filter_predicate`, `filter_rows` step) | `true` (sensitive) | Cleaning steps are exact-match — flipping a single row by predicate has to be predictable |

The asymmetry is deliberate. A future UI toggle wanting either
behavior just passes the flag explicitly; existing callers stay on
their historical path.

## `FilterNode` — the tree

Two accepted wire shapes:

**1. Tree** — recursive AND/OR:

```rust
#[derive(Serialize, Deserialize)]
#[serde(untagged)]
pub enum FilterNode {
    Group(FilterGroup),   // tried first
    Leaf(FilterSpec),     // falls back when `op` ∈ FilterOp
}

pub struct FilterGroup {
    pub op:       GroupOp,            // and | or
    pub children: Vec<FilterNode>,    // recursive
}

#[derive(Copy, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GroupOp { And, Or }
```

Serde's discrimination: `Group` matches first because its `op`
field is `and | or` (not in `FilterOp`); on mismatch, falls back
to `Leaf`. No explicit type tag needed on the wire.

Example:

```json
{
  "op": "and",
  "children": [
    { "col": "amount", "op": "gt", "value": 100 },
    {
      "op": "or",
      "children": [
        { "col": "country", "op": "eq", "value": "FR" },
        { "col": "country", "op": "in", "value": ["BE", "NL"] }
      ]
    }
  ]
}
```

The workspace's 2-level filter UI emits depth-2 trees; the DTO
itself supports arbitrary nesting, so a future UI could surface
deeper structures without a DTO change.

**2. Legacy flat list** — implicit AND:

```json
[
  { "col": "amount", "op": "gt", "value": 100 },
  { "col": "name",   "op": "contains", "value": "foo" }
]
```

Treated as `{ op: "and", children: [<leaves>] }`. Kept for
backward compat; new code should emit the tree shape.

## Engine consumers

### 1. Query-time — `/api/files/:rid/page?filters=...`

`data::parse::apply_filter(df, filter_json)` decodes the filter
and ANDs/ORs leaves into a `polars::Expr` via
`data::parse::filter_expr(spec)`. The workspace's redtable filter
panel emits this on every change; the API returns the filtered
page.

Empty / null filter → frame untouched. Bad / unknown op →
`DataError::InvalidSpec` → 400 with `kind="invalid_spec"`.

### 2. Persisted step — `filter_rows`

The user can promote a filter into a real cleaning step
(`POST /api/files/:rid/steps` with `{ kind: "filter_rows",
params: { combinator, predicates: [{column, op, value?,
case_sensitive?}, ...] } }`). The step gets persisted in
`project_steps` and replayed on every read.

Note the **subtly different params shape** from `FilterNode` —
`filter_rows` accepts a flat list with one combinator. A future
step (`filter_rows_v2`?) could accept the full tree; for today,
the workspace serializes its 2-level tree into the flat list when
the user commits a filter as a step.

See [step-engine](../subsystems/step-engine.md) for the dispatch.

### 3. Wasm — `apply_filter(rows_json, params_json)`

The Phase B wasm wrapper. JSON in / JSON out. Internally routes
through `steps::apply("filter_rows", params)` — same engine, same
ops, same DTO. The browser gets the full predicate surface for
free.

See [wasm-engine](../subsystems/wasm-engine.md) for the wrapper
suite.

## Adding a new op

A new op has to land in **all three** engine paths or it's broken:

1. Add the variant to `shared::filter::FilterOp` (snake_case
   serde renaming will handle the wire form).
2. Add the match arm in
   `data::parse::filter_expr` — usually a one-liner using
   `polars::Expr` builders.
3. Add the match arm in
   `data::steps::build_filter_predicate` — the same Polars
   expression, scoped to the step engine's case_sensitive
   default.
4. (Optional) Add a focused unit test in `parse::tests` using
   `apply_filter(df, filter_json)` — see the 4 case_sensitive
   tests for the pattern.
5. The wasm wrapper picks it up for free (it routes through the
   step engine).

No DB migration needed — `project_steps.kind` is `text`, params
is JSONB.

## Cross-cuts

- **Wire-additive across versions.** Adding a `FilterOp` variant
  is a backward-compatible change because `serde` deserializes
  unknown variants as errors only when explicitly required —
  every consumer ignores unknown ops via `_ => Err(InvalidSpec)`
  rather than enum-exhaustive matching. Old clients don't
  *emit* the new op, so they don't see the error.
- **Tree-shape unchanged across deeper nesting.** The 2-level
  workspace UI is a depth restriction, not a DTO restriction. A
  3-level or N-level UI lands without a DTO change.
- **Validated server-side, not in the DTO.** `FilterOp` enum
  variants don't carry their value-shape requirements at the
  type level (e.g. `Between` requires `[a, b]`); validation lives
  in the engine match arms. That's deliberate — moving it into
  the type system would force a per-op enum variant carrying its
  value type, which complicates the wire shape for a check that's
  one runtime branch.
- **WS#2 wired this end-to-end.** Workspace's filter UI
  serializes to `FilterNode`, sends through `?filters=` on
  `/page`, and the server returns the filtered result. Without
  the canonical enum reconciliation (`3d29291`), that wiring
  would have been impossible.
