#!/usr/bin/env bash
# Run Gemini's adversarial CSV suite #1 (2026-06-01) against /api/demo/parse.
# Output: a structured markdown summary on stdout.
#
# Each case: send payload, capture HTTP code + body. Predictions from
# the Gemini-paste-ready prompt at tools/wasm-bench/gemini-prompt.md.

URL="${URL:-http://localhost:8088/api/demo/parse}"

run() {
    local n="$1" desc="$2" pred="$3"
    # Payload comes via stdin from the wrapper function.
    local body http
    local tmp
    tmp=$(mktemp)
    http=$(curl -s -o "$tmp" -w '%{http_code}' -X POST "$URL" --data-binary @-)
    body=$(cat "$tmp")
    rm -f "$tmp"
    echo "## Case $n: $desc"
    echo "- **predicted**: $pred"
    echo "- **http**: $http"
    echo "- **body**: \`$body\`"
    echo
}

echo "# Gemini adversarial suite #1 — actual vs predicted"
echo "Run: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo

printf 'id,val\r\n1,A\n2,B\r3,C' | run 1 "Mixed line endings (CR + LF + CRLF)" "rows=3 score≈80"
printf 'id,name\n1,"Alice\n2,Bob' | run 2 "Unclosed multi-line quote" "rows=1 cols=2 score≈50"
printf 'colA,colB,colC\n1,2\n3,4,5,6,7' | run 3 "Ragged rows" "rows=2 (cols=3 or 7)"
printf 'id,score\n1,10.5\n2,N/A\n3,20.0' | run 4 "Type drift: N/A in numerics" "rows=3 type_mismatches=1"
printf 'price;qty\n1.234,56;10\n1,234.56;20' | run 5 "Locale delimiter trap" "rows=2 type_mismatches=1"
printf 'col,,col\n1,2,3' | run 6 "Duplicate + empty headers" "rows=1 cols=3 score≈70"
printf 'col1,col2\nvalid,in\0valid' | run 7 "Null byte injection" "rows=1 cols=2"
printf '\xef\xbb\xbfid,name\n1,\xf0\x9f\x91\xa9\xe2\x80\x8d\xf0\x9f\x9a\x80\n2,\xd9\x85\xd8\xb1\xd8\xad\xd8\xa8\xd8\xa7' | run 8 "UTF-8 BOM + ZWJ + emoji + Arabic" "rows=2 score≈100"
printf 'a,b,c,d,e\n,,,,\n,,X,,,,,,\n,,,,' | run 9 "Ghost grid (extremely sparse)" "rows=3 empty_pct≈93"
printf 'val\n1e10\nNaN\n-Inf\n-0' | run 10 "Numeric edges: NaN/Inf/scientific" "rows=4 score≈95"
printf 'col1\n"unterminated' | run 11 "Missing EOF quote" "500 parse failure"
printf 'col1\ncaf\xe9' | run 12 "Invalid UTF-8 (Latin-1)" "500 parse failure"
printf 'col1,col2\n"""",""""""' | run 13 "Quote soup (RFC-4180 escapes)" "rows=1 cols=2"
printf 'is_active\ntrue\nyes\n1\nFalse' | run 14 "Boolean drift" "rows=4 type_mismatches=1"
printf '  id  , name \n\t1\t, Alice  ' | run 15 "Extreme whitespace" "rows=1 cols=2 score≈70"
printf ',' | run 16 "Single delimiter byte" "rows=0|1 cols=2"
printf '' | run 17 "Empty body" "400 bad request"
printf '1,2,3\n4,5,6' | run 18 "All numeric headers" "rows=1 cols=3"
printf ',,\n,,\n,,' | run 19 "Pure empty grid" "rows=2 cols=3 empty_pct=100"
yes "1,2,3,4,5" | head -n 300000 | run 20 "Large payload (3 MB, under 4 MiB cap)" "should succeed (Gemini predicted 413 incorrectly)"
