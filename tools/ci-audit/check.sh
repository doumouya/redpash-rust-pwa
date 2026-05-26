#!/usr/bin/env sh
# ─────────────────────────────────────────────────────────────────────────────
# RedPash CI audit-diff check — the fidelity floor for UI/UX automation.
#
# Runs the full audit suite (sh tools/audit.sh), then queries
# audit.run_diff(latest, previous) per ingested tool. Exits 0 when nothing
# has gotten worse; exits 1 with a markdown table of regressions when
# any tool has `new` or `regressed` findings vs its previous run.
#
# Backed entirely by infrastructure that's already in place:
#   - audit.run / audit.finding (mig 028) — every run persists
#   - audit.run_diff(cur, prev) (mig 030) — classifies findings
#       new / fixed / regressed / improved / unchanged
#   - redpash-audit-ingest binary — exploded findings on every audit.sh run
# This script is just the SQL query + the exit-code wrapping. The diff
# machinery itself lives in Postgres.
#
# "new" + "regressed" are the actionable statuses. "fixed" + "improved"
# are wins (don't fail CI); "unchanged" is the steady state. The 102
# legitimate css-parallel candidates already in the DB are `unchanged`,
# so they don't trigger a regression. Only NEW additions to the noise
# floor (or severity escalation of an existing finding) trigger exit 1.
#
# Usage:
#   sh tools/ci-audit/check.sh              # default: run audits + check diff
#   sh tools/ci-audit/check.sh --no-run     # skip the audit run, check
#                                           # existing latest-vs-previous
#                                           # (fast iteration mode)
#
# Reads DATABASE_URL from the env or backend/.env (same source-of-truth
# as the rest of the backend).
# ─────────────────────────────────────────────────────────────────────────────
set -e

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO_ROOT"

# Load DATABASE_URL from backend/.env if not in env. Mirrors the
# dotenvy::dotenv lookup pattern the api crate uses at boot.
if [ -z "$DATABASE_URL" ] && [ -f backend/.env ]; then
  DB_LINE=$(grep -E "^DATABASE_URL=" backend/.env | head -1 || true)
  if [ -n "$DB_LINE" ]; then
    export DATABASE_URL="${DB_LINE#DATABASE_URL=}"
  fi
fi

if [ -z "$DATABASE_URL" ]; then
  echo "ci-audit: DATABASE_URL not set (neither env nor backend/.env). Aborting."
  exit 2
fi

# Default: run the audit suite first. --no-run skips for fast iteration
# (re-checks the same latest-vs-previous pair without writing a new run).
if [ "${1:-}" != "--no-run" ]; then
  echo "════════════════════════  ci-audit · running suite  ════════════════════════"
  sh tools/audit.sh
  echo
fi

# Find latest-vs-previous run pair per ingested tool + classify findings.
# audit.run_diff (mig 030) does the classification work; we filter to the
# two actionable statuses (new + regressed). Tools with only one run ever
# recorded have prev = NULL and are silently skipped (no diff possible).
echo "════════════════════════  ci-audit · checking regressions  ════════════════════════"
DIFF=$(psql "$DATABASE_URL" --quiet --tuples-only --no-align --field-separator='|' -c "
  WITH ranked AS (
    SELECT tool, id,
           row_number() OVER (PARTITION BY tool ORDER BY ran_at DESC) AS rn
      FROM audit.run
  ),
  pair AS (
    SELECT tool,
           MAX(CASE WHEN rn = 1 THEN id END) AS cur,
           MAX(CASE WHEN rn = 2 THEN id END) AS prev
      FROM ranked
     GROUP BY tool
  )
  SELECT pair.tool,
         d.status,
         d.kind,
         d.finding_key,
         coalesce(d.severity_cur::text,  '—'),
         coalesce(d.severity_prev::text, '—')
    FROM pair, LATERAL audit.run_diff(pair.cur, pair.prev) d
   WHERE pair.prev IS NOT NULL
     AND d.status IN ('new', 'regressed')
   ORDER BY pair.tool, d.status, d.kind, d.finding_key
")

if [ -z "$DIFF" ]; then
  echo "  ✓ no new or regressed findings across ingested tools."
  echo
  echo "audit reports available under tools/<x>-audit/audit.html"
  exit 0
fi

# Render the regressions as a markdown table + exit 1.
echo "  ✗ regressions detected — see the table below."
echo
echo "## Audit regressions"
echo
echo "Latest audit run vs the previous run for the same tool. \`new\` =
this finding wasn't present in the previous run; \`regressed\` =
this finding exists in both but its severity (conflictCount /
divergentCount / saved-lines / etc., per kind) is higher than before.
\`fixed\` / \`improved\` / \`unchanged\` are not regressions and don't
appear here."
echo
echo "| Tool | Status | Kind | Finding key | Severity (prev → cur) |"
echo "|---|---|---|---|---|"
echo "$DIFF" | while IFS='|' read -r tool status kind key sev_cur sev_prev; do
  # Escape any pipes in the finding_key so the markdown table stays valid.
  esc_key=$(echo "$key" | sed 's/|/\\|/g')
  echo "| $tool | $status | $kind | $esc_key | $sev_prev → $sev_cur |"
done

echo
echo "Drill into each finding via the per-tool report: tools/<x>-audit/audit.html"
echo
exit 1
