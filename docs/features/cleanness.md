---
title: Cleanness score
section: Features
order: 5
last modified date: 2026-05-16
---

# Cleanness score

Every file carries a `cleanness_pct` (0–100) that points the user at how
much cleaning work the file still needs. It's an **intrinsic**
assessment — no "clean reference" file required, no calibration set, no
ML — just a deterministic two-tier function over the parsed
`DataFrame` + `ColumnMeta`. The score is recomputed on every upload,
join, snapshot, and cache-miss hydrate, and persisted as
`project_files.cleanness_pct`.

Source: [`crates/data/src/stats.rs`](../../backend/crates/data/src/stats.rs).
Public API:

```rust
pub fn cleanness        (df, columns) -> Option<f32>;            // blended score
pub fn cleanness_report (df, columns) -> Option<CleannessReport>; // + every sub-score
```

---

## The model

Two tiers, **multiplied**:

```
structural_integrity ∈ [0,1]    — did the file even parse into a sane shape?
value_quality        ∈ [0,100]  — given a sane shape, how clean are the values?
cleanness_pct = value_quality × structural_integrity
```

Structure is a **gate**, not a fifth averaged component. A file that
parsed into one bogus column is 0% usable no matter how "complete" that
column looks, so it has to cap the ceiling rather than dilute into an
average. `structural_integrity` is the *weakest link* (min) of three
sub-signals. The `dossier.csv` reference case (a doubly-CSV-encoded
17-column file parsed as 1 column) gets `structural ≈ 0.06` → final
score ~6, no matter what value-quality says.

### Structural tier — three sub-signals (gated on `col_count == 1`)

Multi-column frames are assumed to have parsed correctly and skip the
structural checks entirely (`structural = 1.0`). Only single-column
frames — the file shape where parser failure manifests — are scrutinized:

| Signal | Detects | Score |
|---|---|---|
| **parse-shape** | wrong delimiter or doubly-CSV-encoded export — the lone column's values consistently split into m≥2 fields on some delimiter (≥80% share the modal field count). | `1/m` |
| **encoding** | mojibake — **U+FFFD** replacement chars (decode failure) **and** `Ã©`-style **double-decode** (`Ã©` / `Ã¨` / `Ãª` / `Ã ` / `Ã§` / `Ã®` / `Ã´` / `Ã¢` / `Ã¹` / `Ã»` — latin-1-as-UTF-8 signature, valid UTF-8 but garbled). Note this runs on **every** string column, not just 1-col frames. | `1 − damaged_cells / total_string_cells` |
| **header** | the lone column's *name* is a junk / preamble artefact — empty, `sep` / `sep=…` (Excel separator hint), starts with `#`, or contains `": "` (a `Key: value` metadata line). | `0.5` if junk, else `1.0` |

The 22 `sep`-headed files from the `clean-score` stress dataset used to
trip the header signal (score ≈ 50); now that the parser skips the
preamble in `parse_text`, they parse correctly with their real header
(`appt_id`, `numero_facture`, etc.) and score 100. The signal stays in
place as a safety net for files where the parser can't recover.

### Value-quality tier — four components, weighted blend

| Component | Weight | Measures |
|---|---|---|
| **Completeness** | 35% | `100 − null_pct` per column, averaged. All-null (`empty` dtype) columns pin to 0. |
| **Type consistency** | 25% | per column, fraction of non-null non-empty cells that pass a **strict** native Rust parse for the column's `ColumnMeta::semantic_dtype` (sniffed by `dtype::sniff_semantic_type` — see below). A `string`-stored column whose values are *trying* to be `float` / `date` / `bool` gets docked proportionally to the cells that fail (`€1234`, `1234,56`, `Oui`, `12/03/2024` all fail; `1234`, `2024-03-12`, `true` all pass). Already-typed columns (Polars parsed them) and genuine text columns score 100. |
| **Value hygiene** | 25% | fraction of string cells with no leading/trailing whitespace and not a sentinel (`N/A`, `-`, `?`, `null`, `#N/A`, `unknown`, `inconnu`, …). Genuinely empty cells skipped — that's completeness's concern. |
| **Row uniqueness** | 15% | `100 × distinct_rows / total_rows`. Exact full-row duplicates are the `drop_duplicates` step's target. |

`value_quality = 0.35·compl + 0.25·type + 0.25·hyg + 0.15·uniq`.

---

## Semantic type sniffing

The type-consistency component leans on a second dtype carried on every
`ColumnMeta`:

| Field | Source | Meaning |
|---|---|---|
| `dtype` | Polars' inferred parse type | what the column **is** stored as |
| `semantic_dtype` | `dtype::sniff_semantic_type(series)` | what the column is **trying** to be |

When Polars couldn't natively type a column (it has dirty values like
`€995.83` or `1234,56`), it stays `String`. The sniffer samples up to
50 non-null non-sentinel cells and classifies them:

