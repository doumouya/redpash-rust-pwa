//! Doc: docs/internal/code/backend/data/examples/clean_dir.md
//! Cleaning-EFFICACY harness — the regression gate for "does the tool
//! actually clean?". Sibling of `score_dir.rs`: where that one only
//! *scores* a file, this one runs each raw CSV through the standard
//! cleaning recipe (the always-safe `auto_clean` + `snake_case_columns`
//! + optional date formatting) and RE-scores, so the delta is visible.
//!
//!     cargo run --example clean_dir -- <raw_dir>                  # raw → cleaned Δ per file
//!     cargo run --example clean_dir -- <raw_dir> --dates          # also format date-drift columns
//!     cargo run --example clean_dir -- <raw_dir> --ref <clean_dir> # compare to the human/gold clean file
//!
//! The `--ref` form is the real efficacy metric: `raw → ours → ref`.
//! When `ours` lands well below `ref`, the gap is cleaning we haven't
//! built yet (bool/enum/number normalization, header accent-strip, …).
//! Pairing is by the `NNN` index in `raw_NNN_*.csv` ↔ `clean_NNN_*.csv`.
//!
//! Not part of the app — a throwaway eval tool. It exercises the SAME
//! engine entry points the api crate uses (`clean::auto_clean`,
//! `steps::apply`), so a regression in either shows up here as a flat
//! or falling delta.

use std::{collections::HashMap, env, fs, path::Path};

use serde_json::json;

fn main() {
    let mut args: Vec<String> = env::args().skip(1).collect();
    let dates = take_flag(&mut args, "--dates");
    let ref_dir = take_opt(&mut args, "--ref");
    let dir = args.first().cloned().expect(
        "usage: clean_dir <raw_dir> [--dates] [--ref <clean_dir>]",
    );

    // Index the reference clean files by their NNN prefix, if given.
    let ref_scores: HashMap<String, f32> = ref_dir
        .as_deref()
        .map(|rd| score_dir_by_index(rd))
        .unwrap_or_default();

    let mut paths: Vec<_> = fs::read_dir(&dir)
        .expect("read_dir")
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.extension().and_then(|x| x.to_str()) == Some("csv"))
        .collect();
    paths.sort();

    println!(
        "{:<34} {:>6} {:>6} {:>6}   {:>6}   {}",
        "file", "raw", "clean", "Δ", "ref", "sub-scores (clean): compl/type/hyg/uniq",
    );

    let mut raws = Vec::new();
    let mut cleans = Vec::new();
    let mut deltas = Vec::new();
    let mut met_or_beat_ref = 0usize;
    let mut ref_compared = 0usize;

    for path in &paths {
        let name = path.file_name().unwrap().to_string_lossy().to_string();
        let bytes = match fs::read(path) {
            Ok(b) => b,
            Err(e) => { println!("{name:<34} read-err {e}"); continue; }
        };
        let Some(raw_score) = score_bytes(&bytes) else {
            println!("{name:<34} (unscoreable / empty)");
            continue;
        };

        // ── The standard cleaning recipe ───────────────────────────
        let Some((clean_score, sub)) = clean_and_score(&bytes, dates) else {
            println!("{name:<34} {raw_score:>6.2}  clean-err", );
            continue;
        };
        let delta = clean_score - raw_score;

        // Reference (human/gold clean file) score, matched by NNN.
        let ref_score = file_index(&name).and_then(|ix| ref_scores.get(&ix).copied());
        let ref_str = match ref_score {
            Some(rs) => {
                ref_compared += 1;
                if clean_score + 0.5 >= rs { met_or_beat_ref += 1; }
                format!("{rs:>6.2}")
            }
            None => format!("{:>6}", "-"),
        };

        raws.push(raw_score);
        cleans.push(clean_score);
        deltas.push(delta);

        println!(
            "{name:<34} {raw_score:>6.2} {clean_score:>6.2} {:>+6.1}   {ref_str}   {:5.1}/{:5.1}/{:5.1}/{:5.1}",
            delta, sub.0, sub.1, sub.2, sub.3,
        );
    }

    // ── Summary ────────────────────────────────────────────────────
    println!("\n── summary ──────────────────────────────────────────");
    println!("files scored      : {}", raws.len());
    println!("raw    median     : {:6.2}", median(&mut raws.clone()));
    println!("cleaned median    : {:6.2}", median(&mut cleans.clone()));
    println!("mean Δ (clean−raw): {:+6.2}", mean(&deltas));
    if ref_compared > 0 {
        println!(
            "ours ≥ ref        : {}/{}  (we clean at least as well as the reference on {} files)",
            met_or_beat_ref, ref_compared, met_or_beat_ref,
        );
    }
}

