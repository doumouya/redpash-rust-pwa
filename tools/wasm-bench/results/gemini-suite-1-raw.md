# Gemini adversarial suite #1 — actual vs predicted
Run: 2026-06-01T01:12:27Z

## Case 1: Mixed line endings (CR + LF + CRLF)
- **predicted**: rows=3 score≈80
- **http**: 200
- **body**: `{"rows":0,"columns":3,"score":0.0,"type_mismatches":0,"empty_pct":0.0,"parse_ms":0}`

## Case 2: Unclosed multi-line quote
- **predicted**: rows=1 cols=2 score≈50
- **http**: 200
- **body**: `{"rows":1,"columns":2,"score":100.0,"type_mismatches":0,"empty_pct":0.0,"parse_ms":1}`

## Case 3: Ragged rows
- **predicted**: rows=2 (cols=3 or 7)
- **http**: 200
- **body**: `{"rows":2,"columns":3,"score":94.16667175292969,"type_mismatches":0,"empty_pct":16.666666666666664,"parse_ms":1}`

## Case 4: Type drift: N/A in numerics
- **predicted**: rows=3 type_mismatches=1
- **http**: 200
- **body**: `{"rows":3,"columns":2,"score":87.5,"type_mismatches":1,"empty_pct":0.0,"parse_ms":1}`

## Case 5: Locale delimiter trap
- **predicted**: rows=2 type_mismatches=1
- **http**: 200
- **body**: `{"rows":2,"columns":1,"score":100.0,"type_mismatches":0,"empty_pct":0.0,"parse_ms":0}`

## Case 6: Duplicate + empty headers
- **predicted**: rows=1 cols=3 score≈70
- **http**: 200
- **body**: `{"rows":1,"columns":3,"score":100.0,"type_mismatches":0,"empty_pct":0.0,"parse_ms":1}`

## Case 7: Null byte injection
- **predicted**: rows=1 cols=2
- **http**: 200
- **body**: `{"rows":1,"columns":2,"score":100.0,"type_mismatches":0,"empty_pct":0.0,"parse_ms":1}`

## Case 8: UTF-8 BOM + ZWJ + emoji + Arabic
- **predicted**: rows=2 score≈100
- **http**: 200
- **body**: `{"rows":2,"columns":2,"score":100.0,"type_mismatches":0,"empty_pct":0.0,"parse_ms":1}`

## Case 9: Ghost grid (extremely sparse)
- **predicted**: rows=3 empty_pct≈93
- **http**: 200
- **body**: `{"rows":3,"columns":5,"score":37.333335876464844,"type_mismatches":0,"empty_pct":93.33333333333333,"parse_ms":0}`

## Case 10: Numeric edges: NaN/Inf/scientific
- **predicted**: rows=4 score≈95
- **http**: 200
- **body**: `{"rows":4,"columns":1,"score":93.75,"type_mismatches":0,"empty_pct":0.0,"parse_ms":0}`

## Case 11: Missing EOF quote
- **predicted**: 500 parse failure
- **http**: 200
- **body**: `{"rows":1,"columns":1,"score":100.0,"type_mismatches":0,"empty_pct":0.0,"parse_ms":0}`

## Case 12: Invalid UTF-8 (Latin-1)
- **predicted**: 500 parse failure
- **http**: 200
- **body**: `{"rows":1,"columns":1,"score":100.0,"type_mismatches":0,"empty_pct":0.0,"parse_ms":0}`

## Case 13: Quote soup (RFC-4180 escapes)
- **predicted**: rows=1 cols=2
- **http**: 200
- **body**: `{"rows":1,"columns":2,"score":100.0,"type_mismatches":0,"empty_pct":0.0,"parse_ms":0}`

## Case 14: Boolean drift
- **predicted**: rows=4 type_mismatches=1
- **http**: 200
- **body**: `{"rows":4,"columns":1,"score":87.5,"type_mismatches":1,"empty_pct":0.0,"parse_ms":0}`

## Case 15: Extreme whitespace
- **predicted**: rows=1 cols=2 score≈70
- **http**: 200
- **body**: `{"rows":0,"columns":3,"score":0.0,"type_mismatches":0,"empty_pct":0.0,"parse_ms":0}`

## Case 16: Single delimiter byte
- **predicted**: rows=0|1 cols=2
- **http**: 200
- **body**: `{"rows":0,"columns":2,"score":0.0,"type_mismatches":0,"empty_pct":0.0,"parse_ms":0}`

## Case 17: Empty body
- **predicted**: 400 bad request
- **http**: 400
- **body**: `{"error":"no CSV content","kind":"empty"}`

## Case 18: All numeric headers
- **predicted**: rows=1 cols=3
- **http**: 200
- **body**: `{"rows":1,"columns":3,"score":100.0,"type_mismatches":0,"empty_pct":0.0,"parse_ms":0}`

## Case 19: Pure empty grid
- **predicted**: rows=2 cols=3 empty_pct=100
- **http**: 200
- **body**: `{"rows":2,"columns":3,"score":57.5,"type_mismatches":0,"empty_pct":100.0,"parse_ms":0}`

## Case 20: Large payload (3 MB, under 4 MiB cap)
- **predicted**: should succeed (Gemini predicted 413 incorrectly)
- **http**: 200
- **body**: `{"rows":299999,"columns":5,"score":85.00005340576172,"type_mismatches":0,"empty_pct":0.0,"parse_ms":94}`

