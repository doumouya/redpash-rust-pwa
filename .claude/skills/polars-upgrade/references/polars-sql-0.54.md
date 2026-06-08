# polars-sql 0.54 — the SQL surface RedPash wraps

RedPash's read-only SQL runs through `polars-sql`'s `SQLContext` (see `data/src/sql.rs`
and the `redpash-polars` skill's "Read-only SQL over named frames" shape). When a
`polars-sql` bump changes a signature or deprecates something, fetch the relevant page
rather than guessing — methods live on the owner's page.

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
- `SQLContext` is in `polars::sql`, **not** the prelude — import it explicitly.
- Bound results with `.limit(cap + 1)` (a JOIN cross-product blows past any source
  size); `cap + 1` distinguishes "exactly at cap" from "truncated" — see
  `redpash-polars` footgun #7 and `SQL_RESULT_ROW_CAP`.
- The `function_registry` is the same open-registry (Providers) shape RedPash uses for
  codecs and rules — see the `rust-object-registry-design` skill.
