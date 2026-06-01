# Gemini adversarial suite #1 — divergence analysis

**Run:** 2026-06-01T01:12 UTC
**Endpoint:** `POST /api/demo/parse` (commit 533b331)
**Suite:** 20 CSV payloads, paste-prompt at `tools/wasm-bench/gemini-prompt.md`
**Raw output:** `gemini-suite-1-raw.md`

## Headline

**20/20 returned 200 (no panics, no 5xx)** — the parser is robust against malformed input. But **6 cases revealed silent data loss + missing auto-detection** that should be addressed. The cleanness `score` doesn't capture some of these — the parser succeeds but produces wrong/incomplete data.

## Verdict table

| # | Description | Gemini predicted | Actual | Verdict |
|---|-------------|------------------|--------|---------|
| 1 | Mixed CR + LF + CRLF | rows=3 score≈80 | rows=0 cols=3 score=0 | **🐛 silent data loss** — legacy CR/mixed drops all data rows |
| 2 | Unclosed multi-line quote | rows=1 score≈50 | rows=1 score=100 | **🐛 silent data loss + score lies** — swallowed row 2 into Alice's name, score=100 |
| 3 | Ragged rows | rows=2 | rows=2 cols=3 empty_pct=16.6 | ✓ matches |
| 4 | "N/A" in numerics | rows=3 mismatches=1 | rows=3 mismatches=1 | ✓ matches |
| 5 | Locale delimiter (`;` separator) | rows=2 mismatches=1 | rows=2 cols=1 score=100 | **🐛 missing auto-detection** — never tried `;`, parsed whole row as 1 col |
| 6 | Duplicate + empty headers | rows=1 cols=3 score≈70 | rows=1 cols=3 score=100 | ⚠ partial — Polars auto-renames, score doesn't flag |
| 7 | Null byte injection | rows=1 cols=2 | rows=1 cols=2 | ✓ matches (Rust handles internal null) |
| 8 | BOM + emoji + Arabic | rows=2 score≈100 | rows=2 score=100 | ✓ matches — Unicode handling clean |
| 9 | Ghost grid (sparse) | rows=3 empty_pct≈93 | rows=3 empty_pct=93.3 | ✓ exact match |
| 10 | NaN / Inf / scientific | rows=4 score≈95 | rows=4 score=93.75 | ✓ matches — no panic on NaN/Inf |
| 11 | Missing EOF quote | 500 parse failure | 200 rows=1 cols=1 score=100 | **🐛 silent recovery** — RFC-4180 would error; we score 100 |
| 12 | Invalid UTF-8 (Latin-1 `\xe9`) | 500 parse failure | 200 rows=1 cols=1 score=100 | **🐛 silent data corruption** — lossy UTF-8 decode? bytes accepted silently |
| 13 | Quote soup (RFC-4180 escapes) | rows=1 cols=2 | rows=1 cols=2 | ✓ matches |
| 14 | Boolean drift | rows=4 mismatches=1 | rows=4 mismatches=1 | ✓ matches |
| 15 | Extreme whitespace + tabs | rows=1 cols=2 score≈70 | rows=0 cols=3 score=0 | **🐛 silent data loss** — tabs in data cause 3 cols + 0 rows |
| 16 | Single delimiter byte | rows=0\|1 cols=2 | rows=0 cols=2 | ✓ matches, no panic |
| 17 | Empty body | 400 bad request | 400 `{"error":"no CSV content"}` | ✓ exact match |
| 18 | All numeric headers | rows=1 cols=3 | rows=1 cols=3 | ✓ matches |
| 19 | Pure empty grid | rows=2 empty_pct=100 | rows=2 empty_pct=100 | ✓ exact match (score 57.5 reasonable) |
| 20 | 3 MB payload (under 4 MiB cap) | should succeed | 200 rows=299,999 parse_ms=94 | ✓ — Gemini's 413 prediction was wrong; **300k rows in 94ms = solid throughput** |

## Six real parser-hardening cases

