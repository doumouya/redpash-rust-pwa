//! csv-to-xlsx — faithful CSV → xlsx fixture generator (Rust).
//!
//!     cargo run -- <dir>
//!
//! The Rust sibling of `tools/csv-to-xlsx.py`. Converts every `.csv` in
//! <dir> to a sibling `.xlsx`, laying the grid in as **text cells** —
//! no type inference, no header detection — so preamble lines, ragged
//! rows and numbers-stored-as-text survive into the workbook. The Excel
//! corpus is then a 1:1 mirror of the CSV corpus: a `score_dir`
//! divergence between the two = an Excel-path bug.
//!
//! Standalone (not a cargo example) so it lives in `tools/` per Em's
//! call. The `decode` fn below mirrors `data::encoding::decode`.

use std::{env, fs, path::Path};

use rust_xlsxwriter::Workbook;

/// Candidate delimiters — the set the product parser sniffs.
const DELIMS: [u8; 4] = [b',', b';', b'\t', b'|'];

fn main() {
    let dir = env::args().nth(1).expect("usage: csv-to-xlsx <dir>");

    let mut paths: Vec<_> = fs::read_dir(&dir)
        .expect("read_dir")
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.extension().and_then(|x| x.to_str()) == Some("csv"))
        .collect();
    paths.sort();

    let (mut ok, mut failed) = (0usize, 0usize);
    for path in &paths {
        let name = path.file_name().unwrap().to_string_lossy();
        match convert(path) {
            Ok((rows, cols, delim)) => {
                ok += 1;
                println!("{name:42}  {rows:>5}r x {cols:>3}c  delim={}", show_delim(delim));
            }
            Err(e) => {
                failed += 1;
                println!("{name:42}  ERROR  {e}");
            }
        }
    }
    println!("\n{ok} converted, {failed} failed ({} csv files total)", paths.len());
}

/// Convert one CSV file to a sibling `.xlsx`. Returns (rows, cols, delimiter).
fn convert(csv_path: &Path) -> Result<(usize, usize, u8), String> {
    let bytes = fs::read(csv_path).map_err(|e| e.to_string())?;
    let text = decode(&bytes);

    let delim = sniff_delimiter(&text);

    // Flexible read: no header, ragged rows allowed — every line lands
    // as a row exactly as it sits in the file (preamble included).
    let mut reader = csv::ReaderBuilder::new()
        .delimiter(delim)
        .has_headers(false)
        .flexible(true)
        .from_reader(text.as_bytes());

    let mut workbook = Workbook::new();
    let sheet = workbook.add_worksheet();
    let (mut nrows, mut ncols) = (0u32, 0usize);

    for record in reader.records() {
        let record = record.map_err(|e| e.to_string())?;
        for (col, field) in record.iter().enumerate() {
            // Every cell is text — no type inference. The import path's
            // dtype inference must do the typing, exactly as for a CSV.
            sheet
                .write_string(nrows, col as u16, field)
                .map_err(|e| e.to_string())?;
        }
        ncols = ncols.max(record.len());
        nrows += 1;
    }

    let out = csv_path.with_extension("xlsx");
    workbook.save(&out).map_err(|e| e.to_string())?;
    Ok((nrows as usize, ncols, delim))
}

/// Detect encoding (BOM sniff + chardetng) and decode to text — mirrors
/// `data::encoding::decode` so the fixture text matches what the CSV
/// pipeline would see.
fn decode(bytes: &[u8]) -> String {
    let label: &str = if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        "utf-8"
    } else if bytes.starts_with(&[0xFF, 0xFE]) {
        "utf-16le"
    } else if bytes.starts_with(&[0xFE, 0xFF]) {
        "utf-16be"
    } else {
        let mut detector = chardetng::EncodingDetector::new();
        detector.feed(bytes, true);
        detector.guess(None, true).name()
    };
    let encoding = encoding_rs::Encoding::for_label(label.as_bytes())
        .unwrap_or(encoding_rs::UTF_8);
    encoding.decode(bytes).0.into_owned()
}

/// Pick the delimiter with the highest total count over the first 50
/// lines. Unlike the product parser's ">=2 delimiters on the header"
/// heuristic, a plain total count also detects 2-column non-comma files
/// — the fixture must represent the *real* grid even where the import
/// path later mishandles it. Defaults to comma.
fn sniff_delimiter(text: &str) -> u8 {
    let head: String = text.lines().take(50).collect::<Vec<_>>().join("\n");
    DELIMS
        .iter()
        .map(|&d| (d, head.bytes().filter(|&b| b == d).count()))
        .filter(|&(_, n)| n > 0)
        .max_by_key(|&(_, n)| n)
        .map(|(d, _)| d)
        .unwrap_or(b',')
}

fn show_delim(d: u8) -> &'static str {
    match d {
        b',' => "comma",
        b';' => "semi",
        b'\t' => "tab",
        b'|' => "pipe",
        _ => "?",
    }
}
