//! Purpose: **structure-suspicion flags** — detect the "confidently wrong" CSV
//! shapes the cleanness score otherwise hides (Copilot stress suite #2): a clean
//! `score≈100` on input that was silently mis-delimited, truncated, decoded from
//! binary, or given a junk header. Each flag carries a score penalty so the
//! reported score stops lying, plus a human reason for the cleaner UI.
//! Doc: docs/internal/code/backend/data/structure.md
//!
//! Detection works off the RAW bytes (line endings, invalid-UTF-8/control bytes,
//! delimiter ambiguity, raggedness) + the parsed frame (duplicate / all-numeric
//! headers). It never changes the data — only the score + the surfaced reasons.

use polars::prelude::*;
use serde::Serialize;

const DELIMS: [u8; 4] = [b',', b';', b'\t', b'|'];

/// Per-axis suspicion flags + the reasons behind them.
#[derive(Debug, Clone, Default, Serialize)]
pub struct StructureFlags {
    pub line_ending_suspect: bool,
    pub binary_suspect:      bool,
    pub delimiter_suspect:   bool,
    pub ragged_suspect:      bool,
    pub header_suspect:      bool,
    /// A column is *mostly* one structured type (numeric/bool/date) but
    /// contaminated with off-type cells — the silent 50–95% band the
    /// semantic sniff waves through as a clean string column (hook #6).
    pub type_drift_suspect:  bool,
    /// Worst drifting column's off-type fraction (0..0.5) — the penalty
    /// scales by this so heavier contamination stings more.
    pub type_drift_frac:     f32,
    /// Human-readable reasons (one per fired flag) for the cleaner banner.
    pub reasons: Vec<String>,
}

impl StructureFlags {
    /// Score penalty (0..=100) — how much to knock off an otherwise-clean score.
    /// Byte/shape lies hurt most (the data is wrong); header weirdness least (the
    /// data is fine, the labels aren't). Capped at 100. Calibration is rough on
    /// purpose — the goal here is "a cursed file never reads ≈100", not a precise
    /// grade (that's the score-calibration follow-up).
    pub fn penalty(&self) -> f32 {
        let mut p: f32 = 0.0;
        if self.binary_suspect      { p += 70.0; } // corrupt bytes → unusable
        if self.delimiter_suspect   { p += 45.0; } // wrong shape
        if self.line_ending_suspect { p += 25.0; }
        if self.ragged_suspect      { p += 25.0; }
        if self.header_suspect      { p += 20.0; }
        // Graded: contamination * scale, capped — a 25%-dirty column docks
        // ~17, a 50%-dirty one ~30, never enough alone to read "cursed".
        if self.type_drift_suspect  { p += (self.type_drift_frac * 70.0).min(35.0); }
        p.min(100.0)
    }

    pub fn any(&self) -> bool {
        self.line_ending_suspect
            || self.binary_suspect
            || self.delimiter_suspect
            || self.ragged_suspect
            || self.header_suspect
            || self.type_drift_suspect
    }
}

