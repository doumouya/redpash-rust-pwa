#!/usr/bin/env sh
# ─────────────────────────────────────────────────────────────────────────────
# RedPash audit suite — every tools/*-audit/audit.js + ingest where wired.
#
# Each tools/<x>-audit/audit.js scans one slice of the codebase and writes an
# audit.html report next to itself. This runner discovers them by glob, so a
# new audit folder is picked up automatically the day it's added — no edit
# here.
#
#   css-audit       CSS conflicts / duplication
#   html-audit      HTML structure / duplication
#   js-audit        frontend JS — LOC, unreachable modules, duplicate symbols
#   rs-audit        backend Rust — LOC, repeated lines, big match blocks
#   crossing-audit  the JS <-> Rust /api seam — crossings / dangling / unused
#
# Tracked history: tools that also emit audit.json (today: css + html) are
# additionally ingested via redpash-audit-ingest, landing one audit.run row
# + one audit.finding row per finding and printing a "since last run" diff
# summary inline. The schema's tool CHECK matches that list — adding js /
# rs / crossing means relaxing the CHECK and teaching the binary to explode
# their payload shapes.
#
# Usage:  sh tools/audit.sh
# Run from the repo root (the ingest binary's .env lookup wants it).
# ─────────────────────────────────────────────────────────────────────────────
set -e

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

# Pre-build the ingest binary once so the per-tool loop runs native, not
# through cargo (matters when iterating).
cargo build --quiet --manifest-path backend/crates/api/Cargo.toml \
            --bin redpash-audit-ingest
INGEST="$REPO_ROOT/backend/target/debug/redpash-audit-ingest"

# Tools whose audit.run CHECK constraint allows ingest. Keep in sync with
# the migration; broaden when js / rs / crossing audits learn to emit
# audit.json + the ingest binary learns their explode shape.
INGEST_TOOLS=" css html "

fail=0
for dir in tools/*-audit/; do
  audit="$dir/audit.js"
  [ -f "$audit" ] || continue
  tool="$(basename "$dir" -audit)"
  echo "════════════════════════  $tool  ════════════════════════"

  if ! node "$audit"; then
    echo "  !! $tool audit failed"
    fail=1
    continue
  fi
  echo

  # Ingest only for tools the schema supports; the audit.js itself decides
  # whether it emits an audit.json — if it doesn't, there's nothing to ingest.
  case "$INGEST_TOOLS" in
    *" $tool "*)
      if [ ! -f "$dir/audit.json" ]; then
        echo "  (no audit.json emitted; skipping ingest)"
        echo
        continue
      fi
      if ! "$INGEST" --tool "$tool"; then
        echo "  !! $tool ingest failed"
        fail=1
        continue
      fi
      echo
      ;;
  esac
done

echo "════════════════════════  reports  ════════════════════════"
for dir in tools/*-audit/; do
  [ -f "$dir/audit.html" ]  && echo "  $dir""audit.html"
  [ -f "$dir/report.html" ] && echo "  $dir""report.html"
done

echo
if [ "$fail" -eq 0 ]; then
  echo "all audits ran."
else
  echo "some audits failed — see above."
fi
exit $fail
