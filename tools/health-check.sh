#!/usr/bin/env bash
# Re-exec under bash for [[ ]] + arrays.
if [ -z "${BASH_VERSION-}" ]; then exec bash "$0" "$@"; fi
# ── health-check.sh ──────────────────────────────────────────────────────────
# Single-command "is the dev env healthy?" probe. Runs each sub-check
# independently, reports per-section, and returns the count of failures
# as the exit code (0 = all good).
#
# Sections:
#   1. stack-version    — every tool ≥ MIN_VERSION (uses stack-version.sh)
#   2. postgres reach   — DATABASE_URL works (SELECT 1)
#   3. ports            — no dual-binding surprises (uses port-check.sh)
#   4. cargo check      — backend api crate compiles
#   5. audit suite      — sh tools/audit.sh end-to-end clean
#   6. git              — branch identity + clean working tree
#
# Use as the first thing in the morning, or before a push, or after
# any environment change (WSL relaunch, OS update, new branch). It's
# the audit-cadence rule applied to the dev environment itself.
#
# Exit codes:
#   0 — every section passed
#   N — N sections failed
#
# Usage:
#   sh tools/health-check.sh             # all sections
#   sh tools/health-check.sh --skip-audit   # skip the full audit suite (faster)
#   sh tools/health-check.sh --quick        # only stack-version + db + ports

set -u

SKIP_AUDIT=0
QUICK=0
for arg in "$@"; do
  case "$arg" in
    --skip-audit) SKIP_AUDIT=1 ;;
    --quick)      QUICK=1; SKIP_AUDIT=1 ;;
    -h|--help)
      sed -n '/^# ── health-check.sh/,/^$/p' "$0" | sed 's/^# //;s/^#//'
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
TAG_OK="${C_OK}✓${C_RST}"
TAG_BAD="${C_BAD}✗${C_RST}"
TAG_SKIP="${C_DIM}-${C_RST}"

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"

PG_USER="${PG_USER:-mansa}"
PG_PASS="${PG_PASS:-mansa}"
PG_HOST="${PG_HOST:-localhost}"
PG_PORT="${PG_PORT:-5432}"
PG_DB="${PG_DB:-redpash_prerelease}"

FAILED=0
section() { echo ""; echo "${C_BOLD}── $1${C_RST}"; }

echo ""
echo "${C_BOLD}health-check${C_RST}    $(date '+%FT%T%z')"
echo "  repo:   $REPO_ROOT"
[ "$QUICK" -eq 1 ]      && echo "  ${C_DIM}--quick: only stack + db + ports${C_RST}"
[ "$SKIP_AUDIT" -eq 1 ] && echo "  ${C_DIM}--skip-audit: not running tools/audit.sh${C_RST}"

# ── 1. stack-version ────────────────────────────────────────────────────────
section "1. stack-version"
if sh "$SCRIPT_DIR/stack-version.sh" 2>&1 | tail -2 | grep -q "all good"; then
  echo "  $TAG_OK all 11 tools at MIN_VERSION"
else
  echo "  $TAG_BAD some tool below floor — run tools/stack-version.sh for detail"
  FAILED=$((FAILED + 1))
fi

# ── 2. postgres reach ───────────────────────────────────────────────────────
section "2. postgres reach (DATABASE_URL probe)"
PROBE=$(PGPASSWORD="$PG_PASS" psql -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" -d "$PG_DB" -tAc "SELECT 1;" 2>&1)
if [ "$PROBE" = "1" ]; then
  echo "  $TAG_OK SELECT 1 returned 1 — postgres://${PG_USER}@${PG_HOST}:${PG_PORT}/${PG_DB}"
else
  echo "  $TAG_BAD probe failed: $PROBE"
  FAILED=$((FAILED + 1))
fi

# ── 3. ports ───────────────────────────────────────────────────────────────
section "3. ports (no surprise bindings)"
if [ -x "$SCRIPT_DIR/port-check.sh" ]; then
  if sh "$SCRIPT_DIR/port-check.sh" 2>&1 | tail -3 | grep -q "no surprise"; then
    echo "  $TAG_OK no dual-binding surprises on 8080 / 8081 / 5432 / 50000"
  else
    echo "  $TAG_BAD dual binding or anomaly — run tools/port-check.sh for detail"
    FAILED=$((FAILED + 1))
  fi
else
  echo "  $TAG_SKIP port-check.sh missing — skipping"
fi

# ── 4. cargo check ─────────────────────────────────────────────────────────
section "4. cargo check -p api"
if [ "$QUICK" -eq 1 ]; then
  echo "  $TAG_SKIP skipped (--quick)"
else
  if [ -d "$REPO_ROOT/backend" ]; then
    if (cd "$REPO_ROOT/backend" && cargo check -p api --quiet 2>&1) >/tmp/health-cargo.log 2>&1; then
      echo "  $TAG_OK api crate compiles cleanly"
    else
      echo "  $TAG_BAD cargo check failed — see /tmp/health-cargo.log:"
      sed 's/^/      /' /tmp/health-cargo.log | tail -5
      FAILED=$((FAILED + 1))
    fi
  else
    echo "  $TAG_SKIP no backend/ dir at $REPO_ROOT/backend — skipping"
  fi
fi

# ── 5. audit suite ────────────────────────────────────────────────────────
section "5. audit suite"
if [ "$SKIP_AUDIT" -eq 1 ]; then
  echo "  $TAG_SKIP skipped (--skip-audit or --quick)"
else
  if (cd "$REPO_ROOT" && sh tools/audit.sh) >/tmp/health-audit.log 2>&1; then
    if grep -qE "0 errors, 0 warnings" /tmp/health-audit.log; then
      echo "  $TAG_OK all audits clean (see /tmp/health-audit.log for detail)"
    else
      echo "  $TAG_BAD audit suite exited 0 but has warnings — review /tmp/health-audit.log"
      FAILED=$((FAILED + 1))
    fi
  else
    echo "  $TAG_BAD audit suite failed — last lines:"
    tail -5 /tmp/health-audit.log | sed 's/^/      /'
    FAILED=$((FAILED + 1))
  fi
fi

# ── 6. git ─────────────────────────────────────────────────────────────────
section "6. git (branch + working tree)"
if [ -d "$REPO_ROOT/.git" ]; then
  BRANCH=$(cd "$REPO_ROOT" && git branch --show-current 2>/dev/null)
  HEAD=$(cd "$REPO_ROOT" && git log -1 --oneline 2>/dev/null)
  DIRTY=$(cd "$REPO_ROOT" && git status --porcelain 2>/dev/null | wc -l)
  if [ -z "$BRANCH" ]; then
    echo "  $TAG_BAD detached HEAD"
    FAILED=$((FAILED + 1))
  else
    echo "  $TAG_OK on $BRANCH @ $HEAD"
  fi
  if [ "$DIRTY" -gt 0 ]; then
    echo "  ${C_WARN}·${C_RST} $DIRTY uncommitted change(s) in working tree (run \`git status --short\`)"
  else
    echo "  $TAG_OK working tree clean"
  fi
else
  echo "  $TAG_SKIP not a git checkout"
fi

# ── footer ─────────────────────────────────────────────────────────────────
echo ""
if [ $FAILED -eq 0 ]; then
  echo "${C_OK}healthy.${C_RST}"
  exit 0
else
  echo "${C_BAD}$FAILED section(s) failed — see above${C_RST}"
  exit $FAILED
fi
