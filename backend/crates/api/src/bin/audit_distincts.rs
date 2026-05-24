//! `redpash-audit-distincts` — measurement walk for the column-index
//! design (Torv ↔ Gus, Internal-Slack 2026-05-24).
//!
//! Walks every CSV-typed file in `project_files`, parses it from disk,
//! and for every column computes the distinct-value set using the
//! existing `data::joins::unique_per_col(df, MAX_UNIQUE)` primitive
//! (same cap the autocomplete endpoint will use). Records per-file
//! stats + prints a distribution summary so the architecture decisions
//! (LRU bound, eager-vs-lazy preload, all-cols-vs-per-col endpoint,
//! whether MAX_UNIQUE=5000 is enough) land on data, not a guess.
//!
//! Read-only — no DB writes, no API surface change.
//!
//! Output:
//!   - per-file CSV   →  tools/distincts-audit/per-file.csv
//!   - distribution   →  stdout + tools/distincts-audit/report.md
//!
//! Usage (from repo root):
//!     cargo run --bin redpash-audit-distincts

use anyhow::{Context, Result};
use sqlx::{postgres::PgPoolOptions, Row};
use std::collections::HashSet;
use std::path::PathBuf;
use std::time::Instant;

const MAX_UNIQUE: usize = data::joins::MAX_UNIQUE;

