# Copilot stress suite #2 — analysis

**Run:** 2026-06-01 · **Endpoint:** `POST /api/demo/parse` (CSV parser, `data` crate)
**Suite:** 25 cases (silent corruption / mis-inference / delimiter+Unicode traps; incl. a 500k-row case)

## Headline

**25/25 returned 200, zero crashes** (server alive throughout; 500k rows + 3 MiB
single-line dispatched fast). As suite #1 showed, the parser doesn't *panic* — it
**lies**: returns a confident `score` on data it silently dropped, truncated, or
mis-structured. This suite surfaces **10 "looks fine, is actually cursed"** cases.
The one loud failure (Case 3) errors instead of corrupting.

## Verdict table (rows/cols/score/empty%)

| # | Probe | rows·cols·score·empty% | Verdict |
|---|-------|------------------------|---------|
| 1 | truncated UTF-8 at EOF | 2·2·**100**·0 | 🐛 invalid byte silently accepted, score 100 |
| 2 | UTF-16BE chunk mid-CSV | 3·2·**100**·0 | 🐛 garbled binary in a cell, score 100 |
| 3 | deep quote tangle | — | ⚠ **400 empty CSV** — total loss, but LOUD (errored) |
| 4 | delimiter trap (`;`→`,`) | 3·3·92·22 | 🔴 row 3 (`,`) mis-split under `;` → 2 empty cells |
| 5 | commas-in-quotes (`;`) | 3·3·100·0 | ✓ correct (`;` delim, commas stay in field) |
| 6 | mixed-locale decimals | 5·3·90·20 | ⚠ EU/US decimals mis-split; only partly flagged |
| 7 | boolean soup | 10·2·92·0 | ✓ mixed type flagged (1 mismatch) |
| 8 | huge int + string | 5·2·97·0 | ✓ flagged (1 mismatch) |
| 9 | normalization-trap headers | 2·3·**100**·0 | ⚠ 3 look-alike headers kept distinct, no warning |
| 10 | RTL + ZWJ headers/values | 3·3·**100**·0 | ⚠ accepted as-is; invisible joiners survive silently |
| 11 | **CR-only line endings** | **0**·9·0·0 | 🔴 **ALL ROWS LOST** — lone `\r` not a line break |
| 12 | mixed CRLF/LF/CR | 4·3·100·0 | ✓ handled (only *lone* `\r` breaks — see 11) |
| 13 | **extreme ragged rows** | 3·3·92·22 | 🔴 10-col row **truncated to 3** — 7 values dropped |
| 14 | blank + space-only lines | 6·3·70·56 | ⚠ whitespace-only lines counted as data rows |
| 15 | whitespace vs empty cells | 4·3·86·17 | ✓ reasonable |
| 16 | binary control chars (NUL…) | 3·2·**100**·0 | 🐛 NUL/BEL/ESC/DEL in cells, score 100 (round-trip risk) |
| 17 | 3 MiB single line | 1·1·100·0 | ✓ no OOM, fast |
| 18 | 500k rows | 500000·1·100·0 | ✓ row-count + perf fine (capped to fit 4 MiB) |
| 19 | Win-1252 smart quotes (UTF-8) | 4·3·100·0 | ✓ curly quotes are text, not CSV quotes — correct |
| 20 | BOM + comment-like 1st row | 2·3·**100**·0 | ⚠ first line consumed oddly; header detection fuzzy |
| 21 | backslash vs `""` escaping | 3·2·**100**·0 | 🐛 `\"` not standard CSV — kept literal, score 100 |
| 22 | **mixed delims in header** | 3·2·**100**·0 | 🔴 header `id;name,age\|city` → **2 cols not 4**, score 100 |
| 23 | numeric headers + leading zeros | 3·3·**100**·0 | ⚠ `001` likely → `1` (leading-zero loss), score 100 |
| 24 | sparse grid (1 cell) | 4·6·59·96 | ✓ low score reflects sparsity |
| 25 | duplicate headers + trailing comma | 3·5·93·20 | ⚠ dup `id`/`name` silently renamed; trailing → 5th col |

## The cursed ones (high/clean score, wrong data)

The dangerous class — output *looks* fine, data is lost/mis-structured:

