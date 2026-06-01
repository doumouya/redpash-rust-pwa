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

- `pub struct StructureFlags` — five booleans (`line_ending_suspect`,
  `binary_suspect`, `delimiter_suspect`, `ragged_suspect`, `header_suspect`) +
  `reasons: Vec<String>`. `Serialize`d straight into the demo response.
  - `penalty() -> f32` — 0..=100 to subtract from a clean score. Weights (tuned
    against `tools/wasm-bench/score-calibration.py`): binary 70 (corrupt bytes →
    unusable), delimiter 45 (wrong shape), line-ending 25, ragged 25, header 20;
    capped at 100. Calibration is approximate — direction is guaranteed, the
    graded scale is still being tuned (type-drift, hook #6, is the open axis).
  - `any() -> bool`.
- `pub fn detect(raw: &[u8], df: &DataFrame) -> StructureFlags` — the detector.

## What each flag catches (suite #2 case → flag)

- **binary** — invalid UTF-8, or a control byte `< 0x20` outside `\t\r\n` in a
  cell (Cases 1, 2, 16).
- **line_ending** — a lone `\r` (classic-Mac), or mixed `CRLF`+`LF` (Cases 11, 12).
- **delimiter** — the header line carries ≥2 distinct delimiter candidates
  (`, ; \t |`), so the split is ambiguous (Case 22).
- **ragged** — quote-aware field counts vary across sample rows (max ≥ 2× min, or
  a spread ≥ 3) → truncation / wrong delimiter (Cases 4, 13). **Skipped when a
  quoted field spans physical lines** (tracked via cumulative quote balance) —
  otherwise a clean multiline-quoted file false-flags as ragged.
- **header** — duplicate header names (incl. Polars' `_duplicated_` rename) or
  all-numeric headers (a data row used as the header) (Cases 23, 25).

## Drift-prone areas

- **Detection is from RAW bytes + the parsed frame** — line-ending/binary/
  delimiter/ragged come from the raw text (the frame is already rectangular, so
  raggedness is invisible there); duplicate/numeric headers come from the frame.
- **`count_unquoted` is duplicated** from `parse::sniff` (a 6-line quote-aware
  counter) so the two stay private; if a third copy appears, lift it to a shared
  `pub(crate)` helper.
- **Penalty weights are uncalibrated.** They guarantee the *direction* (cursed
  drops, clean stays 100), not a graded scale. Tune against a dedicated
  score-calibration suite (CSVs labelled "deserves ≈20/50/80/95") before relying
  on the absolute number.
- **No false positives on clean input** is the contract — verified (a plain
  `\n` CSV with unique text headers flags nothing). Keep new heuristics
  conservative so they don't penalize legitimate files.

## Related

- [parse/sniff.rs](parse.md) — the delimiter sniff + line-ending normalization this complements.
- [stats.rs](stats.md) — `cleanness_report` produces the raw score the penalty applies to.
- [routes/demo.rs](../api/routes/demo.md) — `/api/demo/parse` exposes `score` (penalized), `score_raw`, `structure`.