struct PerFile {
    rid:                   String,
    filename:              String,
    row_count:             u64,
    col_count:             u32,
    distinct_total:        u64,      // sum of |distinct set| across cols
    distinct_bytes_total:  u64,      // sum of UTF-8 bytes across all distinct values
    distincts_per_col:     Vec<u32>, // per-col distinct count
    bytes_per_distinct:    Vec<u32>, // per-string byte size (sample of all)
    cols_at_cap:           u32,      // cols that hit MAX_UNIQUE
    scan_ms:               u64,
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<()> {
    let _ = dotenvy::dotenv();
    let _ = dotenvy::from_filename("backend/.env");
    let _ = dotenvy::from_filename("../.env");

    let db_url = std::env::var("DATABASE_URL").context("DATABASE_URL not set")?;
    let data_dir: PathBuf = std::env::var("REDPASH_DATA_DIR")
        .unwrap_or_else(|_| "./data".to_string())
        .into();

    let pool = PgPoolOptions::new()
        .max_connections(2)
        .connect(&db_url)
        .await
        .context("connect Postgres")?;

    // Walk CSV-typed files (xlsx/json get converted to CSV on upload,
    // dashboards/charts have no row data). Sort by row_count DESC NULLS
    // LAST so the biggest files are scanned first — the run halts
    // early on Ctrl-C still gets the most-interesting rows reported.
    //
    // PROJECT-FILES-ACK: type=csv — distincts audit only runs on the
    // data-bearing rows; spec-only types have no frame to scan.
    let rows = sqlx::query(
        "SELECT pf.redpash_id, pf.filename, pf.storage_path, pf.encoding,
                pf.row_count, pf.col_count
           FROM project_files pf
          WHERE pf.file_type IN ('csv')
          ORDER BY pf.row_count DESC NULLS LAST",
    )
    .fetch_all(&pool)
    .await
    .context("list project_files")?;

    println!("scanning {} files from {}", rows.len(), data_dir.display());

    let mut per_file: Vec<PerFile> = Vec::with_capacity(rows.len());

    for (i, r) in rows.iter().enumerate() {
        let rid:       String         = r.try_get("redpash_id").unwrap_or_default();
        let filename:  String         = r.try_get("filename").unwrap_or_default();
        let storage:   String         = r.try_get("storage_path").unwrap_or_default();
        let encoding:  Option<String> = r.try_get("encoding").ok();
        let row_count: Option<i64>    = r.try_get("row_count").ok();
        let col_count: Option<i32>    = r.try_get("col_count").ok();

        let path = data_dir.join(&storage);
        let bytes = match std::fs::read(&path) {
            Ok(b)  => b,
            Err(e) => { eprintln!("  ⚠ {}: read failed: {}", rid, e); continue; }
        };

        // Parse with the persisted encoding when present; otherwise let
        // chardetng pick. Matches what the hydrate path does in
        // routes::files at file-open time.
        let parse_t0 = Instant::now();
        let df = match (
            encoding.as_deref(),
            data::parse::from_csv_bytes_with_encoding(&bytes, encoding.as_deref().unwrap_or("utf-8"))
        ) {
            (_, Ok(df))          => df,
            (Some(_), Err(_))    => {
                match data::parse::from_csv_bytes(&bytes, None) {
                    Ok((df, _)) => df,
                    Err(e)      => { eprintln!("  ⚠ {}: parse failed: {}", rid, e); continue; }
                }
            }
            (None, Err(e))       => { eprintln!("  ⚠ {}: parse failed: {}", rid, e); continue; }
        };
        let _parse_ms = parse_t0.elapsed().as_millis() as u64;

        // The actual measurement — running the same primitive the
        // autocomplete endpoint will call.
        let scan_t0 = Instant::now();
        let map = match data::joins::unique_per_col(&df, MAX_UNIQUE) {
            Ok(m)  => m,
            Err(e) => { eprintln!("  ⚠ {}: unique_per_col failed: {}", rid, e); continue; }
        };
        let scan_ms = scan_t0.elapsed().as_millis() as u64;

        let cols = df.get_columns();
        let mut distincts_per_col: Vec<u32> = Vec::with_capacity(map.len());
        let mut bytes_per_distinct: Vec<u32> = Vec::new();
        let mut distinct_total:       u64 = 0;
        let mut distinct_bytes_total: u64 = 0;
        let mut cols_at_cap:          u32 = 0;
        for c in cols {
            let name = c.name().to_string();
            let set: &HashSet<String> = match map.get(&name) {
                Some(s) => s,
                None    => continue,
            };
            distincts_per_col.push(set.len() as u32);
            distinct_total += set.len() as u64;
            if set.len() >= MAX_UNIQUE { cols_at_cap += 1; }
            for v in set {
                let b = v.len() as u32;
                bytes_per_distinct.push(b);
                distinct_bytes_total += b as u64;
            }
        }

        let pf = PerFile {
            rid:                  rid.clone(),
            filename,
            row_count:            row_count.unwrap_or(df.height() as i64) as u64,
            col_count:            col_count.unwrap_or(df.width() as i32) as u32,
            distinct_total,
            distinct_bytes_total,
            distincts_per_col,
            bytes_per_distinct,
            cols_at_cap,
            scan_ms,
        };

        println!(
            "  [{:>3}/{}]  {:<40}  rows={:>7}  cols={:>3}  distincts={:>7}  bytes={:>10}  scan={}ms  cap_hit={}",
            i + 1, rows.len(),
            shorten(&pf.filename, 38),
            pf.row_count, pf.col_count, pf.distinct_total,
            pf.distinct_bytes_total, pf.scan_ms, pf.cols_at_cap,
        );
        per_file.push(pf);
    }

    write_per_file_csv(&per_file).context("write per-file CSV")?;
    print_summary(&per_file);
    write_report_md(&per_file).context("write report.md")?;

    Ok(())
}

fn shorten(s: &str, max: usize) -> String {
    if s.len() <= max { s.to_string() } else { format!("{}…", &s[..max.saturating_sub(1)]) }
}

fn write_per_file_csv(pf: &[PerFile]) -> Result<()> {
    let out_dir = PathBuf::from("tools/distincts-audit");
    std::fs::create_dir_all(&out_dir)?;
    let path = out_dir.join("per-file.csv");
    let mut s = String::from("rid,filename,row_count,col_count,distinct_total,distinct_bytes_total,cols_at_cap,scan_ms\n");
    for r in pf {
        s.push_str(&format!(
            "{},{},{},{},{},{},{},{}\n",
            r.rid, csv_quote(&r.filename),
            r.row_count, r.col_count,
            r.distinct_total, r.distinct_bytes_total, r.cols_at_cap, r.scan_ms,
        ));
    }
    std::fs::write(&path, s)?;
    println!("\n  per-file → {}", path.display());
    Ok(())
}

fn csv_quote(s: &str) -> String {
    if s.contains(',') || s.contains('"') || s.contains('\n') {
        format!("\"{}\"", s.replace('"', "\"\""))
    } else { s.to_string() }
}

fn percentile(mut v: Vec<u64>, p: f64) -> u64 {
    if v.is_empty() { return 0; }
    v.sort();
    let idx = ((v.len() - 1) as f64 * p).round() as usize;
    v[idx]
}

fn print_summary(pf: &[PerFile]) {
    if pf.is_empty() { println!("\n  no files scanned."); return; }

    // Per-file distributions.
    let scans: Vec<u64> = pf.iter().map(|x| x.scan_ms).collect();
    let cols:  Vec<u64> = pf.iter().map(|x| x.col_count as u64).collect();
    let bytes_per_file: Vec<u64> = pf.iter().map(|x| x.distinct_bytes_total).collect();
    let total_cap_hits: u32  = pf.iter().map(|x| x.cols_at_cap).sum();
    let files_with_cap: usize = pf.iter().filter(|x| x.cols_at_cap > 0).count();

    // Per-col distributions (flatten across all files).
    let distincts_flat: Vec<u64> =
        pf.iter().flat_map(|x| x.distincts_per_col.iter().map(|n| *n as u64)).collect();
    // Bytes-per-distinct-string (flatten across all distinct values).
    let bytes_flat: Vec<u64> =
        pf.iter().flat_map(|x| x.bytes_per_distinct.iter().map(|n| *n as u64)).collect();

    println!("\n  ── distribution summary ──────────────────────────────────────────────");
    println!("  files scanned       {}", pf.len());
    println!("  cols-per-file       P50 {:<6} P90 {:<6} P99 {}",
        percentile(cols.clone(),  0.50),
        percentile(cols.clone(),  0.90),
        percentile(cols,          0.99));
    println!("  distincts-per-col   P50 {:<6} P90 {:<6} P99 {}",
        percentile(distincts_flat.clone(), 0.50),
        percentile(distincts_flat.clone(), 0.90),
        percentile(distincts_flat,         0.99));
    println!("  bytes-per-distinct  P50 {:<6} P90 {:<6} P99 {}",
        percentile(bytes_flat.clone(), 0.50),
        percentile(bytes_flat.clone(), 0.90),
        percentile(bytes_flat,         0.99));
    println!("  bytes-per-file      P50 {:<10} P90 {:<10} P99 {}",
        percentile(bytes_per_file.clone(), 0.50),
        percentile(bytes_per_file.clone(), 0.90),
        percentile(bytes_per_file,         0.99));
    println!("  scan-ms-per-file    P50 {:<6} P90 {:<6} P99 {}",
        percentile(scans.clone(), 0.50),
        percentile(scans.clone(), 0.90),
        percentile(scans,         0.99));
    println!("  cap-hit cols total  {}", total_cap_hits);
    println!("  cap-hit files       {} / {}", files_with_cap, pf.len());
    println!("  MAX_UNIQUE cap      {}", MAX_UNIQUE);
}

fn write_report_md(pf: &[PerFile]) -> Result<()> {
    if pf.is_empty() { return Ok(()); }
    let out_dir = PathBuf::from("tools/distincts-audit");
    std::fs::create_dir_all(&out_dir)?;
    let path = out_dir.join("report.md");

    let scans: Vec<u64> = pf.iter().map(|x| x.scan_ms).collect();
    let cols:  Vec<u64> = pf.iter().map(|x| x.col_count as u64).collect();
    let bytes_per_file: Vec<u64> = pf.iter().map(|x| x.distinct_bytes_total).collect();
    let distincts_flat: Vec<u64> =
        pf.iter().flat_map(|x| x.distincts_per_col.iter().map(|n| *n as u64)).collect();
    let bytes_flat: Vec<u64> =
        pf.iter().flat_map(|x| x.bytes_per_distinct.iter().map(|n| *n as u64)).collect();
    let total_cap_hits: u32  = pf.iter().map(|x| x.cols_at_cap).sum();
    let files_with_cap: usize = pf.iter().filter(|x| x.cols_at_cap > 0).count();

    let now = chrono::Utc::now().to_rfc3339();
    let md = format!(
        "# distincts audit — {}\n\n\
         Scanned **{}** CSV files. MAX_UNIQUE = {}.\n\n\
         ## Distributions\n\n\
         | Metric | P50 | P90 | P99 |\n\
         |---|---:|---:|---:|\n\
         | cols-per-file       | {} | {} | {} |\n\
         | distincts-per-col   | {} | {} | {} |\n\
         | bytes-per-distinct  | {} | {} | {} |\n\
         | bytes-per-file      | {} | {} | {} |\n\
         | scan-ms-per-file    | {} | {} | {} |\n\n\
         ## Cap hits\n\n\
         - **{}** column-scans hit MAX_UNIQUE (across **{}** of **{}** files).\n\n\
         Decision gates (Torv ↔ Gus 2026-05-24):\n\
         1. FE LRU cache size — sized by `bytes-per-file` P99.\n\
         2. Eager preload vs lazy — gated on `scan-ms-per-file` P99.\n\
         3. Endpoint shape (all-cols vs per-col `?q=`) — gated on `bytes-per-file` P99.\n\
         4. MAX_UNIQUE cap re-evaluation — gated on cap-hit ratio.\n\n\
         Per-file CSV: `per-file.csv`.\n",
        now, pf.len(), MAX_UNIQUE,
        percentile(cols.clone(),  0.50), percentile(cols.clone(),  0.90), percentile(cols,          0.99),
        percentile(distincts_flat.clone(), 0.50), percentile(distincts_flat.clone(), 0.90), percentile(distincts_flat, 0.99),
        percentile(bytes_flat.clone(), 0.50),     percentile(bytes_flat.clone(), 0.90),     percentile(bytes_flat,     0.99),
        percentile(bytes_per_file.clone(), 0.50), percentile(bytes_per_file.clone(), 0.90), percentile(bytes_per_file, 0.99),
        percentile(scans.clone(), 0.50), percentile(scans.clone(), 0.90), percentile(scans,         0.99),
        total_cap_hits, files_with_cap, pf.len(),
    );
    std::fs::write(&path, md)?;
    println!("  report   → {}", path.display());
    Ok(())
}
