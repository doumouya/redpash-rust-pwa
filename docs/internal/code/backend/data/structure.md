---
title: backend/crates/data/src/structure.rs
source: ../../../../../backend/crates/data/src/structure.rs
owner: Torv
section: Internal · Code · backend · data
last modified date: 2026-06-01
---

# structure.rs

## Purpose

**Structure-suspicion flags** — the teeth that stop the cleanness score lying.
The parser is panic-proof but *confidently wrong* on adversarial CSVs (Copilot
stress suites #1/#2, `CAS_BFF77F18`): a clean `score≈100` on input that was
silently mis-delimited, truncated, decoded from binary, or given a junk header.
This module detects those shapes and emits a **score penalty + human reasons**,
so a cursed file can't read ≈100.

It changes nothing about the data — only the reported score + the surfaced
reasons. Consumed today by `POST /api/demo/parse`
([routes/demo.md](../api/routes/demo.md)); reusable by the upload path.

## Public surface

- `pub struct StructureFlags` — seven booleans (`line_ending_suspect`,
  `binary_suspect`, `delimiter_suspect`, `ragged_suspect`, `header_suspect`,
  `type_drift_suspect`, `numeric_id_loss_suspect`) + `type_drift_frac: f32` (the
  worst drifting column's off-type fraction) + `reasons: Vec<String>`.
  `Serialize`d straight into the demo response.
  - `penalty() -> f32` — 0..=100 to subtract from a clean score. Flat weights
    (tuned against `tools/wasm-bench/score-calibration.py`): binary 70 (corrupt
    bytes → unusable), delimiter 45 (wrong shape), ragged 25, header 20,
    numeric-id-loss 20 (identity gone, file still usable), date-drift 18,
    whitespace-rows 12. **Line-ending is split by severity**: a lone CR swallows
    rows (lossy) → 25; mixed CRLF/LF is cosmetic (Polars reads both, no loss) →
    8 (`line_ending_cosmetic`).
    **Type-drift is graded**: `type_drift_frac × 70`, capped at 35 — a 25%-dirty
    column docks ~17, a 50%-dirty one ~30 (never enough alone to read "cursed").
    All summed, capped at 100. Verified at **17/18** in-band on the calibration
    suite; the lone outlier (a 95%-empty grid reading 42 vs a hand-drawn band of
    5–40) is inside labelling noise, not a scorer lie.
  - `any() -> bool`.
- `pub fn detect(raw: &[u8], df: &DataFrame) -> StructureFlags` — the detector.

## What each flag catches (suite #2 case → flag)

- **binary** — invalid UTF-8, or a control byte `< 0x20` outside `\t\r\n` in a
  cell (Cases 1, 2, 16).
- **line_ending** — a lone `\r` (classic-Mac), or mixed `CRLF`+`LF` (Cases 11, 12).
- **delimiter** — the header line carries ≥2 distinct delimiter candidates
  (`, ; \t |`), so the split is ambiguous (Case 22).
- **ragged** — two signals, both feed `ragged_suspect`:
  1. quote-aware field counts vary across sample rows (max ≥ 2× min, or a spread
     ≥ 3) → truncation / wrong delimiter (Cases 4, 13).
  2. **any data row is wider than the header** → Polars truncates it to the
     header width, silently dropping the trailing field(s). One over-wide row is
     still lost data, and the spread can be just 1, so signal 1 misses it; the
     *direction* (data > header) is the tell. Catches a single extra-column row,
     EU-decimal mis-splits (`id,price` + `1,1.234,56`), trailing-comma columns.

  Both are **skipped when a quoted field spans physical lines** (tracked via
  cumulative quote balance) — otherwise a clean multiline-quoted file false-flags.
- **header** — duplicate header names (incl. Polars' `_duplicated_` rename) or
  all-numeric headers (a data row used as the header) (Cases 23, 25).
- **numeric_id_loss** — a pure-digit value with a leading zero (`001`, `07920`)
  was cast to int, destroying the zero *and* the identity it encoded (zip / postal
  / badge id). Invisible in the parsed frame (it's already `1`), so detected by
  comparing the **raw bytes** against the columns Polars typed as `int`:
  `split_unquoted` aligns raw fields to columns by position. **Gated on a cleanly
  rectangular parse** (`!ragged_suspect && !multiline_quoted`) — on a ragged file
  the field positions are off, so a stray `00` from a mis-split decimal
  (`2.000,00`) would false-positive (and the raggedness is already flagged).
- **whitespace_rows** — blank / whitespace-only physical lines interspersed in
  the data, which Polars drops silently (penalty 12). Counts INTERIOR blanks
  only (up to the last non-blank line, so a trailing newline doesn't trip it)
  and requires a material fraction (≥8%). A row of empty *fields* (`,,,`) is NOT
  blank — its line trims to `,,,`, not `""`.
- **date_drift** — a date column (≥80% date-shaped) mixing ≥2 incompatible
  format shapes (`2026-01-13` + `13/01/2026` + `01/13/2026`), or a contradictory
  day/month order (one cell dd/mm, another mm/dd). The dates *parse* — to the
  wrong day, silently — so this never shows as a null or mismatch. Detected by
  `dtype::worst_date_drift`; penalty 18, reason calls out the contradiction.
- **type_drift** (hook #6) — a String-stored column whose non-empty cells are
  *mostly* (≥50%) one structured kind (numeric/bool/date) but *not pure* (<95%) —
  the silent band the semantic sniff waves through as a clean string column at
  score≈100 (`amount=[10,20,foo,40]` is 75% numeric, just under the sniff's 80%
  bar). Detected by `dtype::worst_type_drift`; `type_drift_frac` carries the worst
  column's off-type fraction so the penalty scales by severity. Pure columns are
  handled upstream (sniff types them, strict-parse docks stragglers);
  mostly-text columns are genuine strings (Cases 6, 7).

## Drift-prone areas

- **Detection is from RAW bytes + the parsed frame** — line-ending/binary/
  delimiter/ragged come from the raw text (the frame is already rectangular, so
  raggedness is invisible there); duplicate/numeric headers come from the frame.
- **`count_unquoted` is duplicated** from `parse::sniff` (a 6-line quote-aware
  counter) so the two stay private; if a third copy appears, lift it to a shared
  `pub(crate)` helper.
- **Penalty weights are calibrated against the suite, not first-principles.**
  `tools/wasm-bench/score-calibration.py` (18 CSVs labelled with a deserved band)
  is the tuning instrument — re-run it after touching any weight. Currently
  16/18 in-band. They still guarantee the *direction* (cursed drops, clean stays
  100); the absolute graded scale is "good enough", not exact.
- **`worst_type_drift` lives in `dtype.rs`, not here** — it reuses that module's
  shape checks (`classify_cell` → the same `looks_numeric_ish` / `looks_date_shaped`
  / bool-word logic the sniff uses) so drift detection agrees with the sniff. Keep
  the cell-classification logic there; `structure.rs` only consumes the verdict.
- **No false positives on clean input** is the contract — verified (a plain
  `\n` CSV with unique text headers flags nothing). Keep new heuristics
  conservative so they don't penalize legitimate files.

## Related

- [parse/sniff.rs](parse.md) — the delimiter sniff + line-ending normalization this complements.
- [stats.rs](stats.md) — `cleanness_report` produces the raw score the penalty applies to.
- [routes/demo.rs](../api/routes/demo.md) — `/api/demo/parse` exposes `score` (penalized), `score_raw`, `structure`.
