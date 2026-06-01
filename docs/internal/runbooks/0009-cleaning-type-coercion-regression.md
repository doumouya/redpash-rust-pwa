---
title: The cleaner stopped cleaning — type-coercion regression
date: 2026-06-01
owner: Torv
area: backend/crates/data
---

# 0009 — The cleaner stopped cleaning (type-coercion regression)

## Symptom

Em: "snappy but doesn't clean." Against the fleury `clean-score` corpus
the cleaned cleanness score sat far below the gold `clean_NNN` reference
— matching it on only **14/100** files. The entire gap was
`type_consistency`: numeric / date / bool columns that *look* typed
stayed `string` and failed their semantic parse.

## Diagnosis (data-first)

Built `examples/clean_dir.rs` (efficacy gate: raw → recipe → re-score vs
the gold corpus) + a `score_dir -v` drift histogram. Drift across 100
files: **float 255 / date 138 / bool 54**. Root causes:

- `cast` to int/float used Polars' plain `.cast()`, which nulls
  `2114,29` / `1 234,56 €` / `1000 EUR` (French comma, currency,
  thousands) — the dominant real-world numeric shape.
- `parse_date_flex` had only 4-digit-year formats → `02/01/23`
  (dd/mm/yy) and bare `YYYY` became null.
- `cast` to bool only knew `true`/`false` → `oui` / `non` / `1` / `0`
  nulled.

These are the exact dirt classes `docs/VISION.md` names through the
road-assistance (Fleury) dataset. The cleanness *scorer* and *parser*
were fine; the cleaning *operations* on top had regressed while
attention was on CSS/HTML debt (Em's own diagnosis). The Django
predecessor (`redpash-main/cleaner/utils.py`) had handled bare-`YYYY`
(`year_start`) and a wider sentinel set — confirming a regression, not a
never-built feature.

## Fix

- `steps/util.rs`: `normalize_numeric_cell` (strip currency/spaces,
  French comma→dot, last-separator-is-decimal) + `normalize_bool_cell`
  (EN+FR truthy/falsy) + day-first 2-digit formats in `parse_date_flex`.
- `steps/cells.rs`: `cast` routes string→int/float and string→bool
  through the normalizers instead of Polars' lossy `.cast()`.

Result: median **84.7 → 94.5**, gold-match **14 → 33/100**; `raw_001`
`type_consistency` 72 → 100. Numeric normalizer verified on the real
`Solde` column (`2114,29`, `1667,63 €`, `€911.18`, ` 729.65 ` all parse;
`inconnu`/`ND` correctly → null).

## Prevention

- `examples/clean_dir.rs` is the standing regression gate — a future
  change that re-breaks coercion shows as a flat/falling Δ vs the gold
  corpus.
- `examples/tools_check.rs` verifies every Tools button on a real file.
- Unit tests for the normalizers in `steps/util.rs`.

Still open (follow-ups, not regressions): widen `SENTINELS` to catch
`inconnu`/`ND`/`???` in *string* columns; `fill_nulls` smart strategies
(mean/median/mode); column-evidence dd/mm vs mm/dd via
`dtype::daymonth_force`.
