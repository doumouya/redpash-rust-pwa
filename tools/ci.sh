#!/usr/bin/env sh
# Purpose: the whole CI gate, runnable from a fresh clone. Exit code = failure
# count, health-check style. Grows with the phases: ui-fork-audit (Phase 5 S0),
# test-fe (S1+), audits + ci-audit ratchet (Phase 7).
set -u
fails=0
run() { echo "== $*"; "$@" || fails=$((fails + 1)); }

cd "$(dirname "$0")/.."

# node lives under nvm in dev shells; resolve it for non-interactive runs.
if ! command -v node >/dev/null 2>&1; then
  export NVM_DIR="$HOME/.nvm"
  [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" >/dev/null 2>&1
fi

run sh tools/purity-check.sh
run sh -c 'cd backend && cargo check --quiet --workspace'
run sh -c 'cd backend && cargo test --quiet --workspace'
# The ci-audit ratchet runs the WHOLE audit suite (incl. ui-fork) and fails
# only on REGRESSIONS vs tools/ci-audit/baseline.json — existing findings are
# the floored backlog, not a hard block. (File-baseline interim until the
# Phase-7 Postgres run_diff lands; see tools/ci-audit/README.md.)
run sh tools/ci-audit/check.sh
run sh tools/test-fe.sh
# build-fe self-checks the shipped module graph (a typo'd import fails the
# build here instead of 404ing at runtime).
run sh tools/build-fe.sh

echo "ci: $fails failure(s)"
exit "$fails"