/// Detect suspicious structure from the raw input bytes + the parsed frame.
pub fn detect(raw: &[u8], df: &DataFrame) -> StructureFlags {
    let mut f = StructureFlags::default();

    // ── byte level: binary / invalid-UTF-8 masquerading as text ──
    let utf8 = std::str::from_utf8(raw);
    if utf8.is_err() {
        f.binary_suspect = true;
        f.reasons.push("invalid UTF-8 bytes in the input".into());
    } else if raw.iter().any(|&b| b < 0x20 && !matches!(b, b'\t' | b'\n' | b'\r')) {
        f.binary_suspect = true;
        f.reasons.push("control bytes (NUL/BEL/ESC/…) inside cell values".into());
    }

    // ── line endings: lone CR (classic-Mac) or mixed CRLF+LF ──
    let mut prev = 0u8;
    let (mut lone_cr, mut bare_lf, mut crlf) = (false, false, false);
    for &b in raw {
        if prev == b'\r' {
            if b == b'\n' { crlf = true; } else { lone_cr = true; }
        }
        if b == b'\n' && prev != b'\r' { bare_lf = true; }
        prev = b;
    }
    if prev == b'\r' { lone_cr = true; } // trailing CR
    if lone_cr {
        f.line_ending_suspect = true;
        f.reasons.push("lone CR line endings (classic-Mac)".into());
    } else if crlf && bare_lf {
        f.line_ending_suspect = true;
        f.reasons.push("mixed CRLF / LF line endings".into());
    }

    // ── delimiter ambiguity + raggedness (text-level) ──
    if let Ok(text) = utf8 {
        let sample: Vec<&str> =
            text.lines().filter(|l| !l.trim().is_empty()).take(50).collect();
        if let Some(header) = sample.first() {
            let present = DELIMS.iter().filter(|&&d| count_unquoted(header, d) >= 1).count();
            if present >= 2 {
                f.delimiter_suspect = true;
                f.reasons.push(format!("header mixes {present} delimiter types — ambiguous split"));
            }
            let dom = DELIMS
                .iter()
                .copied()
                .max_by_key(|&d| count_unquoted(header, d))
                .unwrap_or(b',');
            // A quoted field can span physical lines, so per-physical-line field
            // counts are meaningless when one does — skip ragged detection then,
            // or a clean multiline-quoted file false-flags as ragged.
            let mut inq = false;
            let mut multiline_quoted = false;
            for l in &sample {
                if l.bytes().filter(|&b| b == b'"').count() % 2 == 1 {
                    inq = !inq;
                }
                if inq {
                    multiline_quoted = true;
                }
            }
            let widths: Vec<usize> = sample.iter().map(|l| count_unquoted(l, dom) + 1).collect();
            let mn = widths.iter().copied().min().unwrap_or(0);
            let mx = widths.iter().copied().max().unwrap_or(0);
            if !multiline_quoted && mx > mn && (mx >= mn.saturating_mul(2) || mx - mn >= 3) {
                f.ragged_suspect = true;
                f.reasons.push(format!("ragged rows: field count ranges {mn}..{mx} (truncation/wrong delimiter)"));
            }
            // Header consistently NARROWER than the data rows → Polars
            // truncates each row to the header width, silently dropping the
            // trailing field(s). The spread can be small (header 2, data 3)
            // so the variance check above misses it; the *direction* is the
            // tell. Catches EU-decimal mis-splits (`id,price` + `1,1.234,56`)
            // and trailing-comma extra columns.
            if !multiline_quoted && !f.ragged_suspect && widths.len() >= 3 {
                let hdr = widths[0];
                let data = &widths[1..];
                let mut freq: std::collections::HashMap<usize, usize> = std::collections::HashMap::new();
                for &w in data { *freq.entry(w).or_insert(0) += 1; }
                if let Some((&modal, &n)) = freq.iter().max_by_key(|&(_, &v)| v) {
                    if modal > hdr && n.saturating_mul(2) >= data.len() {
                        f.ragged_suspect = true;
                        f.reasons.push(format!(
                            "data rows wider than header ({hdr} → {modal} fields): trailing values silently dropped"
                        ));
                    }
                }
            }
        }
    }

    // ── type drift: a column mostly one structured type, contaminated ──
    // The semantic sniff only types a column at ≥80% agreement, so a
    // 50–95%-numeric/bool/date column slips through scoring ≈100. Penalize
    // it, scaled by how off-type it is (see dtype::worst_type_drift).
    if let Some((col, off)) = crate::dtype::worst_type_drift(df) {
        f.type_drift_suspect = true;
        f.type_drift_frac = off;
        f.reasons.push(format!(
            "type drift: column \"{col}\" is mostly one type with {:.0}% off-type values",
            off * 100.0
        ));
    }

    // ── header weirdness: duplicates / all-numeric ──
    let names: Vec<String> = df.get_columns().iter().map(|c| c.name().to_string()).collect();
    // Polars renames duplicate headers with a "_duplicated_" suffix.
    let dup = names.iter().any(|n| n.contains("_duplicated_"))
        || {
            let mut seen = std::collections::HashSet::new();
            names.iter().any(|n| !seen.insert(n.as_str()))
        };
    if dup {
        f.header_suspect = true;
        f.reasons.push("duplicate header names".into());
    }
    if !names.is_empty() && names.iter().all(|n| n.trim().parse::<f64>().is_ok()) {
        f.header_suspect = true;
        f.reasons.push("all-numeric headers (a data row used as the header?)".into());
    }

    f
}

