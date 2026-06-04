#!/usr/bin/env bash
# Purpose: run the Kafka LOADER (the Rust binary, the L of ETL) once against the
#   Confluent cluster, capturing all output to results/. This is NOT the Node
#   spike (spike.mjs) — it's `redpash-api` in REDPASH_KAFKA_LOAD mode:
#   rskafka consume -> avro decode -> a project_files row.
# Doc: docs/internal/code/backend/api/kafka_loader.md
#
# Usage (preferred):  bash connectors/kafka-confluent-rc/load.sh <CON_connection> [max_records]
#   CON_connection : a persisted connection (created in the UI — the user picked
#                    the destination project). The loader reads project + as-user
#                    + topic from it (CAS via the connectors entity). This is the
#                    "ask the user which project" path — no hardcoded destination.
#
# Usage (legacy/ops): bash connectors/kafka-confluent-rc/load.sh <PRJ_target> <USR_as_user> [max_records]
#   PRJ_target  : project to load into (REQUIRED — no default; the loader routes
#                 through the framework upload pipeline, which RBAC-checks the
#                 as-user's write-reach. A silent default could land data in a
#                 project nobody owns — that was the bug. CAS_A4448B94.)
#   USR_as_user : user the load is attributed to + RBAC-checked (REQUIRED).
#   max_records : cap (default 200)
# In legacy mode either of PRJ_target / USR_as_user may come from this dir's .env
# (KAFKA_TARGET_PROJECT / KAFKA_AS_USER); args win. Missing → the script aborts.
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
# KAFKA_CONTRACT only locates the contracts DIR (its parent) + the subject; the
# loader resolves the schema PER RECORD by the version in the Kafka header.
export KAFKA_CONTRACT="$HERE/contracts/topic_account_jlr-value-v2.json"
export KAFKA_WIRE_FORMAT="${KAFKA_WIRE_FORMAT:-raw}"      # this producer emits bare Avro
# Optional explicit version-header key; empty → auto-detect a "version" header.
export KAFKA_VERSION_HEADER="${KAFKA_VERSION_HEADER:-}"

# CONNECTION mode — `load.sh <CON_…>` reads the destination (project + as-user +
# topic) from the persisted connection the user created in the UI (Em: "ask the
# user which project he wants to add the file"). No PRJ/USR args. The LEGACY mode
# (`load.sh <PRJ_…> <USR_…>`) still works for ops/scripting. Either way the
# framework pipeline RBAC-checks the resolved as-user's write-reach — no silent
# default could land data where the operator has no business writing.
if [[ "${1:-}" == CON_* ]]; then
  export REDPASH_KAFKA_CONNECTION="$1"
  export KAFKA_MAX_RECORDS="${2:-${KAFKA_MAX_RECORDS:-200}}"
else
  export KAFKA_TARGET_PROJECT="${1:-${KAFKA_TARGET_PROJECT:-}}"
  export KAFKA_AS_USER="${2:-${KAFKA_AS_USER:-}}"
  export KAFKA_MAX_RECORDS="${3:-${KAFKA_MAX_RECORDS:-200}}"
  [ -n "$KAFKA_TARGET_PROJECT" ] || { echo "✗ no target. Pass a connection (load.sh <CON_…>) OR <PRJ_…> <USR_…> [max]  (or set KAFKA_TARGET_PROJECT in .env)"; exit 1; }
  [ -n "$KAFKA_AS_USER" ]        || { echo "✗ no as-user. Pass <PRJ_…> <USR_…>  (or set KAFKA_AS_USER in .env). The load is RBAC-checked as this user."; exit 1; }
fi

mkdir -p "$HERE/results"
LOG="$HERE/results/load-$(date -u +%Y%m%dT%H%M%SZ).log"

echo "── Kafka loader (Rust) ──"
if [ -n "${REDPASH_KAFKA_CONNECTION:-}" ]; then
  echo "  connection: $REDPASH_KAFKA_CONNECTION  (project · as-user · topic resolved from the DB)"
else
  echo "  topic    : ${KAFKA_TOPIC:-<unset!>}"
  echo "  project  : $KAFKA_TARGET_PROJECT"
  echo "  as-user  : $KAFKA_AS_USER"
fi
echo "  contract : $KAFKA_CONTRACT"
echo "  wire     : $KAFKA_WIRE_FORMAT"
echo "  max      : $KAFKA_MAX_RECORDS"
echo "  ver-hdr  : ${KAFKA_VERSION_HEADER:-<auto-detect>}"
echo "  log      : $LOG"
echo "─────────────────────────"

# Run; capture stdout+stderr to the log AND the terminal.
"$BIN" 2>&1 | tee "$LOG"

echo
echo "── done. full output saved to: $LOG"
