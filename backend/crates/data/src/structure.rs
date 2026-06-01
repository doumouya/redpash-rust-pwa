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
        if self.binary_suspect      { p += 45.0; }
        if self.delimiter_suspect   { p += 35.0; }
        if self.line_ending_suspect { p += 25.0; }
        if self.ragged_suspect      { p += 25.0; }
        if self.header_suspect      { p += 15.0; }
        p.min(100.0)
    }

    pub fn any(&self) -> bool {
        self.line_ending_suspect
            || self.binary_suspect
            || self.delimiter_suspect
            || self.ragged_suspect
            || self.header_suspect
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
            let widths: Vec<usize> = sample.iter().map(|l| count_unquoted(l, dom) + 1).collect();
            let mn = widths.iter().copied().min().unwrap_or(0);
            let mx = widths.iter().copied().max().unwrap_or(0);
            if mx > mn && (mx >= mn.saturating_mul(2) || mx - mn >= 3) {
                f.ragged_suspect = true;
                f.reasons.push(format!("ragged rows: field count ranges {mn}..{mx} (truncation/wrong delimiter)"));
            }
        }
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
    fn penalty_keeps_cursed_below_100() {
        let mut f = StructureFlags::default();
        f.delimiter_suspect = true; // a single shape-lie already pulls a clean score well down
        assert!(f.penalty() >= 30.0);
        assert!(f.penalty() <= 100.0);
    }
}
