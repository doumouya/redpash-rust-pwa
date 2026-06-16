# polars-sql 0.54 — the SQL surface RedPash wraps

RedPash's read-only SQL runs through `polars-sql`'s `SQLContext` (see
`backend/crates/data/src/sql.rs`'s `run_sql` and the `redpash-polars` skill's "Read-only
SQL over named frames" shape). When a `polars-sql` bump changes a signature or deprecates
something, fetch the relevant page rather than guessing — methods live on the owner's page.
(For a forward bump past 0.54, swap the version in the URLs below for the new one.)

| Item | What we use it for | docs.rs |
|---|---|---|
| `SQLContext` | register named frames + `execute(sql)` → `LazyFrame` | https://docs.rs/polars-sql/0.54.4/polars_sql/struct.SQLContext.html |
| `sql_expr` (fn) | parse a single SQL expression into an `Expr` | https://docs.rs/polars-sql/0.54.4/polars_sql/fn.sql_expr.html |
| `extract_table_identifiers` (fn) | discover which tables a query references | https://docs.rs/polars-sql/0.54.4/polars_sql/fn.extract_table_identifiers.html |
| `function_registry::FunctionRegistry` (trait) | the open SQL-function registry (Providers pattern) | https://docs.rs/polars-sql/0.54.4/polars_sql/function_registry/trait.FunctionRegistry.html |
| `function_registry::DefaultFunctionRegistry` | the built-in registry | https://docs.rs/polars-sql/0.54.4/polars_sql/function_registry/struct.DefaultFunctionRegistry.html |
| `function_registry::FunctionOptions` | per-function options | https://docs.rs/polars-sql/0.54.4/polars_sql/function_registry/struct.FunctionOptions.html |
| `keywords::all_keywords` / `all_functions` (fns) | reserved keyword / function name lists | https://docs.rs/polars-sql/0.54.4/polars_sql/keywords/index.html |
| crate root / all items | everything else | https://docs.rs/polars-sql/0.54.4/polars_sql/ · https://docs.rs/polars-sql/0.54.4/polars_sql/all.html |

Notes:
- `SQLContext` is in `polars::sql`, **not** the prelude — import it explicitly
  (`use polars::sql::SQLContext;`, as `sql.rs` does).
- The query is gated by `is_read_only` (an allowlist: must start with `SELECT`/`WITH`/`(`,
  no DDL/DML token, single statement) before it ever reaches the engine — the context is
  already sandboxed to the registered frames, but a query endpoint must also refuse
  in-memory mutations (Polars SQL will happily parse `CREATE`/`DROP`/`INSERT`).
- Bound results with `.limit(cap + 1)` (a JOIN cross-product blows past any source
  size); `cap + 1` distinguishes "exactly at cap" from "truncated". In lean the cap is
  the single `crate::ROW_CAP` constant, re-exported from `sql.rs` as
  `SQL_RESULT_ROW_CAP` (one source of truth for the server page clamp + SQL cap + client
  buffer — see `redpash-polars` footgun on the row cap). The predecessor declared a
  separate `SQL_RESULT_ROW_CAP`; lean unified it, so the name here is an alias, not a
  second constant.
- The module compiles on **both** surfaces (the wasm polars carries the `sql` feature) and
  is deliberately NOT cfg-gated — it backs the server `/sql` route and the client-side
  `Workbook.sql` export. The bundle cost of pulling the SQL planner into wasm (+~7 MiB
  raw / +~1 MiB gz) is an accepted cost; see `docs/decisions/client-data-engines.md`.
- `function_registry` is the same open-registry (Providers) shape RedPash uses for its
  typed object model. The registry design itself lives in
  `docs/decisions/registry-redundancy.md` and the code in
  `backend/crates/api/src/{objects,types,type_cache}.rs` — read those (the older draft
  cited a `rust-object-registry-design` skill that is not installed in `.claude/skills/`).
