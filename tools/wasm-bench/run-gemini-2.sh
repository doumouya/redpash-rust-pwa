#!/usr/bin/env bash
# Run Gemini's adversarial Avro decode suite #2 (CAS_91A65088) against
# /api/demo/avro-decode. Output: structured markdown to stdout.
#
# SKELETON STATUS: built ahead of Gemini's case delivery (Em greenlit
# parallel build). When Gemini returns 20 cases, replace the
# placeholder `cases()` block below with the actual schema + bytes_b64
# + wire_format per case.
#
# Prompt: tools/wasm-bench/gemini-prompt-codec.md
# Endpoint contract (BE-built per CAS_91A65088):
#   POST /api/demo/avro-decode
#   Body JSON: {schema, wire_format, bytes_base64}
#   Returns: {decoded, decode_ms, byte_count} or 4xx/422

URL="${URL:-http://localhost:8088/api/demo/avro-decode}"

# Send one case to the endpoint. Args: n desc schema wire bytes_b64 pred
run_case() {
    local n="$1" desc="$2" schema="$3" wire="$4" bytes_b64="$5" pred="$6"
    local body http tmp
    tmp=$(mktemp)
    http=$(curl -s -o "$tmp" -w '%{http_code}' \
        -X POST "$URL" \
        -H 'Content-Type: application/json' \
        --data-binary "$(jq -cn --arg s "$schema" --arg w "$wire" --arg b "$bytes_b64" \
            '{schema:$s, wire_format:$w, bytes_base64:$b}')")
    body=$(cat "$tmp")
    rm -f "$tmp"
    echo "## Case $n: $desc"
    echo "- **predicted**: $pred"
    echo "- **wire**: $wire"
    echo "- **http**: $http"
    echo "- **body**: \`${body:0:300}${body:300:+...}\`"
    echo
}

echo "# Gemini adversarial Avro suite #2 — actual vs predicted"
echo "Run: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "Endpoint: $URL"
echo

# ── Sanity check ──────────────────────────────────────────────────
# A known-good case using the JLR Account v2 schema + a tiny known payload.
# If this returns non-200, the endpoint isn't live yet (BE hasn't shipped
# /api/demo/avro-decode) and the suite below would all fail uniformly.
SCHEMA_JLR=$(jq -r '.schema' connectors/kafka-confluent-rc/contracts/topic_account_jlr-value-v2.json 2>/dev/null)
if [ -z "$SCHEMA_JLR" ]; then
    echo "⚠ JLR contract not found at connectors/kafka-confluent-rc/contracts/topic_account_jlr-value-v2.json"
    echo "  Run \`node connectors/kafka-confluent-rc/spike.mjs bootstrap-contracts\` first."
    exit 1
fi

# A minimal avro-encoded JLR Account record's first 8 bytes worth (just
# the varint length-prefix for accountId="x") as a smoke ping — not a
# valid full record, but exercises the decode error path cleanly.
SMOKE_BYTES_B64=$(printf '\x02x' | base64 -w0)
run_case "smoke" "endpoint reachable (intentionally truncated bytes)" \
    "$SCHEMA_JLR" "raw" "$SMOKE_BYTES_B64" \
    "either 422 decode_failure (good — endpoint reachable + decoder rejects truncated bytes) or 4xx (endpoint live but rejects shape) or curl-level error (endpoint NOT live)"

echo
echo "──"
echo "## Suite #2 placeholder — Gemini cases swap in here"
echo "──"
echo
echo "Once Gemini returns the 20 adversarial cases per gemini-prompt-codec.md,"
echo "append \`run_case N \"desc\" \"\$schema\" \"raw|confluent\" \"\$bytes_b64\" \"predicted\"\`"
echo "for each case below this line. The runner shape stays identical to"
echo "Suite #1's run-gemini-1.sh; only the payload+predicted strings change."
echo
echo "Categories to land (per the prompt):"
echo "  1-3   Avro logical types (timestamp-millis / date / decimal / uuid / duration / time-millis)"
echo "  4-6   Union variants (null/string, deeply nested, records)"
echo "  7-8   Enum edge cases (out-of-range index, empty symbols)"
echo "  9-10  Recursive records (tree, mutual, infinite-depth)"
echo "  11-12 Truncated + oversized payloads"
echo "  13-14 Wire-format mismatches (Confluent prefix with raw flag, vice versa)"
echo "  15-16 Schema malformations (invalid JSON, invalid Avro types)"
echo "  17-18 Numeric edges (NaN/Inf for double, i64 limits)"
echo "  19    String + bytes/fixed edges"
echo "  20    Map/Array edges (empty, nested, duplicate keys)"
