//! Purpose: Polars-SQL execution substrate — register named frames, run a
//! read-only SQL query, return the result DataFrame.
//! Doc: docs/internal/code/backend/data/sql.md
//!
//! The single execution path behind the Workspace SQL editor (and, later, the
//! GUI-compiles-to-SQL layer). Polars translates SQL into its own expression
//! engine — there is no external SQL database in the loop; the SQLContext is
//! sandboxed to the frames we register (no fs / network reach).
//!
//! What Polars 0.43 SQL actually supports is recorded in
//! `docs/internal/specs/sql-redtable/phase-0-coverage.md` (22/30 of the target
//! analytical surface run natively or via a trivial rewrite; the window
//! ranking/navigation family — ROW_NUMBER/RANK/LAG/LEAD/NTILE — routes through
//! the expression API instead, and is filled in a later phase).
//!
//! Compiles on BOTH surfaces (the wasm polars carries the `sql` feature), so
//! this module is deliberately NOT cfg-gated.

use polars::prelude::*;
use polars::sql::SQLContext;

use crate::{DataError, Result};

/// Hard ceiling on a SQL result's row count. A JOIN / cross-product can blow up
/// well past any single source's size; rather than risk OOM we bound the
/// collected result and ask the caller to add a `LIMIT`. In lockstep with the
/// frontend client-engine row cap (CAS_21B43BEC).
///
/// Reconciliation: the predecessor declared its own `SQL_RESULT_ROW_CAP` (also
/// 500_000). The target unifies every row cap behind the single
/// [`crate::ROW_CAP`] constant (server page clamp + SQL cap + client buffer),
/// so this name is now a re-export alias rather than a second source of truth.
pub use crate::ROW_CAP as SQL_RESULT_ROW_CAP;

/// Run a read-only SQL query against a set of named in-memory tables.
///
/// Each `(name, frame)` is registered as a lazy table; `sql` is executed by
/// Polars' own engine and the result is collected (bounded by
/// [`SQL_RESULT_ROW_CAP`]). The query is rejected unless it passes
/// [`is_read_only`] — the context is already sandboxed to the registered frames,
/// but a *query* endpoint must also refuse in-memory mutations (Polars SQL will
/// happily parse `CREATE`/`DROP`/`TRUNCATE`/`INSERT` against its own tables).
///
/// The caller paginates + stringifies the returned frame for the wire.
pub fn run_sql(tables: Vec<(String, DataFrame)>, sql: &str) -> Result<DataFrame> {
    let trimmed = sql.trim();
    if trimmed.is_empty() {
        return Err(DataError::InvalidSpec("empty SQL".into()));
    }
    if !is_read_only(trimmed) {
        return Err(DataError::InvalidSpec(
            "only read-only queries are allowed (SELECT / WITH / set-operations); \
             DDL/DML (CREATE, DROP, INSERT, UPDATE, DELETE, …) is rejected"
                .into(),
        ));
    }

    let mut ctx = SQLContext::new();
    for (name, frame) in tables {
        ctx.register(&name, frame.lazy());
    }

    // Bound memory before we even materialize: pull one row past the cap so we
    // can distinguish "exactly at the cap" from "truncated → error".
    let cap = SQL_RESULT_ROW_CAP as u32;
    let lf = ctx.execute(trimmed)?; // PolarsError on parse / unknown table / unsupported fn
    let out = lf.limit(cap + 1).collect()?;

    if out.height() > SQL_RESULT_ROW_CAP {
        return Err(DataError::InvalidSpec(format!(
            "result exceeds {SQL_RESULT_ROW_CAP} rows — add a LIMIT or narrow the query"
        )));
    }
    Ok(out)
}