- **bool** — ≥80% match `{true, false, yes, no, oui, non, vrai, faux, y, n, t, f, o, 0, 1}` *and* at least one value is non-numeric (so a pure `1/0` column doesn't get tagged bool over int).
- **date** — ≥80% match a structural date shape: three non-empty numeric groups separated by a single `/`, `-`, or `.`, *or* an 8-digit `yyyymmdd`.
- **float** — ≥80% are "numeric-ish": start with a digit, sign, `.`, or currency symbol (`€` / `$` / `£`) and are ≥50% digits by character count. The starts-with-digit rule is what stops prefix-coded IDs (`REN96584`, `CLI83991`, `FIL_…`) from being mistaken for numbers; the digit-ratio rule catches dirt the strict parse will later reject (`€995.83`, `1234,56`, `1654.54 HT`, `1000 EUR`) without needing a finicky letter whitelist.
- otherwise → **string**.

**Numeric-looking IDs.** A column called `CODE_POSTAL` whose values are
`"01000"`, `"75001"`, `"06600"` is numeric-ish in every cell — the
above rules happily class it as `float`. But casting to float silently
drops the leading zero (a French postcode loses its identity that
way), so the float branch now applies two **vetoes** that demote the
classification back to `string`:

| Veto | Detects |
|---|---|
| **Name token** — column name splits on non-alphanumeric and any token matches `ID_NAME_TOKENS` (`postcode`, `postal`, `zip`, `zipcode`, `siren`, `siret`, `tva`, `phone`, `telephone`, `mobile`, `fax`, `iban`, `bic`, `swift`, `id`, `uid`, `guid`, `uuid`, `ssn`, `code`, `ref`) | Any column whose *name* tells you it's an identifier, even when the values are all digits. |
| **Leading-zero sample** — any sampled value starts with `0` and has length > 1 | Catches identifier columns whose name doesn't hint at it (e.g. a custom case-ref code) but whose sample shows leading-zero preservation matters. |

Either veto fires → return `"string"`. This is what stops the
Cleaner's Data Types panel from suggesting "cast CODE_POSTAL to float"
and silently nulling the leading-zero rows on confirmation.

Already-typed columns (Polars classified them as `Int64`, `Float64`,
`Date`, `Boolean`) skip the sniff and inherit the same vocabulary. The
field is persisted in `project_files.columns_meta` JSONB (additive —
`#[serde(default)]` keeps old rows compatible) and surfaced over the
wire on every `FileSummary` envelope. The cleaner sidebar's
*Data Types* panel (in `scripts/pages/cleaner.js`) uses it to drive the
"this column should be a float — cast it?" suggestion: when `dtype !=
semantic_dtype`, the row renders as an accent-tinted clickable that
dispatches a `cast` step.

---

## Reference scores

| Dataset | What it is | Score range |
|---|---|---|
| `scoring project` (redpash dev fixtures) | 4 raw/clean pairs from the original dataset | raw ≈ 93–96, clean ≈ 96–100 |
| `dossier.csv` | doubly-CSV-encoded 17-col export → parsed as 1 col | **5.88** (structural gate) |
| `clean-score` 100 raw/clean pairs ([generator](<fleury>/Projet Data/clean-score/_generate_clean_score_data.py)) | synthetic stress dataset — French/English, 8 domains, every dirt class | raw median 83.7, clean median 95.7, 99/100 clean > raw, **0 inversions**, mean delta +11.3 |

The `clean-score` harness doubles as a regression suite: any scorer or
parser change that nudges those numbers (especially the inversion
count) needs a justification.

---

## Eval harness

[`crates/data/examples/score_dir.rs`](../../backend/crates/data/examples/score_dir.rs)
runs the exact upload path (`from_csv_bytes → summarize →
cleanness_report`) over every CSV in a directory:

```
cargo run --example score_dir -- <dir>           # one diagnostic line per file
cargo run --example score_dir -- <dir> -v        # also list per-column drift
```

Output:

```
83.56  compl=89.9 type=70.6 hyg=83.4 uniq=91.6  struct=1.00   11c × 178r  flags=drift=5,mojibake=1.00  raw_009_clients_fr.csv
86.71  compl=62.0 type=100.0 hyg=100.0 uniq=100.0  struct=1.00    8c × 163r  flags=-                  clean_004_produits_en.csv
100.00 compl=100.0 type=100.0 hyg=100.0 uniq=100.0  struct=1.00    1c × 146r  flags=-                  clean_006_rendezvous_en.csv
```

Score first (eyeball-sorts), then every sub-component, then frame
shape, then a `flags=` tail with high-level diagnostic categories:

- `drift=N` — N columns whose `semantic_dtype ≠ dtype` (cast candidates)
- `mojibake=X` — `encoding_integrity` < 1.0 (`Ã©` or U+FFFD damage)
- `shape=X` — 1-column mis-parse caught by the shape gate
- `header=X` — junk header (`sep`, `#…`, `Key: value`)

`flags=-` means nothing's wrong. `grep flags=mojibake` finds
encoding-damaged files at a glance.

The `-v` flag adds `⤷ drift: <col> storage=string → semantic=<intent>`
lines under each file, so you can point at the specific columns
dragging the score down:

```
81.04  compl=95.1 type=62.3 hyg=73.7 uniq=91.7  struct=1.00   10c × 205r  flags=drift=5  raw_001_clients_fr.csv
        ⤷ drift: telephone                storage=string → semantic=float
        ⤷ drift:  date_inscription        storage=string → semantic=date
        ⤷ drift: agé                      storage=string → semantic=float
        ⤷ drift:  ACTIF                   storage=string → semantic=bool
        ⤷ drift: Solde                    storage=string → semantic=float
```

---

## User-extended sentinel set — the learning loop

The canonical `SENTINELS` list (above) is finite and biased toward the
English / French data we've seen. Real datasets carry junk values
RedPash can't anticipate: `"???"`, `"----"`, `"<NULL>"`, `"NDISPO"`,
etc. The system learns from users via three tiers:

| Tier | Source | Scope | Scored by |
|---|---|---|---|
| **Built-in** | `data::stats::SENTINELS` (compiled into the crate) | Everyone | Always |
| **Global** | `global_sentinels` view (`COUNT(DISTINCT user_id) >= 2` over `sentinel_submissions`) | Everyone, once promoted | Always |
| **Personal** | `prefs.learned_sentinels` JSONB array | One user | Only on explicit `compute_cleanness` |

### Frontend flow

The Workspace cleaner mode's *Fix invalid values* modal (see
[features/cleaner.md](cleaner.md))
lets the user type any string that's polluting their file → backend
re-scans for it (`GET /api/files/:rid/sentinels?extra=`) → user picks
it → `Apply` runs one `fix_invalid` step that covers the whole
selection **and** pushes the canonical (trim + lowercase) form into
the user's `prefs.learned_sentinels` JSONB array via `rpSavePref`.