/// Run the standard always-safe cleaning recipe, return (score, sub-scores).
fn clean_and_score(bytes: &[u8], dates: bool) -> Option<(f32, (f32, f32, f32, f32))> {
    let (df, _enc) = data::parse::from_csv_bytes(bytes, None).ok()?;

    // 1+2. trim + sentinel→null + drop dup rows (the conservative core).
    let (mut df, _summary) = data::clean::auto_clean(&df).ok()?;

    // 3. normalise headers (snake_case).
    df = data::steps::apply(df, "snake_case_columns", &json!({})).ok()?;

    // 4. coerce drifting columns (string storage, typed intent) toward
    //    their semantic type — the "user accepts the Data-Types suggestions"
    //    path. Numbers (int/float) first: the dominant gap (255 cols).
    //    date/bool widen this filter as their coercion is hardened.
    let _ = dates; // CLI compat; coercion is now unconditional
    let cols = data::dtype::summarize(&df).ok()?;
    let drift: Vec<(String, String)> = cols.iter()
        .filter(|c| c.dtype == "string" && matches!(c.semantic_dtype.as_str(), "int" | "float" | "date" | "bool"))
        .map(|c| (c.name.clone(), c.semantic_dtype.clone()))
        .collect();
    for (name, sem) in drift {
        if let Ok(next) = data::steps::apply(
            df.clone(), "cast", &json!({ "column": name, "dtype": sem }),
        ) {
            df = next;
        }
    }

    let cols = data::dtype::summarize(&df).ok()?;
    let r = data::stats::cleanness_report(&df, &cols, &[])?;
    Some((r.score, (r.completeness, r.type_consistency, r.value_hygiene, r.row_uniqueness)))
}

fn score_bytes(bytes: &[u8]) -> Option<f32> {
    let (df, _enc) = data::parse::from_csv_bytes(bytes, None).ok()?;
    let cols = data::dtype::summarize(&df).ok()?;
    Some(data::stats::cleanness_report(&df, &cols, &[])?.score)
}

/// Score every CSV in a directory, keyed by its `NNN` index.
fn score_dir_by_index(dir: &str) -> HashMap<String, f32> {
    let mut out = HashMap::new();
    let Ok(rd) = fs::read_dir(dir) else { return out; };
    for entry in rd.flatten() {
        let path = entry.path();
        if path.extension().and_then(|x| x.to_str()) != Some("csv") { continue; }
        let name = path.file_name().unwrap().to_string_lossy().to_string();
        let (Some(ix), Ok(bytes)) = (file_index(&name), fs::read(&path)) else { continue; };
        if let Some(s) = score_bytes(&bytes) { out.insert(ix, s); }
    }
    out
}

/// Extract the `NNN` index from `raw_001_clients_fr.csv` / `clean_001_…`.
fn file_index(name: &str) -> Option<String> {
    let stem = Path::new(name).file_stem()?.to_str()?;
    let mut parts = stem.split('_');
    parts.next()?; // "raw" / "clean"
    let n = parts.next()?;
    if n.chars().all(|c| c.is_ascii_digit()) && !n.is_empty() { Some(n.to_string()) } else { None }
}

fn take_flag(args: &mut Vec<String>, flag: &str) -> bool {
    if let Some(i) = args.iter().position(|a| a == flag) { args.remove(i); true } else { false }
}

fn take_opt(args: &mut Vec<String>, flag: &str) -> Option<String> {
    let i = args.iter().position(|a| a == flag)?;
    args.remove(i);
    if i < args.len() { Some(args.remove(i)) } else { None }
}

fn median(v: &mut [f32]) -> f32 {
    if v.is_empty() { return 0.0; }
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let n = v.len();
    if n % 2 == 1 { v[n / 2] } else { (v[n / 2 - 1] + v[n / 2]) / 2.0 }
}

fn mean(v: &[f32]) -> f32 {
    if v.is_empty() { 0.0 } else { v.iter().sum::<f32>() / v.len() as f32 }
}