/// True when `sql` is a single read-only statement. Conservative allowlist: the
/// statement must begin with `SELECT`, `WITH`, or `(` (parenthesized set-op),
/// carry no DDL/DML keyword token, and be a single statement (no stacked
/// `;`-separated queries).
///
/// Comments and string-literal contents are stripped before the keyword scan,
/// so a forbidden word can hide in neither `-- …` / `/* … */` nor `'… drop …'`.
pub fn is_read_only(sql: &str) -> bool {
    let norm = normalize_for_check(sql);
    let s = norm.trim();

    // Single statement only (one optional trailing ';' is fine).
    let body = s.strip_suffix(';').unwrap_or(s).trim();
    if body.contains(';') {
        return false;
    }

    let lower = body.to_ascii_lowercase();
    let starts_ok =
        lower.starts_with("select") || lower.starts_with("with") || lower.starts_with('(');
    if !starts_ok {
        return false;
    }

    const FORBIDDEN: &[&str] = &[
        "insert", "update", "delete", "drop", "create", "alter", "truncate", "attach", "copy",
        "merge", "grant", "revoke", "call", "execute", "replace", "into", "vacuum", "analyze",
    ];
    !tokenize(&lower)
        .iter()
        .any(|t| FORBIDDEN.contains(&t.as_str()))
}

/// Strip `-- line` and `/* block */` comments AND empty out string-literal
/// contents (keeping the surrounding structure), so the keyword scan sees only
/// SQL syntax — never user text or commented-out code.
fn normalize_for_check(sql: &str) -> String {
    let b = sql.as_bytes();
    let mut out = String::with_capacity(b.len());
    let mut i = 0;
    let mut in_line = false;
    let mut in_block = false;
    let mut in_str: Option<u8> = None; // Some(b'\'') or Some(b'"')
    while i < b.len() {
        let c = b[i];
        let n = if i + 1 < b.len() { b[i + 1] } else { 0 };
        if in_line {
            if c == b'\n' {
                in_line = false;
                out.push('\n');
            }
            i += 1;
        } else if in_block {
            if c == b'*' && n == b'/' {
                in_block = false;
                i += 2;
            } else {
                i += 1;
            }
        } else if let Some(q) = in_str {
            // Drop the content; close on the matching quote.
            if c == q {
                in_str = None;
            }
            i += 1;
        } else if c == b'-' && n == b'-' {
            in_line = true;
            i += 2;
        } else if c == b'/' && n == b'*' {
            in_block = true;
            i += 2;
        } else if c == b'\'' || c == b'"' {
            in_str = Some(c);
            i += 1;
        } else {
            out.push(c as char);
            i += 1;
        }
    }
    out
}

/// Split a lowercase string into alphanumeric/underscore word tokens, so a
/// column named `update_date` is one token (≠ `update`) and never trips the
/// keyword filter.
fn tokenize(s: &str) -> Vec<String> {
    s.split(|c: char| !(c.is_ascii_alphanumeric() || c == '_'))
        .filter(|t| !t.is_empty())
        .map(|t| t.to_string())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn df_orders() -> DataFrame {
        df![
            "id"     => [1i64, 2, 3],
            "amt"    => [100.0f64, 50.0, 200.0],
            "status" => ["paid", "pending", "paid"],
        ]
        .unwrap()
    }

    #[test]
    fn runs_basic_select() {
        let out = run_sql(
            vec![("t".into(), df_orders())],
            "SELECT id, amt FROM t WHERE amt > 60",
        )
        .unwrap();
        assert_eq!(out.height(), 2);
        assert_eq!(out.width(), 2);
    }

    #[test]
    fn allows_with_and_setops() {
        assert!(is_read_only("WITH p AS (SELECT * FROM t) SELECT * FROM p"));
        assert!(is_read_only("SELECT a FROM t UNION ALL SELECT a FROM u"));
        assert!(is_read_only("select * from t -- drop table t\n"));
        assert!(is_read_only(
            "SELECT * FROM t WHERE name = 'please drop everything'"
        ));
    }

    #[test]
    fn rejects_mutations_and_stacked() {
        assert!(!is_read_only("DROP TABLE t"));
        assert!(!is_read_only("CREATE TABLE x AS SELECT * FROM t"));
        assert!(!is_read_only("INSERT INTO t VALUES (1)"));
        assert!(!is_read_only("SELECT * FROM t; DROP TABLE t"));
        assert!(!is_read_only("DELETE FROM t"));
        assert!(run_sql(vec![("t".into(), df_orders())], "DROP TABLE t").is_err());
    }
}
