# Gemini prompt — adversarial CSV generation for `/api/demo/parse`

Paste this block into a Gemini chat. It describes the endpoint, the response shape, and a structured task. Gemini returns CSV payloads + curl commands you can pipe into the endpoint directly.

---

## The system

We're building a CSV parser + cleanness scorer. The endpoint:

```
POST http://localhost:8088/api/demo/parse
Body: raw CSV bytes (any encoding, any line endings)
Headers: none required (no Content-Type check)
Auth: none
Body cap: 4 MiB (returns 413 if exceeded)
```

Response on success (200):

```json
{
  "rows":            <integer>,
  "columns":         <integer>,
  "score":           <float, 0.0-100.0>,
  "type_mismatches": <integer>,
  "empty_pct":       <float, 0.0-100.0>,
  "parse_ms":        <integer>
}
```

- **score** is a blended cleanness metric. 100 = pristine, 0 = unparseable garbage.
- **type_mismatches** counts string-typed columns that are really numeric / date / boolean — the kind of dirt RedPash's cleaner fixes.
- **empty_pct** is the fraction of empty cells across the whole grid.

Errors:
- 400 — empty body
- 413 — over 4 MiB
- 500 — parse failure (the parser should never panic, only return errors)

## Your task

Generate **20 adversarial CSV files** that stress this parser. For each one:
1. Show the raw CSV content (use code fences with the file name in a comment).
2. Predict what `rows`, `columns`, `score`, `type_mismatches`, `empty_pct` you'd expect.
3. Give a one-line description of the edge case being tested.
4. Provide a curl command to send it.

## Coverage I'm interested in

Aim for breadth across these categories. Pick 1-3 from each:

| Category | Examples |
|----------|----------|
| **Encoding** | UTF-8 BOM, UTF-16 LE/BE, Windows-1252, Latin-1, mixed in one file |
| **Line endings** | CRLF, LF, CR (legacy Mac), mixed |
| **Quoting** | Unclosed quotes, escaped quotes inside quotes, mixed quote chars |
| **Delimiters** | Tab, semicolon, pipe, mixed, auto-detection trap (e.g. commas inside quoted fields) |
| **Headers** | No header, duplicate headers, empty header cell, all-numeric headers |
| **Type drift** | Numeric column with one string row, date column with mixed formats, boolean column with `yes`/`no`/`1`/`0` mixed |
| **Locale** | European decimal (`1.234,56`), American decimal (`1,234.56`), French dates (`13/01/2026`), ISO dates (`2026-01-13`) |
| **Whitespace** | Trailing spaces, only-whitespace cells, tab in cell value |
| **Sparse** | Mostly-empty grid, single non-empty cell in a sea of empties |
| **Wide** | 100+ columns, 1 row vs 1 column, 1000 rows |
| **Numeric edges** | Scientific notation, leading zeros, `∞`, `NaN`, very large numbers, negative zero |
| **Unicode** | RTL (Arabic / Hebrew), zero-width joiners, emoji, combining characters in headers |
| **Structural** | Ragged rows (different column counts per row), only-header, trailing newlines |
| **Size** | Empty body, single byte, exactly 4 MiB, just over 4 MiB |

## Output format

For each test case, produce a block like:

````
### Case N: <one-line description>

```csv
<raw CSV>
```

**Expected:** rows=X, columns=Y, score≈Z, type_mismatches=W, empty_pct≈V

```sh
printf '<CSV content properly shell-escaped>' | curl -sX POST http://localhost:8088/api/demo/parse --data-binary @-
```
````

## Notes for your generation

- The parser is in Rust (Polars-based). Common failure modes: panics on truly weird Unicode, OOM on pathological repetition, infinite loops on certain malformed quote sequences, silent data loss on non-UTF-8 encodings.
- We **want** failures. A test that returns 200 with score=100 is a wasted slot. Aim for cases that produce low scores, high `type_mismatches`, surprising `rows`/`columns` counts, or 5xx errors.
- Don't bother with "valid CSV" cases — we already test those. Focus on the boundary between "parses fine but with surprising semantics" and "should fail cleanly".

## Once you generate

Em pipes each curl into the endpoint and compares actual vs predicted. Discrepancies are codec / parser bugs we file.
