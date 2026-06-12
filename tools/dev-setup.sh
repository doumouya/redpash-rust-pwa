#!/usr/bin/env bash
# Purpose: first-run orchestrator: install-stack → db-setup → wasm build.
# Doc: docs/internal/code/tools/shell/dev-setup.md
# Re-exec under bash for arrays + [[ ]].
if [ -z "${BASH_VERSION-}" ]; then exec bash "$0" "$@"; fi
# ── dev-setup.sh ─────────────────────────────────────────────────────────────
# Orchestrator: chains the three onboarding scripts in dependency order
# so a fresh host goes from clean to "api boots" in one invocation.
#
#   1. tools/stack-version.sh  — probe: are the 11 tools at MIN_VERSION?
#   2. tools/install-stack.sh  — fill any gaps (rust, node, psql, …)
#   3. tools/stack-version.sh  — re-probe to confirm install worked
#   4. tools/db-setup.sh       — service + role + database + .env + auth
#   5. tools/mcp-server build  — npm install + tsc so the redpash-slack MCP has dist/
#   6. tools audit deps        — npm install (acorn) so `sh tools/audit.sh` runs
#   7. cargo check -p api      — repo compiles against the new env
#
# Exit codes:
#   0 — every step landed; api crate compiles
#   N — first step that failed (passes through child exit code)
#
# Usage:
#   sh tools/dev-setup.sh                # full onboarding
#   sh tools/dev-setup.sh --dry-run      # show what each step would do
#   sh tools/dev-setup.sh --no-install   # skip install-stack (assume tools present)
#   sh tools/dev-setup.sh --no-db        # skip db-setup (BYO postgres)
#   sh tools/dev-setup.sh --no-build     # skip the cargo check sanity build

set -u

DRY_RUN=0
NO_INSTALL=0
NO_DB=0
NO_BUILD=0
for arg in "$@"; do
  case "$arg" in
    --dry-run)    DRY_RUN=1 ;;
    --no-install) NO_INSTALL=1 ;;
    --no-db)      NO_DB=1 ;;
    --no-build)   NO_BUILD=1 ;;
    -h|--help)
      sed -n '/^# ── dev-setup.sh/,/^$/p' "$0" | sed 's/^# //;s/^#//'
      exit 0 ;;
    *) echo "unknown argument: $arg (try --help)"; exit 2 ;;
  esac
done

if [ -t 1 ] && command -v tput >/dev/null 2>&1; then
  C_OK=$(tput setaf 2); C_WARN=$(tput setaf 3); C_BAD=$(tput setaf 1)
  C_DIM=$(tput setaf 8 2>/dev/null || tput setaf 7); C_RST=$(tput sgr0); C_BOLD=$(tput bold)
else
  C_OK=""; C_WARN=""; C_BAD=""; C_DIM=""; C_RST=""; C_BOLD=""
fi

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"

DRY_FLAG=""
[ "$DRY_RUN" -eq 1 ] && DRY_FLAG="--dry-run"

step() {
  local label="$1"; shift
  echo ""
  echo "${C_BOLD}════ $label ════${C_RST}"
  "$@"
  local rc=$?
  if [ $rc -ne 0 ]; then
    echo "${C_BAD}✗ '$label' exited $rc — aborting${C_RST}"
    exit $rc
  fi
}

echo ""
echo "${C_BOLD}RedPash dev-setup${C_RST}    $(date '+%FT%T%z')"
echo "  repo:    $REPO_ROOT"
[ "$DRY_RUN" -eq 1 ]    && echo "  ${C_WARN}DRY RUN — chained scripts run with --dry-run${C_RST}"
[ "$NO_INSTALL" -eq 1 ] && echo "  ${C_DIM}skipping install-stack.sh${C_RST}"
[ "$NO_DB" -eq 1 ]      && echo "  ${C_DIM}skipping db-setup.sh${C_RST}"
[ "$NO_BUILD" -eq 1 ]   && echo "  ${C_DIM}skipping cargo check${C_RST}"

step "stack-version (initial probe)"  sh "$SCRIPT_DIR/stack-version.sh" || true
# stack-version exits 1 if any core tool is below floor — that's expected
# on a fresh host; install-stack picks up next. Suppress with `|| true`
# only here, since the probe is a measurement not a gate.

if [ "$NO_INSTALL" -eq 0 ]; then
  step "install-stack"                sh "$SCRIPT_DIR/install-stack.sh" $DRY_FLAG
  step "stack-version (post-install)" sh "$SCRIPT_DIR/stack-version.sh"
fi

if [ "$NO_DB" -eq 0 ]; then
  step "db-setup"                     sh "$SCRIPT_DIR/db-setup.sh" $DRY_FLAG
fi

if [ "$NO_BUILD" -eq 0 ] && [ "$DRY_RUN" -eq 0 ]; then
  # Build the cases/Slack MCP server so dist/server.js exists. The redpash-slack MCP
  # entry points at dist/, but node_modules + dist are gitignored, so a fresh checkout
  # has neither and the server fails to connect ("Connection closed", -32000). Build it
  # here once so `/mcp` finds it. Skipped if node is absent (install-stack handles node).
  if command -v npm >/dev/null 2>&1; then
    step "mcp-server build"           sh -c "cd '$REPO_ROOT/tools/mcp-server' && npm install --no-audit --no-fund && npm run build"
    # Static-analysis audit deps (acorn) so `sh tools/audit.sh` runs. The JS audits
    # (js / admin-scope / css-tab-compare / fe-framework) `require('acorn')`, but
    # tools/node_modules is gitignored — a fresh checkout crashes them with MODULE_NOT_FOUND.
    step "audit deps (acorn)"         sh -c "cd '$REPO_ROOT/tools' && npm install --no-audit --no-fund"
  fi
  step "cargo check -p api"           sh -c "cd '$REPO_ROOT/backend' && cargo check -p api"
fi

echo ""
echo "${C_OK}dev-setup complete.${C_RST}"
echo ""
echo "  Boot the api:    ${C_DIM}cd backend && cargo run -p api${C_RST}"
echo "  Audit the tree:  ${C_DIM}sh tools/audit.sh${C_RST}"
echo "  Probe health:    ${C_DIM}sh tools/health-check.sh${C_RST}"
