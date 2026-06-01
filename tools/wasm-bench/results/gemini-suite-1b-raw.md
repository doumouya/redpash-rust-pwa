# Gemini adversarial CSV suite #1B — actual vs predicted
Run: 2026-06-01T02:09:02Z
Endpoint: http://localhost:8088/api/demo/parse

## Case 1: UTF-8 BOM + commas inside quotes + unclosed-quote mid-file
- **predicted**: rows≈4 cols=3 score≈40
- **http**: 200
- **body**: `{"rows":3,"columns":3,"score":100.0,"type_mismatches":0,"empty_pct":0.0,"parse_ms":38}`

## Case 2: UTF-16LE BOM (literal bytes ÿþ, not real UTF-16)
- **predicted**: rows≈1 mojibake OR 500
- **http**: 200
- **body**: `{"rows":2,"columns":2,"score":100.0,"type_mismatches":0,"empty_pct":0.0,"parse_ms":6}`

## Case 3: Windows-1252 smart quotes + € + ™
- **predicted**: rows≈4 cols=3 score≈30
- **http**: 200
- **body**: `{"rows":4,"columns":3,"score":100.0,"type_mismatches":0,"empty_pct":0.0,"parse_ms":1}`

## Case 4: Mixed LF/CRLF line endings (different from Suite #1)
- **predicted**: rows≈4 cols=3 score≈60
- **http**: 200
- **body**: `{"rows":4,"columns":3,"score":100.0,"type_mismatches":0,"empty_pct":0.0,"parse_ms":1}`

## Case 5: Unclosed quote + nested unescaped quotes
- **predicted**: rows≈4 cols≈3-4 ragged
- **http**: 200
- **body**: `{"rows":2,"columns":3,"score":100.0,"type_mismatches":0,"empty_pct":0.0,"parse_ms":1}`

## Case 6: Three delimiters in one file (; | ,)
- **predicted**: rows=4 score≈35
- **http**: 200
- **body**: `{"rows":4,"columns":2,"score":95.625,"type_mismatches":0,"empty_pct":12.5,"parse_ms":1}`

## Case 7: No header + ragged rows + trailing delimiter
- **predicted**: rows=4 cols≈5
- **http**: 200
- **body**: `{"rows":3,"columns":4,"score":82.5,"type_mismatches":0,"empty_pct":50.0,"parse_ms":3}`

## Case 8: Duplicate id headers + 2 empty header positions
- **predicted**: rows=3 cols=5 score≈45
- **http**: 200
- **body**: `{"rows":3,"columns":5,"score":86.0,"type_mismatches":0,"empty_pct":40.0,"parse_ms":2}`

## Case 9: Numeric column with one string outlier
- **predicted**: rows=5 type_mismatches=1 score≈70
- **http**: 200
- **body**: `{"rows":5,"columns":2,"score":97.5,"type_mismatches":1,"empty_pct":0.0,"parse_ms":1}`

## Case 10: Date column with 5 different date formats
- **predicted**: rows=5 type_mismatches=1 score≈60
- **http**: 200
- **body**: `{"rows":5,"columns":2,"score":90.0,"type_mismatches":1,"empty_pct":0.0,"parse_ms":1}`

## Case 11: Boolean column with 8 different conventions
- **predicted**: rows=8 type_mismatches=1 score≈65
- **http**: 200
- **body**: `{"rows":8,"columns":2,"score":90.625,"type_mismatches":1,"empty_pct":0.0,"parse_ms":1}`

## Case 12: Mixed EU/US decimal in same column
- **predicted**: rows=6 type_mismatches=1 score≈50
- **http**: 200
- **body**: `{"rows":5,"columns":3,"score":89.66666412353516,"type_mismatches":1,"empty_pct":20.0,"parse_ms":7}`

## Case 13: Whitespace-only + tab in quoted cell + padded cells
- **predicted**: rows=4 cols=3 score≈55
- **http**: 200
- **body**: `{"rows":4,"columns":3,"score":90.0,"type_mismatches":0,"empty_pct":0.0,"parse_ms":1}`

## Case 14: 5x6 grid with single value at [2][2]
- **predicted**: rows=5 cols≈5 empty_pct≈96
- **http**: 200
- **body**: `{"rows":4,"columns":6,"score":58.958335876464844,"type_mismatches":0,"empty_pct":95.83333333333334,"parse_ms":1}`

## Case 15: 100-column header + 100-column data row
- **predicted**: rows=1 cols=100 score≈80
- **http**: 200
- **body**: `{"rows":1,"columns":100,"score":100.0,"type_mismatches":0,"empty_pct":0.0,"parse_ms":15}`

## Case 16: 0, -0, NaN, ±Infinity, 1e309 (overflow), excess-precision pi
- **predicted**: rows=8 score≈55
- **http**: 200
- **body**: `{"rows":8,"columns":2,"score":96.875,"type_mismatches":0,"empty_pct":0.0,"parse_ms":1}`

## Case 17: Emoji + RTL + ZWJ + combining chars in HEADER NAMES
- **predicted**: rows=3 cols=4 score≈60
- **http**: 200
- **body**: `{"rows":3,"columns":4,"score":100.0,"type_mismatches":0,"empty_pct":0.0,"parse_ms":1}`

## Case 18: Only header + 4 trailing blank lines
- **predicted**: rows≈0-4 cols=3 empty_pct=high
- **http**: 200
- **body**: `{"rows":4,"columns":3,"score":53.75,"type_mismatches":0,"empty_pct":100.0,"parse_ms":0}`

## Case 19: Empty body
- **predicted**: HTTP 400
- **http**: 400
- **body**: `{"error":"no CSV content","kind":"empty"}`

## Case 20: Just over 4 MiB body
- **predicted**: HTTP 413
- **http**: 413
- **body**: `Failed to buffer the request body: length limit exceeded`

