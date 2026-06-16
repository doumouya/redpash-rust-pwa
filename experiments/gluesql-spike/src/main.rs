//! GlueSQL-over-CSV spike: load a CSV into a SQL table, then run the redtable's
//! queries (count / page / filter / search / sort) as SQL — the "query a SQL
//! database" model, vs RedPash's Polars compute engine.
//!
//! Usage: gluesql-spike <corpus.csv> [rows]
//! Emits a JSON line of median latencies, comparable to the Polars bench.

use std::time::Instant;

use futures::executor::block_on;
use gluesql::prelude::{Glue, MemoryStorage, Payload};

fn exec(glue: &mut Glue<MemoryStorage>, sql: &str) -> Vec<Payload> {
    block_on(glue.execute(sql)).unwrap_or_else(|e| panic!("SQL failed:\n  {sql}\n  {e}"))
}

fn rows_of(p: &Payload) -> usize {
    match p {
        Payload::Select { rows, .. } => rows.len(),
        _ => 0,
    }
}

fn first_count(p: &[Payload]) -> i64 {
    if let Some(Payload::Select { rows, .. }) = p.first() {
        if let Some(row) = rows.first() {
            if let Some(gluesql::prelude::Value::I64(n)) = row.first() {
                return *n;
            }
        }
    }
    -1
}

fn median(mut v: Vec<f64>) -> f64 {
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let m = v.len() / 2;
    if v.len() % 2 == 1 { v[m] } else { (v[m - 1] + v[m]) / 2.0 }
}

/// W=2 warmup + K timed; median ms (matches the Polars bench protocol).
fn bench<F: FnMut()>(rows: usize, mut f: F) -> f64 {
    let k = if rows >= 250_000 { 4 } else { 6 };
    for _ in 0..2 { f(); }
    let mut t = Vec::with_capacity(k);
    for _ in 0..k {
        let a = Instant::now();
        f();
        t.push(a.elapsed().as_secs_f64() * 1000.0);
    }
    (median(t) * 1000.0).round() / 1000.0
}

fn esc(s: &str) -> String {
    s.replace('\'', "''")
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let path = args.get(1).expect("usage: gluesql-spike <corpus.csv> [rows]");

    // ── load: CSV → all-TEXT table via batched INSERT (the load cost) ─────────
    let mut rdr = csv::Reader::from_path(path).expect("open csv");
    let headers: Vec<String> = rdr.headers().unwrap().iter().map(|s| s.to_string()).collect();
    let data: Vec<Vec<String>> = rdr
        .records()
        .map(|r| r.unwrap().iter().map(|s| s.to_string()).collect())
        .collect();
    let n = data.len();
    let col0 = headers[0].clone();

    let mut glue = Glue::new(MemoryStorage::default());
    let ddl = headers.iter().map(|h| format!("{h} TEXT")).collect::<Vec<_>>().join(", ");

    let load_t = Instant::now();
    exec(&mut glue, &format!("CREATE TABLE t ({ddl})"));
    for chunk in data.chunks(2000) {
        let vals = chunk
            .iter()
            .map(|row| {
                let cells = row.iter().map(|c| format!("'{}'", esc(c))).collect::<Vec<_>>().join(",");
                format!("({cells})")
            })
            .collect::<Vec<_>>()
            .join(",");
        exec(&mut glue, &format!("INSERT INTO t VALUES {vals}"));
    }
    let load_ms = (load_t.elapsed().as_secs_f64() * 1000.0 * 1000.0).round() / 1000.0;

    // verify
    let total = first_count(&exec(&mut glue, "SELECT COUNT(*) AS n FROM t"));
    assert_eq!(total as usize, n, "loaded row count mismatch");

    // the redtable queries (LIKE '%1%' mirrors the Polars string-contains bench)
    let q_page = "SELECT * FROM t LIMIT 100 OFFSET 0".to_string();
    let q_filter = format!("SELECT * FROM t WHERE {col0} LIKE '%1%' LIMIT 100");
    let q_filter_count = format!("SELECT COUNT(*) AS n FROM t WHERE {col0} LIKE '%1%'");
    let search_or = headers.iter().map(|h| format!("{h} LIKE '%1%'")).collect::<Vec<_>>().join(" OR ");
    let q_search = format!("SELECT * FROM t WHERE {search_or} LIMIT 100");
    let q_sort = format!("SELECT * FROM t ORDER BY {col0} DESC LIMIT 100");

    // The index thesis: an EQUALITY filter (index-friendly) + ORDER BY indexed
    // col. Note `LIKE '%1%'` (leading wildcard) can't use an index in ANY DB, so
    // contains-filter/search stay scans regardless — that's an honest finding.
    let q_filter_eq = format!("SELECT * FROM t WHERE {col0} = '5000' LIMIT 100");

    // correctness sample (printed to stderr so stdout stays one JSON line)
    let fc = first_count(&exec(&mut glue, &q_filter_count));
    let sp = rows_of(&exec(&mut glue, &q_search)[0]);
    eprintln!("  load {n} rows x {} cols in {load_ms} ms | filter-count={fc} | search-page-rows={sp}", headers.len());

    // ── SCAN baseline (no index) ──────────────────────────────────────────────
    let mut out = serde_json::json!({
        "surface": "gluesql-native",
        "engine": "gluesql-memory-text",
        "rows": n,
        "cols": headers.len(),
        "load_ms": load_ms,
        "count_ms": bench(n, || { exec(&mut glue, "SELECT COUNT(*) AS n FROM t"); }),
        "page_ms": bench(n, || { exec(&mut glue, &q_page); }),
        "filter_contains_ms": bench(n, || { exec(&mut glue, &q_filter); }),
        "filter_count_ms": bench(n, || { exec(&mut glue, &q_filter_count); }),
        "filter_eq_scan_ms": bench(n, || { exec(&mut glue, &q_filter_eq); }),
        "search_ms": bench(n, || { exec(&mut glue, &q_search); }),
        "sort_scan_ms": bench(n, || { exec(&mut glue, &q_sort); }),
    });

    // ── INDEX thesis: does CREATE INDEX rescue equality-filter + sort? ─────────
    let idx = block_on(glue.execute(&format!("CREATE INDEX idx_col0 ON t ({col0})")));
    match idx {
        Ok(_) => {
            let o = out.as_object_mut().unwrap();
            o.insert("index".into(), serde_json::json!("created"));
            o.insert("filter_eq_indexed_ms".into(), serde_json::json!(bench(n, || { exec(&mut glue, &q_filter_eq); })));
            o.insert("sort_indexed_ms".into(), serde_json::json!(bench(n, || { exec(&mut glue, &q_sort); })));
        }
        Err(e) => {
            out.as_object_mut().unwrap().insert("index".into(), serde_json::json!(format!("UNSUPPORTED: {e}")));
        }
    }

    // ── mutation: the capability Polars frames lack ───────────────────────────
    let upd = block_on(glue.execute(&format!("UPDATE t SET status = 'EDITED' WHERE {col0} = '5000'")));
    let del = block_on(glue.execute(&format!("DELETE FROM t WHERE {col0} = '4999'")));
    out.as_object_mut().unwrap().insert(
        "mutation".into(),
        serde_json::json!(format!("update={} delete={}", upd.is_ok(), del.is_ok())),
    );

    println!("{out}");
}