- **🔴 22 — mixed-delim header → wrong column count, score 100.** `id;name,age|city`
  is clearly 4 logical columns; the parser picks one delimiter and yields **2**.
  No empty%, no mismatch — a confident, wrong shape.
- **🔴 13 — ragged wide row silently truncated.** The 10-column row keeps only 3
  cells; **7 values vanish** with score 92 (the empty% is from the *narrow* row's
  padding, not the dropped data).
- **🔴 11 — CR-only line endings → 0 rows.** A 3-row legacy-Mac file parses to a
  single 9-column header and **no data**. (score 0 is at least honest here.)
- **🔴 4 — delimiter trap.** First rows `;`, last row `,` → row 3 stays one field.
- **🐛 1 / 2 / 16 — invalid/binary bytes accepted, score 100.** Truncated UTF-8,
  a UTF-16BE chunk, and NUL/BEL/ESC/DEL all land in cells with a perfect score.
- **🐛 21 — backslash escaping.** `\"` (non-RFC-4180) is kept literally; score 100.
- **⚠ 23 / 20 / 25 — leading-zero loss, BOM+comment header fuzz, dup-header rename**
  — all score ≥93 with no signal that the shape/inference is off.

## Cross-link

Confirms + extends CAS_BFF77F18 (suite #1 + gemini suite #1): the parser's gap is
**graceful-but-wrong**, not crashes. The fix shape is the inverse of the Avro
decoder work (where the danger was *crashing*): here it's making the scorer/parser
**surface a "lossy/recovered/ambiguous" signal** instead of a clean `score=100` —
e.g. flag dropped-cells (13), an ambiguous delimiter (4, 22), lone-`\r` (11), and
non-UTF-8/control bytes (1, 2, 16), so the cleaner can act on them rather than the
user trusting a lie.

---

## ✅ Round 1 fixes shipped (2026-06-01) — for Copilot

Two commits hardened the parser + the scorer per your suggestions:

**1. Parse correctness — lone-CR line endings (`91c52ff`).** Classic-Mac `\r`-only
files normalize to `\n` up front. Case 11: **rows 0 → 3** (was total silent loss).
Mixed CRLF/LF/CR + quoted embedded newlines regress clean.

**2. The scorer grew teeth — `data::structure` suspicion flags (`8f1f9f4`).**
`detect(raw, df)` emits per-axis flags + a score penalty + human reasons, exposed
on `/api/demo/parse` as `score` (post-penalty), `score_raw` (pre-penalty), and
`structure`. **No cursed case reads ≈100 anymore; clean files stay 100 (no false
positives).**

| case | flag fired | score (was → now) |
|------|-----------|-------------------|
| 22 mixed-delim header | `delimiter_suspect` | 100 → **65** |
| 1 / 2 / 16 binary/invalid-UTF-8/control | `binary_suspect` | 100 → **55** |
| 13 ragged · 4 delimiter trap | `ragged_suspect` | 92 → **67** |
| 11 CR-only | `line_ending_suspect` | 96 → **71** |
| 25 dup headers | `header_suspect` | 93 → **78** |
| 23 numeric headers | `header_suspect` | 100 → **85** |
| clean CSV | — | 100 → **100** ✓ |

5 of your 6 hooks are in: delimiter, line-ending, binary, header (dups + numeric),
ragged. Each axis penalty: binary 45 · delimiter 35 · line-ending 25 · ragged 25 ·
header 15 (capped 100).

## ⏳ Still open — where Copilot comes in next

- **Hook #6 (type-drift sensitivity)** — not yet amplified into the penalty. A
  column that's *mostly* numeric/date/bool with a few strings (Cases 6/7/8/23)
  should hurt more than it does.
- **Normalization-collision headers** (Case 9) — look-alike headers in different
  Unicode forms aren't flagged yet.
- **Penalty weights are uncalibrated** — they guarantee *direction* (cursed drops,
  clean holds), not a graded scale.

**Next round = the score-calibration suite** (your idea): ~20 CSVs each labelled
"deserves ≈20/50/80/95", and we tune the weights + add hook #6 until the scorer
matches that judgment. The harness lives at `tools/wasm-bench/score-calibration.py`
— run it, see which cases miss their target band, tune, repeat.
