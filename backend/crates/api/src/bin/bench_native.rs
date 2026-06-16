//! Native-surface bench for the wasm-vs-native perf comparison. Times the SAME
//! ops the wasm `Workbook` runs (parse / page / filter / search / sort / score)
//! on a corpus CSV, natively (the server surface). Emits one JSON line.
//!
//! Marshal parity: every windowed op SERIALIZES its `Page` to a JSON string
//! (`Page::to_json().to_string()`) exactly as the wasm boundary does, so the
//! wasm/native ratio compares like-for-like (compute + serialize) rather than
//! native-compute-only vs wasm-compute-plus-serialize. The wasm number also
//! carries the JS↔wasm call boundary the native number can't — that gap IS the
//! real wasm-path cost and is left in on purpose.
//!
//! Run: cargo run -p api --release --bin bench_native -- <corpus.csv> <rows>

use std::time::Instant;

use shared::filter::{FilterNode, GroupOp, PredOp};
use shared::sort::SortKey;

fn median(mut xs: Vec<f64>) -> f64 {
    xs.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let m = xs.len() / 2;
    if xs.len() % 2 == 1 {
        xs[m]
    } else {
        (xs[m - 1] + xs[m]) / 2.0
    }
}

/// W=2 warmups (discarded), then K timed; report the median in ms (3 dp). K is
/// trimmed for the big sizes so the full sweep stays reasonable.
fn bench<F: FnMut()>(rows: usize, mut f: F) -> f64 {
    let k = if rows >= 250_000 { 4 } else { 6 };
    for _ in 0..2 {
        f();
    }
    let mut t = Vec::with_capacity(k);
    for _ in 0..k {
        let a = Instant::now();
        f();
        t.push(a.elapsed().as_secs_f64() * 1000.0);
    }
    (median(t) * 1000.0).round() / 1000.0
}

/// Peak resident set (VmHWM) in MB — the native memory high-water for this run.
fn peak_rss_mb() -> Option<f64> {
    let s = std::fs::read_to_string("/proc/self/status").ok()?;
    for line in s.lines() {
        if let Some(rest) = line.strip_prefix("VmHWM:") {
            let kb: f64 = rest.split_whitespace().next()?.parse().ok()?;
            return Some((kb / 1024.0 * 10.0).round() / 10.0);
        }
    }
    None
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let corpus = args.get(1).expect("usage: bench_native <corpus.csv> <rows>");

    let bytes = std::fs::read(corpus).expect("read corpus");
    let (df, _diag, _enc) = data::parse::from_csv_bytes(&bytes, None).expect("parse corpus");
    let total = df.height();
    let col0 = df.get_column_names()[0].to_string();

    // The SAME shapes bench-wasm.mjs builds: single-column contains for filter,
    // all-columns search "1", sort by col0 desc.
    let filter = FilterNode::Group {
        op: GroupOp::And,
        children: vec![FilterNode::Pred {
            col: col0.clone(),
            op: PredOp::Contains,
            value: Some(serde_json::Value::String("1".into())),
            case_sensitive: false,
        }],
    };
    let sort = vec![SortKey { col: col0, descending: true }];

    let parse_ms = bench(total, || {
        let _ = data::parse::from_csv_bytes(&bytes, None).unwrap();
    });
    let page_ms = bench(total, || {
        let _ = data::view::page(&df, 0, 100).to_json().to_string();
    });
    let filter_ms = bench(total, || {
        let f = data::filter::apply_filter(&df, &filter).unwrap();
        let _ = data::view::page(&f, 0, 100).to_json().to_string();
    });
    let search_ms = bench(total, || {
        let f = data::search::apply_search(&df, "1").unwrap();
        let _ = data::view::page(&f, 0, 100).to_json().to_string();
    });
    let sort_ms = bench(total, || {
        let s = data::sort::apply_sort(&df, &sort).unwrap();
        let _ = data::view::page(&s, 0, 100).to_json().to_string();
    });
    let score_ms = bench(total, || {
        let cols = data::dtype::summarize(&df).unwrap();
        let _ = data::stats::cleanness_report(&df, &cols, &[]);
        let _ = data::stats::find_sentinels(&df, &[]);
    });

    let out = serde_json::json!({
        "surface": "native",
        "build": "release",
        "rows": total,
        "cols": df.width(),
        "parse_ms": parse_ms,
        "page_ms": page_ms,
        "filter_ms": filter_ms,
        "search_ms": search_ms,
        "sort_ms": sort_ms,
        "score_ms": score_ms,
        "rss_mb": peak_rss_mb(),
    });
    println!("{out}");
}
