#!/usr/bin/env sh
# ─────────────────────────────────────────────────────────────────────────────
# RedPash audit suite — every tools/*-audit in one pass.
#
# Each tools/<x>-audit/audit.js scans one slice of the codebase and writes a
# report.html next to itself. This runner discovers them by glob, so a new
# audit folder is picked up automatically the day it's created — no edit here.
#
#   css-audit       CSS conflicts / duplication
#   html-audit      HTML structure / duplication
#   js-audit        frontend JS — LOC, unreachable modules, duplicate symbols
#   rs-audit        backend Rust — LOC, repeated lines, big match blocks
#   crossing-audit  the JS <-> Rust /api seam — crossings / dangling / unused
#
# Usage:  sh audit.sh
# ─────────────────────────────────────────────────────────────────────────────
cd "$(dirname "$0")" || exit 1

fail=0
for dir in *-audit; do
  [ -f "$dir/audit.js" ] || continue
  echo "════════════════════════  $dir  ════════════════════════"
  if node "$dir/audit.js"; then
    :
  else
    echo "  !! $dir failed"
    fail=1
  fi
  echo
done

echo "════════════════════════  reports  ════════════════════════"
for dir in *-audit; do
  [ -f "$dir/report.html" ] && echo "  $dir/report.html"
done

echo
if [ "$fail" -eq 0 ]; then
  echo "all audits ran."
else
  echo "some audits failed — see above."
fi
exit $fail
