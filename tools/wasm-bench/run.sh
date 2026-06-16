#!/usr/bin/env sh
# Orchestrate the wasm-vs-native perf sweep. For each size: generate the corpus,
# bench-wasm in a FRESH node child (honest per-size wasm-memory peak — wasm
# linear memory only grows within a process), then bench-native, appending one
# JSONL line each. Then aggregate into results/results-<shape>.{json,md}.
#
#   SIZES="1000 10000 100000" SHAPE=wide sh tools/wasm-bench/run.sh
set -eu
cd "$(dirname "$0")"
ROOT=../..
SHAPE="${SHAPE:-wide}"
SIZES="${SIZES:-1000 10000 50000 100000 250000 500000}"
NATIVE="$ROOT/backend/target/release/bench_native"
mkdir -p corpus results
RAW="results/raw-$SHAPE.jsonl"
: > "$RAW"

ls "$ROOT"/frontend/wasm/data_bg.*.wasm >/dev/null 2>&1 \
  || { echo "build the wasm engine first:  sh tools/build-wasm.sh"; exit 1; }
[ -x "$NATIVE" ] \
  || { echo "build the native bench first:  cargo build -p api --release --bin bench_native"; exit 1; }

for n in $SIZES; do
  csv="corpus/$SHAPE-$n.csv"
  echo "== size $n ($SHAPE) =="
  python3 generate.py --rows "$n" --shape "$SHAPE" --out "$csv"
  node bench-wasm.mjs "$csv" "$n" Oz >> "$RAW"   # fresh process per size
  "$NATIVE" "$csv" "$n" >> "$RAW"
done

node aggregate.mjs "$RAW" "$SHAPE"
echo "-> results/results-$SHAPE.md  +  results/results-$SHAPE.json"
