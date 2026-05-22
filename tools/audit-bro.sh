#!/usr/bin/env sh
# ─────────────────────────────────────────────────────────────────────────────
# RedPash audit-bro suite — every tools/*-audit/audit-bro.js + ingest.
#
# The bro counterpart of audit.sh. Where audit.sh runs audit.js (writes
# report.html and exits), this one runs audit-bro.js (writes audit-bro.html
# *and* audit-bro.json), then ingests the JSON via redpash-audit-ingest so
# the run lands in audit.run + audit.finding and prints a "since last run"
# diff summary inline.
#
# Auto-discovers tools/*-audit/ dirs that have an audit-bro.js — today
# that's css-audit and html-audit (matching the audit.run CHECK constraint).
# A new bro audit dropped into tools/<x>-audit/ is picked up automatically
# the day it's added.
#
# Usage:  sh tools/audit-bro.sh
# Run from the repo root (the binary's .env lookup wants it).
# ─────────────────────────────────────────────────────────────────────────────
set -e

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

# Pre-build once so the per-tool loop runs the native binary, not cargo.
cargo build --quiet --manifest-path backend/crates/api/Cargo.toml \
            --bin redpash-audit-ingest
INGEST="$REPO_ROOT/backend/target/debug/redpash-audit-ingest"

fail=0
for dir in tools/*-audit; do
  bro="$dir/audit-bro.js"
  [ -f "$bro" ] || continue
  tool="$(basename "$dir" -audit)"
  echo "════════════════════════  $tool  ════════════════════════"

  if ! node "$bro"; then
    echo "  !! $tool audit-bro failed"
    fail=1
    continue
  fi
  echo

  if ! "$INGEST" --tool "$tool"; then
    echo "  !! $tool ingest failed"
    fail=1
    continue
  fi
  echo
done

if [ "$fail" -eq 0 ]; then
  echo "all audit-bros ran + ingested."
else
  echo "some steps failed — see above."
fi
exit $fail