### 🐛 1. Legacy / mixed line endings drop all data rows

```
Case 1: Mixed CR + LF + CRLF → rows=0 cols=3
Case 15: Tabs in data → rows=0 cols=3
```

Both produce the same pattern: parser sees the header row but returns ZERO data rows. The CR / tab characters silently break row tokenization. **Severity: HIGH** — a real-world CSV from a legacy Mac source (CR-only line endings) or a TSV mistakenly hitting CSV would silently lose all data.

### 🐛 2. Unclosed multi-line quote silently swallows rows, score lies

```
Case 2: "Alice\n2,Bob (no closing quote) → rows=1 score=100
```

The parser treats the unclosed quote as a multi-line value swallowing row 2. The score reports 100 (pristine) even though half the rows are gone. **Severity: HIGH** — this is the worst kind of silent data loss because the user gets a "clean!" signal while losing data.

### 🐛 3. No delimiter auto-detection

```
Case 5: 'price;qty\n1.234,56;10\n...' → rows=2 cols=1 score=100
```

The parser defaults to `,` and parses the whole `price;qty` header as one column name. EU-locale CSVs (semicolon-delimited) silently parse as garbage with score=100. **Severity: HIGH** — every European CSV would silently corrupt.

### 🐛 4. Missing EOF quote auto-recovers without flagging

```
Case 11: 'col1\n"unterminated' → rows=1 cols=1 score=100
```

RFC-4180 strictly says this is malformed. Polars / our parser silently recovers by treating the missing quote as EOF. Could be desired graceful behavior, but the score=100 should at least flag it. **Severity: MEDIUM** — depends on whether we want RFC-strict or graceful.

### 🐛 5. Invalid UTF-8 silently accepted

```
Case 12: bytes 'caf\xe9' (Latin-1 'é') → rows=1 cols=1 score=100
```

The `\xe9` byte is invalid UTF-8 (Latin-1 `é`). The parser accepted it cleanly. Two possible mechanisms:
- Lossy UTF-8 decode (`\xe9` → U+FFFD replacement char) silently swaps the byte
- Polars permits non-UTF-8 bytes in strings (unlikely)

Either way, the user uploads a Latin-1 file expecting "café" + gets "caf" + replacement OR mojibake. **Severity: HIGH** — Excel default encoding on Windows is Windows-1252/Latin-1; this is a real production case.

### 🐛 6. Duplicate header doesn't reduce score (minor)

```
Case 6: 'col,,col\n1,2,3' → rows=1 cols=3 score=100
```

Polars auto-renames duplicates (`col`, `column_2`, `col_duplicated_0` or similar). The cleanness score doesn't flag this. **Severity: LOW** — auto-rename is reasonable; the score not surfacing it is a minor gap.

## What the suite confirms is working

- ✓ Unicode (BOM, ZWJ, emoji, RTL Arabic) — clean
- ✓ Sparse / empty grids — `empty_pct` accurate
- ✓ NaN / Inf / scientific notation — no panic
- ✓ Null bytes — preserved
- ✓ Ragged rows — handled with `empty_pct` reflecting drift
- ✓ RFC-4180 quote escapes (`"""` → `"`) — correct
- ✓ Type drift detection (numeric "N/A", boolean mixed vernacular) — caught
- ✓ Empty body 400 — fast fail
- ✓ Bounded body (4 MiB cap) + 300k rows in 94ms — solid throughput

## Sequencing

These divergences live in the **backend/crates/data** lane (parser, not codec). Filing a single tracking case (CAS_<gemini-csv-parser>) with the 6 hardening items + this analysis as the artifact. Each item is its own slice; severity-ordered (HIGH first).

Next suite (#2): Em + Gemini design once these are addressed, or against the v1.1 codec registry directly (different surface — Avro/JSON decode, not CSV parse).

— Sequenced [[gemini-adversary]] in action: Gemini designs adversarial inputs Claude wouldn't, Claude runs them, the divergences become a case BE picks up. End-to-end loop, ~30 minutes from prompt to filed findings.
