//! Apply / replay cleaning steps against a Polars DataFrame.
//!
//! `apply` is the single switch from `kind` (string) → Polars op. Every
//! handler in the api crate that mutates a file's state goes through
//! `replay`: the canonical file is the on-disk CSV; the persistent
//! history is `project_steps`; the current view is the replay result.
//!
//! Supported kinds (Phase A complete set, except split / join / dates /
//! fix_invalid which land in Phase A.2):
//!
//!   drop_columns       params.cols: [string]
//!   drop_rows          params.indices: [int]
//!   drop_nulls         params.cols?: [string]   (empty → any-null row)
//!   set_cell           params.row: int, params.column: string,
//!                      params.value: string|number|null
//!                      Replace one cell at (row, column). Cast to the
//!                      column's dtype; empty/null → NULL cell.
//!   fill_nulls         params.strategy: "fixed"|"zero"|"forward"
//!                      params.column?: string
//!                      params.value?:  string|number  (for fixed)
//!   cast               params.column: string, params.dtype: int|float|str|bool
//!   rename_column      params.from, params.to
//!   snake_case_columns no params; renames every header to snake_case
//!   replace_in_names   params.find: string, params.replace?: string
//!   change_case        params.mode: "lower"|"upper"|"title"
//!   filter_columns     params.cols: [string]    (columns to KEEP)
//!   filter_rows        params.combinator: "and"|"or"
//!                      params.predicates: [{ column, op, value?, case_sensitive? }]
//!                      ops: eq · neq · in · not_in · contains · starts_with ·
//!                           ends_with · gt · gte · lt · lte · between ·
//!                           before · after · is_null · not_null
//!                      Drops rows that fail the combined predicate — undoable
//!                      like every other step; canonical CSV stays intact.
//!   unwrap_csv         no params. Rescues a "wrapped" CSV — one where every
//!                      row parsed as a single quoted column because the
//!                      original separator was wrapped in quotes. Re-parses
//!                      the single column's values as CSV themselves.
//!   replace_text       params.column, params.find, params.replace?, params.is_regex?
//!                      remove_text = replace_text with replace=""

use crate::{DataError, Result};
use polars::prelude::*;

mod cells;
mod columns;
mod rows;
mod structure;
mod util;

pub fn apply(df: DataFrame, kind: &str, params: &serde_json::Value) -> Result<DataFrame> {
    match kind {
        "drop_columns"   => columns::drop_columns(df, params),
        "filter_columns" => columns::filter_columns(df, params),

        "drop_rows"   => rows::drop_rows(df, params),
        "filter_rows" => rows::filter_rows(df, params),

        "unwrap_csv" => structure::unwrap_csv(df, params),

        "drop_nulls" => rows::drop_nulls(df, params),

        "set_cell"   => cells::set_cell(df, params),
        "fill_nulls" => cells::fill_nulls(df, params),
        "cast"       => cells::cast(df, params),

        "rename_column"      => columns::rename_column(df, params),
        "snake_case_columns" => columns::snake_case_columns(df, params),
        "replace_in_names"   => columns::replace_in_names(df, params),

        "change_case"  => cells::change_case(df, params),
        "replace_text" => cells::replace_text(df, params),
        "fix_invalid"  => cells::fix_invalid(df, params),

        "join_columns" => structure::join_columns(df, params),
        "split_column" => structure::split_column(df, params),
        "format_dates" => structure::format_dates(df, params),

        other => Err(DataError::InvalidSpec(format!("unknown step kind: {other}"))),
    }
}

/// Apply a sequence of steps in order. Used by the api crate's hydrate
/// path to reconstruct the current view from the base CSV.
pub fn replay(base: DataFrame, steps: &[(&str, serde_json::Value)]) -> Result<DataFrame> {
    let mut df = base;
    for (kind, params) in steps {
        df = apply(df, kind, params)?;
    }
    Ok(df)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A wrapped one-column frame whose rows each use a DIFFERENT inner
    /// delimiter and quote style — the `raw_dossier_onecol_tricky`
    /// shape. After `unwrap_csv` every row must land in the same
    /// columns, regardless of its individual wrapping.
    #[test]
    fn unwrap_csv_handles_per_row_delimiter_and_quote_variation() {
        let df = df![
            "id,\"name\",\"city\",\"ok\"" => [
                "R1,\"Alice\",\"Paris\",\"yes\"",          // comma + double quote
                "R2;\"Bob\";\"Lyon\";\"no\"",              // semicolon
                "R3|\"Carol\"|\"Nice\"|\"yes\"",           // pipe
                "R4,\\\"Dan\\\",\\\"Metz\\\",\\\"no\\\"",  // backslash-escaped quote
                "R5,'Eve','Lille','yes'",                  // single quote
                "R6,Frank,Caen,no",                        // bare, unquoted
            ]
        ]
        .unwrap();

        let out = apply(df, "unwrap_csv", &serde_json::Value::Null).unwrap();

        assert_eq!(out.width(), 4, "every row must unwrap to the 4 real columns");
        assert_eq!(out.height(), 6);

        let cols: Vec<&str> =
            out.get_column_names().iter().map(|c| c.as_str()).collect();
        assert_eq!(cols, ["id", "name", "city", "ok"]);

        let col = |name: &str| -> Vec<String> {
            out.column(name)
                .unwrap()
                .str()
                .unwrap()
                .into_iter()
                .map(|o| o.unwrap_or("").to_string())
                .collect()
        };
        // The `;`, `|`, `\"`-escaped and `'`-quoted rows all split into
        // the right cells — not just the dominant comma/double-quote row.
        assert_eq!(col("name"), ["Alice", "Bob", "Carol", "Dan", "Eve", "Frank"]);
        assert_eq!(col("city"), ["Paris", "Lyon", "Nice", "Metz", "Lille", "Caen"]);
    }
}
