#!/usr/bin/env sh
# Purpose: FE test gate — runs the node:test harness over frontend/tests/.
# Doc: docs/internal/code/tools/shell/test-fe.md (predecessor convention)
# node:test only — no JS test framework (repo rule).
set -eu
cd "$(dirname "$0")/.."

if ! command -v node >/dev/null 2>&1; then
  export NVM_DIR="$HOME/.nvm"
  # shellcheck disable=SC1091
  [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" >/dev/null 2>&1
fi

if [ -d frontend/tests ]; then
  # explicit glob — some node versions reject a bare directory argument
  exec node --test frontend/tests/*.test.js "$@"
else
  echo "test-fe: no frontend/tests/ yet — FE gate n/a (0 tests)"
  exit 0
fi
