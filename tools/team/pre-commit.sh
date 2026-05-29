#!/usr/bin/env sh
# RedPash pre-commit — fast correctness gate on what you're committing.
#
# Installed into .git/hooks/pre-commit by tools/team/install.sh. Bypass
# with `git commit --no-verify` (only when you know why — a WIP stash, a
# docs-only commit the gate misreads, etc.).
#
# Enforces the checks we kept running by hand before every commit:
#   1. Staged frontend *.js → `node --check` each — catches parse errors
#      and the module-scope duplicate-declaration trap that silently
#      blanks the page (see feedback-module-strict-mode).
#   2. Any frontend *.js staged → the js-audit gate — fails the commit on
#      an extracted anti-pattern (esc/cssEsc redefinition, themeless
#      echarts.init, data-endpoint without a file_type gate, …). Scans the
#      whole frontend (cheap, <1s); report.html is gitignored so the run
#      never dirties the tree.
#   3. Any backend *.rs staged → `cargo check -p api`.
#
# Each step runs ONLY when its file kind is staged, so a frontend-only
# commit never pays the Rust compile and a backend-only commit never runs
# the JS checks. Exit non-zero blocks the commit.

ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || exit 0
cd "$ROOT" || exit 0

# Added / Copied / Modified staged paths (skip deletes + renames-source).
STAGED=$(git diff --cached --name-only --diff-filter=ACM)
[ -z "$STAGED" ] && exit 0

JS=$(printf '%s\n' "$STAGED" | grep -E '^frontend/.*\.js$')
RS=$(printf '%s\n' "$STAGED" | grep -E '^backend/.*\.rs$')
fail=0

# Iterate newline-separated lists without a subshell (so `fail` survives).
OLDIFS=$IFS
IFS='
'

# ── 1. staged JS syntax ──────────────────────────────────────────────
# The frontend is all ES modules. Plain `node --check <file>` parses .js
# as CommonJS and SILENTLY PASSES a broken ESM file, so we feed the file
# on stdin with --input-type=module to force a real module parse (the
# only invocation that actually catches `export const x = ;`).
if [ -n "$JS" ]; then
  for f in $JS; do
    [ -f "$f" ] || continue
    if ! err=$(node --check --input-type=module < "$f" 2>&1); then
      echo "  ✗ JS syntax: $f"
      printf '%s\n' "$err" | sed 's/^/      /'
      fail=1
    fi
  done
fi

IFS=$OLDIFS

# ── 2. js-audit gate (whole frontend; report.html is gitignored) ─────
if [ -n "$JS" ]; then
  if ! out=$(node tools/js-audit/audit.js 2>&1); then
    echo "  ✗ js-audit gate failed — run: node tools/js-audit/audit.js"
    printf '%s\n' "$out" | grep -iE "extracted|violat|gate" | sed 's/^/      /'
    fail=1
  fi
fi

# ── 3. backend cargo check (only when .rs staged) ────────────────────
if [ -n "$RS" ]; then
  echo "  → cargo check -p api (backend .rs staged)…"
  if ! err=$(cd backend && cargo check -p api -q 2>&1); then
    echo "  ✗ cargo check failed:"
    printf '%s\n' "$err" | tail -25 | sed 's/^/      /'
    fail=1
  fi
fi

if [ "$fail" -ne 0 ]; then
  echo ""
  echo "  pre-commit blocked. Fix the above, or 'git commit --no-verify' to bypass."
  exit 1
fi
exit 0
