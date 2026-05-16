//! Dev eval harness — score every CSV in a directory through the exact
//! upload path (`from_csv_bytes` → `summarize` → `stats::cleanness_report`).
//!
//!     cargo run --example score_dir -- <dir>           # one summary line per file
//!     cargo run --example score_dir -- <dir> -v        # also list per-column drift / mojibake / dirt
//!
//! Each line carries the blended score, every sub-score, and the
//! structural sub-signals. A `flags:` tail surfaces the high-level
//! diagnostic categories so `grep flags=mojibake` etc. just works.
//! Not part of the app — a throwaway tool for validating the cleanness
//! scorer + parser against sample datasets.

use std::{env, fs};

fn main() {
    let mut args = env::args().skip(1);
    let dir = args.next().expect("usage: score_dir <dir> [-v]");
    let verbose = args.any(|a| a == "-v" || a == "--verbose");

    let mut paths: Vec<_> = fs::read_dir(&dir)
        .expect("read_dir")
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.extension().and_then(|x| x.to_str()) == Some("csv"))
        .collect();
    paths.sort();

    for path in paths {
        let name = path.file_name().unwrap().to_string_lossy().to_string();
        let bytes = match fs::read(&path) {
            Ok(b) => b,
            Err(e) => { println!("{name}\tread-err\t{e}"); continue; }
        };
        match data::parse::from_csv_bytes(&bytes, None) {
            Ok((df, _enc)) => match data::dtype::summarize(&df) {
                Ok(cols) => print_report(&name, &df, &cols, verbose),
                Err(e) => println!("{name}\tsummarize-err\t{e}"),
            },
            Err(e) => println!("{name}\tparse-err\t{e}"),
        }
    }
}

fn print_report(name: &str, df: &polars::prelude::DataFrame, cols: &[shared::file::ColumnMeta], verbose: bool) {
    let Some(r) = data::stats::cleanness_report(df, cols) else {
        println!("{name}\tempty");
        return;
    };

    // Collect drifting columns (storage != semantic, where the diff is meaningful).
    let drift_cols: Vec<&shared::file::ColumnMeta> = cols.iter()
        .filter(|c| c.dtype == "string"
            && matches!(c.semantic_dtype.as_str(), "int" | "float" | "date" | "bool"))
        .collect();

    // Flags surface the high-level diagnostic categories at a glance.
    let mut flags: Vec<String> = Vec::new();
    if !drift_cols.is_empty() { flags.push(format!("drift={}", drift_cols.len())); }
    if r.shape_integrity    < 0.999 { flags.push(format!("shape={:.2}",    r.shape_integrity)); }
    if r.encoding_integrity < 0.999 { flags.push(format!("mojibake={:.2}", r.encoding_integrity)); }
    if r.header_integrity   < 0.999 { flags.push(format!("header={:.2}",   r.header_integrity)); }
    let flags_str = if flags.is_empty() { "-".into() } else { flags.join(",") };

    println!(
        "{:6.2}  compl={:5.1} type={:5.1} hyg={:5.1} uniq={:5.1}  struct={:.2}  {:>3}c × {:>4}r  flags={}  {}",
        r.score,
        r.completeness, r.type_consistency, r.value_hygiene, r.row_uniqueness,
        r.structural,
        df.width(), df.height(),
        flags_str,
        name,
    );

    if verbose && !drift_cols.is_empty() {
        for c in drift_cols {
            println!("        ⤷ drift: {:24} storage={:<6} → semantic={}", c.name, c.dtype, c.semantic_dtype);
        }
    }
}
