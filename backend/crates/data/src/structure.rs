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
    /// The line-ending issue is cosmetic (mixed CRLF/LF, no data loss) rather
    /// than lossy (a lone CR that swallows rows) — penalized far less.
    pub line_ending_cosmetic: bool,
    pub binary_suspect: bool,
    pub delimiter_suspect: bool,
    pub ragged_suspect: bool,
    pub header_suspect: bool,
    /// A column is *mostly* one structured type (numeric/bool/date) but
    /// contaminated with off-type cells — the silent 50–95% band the
    /// semantic sniff waves through as a clean string column (hook #6).
    pub type_drift_suspect: bool,
    /// Worst drifting column's off-type fraction (0..0.5) — the penalty
    /// scales by this so heavier contamination stings more.
    pub type_drift_frac: f32,
    /// A pure-digit value with a leading zero (`001`, `07920`) was cast
    /// to int — the zero, and the identity it encoded (zip / code / badge
    /// id), is silently gone. Only visible by comparing raw bytes to the
    /// typed frame.
    pub numeric_id_loss_suspect: bool,
    /// A date column mixes ≥2 incompatible formats (`2026-01-13` + `13/01/2026`)
    /// — the dates parse to different days silently. Worse when day/month order
    /// is contradictory (one cell is dd/mm, another mm/dd).
    pub date_drift_suspect: bool,
    /// Blank / whitespace-only rows are interspersed in the data — Polars drops
    /// them silently, so the parsed frame hides that the source was peppered
    /// with empty lines.
    pub whitespace_rows_suspect: bool,
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
        if self.binary_suspect {
            p += 70.0;
        } // corrupt bytes → unusable
        if self.delimiter_suspect {
            p += 45.0;
        } // wrong shape
          // Lone CR swallows rows (data loss); mixed CRLF/LF is cosmetic (Polars
          // reads both) — so the cosmetic case docks a token amount, not 25.
        if self.line_ending_suspect {
            p += if self.line_ending_cosmetic { 8.0 } else { 25.0 };
        }
        if self.ragged_suspect {
            p += 25.0;
        }
        if self.header_suspect {
            p += 20.0;
        }
        // Graded: contamination * scale, capped — a 25%-dirty column docks
        // ~17, a 50%-dirty one ~30, never enough alone to read "cursed".
        if self.type_drift_suspect {
            p += (self.type_drift_frac * 70.0).min(35.0);
        }
        // Identity loss, not corruption: the data parsed, but a code/id lost
        // its leading zero. Moderate — the file is usable, the column isn't.
        if self.numeric_id_loss_suspect {
            p += 20.0;
        }
        // Mixed date formats parse to silently-wrong days; ambiguous and
        // dangerous, but the values are recoverable once normalized.
        if self.date_drift_suspect {
            p += 18.0;
        }
        // Dropped blank rows — the data's fine, but the source was messier than
        // the frame admits. Mild.
        if self.whitespace_rows_suspect {
            p += 12.0;
        }
        p.min(100.0)
    }

    pub fn any(&self) -> bool {
        self.line_ending_suspect
            || self.binary_suspect
            || self.delimiter_suspect
            || self.ragged_suspect
            || self.header_suspect
            || self.type_drift_suspect
            || self.numeric_id_loss_suspect
            || self.date_drift_suspect
            || self.whitespace_rows_suspect
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
    } else if raw
        .iter()
        .any(|&b| b < 0x20 && !matches!(b, b'\t' | b'\n' | b'\r'))
    {
        f.binary_suspect = true;
        f.reasons
            .push("control bytes (NUL/BEL/ESC/…) inside cell values".into());
    }

    // ── line endings: lone CR (classic-Mac) or mixed CRLF+LF ──
    let mut prev = 0u8;
    let (mut lone_cr, mut bare_lf, mut crlf) = (false, false, false);
    for &b in raw {
        if prev == b'\r' {
            if b == b'\n' {
                crlf = true;
            } else {
                lone_cr = true;
            }
        }
        if b == b'\n' && prev != b'\r' {
            bare_lf = true;
        }
        prev = b;
    }
    if prev == b'\r' {
        lone_cr = true;
    } // trailing CR
    if lone_cr {
        f.line_ending_suspect = true; // lossy: a lone CR swallows whole rows
        f.reasons.push("lone CR line endings (classic-Mac)".into());
    } else if crlf && bare_lf {
        f.line_ending_suspect = true;
        f.line_ending_cosmetic = true; // Polars reads both — no data lost
        f.reasons
            .push("mixed CRLF / LF line endings (cosmetic)".into());
    }

    // ── delimiter ambiguity + raggedness (text-level) ──
    if let Ok(text) = utf8 {
        let sample: Vec<&str> = text
            .lines()
            .filter(|l| !l.trim().is_empty())
            .take(50)
            .collect();
        if let Some(header) = sample.first() {
            let present = DELIMS
                .iter()
                .filter(|&&d| count_unquoted(header, d) >= 1)
                .count();
            if present >= 2 {
                f.delimiter_suspect = true;
                f.reasons.push(format!(
                    "header mixes {present} delimiter types — ambiguous split"
                ));
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
                f.reasons.push(format!(
                    "ragged rows: field count ranges {mn}..{mx} (truncation/wrong delimiter)"
                ));
            }
            // ANY data row wider than the header → Polars truncates it to the
            // header width, silently dropping the trailing field(s). One such
            // row is still lost data, and the field-count spread can be just 1,
            // so the variance check above misses it — the *direction* (data >
            // header) is the tell. Catches a single over-wide row, EU-decimal
            // mis-splits (`id,price` + `1,1.234,56`), trailing-comma columns.
            if !multiline_quoted && !f.ragged_suspect && widths.len() >= 2 {
                let hdr = widths[0];
                let data_max = widths[1..].iter().copied().max().unwrap_or(hdr);
                if data_max > hdr {
                    f.ragged_suspect = true;
                    f.reasons.push(format!(
                        "a data row is wider than the header ({hdr} → {data_max} fields): trailing values silently dropped"
                    ));
                }
            }

            // ── leading-zero / numeric-id loss ──
            // Polars casts a pure-digit value with a leading zero ("001",
            // "07920") to int, destroying the zero AND the identity it carried
            // (zip / postal / badge id). It's already `1` in the frame, so the
            // only way to see it is to compare the RAW field against the column
            // Polars typed as int. Quote-aware split aligns raw fields to df
            // columns by position — only reliable on a cleanly rectangular
            // parse. On a ragged / multiline-quoted file the positions are off,
            // so a stray "00" from a mis-split decimal ("2.000,00") would
            // false-positive; that raggedness is already flagged, so skip.
            let int_cols: Vec<usize> = df
                .get_columns()
                .iter()
                .enumerate()
                .filter(|(_, c)| c.dtype().is_integer())
                .map(|(j, _)| j)
                .collect();
            if !multiline_quoted && !f.ragged_suspect && !int_cols.is_empty() && sample.len() >= 2 {
                let lost = sample[1..].iter().any(|row| {
                    let fields = split_unquoted(row, dom);
                    int_cols.iter().any(|&j| {
                        fields.get(j).is_some_and(|v| {
                            let t = v.trim();
                            t.len() > 1
                                && t.starts_with('0')
                                && t.bytes().all(|b| b.is_ascii_digit())
                        })
                    })
                });
                if lost {
                    f.numeric_id_loss_suspect = true;
                    f.reasons.push(
                        "leading-zero values cast to int — the zero (and the identity it encoded: zip/code/id) is lost".into(),
                    );
                }
            }

            // ── blank / whitespace-only rows interspersed in the data ──
            // Polars drops them silently, so the frame hides that the source
            // was peppered with empty lines. Count INTERIOR blanks only (up to
            // the last non-blank line) so a trailing newline doesn't trip it,
            // and require a material fraction so one stray blank in a big file
            // is ignored. A row of empty FIELDS (",,,") is NOT blank — its
            // line trims to ",,,", not "".
            let lines: Vec<&str> = text.lines().collect();
            if let Some(last) = lines.iter().rposition(|l| !l.trim().is_empty()) {
                let blank = lines[..=last]
                    .iter()
                    .filter(|l| l.trim().is_empty())
                    .count();
                let total = last + 1;
                if blank > 0 && blank as f32 / total as f32 >= 0.08 {
                    f.whitespace_rows_suspect = true;
                    f.reasons.push(format!(
                        "{blank} blank/whitespace-only rows silently dropped (of {total} lines)"
                    ));
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

    // ── date-format drift: a date column mixing incompatible formats ──
    // Parses "fine" to silently-wrong days. Worst when the day/month order is
    // self-contradictory (one cell dd/mm, another mm/dd) — flag it loudly.
    if let Some((col, shapes, contradiction)) = crate::dtype::worst_date_drift(df) {
        f.date_drift_suspect = true;
        f.reasons.push(if contradiction {
            format!("date drift: column \"{col}\" mixes {shapes} date formats with contradictory day/month order — dates are ambiguous")
        } else {
            format!("date drift: column \"{col}\" mixes {shapes} date formats — may parse to wrong days")
        });
    }

    // ── header weirdness: duplicates / all-numeric ──
    let names: Vec<String> = df
        .get_columns()
        .iter()
        .map(|c| c.name().to_string())
        .collect();
    // Polars renames duplicate headers with a "_duplicated_" suffix.
    let dup = names.iter().any(|n| n.contains("_duplicated_")) || {
        let mut seen = std::collections::HashSet::new();
        names.iter().any(|n| !seen.insert(n.as_str()))
    };
    if dup {
        f.header_suspect = true;
        f.reasons.push("duplicate header names".into());
    }
    if !names.is_empty() && names.iter().all(|n| n.trim().parse::<f64>().is_ok()) {
        f.header_suspect = true;
        f.reasons
            .push("all-numeric headers (a data row used as the header?)".into());
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

/// Split `line` on byte `d` outside `"…"` quoted regions (quote-aware) — the
/// splitting twin of `count_unquoted`. `d` and `"` are ASCII, so every cut is
/// on a char boundary and the `&str` slices are valid UTF-8. Used to align raw
/// fields to parsed columns for the leading-zero / numeric-id-loss check.
fn split_unquoted(line: &str, d: u8) -> Vec<&str> {
    let (mut out, mut start, mut in_q) = (Vec::new(), 0usize, false);
    for (i, b) in line.bytes().enumerate() {
        if b == b'"' {
            in_q = !in_q;
        } else if b == d && !in_q {
            out.push(&line[start..i]);
            start = i + 1;
        }
    }
    out.push(&line[start..]);
    out
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
        let f = detect(b"a,b\r1,2\r3,4", &df); // lone CR — lossy
        assert!(f.line_ending_suspect && !f.line_ending_cosmetic);
        assert_eq!(f.penalty(), 25.0, "lone CR is the lossy 25-point penalty");
        let f = detect(b"a,b\r\n1,2\nx,y\r\n", &df); // mixed CRLF/LF — cosmetic
        assert!(f.line_ending_suspect && f.line_ending_cosmetic);
        assert_eq!(
            f.penalty(),
            8.0,
            "mixed CRLF/LF is the cosmetic 8-point penalty"
        );
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
        assert!(
            f.ragged_suspect,
            "data wider than header should flag ragged"
        );

        // A SINGLE over-wide row (the rest match the header) is still lost
        // data — one dropped field must flag, spread of 1 notwithstanding.
        let df = DataFrame::new(vec![
            Series::new("id".into(), &["1", "2", "3", "4"]).into(),
            Series::new("name".into(), &["Alice", "Bob", "Charlie", "Delta"]).into(),
            Series::new("age".into(), &["30", "29", "31", "32"]).into(),
        ])
        .unwrap();
        let f = detect(
            b"id,name,age\n1,Alice,30\n2,Bob,29\n3,Charlie,31,extra\n4,Delta,32\n",
            &df,
        );
        assert!(f.ragged_suspect, "one over-wide row drops a field → flag");
    }

    #[test]
    fn flags_whitespace_rows_but_not_empty_fields() {
        let df = df2("id", "name");
        // interior blank + whitespace-only lines → flag
        let f = detect(b"id,name\n1,a\n\n2,b\n  \n3,c\n", &df);
        assert!(f.whitespace_rows_suspect);
        // a row of empty FIELDS (",,") is NOT a blank line → no flag
        let f = detect(b"id,name\n1,a\n,\n3,c\n4,d\n", &df);
        assert!(
            !f.whitespace_rows_suspect,
            "empty-field row is not a blank line"
        );
        // a single trailing newline is not interior → no flag
        let f = detect(b"id,name\n1,a\n2,b\n", &df);
        assert!(!f.whitespace_rows_suspect);
    }

    #[test]
    fn flags_leading_zero_numeric_id_loss() {
        // code column "001"/"010"/"100" → Polars stores int 1/10/100, the
        // leading zero is gone. Frame is clean ints; only raw reveals it.
        let df = DataFrame::new(vec![
            Series::new("id".into(), &[1i64, 2, 3]).into(),
            Series::new("code".into(), &[1i64, 10, 100]).into(),
        ])
        .unwrap();
        let f = detect(b"id,code\n1,001\n2,010\n3,100\n", &df);
        assert!(
            f.numeric_id_loss_suspect,
            "leading-zero ids cast to int should flag"
        );

        // Plain ints with no leading zeros → no false positive.
        let f = detect(b"id,code\n1,5\n2,42\n3,100\n", &df);
        assert!(!f.numeric_id_loss_suspect);
    }

    #[test]
    fn penalty_keeps_cursed_below_100() {
        let mut f = StructureFlags::default();
        f.delimiter_suspect = true; // a single shape-lie already pulls a clean score well down
        assert!(f.penalty() >= 30.0);
        assert!(f.penalty() <= 100.0);
    }
}
