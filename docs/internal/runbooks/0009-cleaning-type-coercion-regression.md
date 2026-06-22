# 0009 — the cleaner stopped cleaning (type-coercion regression)

Historical reasoning record. The regression below was diagnosed and **fixed on the
rebuild tree** (commit `690b934`, "data: locale-aware numeric/date/bool coercion +
cleaning-efficacy gate"); the fix is **live on lean** today — the locale coercers in
[`steps/util.rs`](../../../backend/crates/data/src/steps/util.rs) and the cast routing in
[`steps/cells.rs`](../../../backend/crates/data/src/steps/cells.rs). This doc preserves the
WHY (what regressed, how the data-first diagnosis ran, why the lossy `.cast()` was the
trap) and rebuilds every specific against the lean source. There is no open fix to apply
here.

It interlocks with the polars 0.54 bump: the same migration that triggered the
[`Series` → `Column` API moves](../../../backend/crates/data/src/clean.rs) and the wasm
fork is the era this coercion work landed in — see
[0023 — polars 0.54 wasm fork](0023-polars-0.54-wasm-fork.md). The coercers themselves are
the product's actual moat over naive CSV ingestion, and `steps/util.rs` says so in its own
header comment.

## Symptom

Em: "snappy but doesn't clean." Against the Fleury cleaning corpus, the cleanness score on
cleaned output sat far below the gold reference — the entire gap was `type_consistency`:
numeric / date / bool columns that *look* typed stayed `string` and failed their semantic
parse. Fast UI, no cleanliness gain.

## Diagnosis (data-first)

The cleanness *scorer* and *parser* were fine; the cleaning *operations* on top had
regressed while attention was on CSS/HTML debt (Em's own read). Re-scoring cleaned output
against the gold corpus localised the drift to three dirt classes, each a real-world shape
the Fleury (road-assistance) dataset is full of:

- **Numeric** — `cast` to int/float used Polars' plain `.cast()`, which nulls
  `2114,29` / `1 234,56 €` / `1000 EUR` (French decimal comma, currency symbols, thousands
  separators) — the dominant real-world numeric shape in the corpus.
- **Date** — the flexible date parser only knew 4-digit-year formats, so day-first
  2-digit dates like `02/01/23` (dd/mm/yy) became null, and worse, a greedy `%Y` would
  read `02/01/23` as **year 0002**.
- **Bool** — `cast` to bool only knew `true`/`false`, so `oui` / `non` / `1` / `0` nulled.

These are exactly the junk classes the founding (Fleury) locale named — see
[`decisions/vision.md`](../../decisions/vision.md). The Django predecessor had already
handled the wider date and sentinel set, which is what made this a **regression**, not a
never-built feature: the capability existed before and was lost in the port.

## Root cause

Polars' plain `Expr::cast` / `Series::cast` to a numeric or bool dtype is **locale-naive**:
it parses only the canonical machine form (`.` decimal, ASCII `true`/`false`, 4-digit-year
ISO dates) and silently nulls everything else. Feeding it the raw string column threw away
every FR/dirty cell that a human would read as a number, a boolean, or a date. The cure is
a normalization pass *before* the typed cast, not a different cast.

## The fix (live on lean)

Three coercers in [`steps/util.rs`](../../../backend/crates/data/src/steps/util.rs), and a
`cast` step that routes string sources through them in
[`steps/cells.rs`](../../../backend/crates/data/src/steps/cells.rs):

- **`normalize_numeric_cell`** — strips currency/units/spaces (incl. NBSP `\u{00A0}` and
  narrow NBSP `\u{202F}`), then resolves `,` vs `.` by "last separator is the decimal"
  (`1.234,56` → `1234.56`, `1,234.56` → `1234.56`) and treats a lone comma as the FR
  decimal (`2114,29` → `2114.29`). `None` when there's no digit.
- **`normalize_bool_cell`** — EN + FR truthy/falsy (`true`/`oui`/`vrai`/`yes`/`y`/`o`/`1`
  → true; `false`/`non`/`faux`/`no`/`n`/`0` → false). A genuine enum like
  `feminin`/`masculin` returns `None` and is left for the user.
- **`parse_date_flex`** — day-first 2-digit formats precede month-first, and `%y`
  (2-digit year) precedes `%Y` in the coalesce list, so `02/01/23` reads as `2023-01-02`,
  **not** year 0002; a day > 12 (`03/27/2023`) forces month-first.

The cast step in `steps/cells.rs::cast` only diverts when the **source is `String`**: for
`int`/`float` it builds the column from `ca.iter().map(normalize_numeric_cell)`, for `bool`
from `normalize_bool_cell`, and `date`/`datetime` go through `parse_date_flex` /
`parse_datetime_flex`. Non-string sources and the other dtypes fall through to plain
`col(column).cast(...)`. The numeric path materialises a fresh `Series` and writes it back:

```rust
// steps/cells.rs::cast — string → numeric, locale-aware
let floats: Vec<Option<f64>> = ca.iter().map(|o| o.and_then(normalize_numeric_cell)).collect();
let series = Series::new(column.into(), floats);
let new_col = if dtype == "int" { series.cast(&DataType::Int64)? } else { series };
out.with_column(new_col.into_column())?;   // 0.54 Series → Column move
```

The `.into_column()` here is the polars 0.54 `Series` → `Column` API the whole engine moved
to in the same bump — `DataFrame` columns are `Column`, and `Series::new(...).into_column()`
/ `DataFrame::new_infer_height(Vec<Column>)` / `df.columns() → &[Column]` recur throughout
[`clean.rs`](../../../backend/crates/data/src/clean.rs) and the rest of the crate. The
type-coercion fix and the API move are the same era; both trace to
[0023](0023-polars-0.54-wasm-fork.md).

## Standing regression gate (on lean)

The prerelease tree pinned this with throwaway `examples/` binaries
(`clean_dir.rs` / `score_dir.rs` / `tools_check.rs`) that re-scored a directory of files
against the gold corpus. **Those examples were dropped in the lean graduation** — they
depended on a local corpus that isn't part of the tree. On lean the coercers are pinned by
**in-crate `#[test]`s** instead, which is what a CI run actually exercises:

- `steps/util.rs::numeric_handles_french_currency_and_thousands` — `2114,29`, `1667,63 €`,
  `€911.18`, `1000 EUR`, `-3,5`, `1 234,56`, `1.234,56`, `1,234.56` all parse; `inconnu`
  and `""` → `None`.
- `steps/util.rs::bool_handles_en_fr_spellings` — the EN+FR truthy/falsy set; `feminin`
  → `None`.
- `steps/util.rs::date_flex_2digit_year_is_day_first_not_year_0002` — asserts `02/01/23`
  → `2023-01-02` (the exact year-0002 trap), plus month-first force and ISO/compact forms.
- [`clean.rs`](../../../backend/crates/data/src/clean.rs) `auto_clean_trims_blanks_and_dedups`
  and `fr_sentinel_is_blanked` cover the no-human-in-the-loop `auto_clean` path.

`cargo test -p data` runs the lot. (Per [0023](0023-polars-0.54-wasm-fork.md) the data crate
carries ~76 tests on source that compiles to both the host and wasm targets.)

## Resolved follow-ups (were "still open" on prerelease)

The prerelease record left three items open. Two are now closed on lean:

- **Widen the sentinel set** for string columns (`inconnu` / `ND` / `???`): closed — the
  single unified vocabulary in [`sentinels.rs`](../../../backend/crates/data/src/sentinels.rs)
  now carries `inconnu`, `nd` / `n/d` / `n.d.`, `???`, the Excel error literals, and the FR
  junk (`non disponible`, `sans objet`, …). `auto_clean` blanks them via `is_sentinel`, and
  `clean.rs::fr_sentinel_is_blanked` pins it.
- **`fill_nulls` strategies**: `steps/cells.rs::fill_nulls` ships `fixed` / `zero` /
  `forward` today. Mean/median/mode remain a deliberate non-goal of the always-safe path
  (a statistical fill is a judgment call, left to the interactive cleaner).
- **Column-evidence dd/mm vs mm/dd**: still a heuristic, not a per-column vote —
  `parse_date_flex` resolves ambiguity by format order (day-first first, day > 12 forces
  month-first), which is correct for the FR/Africa default. A column-evidence override
  stays a future enhancement, not a regression.

## Prevention / lessons

- **Re-score against the gold corpus to localise drift** — the symptom ("doesn't clean")
  was diffuse; scoring per dirt-class (numeric / date / bool) pointed straight at the lossy
  `.cast()`. Data decides which class regressed.
- **Plain `.cast()` to a typed dtype is locale-naive** — normalize the *string* first, then
  cast; never hand a dirty FR column straight to `Expr::cast`.
- **A capability the predecessor had is a regression when it's missing, not a feature
  request** — the Django cleaner's wider date/sentinel handling was the tell.
- **Pin coercion with in-crate tests, not corpus-dependent `examples/`** — the lean gate
  travels with the source and runs under `cargo test -p data`; an external-corpus binary
  doesn't survive a graduation.

For the data crate's architecture and the load → shape → emit pipeline these steps sit in,
see [`data-engine.md`](../code/backend/data-engine.md); for day-to-day polars code in this
repo, the `redpash-polars` skill.
