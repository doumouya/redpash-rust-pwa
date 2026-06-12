#!/usr/bin/env sh
# Purpose: FE test gate — runs the node:test harness over frontend/tests/.
# Doc: docs/internal/code/tools/shell/test-fe.md
#
# Referenced as the FE gate by the agent role chain (tester.md "Running
# tests"; coder.md defers here). Tolerant of the not-yet-existing test tree
# (the harness itself is Phase 2 of the agent-roles rollout): no
# frontend/tests/ yet → explicit n/a notice + exit 0, matching the run
# ledger's "(n/a — backend feature)" convention. An agent must never mistake
# a missing harness for either a pass or a failure — hence the loud notice.
# Once frontend/tests/ lands this becomes a real red/green gate.
# node:test only — no JS test framework (repo rule).

set -eu
cd "$(dirname "$0")/.."

if [ -d frontend/tests ]; then
  exec node --test frontend/tests/ "$@"
else
  echo "test-fe: no frontend/tests/ yet — FE gate n/a (0 tests). Harness lands in agent-roles Phase 2."
  exit 0
fi
