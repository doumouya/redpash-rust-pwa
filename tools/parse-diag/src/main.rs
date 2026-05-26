//! parse-diag — compare spike for parse_and_rescue (draft) vs the
//! production `data::parse::from_csv_bytes_with_diag` pipeline.
//!
//! Inlines Em's `parse_and_rescue` draft (2026-05-26 04:30-ish) byte-
//! identical to the original so the measurement is on the actual
//! proposed code, not a paraphrase. Decodes once via chardetng so both
//! impls see the same UTF-8 string in their rescue hot path (the draft
//! takes `&str`; the production path takes bytes and runs its own
//! encoding detect — we feed both consistent inputs).
//!
//! Output is a single markdown table to stdout: one row per
//! (file × impl). Verdict reads at a glance. Per Woz's 2026-05-26 04:33
//! proposal:
//!   - rows / cols come from each impl's parse output
//!   - diag column shows the production path's `RescueDiag` outcome
//!     (NotAttempted / Attempted{delivered_width})
//!   - error column captures any parse failure surface
//!
//! Usage:  cargo run --release --bin compare -- <csv> [<csv> ...]

use std::fs;
use std::path::Path;

use chardetng::EncodingDetector;
use csv::{ReaderBuilder, StringRecord};
use data::parse::{from_csv_bytes_with_diag, RescueDiag};

// ─────────────────────────────────────────────────────────────────────────
// Em's draft, 2026-05-26 04:30-ish. Inlined verbatim — measurement
// IS the deliverable, so the code-under-test must be the literal
// candidate, not a paraphrase. Any future amendments to the draft
// land here as patch hunks against this snapshot.
// ─────────────────────────────────────────────────────────────────────────

fn parse_and_rescue(raw_csv_data: &str) -> Result<Vec<StringRecord>, csv::Error> {
    let cleaned_data = raw_csv_data
        .lines()
        .map(|line| {
            let trimmed = line.trim();
            if trimmed.starts_with('"') && trimmed.ends_with('"') && trimmed.len() >= 2 {
                let inner_payload = &trimmed[1..trimmed.len() - 1];
                inner_payload
                    .replace("\"\"", "\"")
                    .replace("\\\"", "\"")
            } else {
                trimmed.to_string()
            }
        })
        .collect::<Vec<String>>()
        .join("\n");

    let mut rdr = ReaderBuilder::new()
        .has_headers(true)
        .trim(csv::Trim::All)
        .from_reader(cleaned_data.as_bytes());

    let _headers = rdr.headers()?.clone();
    let mut records = Vec::new();
    for result in rdr.records() {
        records.push(result?);
    }
    Ok(records)
}

// ─────────────────────────────────────────────────────────────────────────
// Comparison harness.
// ─────────────────────────────────────────────────────────────────────────

fn decode_to_string(bytes: &[u8]) -> (String, &'static str) {
    let mut det = EncodingDetector::new();
    det.feed(bytes, true);
    let enc = det.guess(None, true);
    let (cow, _, _) = enc.decode(bytes);
    (cow.into_owned(), enc.name())
}

fn diag_to_str(d: RescueDiag) -> String {
    match d {
        RescueDiag::NotAttempted => "—".to_string(),
        RescueDiag::Attempted { delivered_width } => format!("rescue→{}", delivered_width),
    }
}

fn fmt_err(s: &str) -> String {
    // Markdown table needs single-line entries with no unescaped pipes.
    s.replace('|', "\\|").replace('\n', " ").chars().take(80).collect()
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.is_empty() {
        eprintln!("usage: compare <csv-file> [<csv-file> ...]");
        eprintln!();
        eprintln!("Compares parse_and_rescue (draft) vs the production");
        eprintln!("data::parse::from_csv_bytes_with_diag path on each fixture.");
        eprintln!("Emits a markdown table to stdout — pipe to a file to capture.");
        std::process::exit(2);
    }

    println!("# parse_and_rescue vs unwrap_csv — compare spike");
    println!();
    println!("Measurement per Torv.md 2026-05-26 05:39 ACK · Woz's 04:33 proposal.");
    println!();
    println!("| file | impl | rows | cols | encoding | diag | error |");
    println!("|---|---|---|---|---|---|---|");

    for path in &args {
        let fname = Path::new(path)
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or(path);

        let bytes = match fs::read(path) {
            Ok(b) => b,
            Err(e) => {
                println!(
                    "| {} | — | — | — | — | — | read failed: {} |",
                    fname,
                    fmt_err(&e.to_string())
                );
                continue;
            }
        };

        // --- production path -------------------------------------------------
        match from_csv_bytes_with_diag(&bytes, None) {
            Ok((df, encoding, diag)) => {
                println!(
                    "| {} | unwrap_csv | {} | {} | {} | {} | — |",
                    fname,
                    df.height(),
                    df.width(),
                    encoding,
                    diag_to_str(diag),
                );
            }
            Err(e) => {
                println!(
                    "| {} | unwrap_csv | — | — | — | — | {} |",
                    fname,
                    fmt_err(&e.to_string())
                );
            }
        }

        // --- draft path ------------------------------------------------------
        let (text, draft_encoding) = decode_to_string(&bytes);
        match parse_and_rescue(&text) {
            Ok(records) => {
                let rows = records.len();
                let cols = records.first().map(|r| r.len()).unwrap_or(0);
                println!(
                    "| {} | parse_and_rescue | {} | {} | {} | — | — |",
                    fname, rows, cols, draft_encoding,
                );
            }
            Err(e) => {
                println!(
                    "| {} | parse_and_rescue | — | — | {} | — | {} |",
                    fname,
                    draft_encoding,
                    fmt_err(&e.to_string())
                );
            }
        }
    }
}
