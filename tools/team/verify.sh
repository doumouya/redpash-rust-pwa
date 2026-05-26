#!/usr/bin/env bash
# Re-exec under bash when invoked via `sh script.sh` (which ignores the
# shebang and runs under dash). Sibling of install.sh + post-commit.sh.
if [ -z "${BASH_VERSION-}" ]; then exec bash "$0" "$@"; fi
# ── tools/team/verify.sh ────────────────────────────────────────────────────
# Diff git log against Internal-Slack/commits.log and report any commit
# whose short SHA is missing from the log — the silent-failure mode that
# bit us 2026-05-26 when a mid-session sync overwrote 4 hook-written
# entries before the next commit landed.
#
# The post-commit hook does its job, but the log lives in a directory
# that's also externally synced; an overwrite-style sync (rsync without
# --update / scp) can stomp recent entries between hook fires. This
# script is the audit-layer check that catches the resulting gap.
#
# Usage:
#   sh tools/team/verify.sh                       # default: last 100 git commits
#   sh tools/team/verify.sh --all                 # scan every commit in HEAD
#   sh tools/team/verify.sh --since=2d            # last 2 days (shorthand: Nh/Nd/Nm)
#   sh tools/team/verify.sh --since="yesterday"   # absolute date / phrase — passed
#                                                 # straight through to git
#   sh tools/team/verify.sh --fix                 # backfill missing entries
#   sh tools/team/verify.sh --fix --agent=Torv    # explicit agent tag for fix
#
# --fix:
#   - Default agent = contents of $SLACK/.agent (or "unknown" if absent)
#   - Each missing commit gets a line built from `git log -1 --format` data
#     (committer ISO date in UTC; branch from the current checkout; subject
#     verbatim) — same shape the hook emits.
#   - Atomic: writes to a tmp file, sorts the merged log by timestamp,
#     mv's into place. Backup is created at commits.log.bak.<epoch>.
#
# Exit code:
#   0 — log fully in sync (no missing entries)
#   1 — missing entries found (or --fix wrote some)
#   2 — argument error / log not initialised yet
# ────────────────────────────────────────────────────────────────────────────

set -u

SLACK="/home/mansa/Internal-Slack"
LOG="$SLACK/commits.log"
LIMIT=100
SINCE=""
FIX=0
AGENT=""

for arg in "$@"; do
  case "$arg" in
    --all)        LIMIT=0 ;;
    --since=*)    SINCE="${arg#--since=}" ;;
    --fix)        FIX=1 ;;
    --agent=*)    AGENT="${arg#--agent=}" ;;
    -h|--help)
      sed -n '/^# ── tools\/team\/verify.sh/,/^# ───/p' "$0" | sed 's/^# //;s/^#//'
      exit 0 ;;
    *) echo "unknown argument: $arg (try --help)"; exit 2 ;;
  esac
done

# Expand `Nh` / `Nd` / `Nm` shorthand to git's `N hours/days/minutes ago` form.
# Git's --since= parser accepts the long form but silently ignores the
# shorthand; without this expansion the flag fell through and the range
# became "everything". Anything not matching the shorthand passes through
# unchanged so absolute dates / "2 weeks ago" / "yesterday" still work.
case "$SINCE" in
  ""|*\ *) ;;  # empty or already a phrase — leave it
  *h) SINCE="${SINCE%h} hours ago" ;;
  *d) SINCE="${SINCE%d} days ago" ;;
  *m) SINCE="${SINCE%m} minutes ago" ;;
esac

# ── colour tags (mirrors install-stack.sh / stack-version.sh) ───────────────
if [ -t 1 ] && command -v tput >/dev/null 2>&1; then
  C_OK=$(tput setaf 2); C_BAD=$(tput setaf 1); C_DIM=$(tput setaf 8 2>/dev/null || tput setaf 7)
  C_RST=$(tput sgr0); C_BOLD=$(tput bold)
else
  C_OK=""; C_BAD=""; C_DIM=""; C_RST=""; C_BOLD=""
