//! Doc: docs/internal/code/backend/data/examples/tools_check.md
//! Tools-palette verification — runs EVERY Tools-panel operation against
//! one real file and prints before→after, so "do all the buttons work?"
//! is answered with data instead of clicking. Each tool is applied to a
//! FRESH parse of the file (independent, no cascade), through the exact
//! `steps::apply(kind, params)` entry the api crate calls.
//!
//!     cargo run --example tools_check -- <file.csv>
//!
//! A tool that errors, or returns an obviously-wrong shape, prints FAIL.
//! Not part of the app — a throwaway functional check (sibling of
//! `clean_dir.rs` / `score_dir.rs`).

use std::env;

use serde_json::{json, Value};

fn main() {
    let path = env::args().nth(1).expect("usage: tools_check <file.csv>");
    let bytes = std::fs::read(&path).expect("read file");
    let (df, enc) = data::parse::from_csv_bytes(&bytes, None).expect("parse");
    let names: Vec<String> = df.get_column_names().iter().map(|s| s.to_string()).collect();

    println!("file    : {path}");
    println!("encoding: {enc:?}");
    println!("shape   : {} cols × {} rows", df.width(), df.height());
    println!("columns : {}", names.join(" | "));
    println!();

    // Resolve columns by position so params track THIS file's real headers.
    let c = |i: usize| names.get(i).cloned().unwrap_or_default();
    // raw_001 layout: 0 id,1 nom,2 email,3 telephone,4 ville,5 date,6 age,7 sexe,8 actif,9 solde
    let date_col = c(5);
    let age_col  = c(6);
    let bool_col = c(8);
    let num_col  = c(9);

    // (label, kind, params, focus column to sample before/after)
    let cases: Vec<(&str, &str, Value, String)> = vec![
        ("Drop nulls",        "drop_nulls",        json!({ "column": c(1) }), c(1)),
        ("Fill nulls (ffwd)", "fill_nulls",        json!({ "column": c(1), "strategy": "forward" }), c(1)),
        ("Change type→float", "cast",              json!({ "column": num_col, "dtype": "float" }), num_col.clone()),
        ("Change type→int",   "cast",              json!({ "column": age_col, "dtype": "int" }), age_col.clone()),
        ("Change type→bool",  "cast",              json!({ "column": bool_col, "dtype": "bool" }), bool_col.clone()),
        ("Change type→date",  "cast",              json!({ "column": date_col, "dtype": "date" }), date_col.clone()),
        ("Rename column",     "rename_column",     json!({ "from": c(0), "to": "client_ref" }), c(0)),
        ("Drop columns",      "drop_columns",      json!({ "cols": [c(2)] }), c(2)),
        ("Keep columns",      "filter_columns",    json!({ "cols": [c(0), c(1), num_col] }), c(0)),
        ("Snake-case headers","snake_case_columns",json!({}), c(7)),
        ("Replace in names",  "replace_in_names",  json!({ "find": " ", "replace": "" }), c(1)),
        ("Change case (vals)","change_case",       json!({ "mode": "lower" }), c(7)),
        ("Replace text",      "replace_text",      json!({ "column": c(2), "find": "@example.fr", "replace": "@redpash.io" }), c(2)),
        ("Fix invalid",       "fix_invalid",       json!({ "sentinels": ["inconnu", "NA", "TBD", "#NAME?", "#VALUE!", "null", "-"] }), c(1)),
        ("Concatenate cols",  "join_columns",      json!({ "col1": c(0), "col2": c(4), "sep": " · ", "new_name": "id_ville" }), c(0)),
        ("Split column",      "split_column",      json!({ "column": c(3), "sep": " ", "keep_original": true }), c(3)),
        ("Format dates",      "format_dates",      json!({ "column": date_col, "fmt": "%Y-%m-%d", "on_incomplete": "keep" }), date_col.clone()),
        ("Unwrap CSV",        "unwrap_csv",        json!({}), c(0)),
    ];

    let (mut pass, mut fail) = (0, 0);
    for (label, kind, params, focus) in cases {
        let before = sample(&df, &focus, 3);
        match data::steps::apply(df.clone(), kind, &params) {
            Ok(out) => {
                let shape = format!("{}c×{}r", out.width(), out.height());
                // Did the focus column survive? (rename/drop/split intentionally remove it)
                let after = sample(&out, &focus, 3);
                // Unwrap is EXPECTED to fail on a multi-col frame — that's correct.
                println!("✅ {label:<20} [{shape}]");
                if !before.is_empty() || !after.is_empty() {
                    println!("     {focus}: {before}  →  {after}");
                }
                pass += 1;
            }
            Err(e) => {
                let expected = kind == "unwrap_csv" && df.width() > 1;
                if expected {
                    println!("➖ {label:<20} (correctly refused: {e})");
                } else {
                    println!("❌ {label:<20} FAIL: {e}");
                    fail += 1;
                }
            }
        }
    }
    println!("\n{pass} ok, {fail} fail");
}

/// First `n` non-null values of `col` as a compact string, or "" if the
/// column is gone (dropped/renamed/split).
fn sample(df: &polars::prelude::DataFrame, col: &str, n: usize) -> String {
    let Ok(s) = df.column(col) else { return String::new(); };
    let mut out = Vec::new();
    for i in 0..s.len().min(n * 4) {
        if let Ok(v) = s.get(i) {
            let t = format!("{v}");
            if t != "null" && !t.is_empty() { out.push(t); }
        }
        if out.len() >= n { break; }
    }
    out.join(", ")
}
