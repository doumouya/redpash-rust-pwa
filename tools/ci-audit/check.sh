#!/usr/bin/env sh
# ─────────────────────────────────────────────────────────────────────────────
# RedPash CI audit-diff check — the fidelity floor for UI/UX automation.
#
# Auto-discovers every tools/*-audit/audit.js, runs it, then ratchets each
# tool's violation count against a committed baseline. Exits 0 when nothing
# has gotten worse; exits 1 with a markdown table of regressions when any
# tool has MORE violations than its baseline (a `new` regression). Tools at
# or below baseline pass (`fixed` / `improved` / `unchanged` are wins).
#
# ── Adapted from prerelease for the lean tree ──────────────────────────────
# Prerelease backed this on the Postgres audit-trail (audit.run / audit.finding
# mig 028, audit.run_diff mig 030) + the redpash-audit-ingest binary + a
# separate tools/audit.sh suite runner. NONE of that exists in lean yet —
# "Audits-as-CI ratchet (findings in Postgres, run_diff SQL)" is an explicit
# Phase-7 roadmap item (docs/ROADMAP.md). So the diff machinery here is a
# file-based baseline (tools/ci-audit/baseline.json: per-tool violation
# counts) instead of a psql query. Same exit-code contract; the baseline is
# the interim stand-in until the Postgres ratchet lands, at which point
# baseline.json is replaced by audit.run_diff and this header note retires.
#
# The suite runner is inlined (lean has no tools/audit.sh): the per-tool loop
# globs tools/*-audit/audit.js exactly like prerelease's audit.sh did, so a
# new audit folder is picked up the day it's added — no edit here. Today only
# tools/ui-fork-audit/ ships; the rest land across Phase 5–7.
#
# Usage:
#   sh tools/ci-audit/check.sh                    # run audits + ratchet vs baseline
#   sh tools/ci-audit/check.sh --no-run           # skip the run; ratchet the
#                                                 # existing audit.json outputs
#                                                 # (fast iteration mode)
#   sh tools/ci-audit/check.sh --update-baseline  # accept current counts as the
#                                                 # new baseline (after a
#                                                 # reviewed, intentional change)
# ─────────────────────────────────────────────────────────────────────────────
set -e

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO_ROOT"
HERE="tools/ci-audit"

# node lives under nvm in dev shells; resolve it for non-interactive runs
# (mirrors tools/ci.sh).
if ! command -v node >/dev/null 2>&1; then
  export NVM_DIR="$HOME/.nvm"
  [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" >/dev/null 2>&1
fi
if ! command -v node >/dev/null 2>&1; then
  echo "ci-audit: node not found (needed to run the audit suite). Aborting."
  exit 2
fi

MODE="run"
case "${1:-}" in
  --no-run)          MODE="no-run" ;;
  --update-baseline) MODE="update" ;;
  "")                MODE="run" ;;
  *) echo "ci-audit: unknown arg '$1' (expected --no-run | --update-baseline)"; exit 2 ;;
esac

# ── 1. run the suite (auto-discovered audit.js per tools/*-audit/) ───────────
# Each audit.js exits with its violation count and writes audit.json next to
# itself (the ones that emit it). --no-run reuses whatever audit.json is on
# disk. We never let a non-zero audit exit abort the script — a violation is
# data for the ratchet, not a hard error here (set -e is scoped around it).
if [ "$MODE" != "no-run" ]; then
  echo "════════════════════════  ci-audit · running suite  ════════════════════════"
  for audit in tools/*-audit/audit.js; do
    [ -f "$audit" ] || continue
    # Tracked-only: untracked tools/*-audit/ dirs are stale prerelease debris
    # in the working tree — the ratchet ignores them, so don't run them here
    # either (keeps the suite reproducible from a fresh clone).
    git ls-files --error-unmatch "$audit" >/dev/null 2>&1 || continue
    tool="$(basename "$(dirname "$audit")" -audit)"
    echo "────────  $tool  ────────"
    set +e
    node "$audit"
    set -e
    echo
  done
fi

# ── 2. ratchet violation counts against the committed baseline ───────────────
echo "════════════════════════  ci-audit · checking regressions  ════════════════════════"
node "$HERE/ratchet.mjs" "$MODE"
