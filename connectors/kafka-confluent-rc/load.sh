#!/usr/bin/env bash
# Purpose: run the Kafka LOADER (the Rust binary, the L of ETL) once against the
#   Confluent cluster, capturing all output to results/. This is NOT the Node
#   spike (spike.mjs) — it's `redpash-api` in REDPASH_KAFKA_LOAD mode:
#   rskafka consume -> avro decode -> a project_files row.
# Doc: docs/internal/code/backend/api/kafka_loader.md
#
# Usage:   bash connectors/kafka-confluent-rc/load.sh [PRJ_target] [max_records]
#   PRJ_target  : project to load into (default: first Workspace project)
#   max_records : cap (default 200)
#
# Reads Kafka creds + topic from this dir's .env, and DATABASE_URL from
# backend/.env. Output is teed to results/load-<UTC>.log and the path printed.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"          # connectors/kafka-confluent-rc
ROOT="$(cd "$HERE/../.." && pwd)"              # repo root
BIN="$ROOT/backend/target/debug/redpash-api"

[ -x "$BIN" ] || { echo "✗ loader binary not built: $BIN
  build it:  (cd \"$ROOT/backend\" && cargo build -p api)"; exit 1; }
[ -f "$HERE/.env" ]          || { echo "✗ missing $HERE/.env (Kafka creds + KAFKA_TOPIC)"; exit 1; }
[ -f "$ROOT/backend/.env" ]  || { echo "✗ missing $ROOT/backend/.env (DATABASE_URL)"; exit 1; }

# Pull KAFKA_* (creds, bootstrap, topic) + DATABASE_URL into the environment.
set -a
# shellcheck disable=SC1090
. "$HERE/.env"
. "$ROOT/backend/.env"
set +a

export REDPASH_KAFKA_LOAD=1
export REDPASH_DATA_DIR="$ROOT/backend/data"
export KAFKA_CONTRACT="$HERE/contracts/topic_account_jlr-value-v2.json"
export KAFKA_WIRE_FORMAT="${KAFKA_WIRE_FORMAT:-raw}"      # this producer emits bare Avro
export KAFKA_TARGET_PROJECT="${1:-${KAFKA_TARGET_PROJECT:-PRJ_D32D474BB899488B84CBB1F49A418F17}}"
export KAFKA_MAX_RECORDS="${2:-${KAFKA_MAX_RECORDS:-200}}"

mkdir -p "$HERE/results"
LOG="$HERE/results/load-$(date -u +%Y%m%dT%H%M%SZ).log"

echo "── Kafka loader (Rust) ──"
echo "  topic    : ${KAFKA_TOPIC:-<unset!>}"
echo "  contract : $KAFKA_CONTRACT"
echo "  wire     : $KAFKA_WIRE_FORMAT"
echo "  project  : $KAFKA_TARGET_PROJECT"
echo "  max      : $KAFKA_MAX_RECORDS"
echo "  log      : $LOG"
echo "─────────────────────────"

# Run; capture stdout+stderr to the log AND the terminal.
"$BIN" 2>&1 | tee "$LOG"

echo
echo "── done. full output saved to: $LOG"