/// Count byte `d` outside `"…"` quoted regions (quote-aware) — mirrors the
/// sniff's header counting so delimiter detection here matches the parser's.
fn count_unquoted(line: &str, d: u8) -> usize {
    let (mut n, mut in_q) = (0usize, false);
    for b in line.bytes() {
        if b == b'"' {
            in_q = !in_q;
        } else if b == d && !in_q {
            n += 1;
        }
    }
    n
}

#[cfg(test)]
mod tests {
    use super::*;

    fn df2(h1: &str, h2: &str) -> DataFrame {
        DataFrame::new(vec![
            Series::new(h1.into(), &["x"]).into(),
            Series::new(h2.into(), &["y"]).into(),
        ])
        .unwrap()
    }

    #[test]
    fn flags_binary_and_line_endings() {
        let df = df2("a", "b");
        let f = detect(b"a,b\r1,2\r3,4", &df); // lone CR
        assert!(f.line_ending_suspect);
        let f = detect(b"a,b\n1,\x00\n", &df); // control byte
        assert!(f.binary_suspect);
        let f = detect("a,b\nx,y\n".as_bytes(), &df); // clean
        assert!(!f.any());
    }

    #[test]
    fn flags_ambiguous_delimiter() {
        let df = df2("id;name", "age|city");
        let f = detect(b"id;name,age|city\n1;Alice,30|London\n", &df);
        assert!(f.delimiter_suspect, "header with ;,| should flag");
    }

    #[test]
    fn flags_duplicate_and_numeric_headers() {
        let dup = df2("id", "id_duplicated_0");
        assert!(detect(b"id,id\n1,2\n", &dup).header_suspect);
        let numeric = df2("123", "456");
        assert!(detect(b"123,456\n1,2\n", &numeric).header_suspect);
    }

    #[test]
    fn flags_type_drift_and_header_narrower_than_data() {
        // amount column 3/4 numeric + one "foo" → type drift (hook #6).
        let df = DataFrame::new(vec![
            Series::new("id".into(), &["1", "2", "3", "4"]).into(),
            Series::new("amount".into(), &["10", "20", "foo", "40"]).into(),
        ])
        .unwrap();
        let f = detect(b"id,amount\n1,10\n2,20\n3,foo\n4,40\n", &df);
        assert!(f.type_drift_suspect, "75%-numeric column should drift");
        assert!(f.type_drift_frac > 0.0 && f.penalty() > 0.0);

        // Header 2 cols, data rows 3 fields (EU-decimal mis-split) → the
        // trailing-field drop fires ragged even though the spread is 1.
        let df = df2("id", "price");
        let f = detect(b"id,price\n1,1.234,56\n2,2.000,00\n3,3.500,75\n", &df);
        assert!(f.ragged_suspect, "data wider than header should flag ragged");
    }

    #[test]
    fn penalty_keeps_cursed_below_100() {
        let mut f = StructureFlags::default();
        f.delimiter_suspect = true; // a single shape-lie already pulls a clean score well down
        assert!(f.penalty() >= 30.0);
        assert!(f.penalty() <= 100.0);
    }
}
