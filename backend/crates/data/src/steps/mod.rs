//! Purpose: apply / replay cleaning steps. `apply` is the single switch from
//! `kind` (open string) → Polars op; the api crate's hydrate path replays the
//! `project_steps` history over the immutable base CSV to reconstruct the
//! current view (non-destructive editing, undo = flip `applied`).
//!
//! `kind` is free-form text (shared::Step) so a new op ships with zero DB/DTO
//! changes; unknown kinds are a clean InvalidSpec.
//!
//! Ported this slice: drop/filter columns, drop/filter/drop_nulls rows,
//! set_cell, fill_nulls, locale-aware cast, change_case, replace_text,
//! fix_invalid. DEFERRED to the structure micro-slice (next): unwrap_csv,
//! join_columns, split_column, format_dates — they error clearly until then.

mod cells;
mod columns;
mod rows;
mod structure;
// `util` exposes the ONE filter-predicate compiler (build_filter_predicate),
// reused by `crate::filter` — so the module must be crate-visible, not private
// to `steps`. Everything else in it stays pub(super)-gated.
pub(crate) mod util;

use shared::Step;

use crate::{DataError, Result};
use polars::prelude::DataFrame;

pub fn apply(df: DataFrame, kind: &str, params: &serde_json::Value) -> Result<DataFrame> {
    match kind {
        "drop_columns" => columns::drop_columns(df, params),
        "filter_columns" => columns::filter_columns(df, params),
        "rename_column" => columns::rename_column(df, params),
        "snake_case_columns" => columns::snake_case_columns(df, params),
        "replace_in_names" => columns::replace_in_names(df, params),

        "drop_rows" => rows::drop_rows(df, params),
        "filter_rows" => rows::filter_rows(df, params),
        "drop_nulls" => rows::drop_nulls(df, params),

        "set_cell" => cells::set_cell(df, params),
        "fill_nulls" => cells::fill_nulls(df, params),
        "cast" => cells::cast(df, params),
        "change_case" => cells::change_case(df, params),
        "replace_text" => cells::replace_text(df, params),
        "fix_invalid" => cells::fix_invalid(df, params),

        "unwrap_csv" => structure::unwrap_csv(df, params),
        "join_columns" => structure::join_columns(df, params),
        "split_column" => structure::split_column(df, params),
        "format_dates" => structure::format_dates(df, params),

        // Genesis marker: "the data as uploaded". It carries the baseline
        // cleanness on its step record (ordinal 0) but transforms nothing, so
        // replaying it is the identity — the base CSV already IS this state.
        "original" => Ok(df),

        other => Err(DataError::InvalidSpec(format!("unknown step kind: {other}"))),
    }
}

/// Apply a sequence of steps in order — the hydrate path's reconstruction of
/// the current view from the base CSV.
pub fn replay(base: DataFrame, steps: &[Step]) -> Result<DataFrame> {
    let mut df = base;
    for step in steps {
        df = apply(df, &step.kind, &step.params)?;
    }
    Ok(df)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn df3() -> DataFrame {
        crate::parse::from_text("id,name,amount\n1,FOO,10\n2,Bar,20\n3,baz,30\n").unwrap()
    }

    #[test]
    fn change_case_lowers_string_columns() {
        let out = apply(df3(), "change_case", &json!({"mode":"lower"})).unwrap();
        let names: Vec<String> =
            out.column("name").unwrap().str().unwrap().iter().map(|o| o.unwrap_or("").into()).collect();
        assert_eq!(names, ["foo", "bar", "baz"]);
    }

    #[test]
    fn drop_and_filter_columns_round_trip() {
        let out = apply(df3(), "drop_columns", &json!({"cols":["amount"]})).unwrap();
        assert_eq!(out.width(), 2);
        let out = apply(df3(), "filter_columns", &json!({"cols":["name"]})).unwrap();
        assert_eq!(out.get_column_names().len(), 1);
    }

    #[test]
    fn filter_rows_applies_predicate() {
        let out = apply(
            df3(),
            "filter_rows",
            &json!({"predicates":[{"column":"amount","op":"gte","value":20}]}),
        )
        .unwrap();
        assert_eq!(out.height(), 2);
    }

    #[test]
    fn locale_cast_recovers_french_numbers() {
        // Build the frame directly: a CSV with FR-comma decimals would be
        // ambiguous against the comma delimiter (that's why real FR exports
        // are `;`-delimited). This isolates the cast's locale coercion.
        use polars::prelude::*;
        let df = DataFrame::new_infer_height(vec![Series::new(
            "p".into(),
            &["1 234,56", "€99,90", "1000 EUR"],
        )
        .into()])
        .unwrap();
        let out = apply(df, "cast", &json!({"column":"p","dtype":"float"})).unwrap();
        let vals: Vec<Option<f64>> = out.column("p").unwrap().f64().unwrap().iter().collect();
        assert_eq!(vals, vec![Some(1234.56), Some(99.90), Some(1000.0)]);
    }

    #[test]
    fn replay_threads_steps_in_order() {
        let steps = vec![
            Step { kind: "drop_columns".into(), params: json!({"cols":["amount"]}) },
            Step { kind: "change_case".into(), params: json!({"mode":"upper"}) },
        ];
        let out = replay(df3(), &steps).unwrap();
        assert_eq!(out.width(), 2);
        let names: Vec<String> =
            out.column("name").unwrap().str().unwrap().iter().map(|o| o.unwrap_or("").into()).collect();
        assert_eq!(names, ["FOO", "BAR", "BAZ"]);
    }

    #[test]
    fn unknown_and_deferred_kinds_error_cleanly() {
        assert!(apply(df3(), "frobnicate", &json!({})).is_err());
        assert!(apply(df3(), "unwrap_csv", &serde_json::Value::Null).is_err());
    }

    #[test]
    fn original_genesis_kind_is_identity() {
        // The genesis marker transforms nothing — replaying it reconstructs the
        // base frame unchanged (the baseline cleanness rides on its step record,
        // not in the frame), so hydrate over the as-uploaded data is a no-op.
        let before = df3();
        let out = apply(df3(), "original", &json!({})).unwrap();
        assert_eq!(out.shape(), before.shape());
        let names: Vec<String> =
            out.column("name").unwrap().str().unwrap().iter().map(|o| o.unwrap_or("").into()).collect();
        let expect: Vec<String> =
            before.column("name").unwrap().str().unwrap().iter().map(|o| o.unwrap_or("").into()).collect();
        assert_eq!(names, expect);
    }
}