fi

if [ ! -f "$LOG" ]; then
  echo "  ${C_BAD}✗${C_RST} commits.log not found at $LOG"
  echo "     install the hook first: sh tools/team/install.sh"
  exit 2
fi

# Resolve agent for --fix mode
if [ "$FIX" -eq 1 ] && [ -z "$AGENT" ]; then
  AGENT=$(cat "$SLACK/.agent" 2>/dev/null | tr -d '\n')
  [ -z "$AGENT" ] && AGENT="unknown"
fi

# Build the git log range arguments. --since wins over --all wins over -n.
range_args=()
if [ -n "$SINCE" ]; then
  range_args+=(--since="$SINCE")
elif [ "$LIMIT" -gt 0 ]; then
  range_args+=(-n "$LIMIT")
fi

# Walk git log oldest→newest so any --fix backfill stays chronological.
present=0
missing=0
missing_shas=()
missing_count_total=$(git log --reverse --format=%h "${range_args[@]}" | wc -l | tr -d ' ')

if [ -n "$SINCE" ]; then
  range_desc="--since=\"$SINCE\""
elif [ "$LIMIT" -eq 0 ]; then
  range_desc="--all"
else
  range_desc="last $LIMIT commits (default)"
fi
echo ""
echo "  ${C_BOLD}── commits.log verify ──${C_RST}"
echo "  range: $range_desc  scanning $missing_count_total commits"
echo ""

while IFS=$'\t' read -r sha subject _date; do
  # The hook writes short SHA verbatim; grep -F on tab-bound field is enough.
  if grep -q -F "	$sha	" "$LOG"; then
    present=$((present + 1))
  else
    missing=$((missing + 1))
    missing_shas+=("$sha")
    echo "  ${C_BAD}✗${C_RST}  $sha  $subject"
  fi
done < <(git log --reverse --format="%h%x09%s%x09%cI" "${range_args[@]}")

echo ""
echo "  ────────────────────────────────────────"
echo "  scanned: $((present + missing))  ${C_OK}✓${C_RST} in log: $present  ${C_BAD}✗${C_RST} missing: $missing"

if [ "$missing" -eq 0 ]; then
  echo "  ${C_OK}✓ commits.log in sync${C_RST}"
  exit 0
fi

if [ "$FIX" -eq 0 ]; then
  echo "  ${C_DIM}re-run with --fix to backfill (--agent=<name> to set tag; defaults to $SLACK/.agent)${C_RST}"
  exit 1
fi

# ── --fix mode ──────────────────────────────────────────────────────────────
echo ""
echo "  ${C_BOLD}→ backfilling $missing entries (agent=$AGENT)${C_RST}"

BACKUP="$LOG.bak.$(date +%s)"
cp "$LOG" "$BACKUP"
echo "  backup -> $BACKUP"

# Build appended block in a tmp file, then sort-merge with existing log.
TMP=$(mktemp)
trap 'rm -f "$TMP"' EXIT

cp "$LOG" "$TMP"

BRANCH=$(git rev-parse --abbrev-ref HEAD)
for sha in "${missing_shas[@]}"; do
  iso_utc=$(date -u -d "$(git log -1 --format=%cI "$sha")" +"%Y-%m-%dT%H:%M:%SZ")
  subject=$(git log -1 --format=%s "$sha")
  printf '%s\t%s\t%s\t%s\t%s\n' "$iso_utc" "$AGENT" "$BRANCH" "$sha" "$subject" >> "$TMP"
done

# Sort by column 1 (ISO timestamp). LC_ALL=C keeps the sort lexicographic
# so ISO-Z timestamps compare correctly without locale surprises.
LC_ALL=C sort -t$'\t' -k1,1 -o "$TMP" "$TMP"

# Atomic swap
mv "$TMP" "$LOG"
trap - EXIT

echo "  ${C_OK}✓ backfilled $missing entries (atomic mv)${C_RST}"
exit 1
