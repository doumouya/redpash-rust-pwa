#!/usr/bin/env bash
# Copilot adversarial CSV stress suite #1 (2026-06-01) — DIFFERENT goal
# from Suite #1 / #1B: **the target is 500s, panics, infinite loops,
# OOM-adjacent behavior**. Copilot designed these to break the parser,
# not to find divergences.
#
# Cases 1-6 from Em's paste; Case 7 truncated (ZWJ wall — using a
# minimal 1000-char version since full version cut off mid-paste).
# Cases 8-12 missing from paste.
#
# Suite goal: any 500 / panic / hang = a real finding. Any clean parse
# of pathological input = surprisingly robust + still worth flagging
# for score-honesty (silent corruption of garbage = bad UX).

URL="${URL:-http://localhost:8088/api/demo/parse}"

run() {
    local n="$1" desc="$2" weakness="$3"
    local body http tmp
    tmp=$(mktemp)
    # Cap each test at 30s to prevent the runner hanging if the parser
    # infinite-loops. If a case hits the timeout, we KNOW it's a hang.
    http=$(timeout 30 curl -s -o "$tmp" -w '%{http_code}' -X POST "$URL" --data-binary @-)
    body=$(cat "$tmp")
    rm -f "$tmp"
    echo "## Case $n: $desc"
    echo "- **expected weakness**: $weakness"
    echo "- **http**: ${http:-TIMEOUT-30s}"
    echo "- **body**: \`${body:0:400}${body:400:+...}\`"
    echo
}

echo "# Copilot CSV stress suite #1 — looking for 500s/panics/hangs"
echo "Run: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "Endpoint: $URL"
echo

# Case 1: UTF-16LE with mid-stream surrogate break
printf '\xFF\xFEi\x00d\x00,\x00v\x00a\x00l\x00u\x00e\x00\n\xD8\x00\x00\x00' | run 1 "UTF-16LE BOM + invalid surrogate halves" "Arrow decode panic on invalid surrogate"

# Case 2: UTF-8 with embedded illegal byte sequences
printf 'id,value\n1,\xFF\n2,\xC0\xAF\n3,\xF5\xFF\xFF\n' | run 2 "UTF-8 with forbidden byte sequences (overlong + 0xF5+)" "Panic on overlong UTF-8 encoding"

# Case 3: Infinite-quote-state trap
printf 'id,value\n1,"start "nested ""quote"" CR\r still open\n2,hello\n' | run 3 "Unclosed quote + nested + CR mix" "State-machine infinite loop"

# Case 4: 200k-character unclosed quote (OOM/stack overflow bait)
{ printf '"'; yes '.' | head -c 200000 | tr -d '\n'; } | run 4 "200k-character unclosed quote" "OOM or stack overflow on buffer growth"

# Case 5: Extreme ragged rows
printf 'a,b,c\n1,2\n1,2,3,4,5,6,7,8,9\n,,,\n' | run 5 "Extreme column-count variance per row" "Arrow assertion panic on column mismatch"

# Case 6: NUL bytes inside delimiters
printf 'id;name\x00age,city\n1;Alice\x00Bob,London\n' | run 6 "NUL bytes inside cell values + mixed delimiters" "SIMD fast-path panic on NUL"

# Case 7: ZWJ wall (truncated from Em's paste — using 1000 ZWJ chars
# instead of the full ~3000+ wall that got cut off mid-paste)
header='id,na‍me,ar‏abic'
zwj_block=$(python3 -c "print('1,A' + '‍' * 1000)")
printf '%s\n%s\n' "$header" "$zwj_block" | run 7 "ZWJ wall (1000 ZWJ chars in single cell — truncated from Em's full paste)" "Memory pressure / parsing pathology on long ZWJ sequence"

# Cases 8-12 missing from Em's paste — re-ask if Copilot generated more.

echo "──"
echo "## Note: paste truncation"
echo "──"
echo "Em's paste was cut off mid-Case-7 (ZWJ wall). Cases 8-12 (if Copilot generated them) are not in this run."
echo "If Copilot returned more cases, re-paste them and we extend the runner."
