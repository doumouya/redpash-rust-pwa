//! Purpose: order a DataFrame by a list of `shared::SortKey`s — the one place a
//! sort spec becomes ordered rows, for the `/page` window. Consumed by BOTH
//! surfaces: the server's POST `/page` handler (native polars, inside
//! spawn_blocking) and the wasm `Workbook` (single-threaded browser).
//!
//! Thread-free by law: the data crate must compile + run on wasm32
//! (`tools/purity-check.sh`), and polars' parallel sort routes through rayon,
//! which has no wasm32 backend (the `unique_stable` footgun in `clean.rs`). So
//! the sort is pinned single-threaded (`with_multithreaded(false)`) on BOTH
//! surfaces — one engine, byte-identical output server-side and client-side.

use polars::prelude::*;
use shared::sort::SortKey;

use crate::{DataError, Result};

/// Sort `df` by `keys` (first key primary; ties break on the next).
///
/// EMPTY `keys` = identity: the frame is returned unchanged with no work — the
/// same match-all fast path `apply_filter` uses, so an unsorted page is
/// byte-identical to the bare GET page. A key naming a column absent from the
/// frame is an `InvalidSpec` error (a clean 400, never a panic). The sort is
/// STABLE (`maintain_order`): rows equal on every key keep their input order,
/// so a click-to-sort on one column doesn't scramble the rest.
pub fn apply_sort(df: &DataFrame, keys: &[SortKey]) -> Result<DataFrame> {
    if keys.is_empty() {
        return Ok(df.clone());
    }
    // Validate up front so a typo'd column is a clean error, not a polars panic
    // deep in the sort.
    for k in keys {
        if df.column(&k.col).is_err() {
            return Err(DataError::InvalidSpec(format!(
                "sort column not found: {}",
                k.col
            )));
        }
    }
    let by: Vec<&str> = keys.iter().map(|k| k.col.as_str()).collect();
    let descending: Vec<bool> = keys.iter().map(|k| k.descending).collect();
    let opts = SortMultipleOptions::default()
        .with_order_descending_multi(descending)
        .with_maintain_order(true) // stable: equal keys keep input order
        .with_multithreaded(false); // wasm-safe: no rayon (the purity law)
    df.sort(by, opts).map_err(DataError::from)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn df5() -> DataFrame {
        // `amount` parses to i64 (numeric-intent), `name` stays string.
        crate::parse::from_text("id,name,amount\n3,C,30\n1,A,10\n2,B,30\n5,E,50\n4,D,20\n")
            .unwrap()
    }

    fn key(col: &str, descending: bool) -> SortKey {
        SortKey { col: col.into(), descending }
    }

    fn ids(df: &DataFrame) -> Vec<Option<i64>> {
        df.column("id").unwrap().i64().unwrap().iter().collect()
    }

    #[test]
    fn empty_keys_is_identity_unchanged() {
        let df = df5();
        let out = apply_sort(&df, &[]).unwrap();
        assert_eq!(out.height(), 5);
        assert_eq!(ids(&out), ids(&df)); // original order preserved
        assert_eq!(out.get_column_names(), df.get_column_names());
    }

    #[test]
    fn single_key_ascending() {
        let out = apply_sort(&df5(), &[key("amount", false)]).unwrap();
        // amounts 10,20,30,30,50 → ids 1,4,(3,2 stable),5
        assert_eq!(ids(&out), vec![Some(1), Some(4), Some(3), Some(2), Some(5)]);
    }

    #[test]
    fn single_key_descending() {
        let out = apply_sort(&df5(), &[key("amount", true)]).unwrap();
        // 50,30,30,20,10 → ids 5,(3,2 stable),4,1
        assert_eq!(ids(&out), vec![Some(5), Some(3), Some(2), Some(4), Some(1)]);
    }

    #[test]
    fn multi_key_breaks_ties_on_second() {
        // primary amount asc, secondary name desc → the 30-tie (C id3, B id2)
        // orders by name desc: C before B.
        let out = apply_sort(&df5(), &[key("amount", false), key("name", true)]).unwrap();
        assert_eq!(ids(&out), vec![Some(1), Some(4), Some(3), Some(2), Some(5)]);
    }

    #[test]
    fn stable_keeps_input_order_on_equal_keys() {
        // sort only by amount: the two 30s (input order id3 then id2) keep it.
        let out = apply_sort(&df5(), &[key("amount", false)]).unwrap();
        let tie: Vec<Option<i64>> = ids(&out).into_iter().skip(2).take(2).collect();
        assert_eq!(tie, vec![Some(3), Some(2)]);
    }

    #[test]
    fn missing_column_is_invalid_spec() {
        let err = apply_sort(&df5(), &[key("nope", false)]).unwrap_err();
        assert!(matches!(err, DataError::InvalidSpec(_)), "got {err:?}");
    }
}
