# Copilot CSV stress suite #1 — looking for 500s/panics/hangs
Run: 2026-06-01T02:15:22Z
Endpoint: http://localhost:8088/api/demo/parse

## Case 1: UTF-16LE BOM + invalid surrogate halves
- **expected weakness**: Arrow decode panic on invalid surrogate
- **http**: 200
- **body**: `{"rows":0,"columns":2,"score":0.0,"type_mismatches":0,"empty_pct":0.0,"parse_ms":4}`

## Case 2: UTF-8 with forbidden byte sequences (overlong + 0xF5+)
- **expected weakness**: Panic on overlong UTF-8 encoding
- **http**: 200
- **body**: `{"rows":3,"columns":2,"score":100.0,"type_mismatches":0,"empty_pct":0.0,"parse_ms":5}`

## Case 3: Unclosed quote + nested + CR mix
- **expected weakness**: State-machine infinite loop
- **http**: 200
- **body**: `{"rows":2,"columns":2,"score":100.0,"type_mismatches":0,"empty_pct":0.0,"parse_ms":1}`

## Case 4: 200k-character unclosed quote
- **expected weakness**: OOM or stack overflow on buffer growth
- **http**: 200
- **body**: `{"rows":0,"columns":1,"score":0.0,"type_mismatches":0,"empty_pct":0.0,"parse_ms":6}`

## Case 5: Extreme column-count variance per row
- **expected weakness**: Arrow assertion panic on column mismatch
- **http**: 200
- **body**: `{"rows":3,"columns":3,"score":84.44444274902344,"type_mismatches":0,"empty_pct":44.44444444444444,"parse_ms":1}`

## Case 6: NUL bytes inside cell values + mixed delimiters
- **expected weakness**: SIMD fast-path panic on NUL
- **http**: 200
- **body**: `{"rows":1,"columns":2,"score":100.0,"type_mismatches":0,"empty_pct":0.0,"parse_ms":0}`

## Case 7: ZWJ wall (1000 ZWJ chars in single cell — truncated from Em's full paste)
- **expected weakness**: Memory pressure / parsing pathology on long ZWJ sequence
- **http**: 200
- **body**: `{"rows":1,"columns":3,"score":88.33332824707031,"type_mismatches":0,"empty_pct":33.33333333333333,"parse_ms":2}`

──
## Note: paste truncation
──
Em's paste was cut off mid-Case-7 (ZWJ wall). Cases 8-12 (if Copilot generated them) are not in this run.
If Copilot returned more cases, re-paste them and we extend the runner.