If the user has consented to share (`prefs.share_sentinels === true`,
captured via a one-time consent modal on the first custom Apply), the
PATCH `/api/me` handler also writes the new canonicals to
`sentinel_submissions(canonical, user_id)`. The view auto-promotes
them to `global_sentinels` once a second distinct user has flagged
the same value.

### Scoring with the union

`value_hygiene_score(df, extras: &[String])` and the wrapper
`cleanness_report(df, columns, extras)` / `cleanness(df, columns,
extras)` take an extras slice that extends the canonical match set.
The plumbing is the same as `find_sentinels(df, extras)` — both
canonicalise (trim + lowercase) and short-circuit empties — so the
modal scan and the scorer always agree on what counts as a sentinel.

Per call-site:

- **Hydrate** (upload / cache-miss / step-apply / join / snapshot) →
  `extras = list_global_sentinels()`. Score reflects what every user
  agrees is junk, no per-user context required (the hydrate path
  doesn't have a session).
- **`POST /api/files/:rid/cleanness`** → first runs `hydrate` (so the
  baseline score is global-only), then if the file owner has any
  `prefs.learned_sentinels` entries that aren't already in globals,
  re-scores against `extras = globals ∪ learned`, persists the new
  number, and refreshes the in-memory cache. The file owner sees
  *their* view of cleanness; every other reader sees the global
  baseline until they trigger their own recompute.
- **`crates/data/examples/score_dir.rs`** — eval harness always
  passes `extras = &[]` so reference scores stay user / DB-
  independent. The non-regression guard is: with no extras, the
  scorer's output must match the pre-learning baseline byte-for-byte.

## Open follow-ups

- **Persist the sub-scores.** Today only the blended `cleanness_pct`
  reaches the DB. `cleanness_report` returns the rich struct — surfacing
  it in the cleaner UI (a "why is this 86?" expander on the overall
  cleanness bar) would close the diagnostic loop. Needs a column on
  `project_files` (JSONB `cleanness_breakdown` is the natural shape).
- **Encoding signal expansion.** Catches U+FFFD and ten common French
  double-decode bigrams; doesn't catch e.g. windows-1252-as-latin-1
  variants or the cp1252-curly-quote class. Cheap to extend.
- **Project-level cleanness.** `ProjectSummary.cleanness_pct` is still
  `None` — aggregating file scores (mean? weighted by row count?) into
  a project rollup would let the home minitable show one number per
  workspace.

---

## Related

- [`objects/file.md`](../objects/file.md) — `FileSummary` / `ColumnMeta` DTO + the `project_files` table.
- [`features/cleaner.md`](cleaner.md) — the UI on top of the score, including the cast-suggestion loop.
- `crates/data/src/stats.rs` — the scorer.
- `crates/data/src/dtype.rs` — `summarize` + `sniff_semantic_type`.
- `crates/data/src/parse/` — the two-pass parser: `mod.rs` ties it together, `sniff.rs` does header + delimiter sniff + 1-col preamble walk, `filter.rs` carries the predicate evaluator.
