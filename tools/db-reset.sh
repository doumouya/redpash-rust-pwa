#!/usr/bin/env bash
# Purpose: dev-DB lifecycle: drop + recreate redpash_prerelease.
# Doc: docs/internal/code/tools/shell/db-reset.md
# Re-exec under bash for [[ ]] + here-strings.
if [ -z "${BASH_VERSION-}" ]; then exec bash "$0" "$@"; fi
# ── db-reset.sh ──────────────────────────────────────────────────────────────
# Dev-DB lifecycle: drop + recreate the redpash_prerelease database.
# Use when migrations get tangled, when you want a clean event/audit
# log, or before a brittle schema change you want to reproduce on a
# fresh slate.
#
#   1. confirm the running database is the dev one (NOT prod)
#   2. drop + recreate (forces existing connections off)
#   3. print the URL so `cargo run -p api` re-applies migrations next boot
#
# The role (`mansa`) stays — only the database is wiped.
#
# Convention (match db-setup.sh + .env):
#
#   DATABASE_URL=postgres://mansa:mansa@localhost:5432/redpash_prerelease
#
# Each component is overridable via env var: PG_USER PG_PASS PG_HOST
# PG_PORT PG_DB.
#
# Safety: refuses to run against a database whose name doesn't end in
# `_dev` / `_prerelease` / `_test` unless `--force` is passed. The
# accidental `psql -d redpash_prod -c 'DROP DATABASE redpash_prod'`
# rejection should NOT be one careless argument away.
#
# Usage:
#   sh tools/db-reset.sh                 # interactive — asks before dropping
#   sh tools/db-reset.sh --yes           # skip confirm
#   sh tools/db-reset.sh --force         # bypass the prod-name guard
#   sh tools/db-reset.sh --dry-run       # print plan, do nothing

set -u

YES=0
FORCE=0
DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --yes|-y)   YES=1 ;;
    --force)    FORCE=1 ;;
    --dry-run)  DRY_RUN=1 ;;
    -h|--help)
      sed -n '/^# ── db-reset.sh/,/^$/p' "$0" | sed 's/^# //;s/^#//'
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

PG_USER="${PG_USER:-mansa}"
PG_PASS="${PG_PASS:-mansa}"
PG_HOST="${PG_HOST:-localhost}"
PG_PORT="${PG_PORT:-5432}"
PG_DB="${PG_DB:-redpash_prerelease}"
DB_URL="postgres://${PG_USER}:${PG_PASS}@${PG_HOST}:${PG_PORT}/${PG_DB}"

# Safety: prod-name guard.
case "$PG_DB" in
  *_dev|*_prerelease|*_test)
    : # ok
    ;;
  *)
    if [ "$FORCE" -ne 1 ]; then
      echo "${C_BAD}refusing: '$PG_DB' doesn't look like a dev/test database${C_RST}"
      echo "  Pass --force if you really mean to drop it."
      exit 1
    fi
    ;;
esac

echo ""
echo "${C_BOLD}db-reset${C_RST}    $(date '+%FT%T%z')"
echo "  target: ${C_WARN}DROP + CREATE${C_RST} $PG_DB on $PG_HOST:$PG_PORT (as $PG_USER)"
echo "  url:    $DB_URL"
[ "$DRY_RUN" -eq 1 ] && echo "  ${C_WARN}DRY RUN${C_RST}"

if [ "$YES" -ne 1 ] && [ "$DRY_RUN" -ne 1 ]; then
  echo ""
  read -r -p "Proceed? [y/N] " ans
  case "$ans" in
    [yY]|[yY][eE][sS]) : ;;
    *) echo "aborted"; exit 1 ;;
  esac
fi

run_psql_admin() {
  if [ "$DRY_RUN" -eq 1 ]; then
    echo "  ${C_DIM}[dry] sudo -u postgres psql -v ON_ERROR_STOP=1 -c \"$1\"${C_RST}"
    return 0
  fi
  echo "  ${C_DIM}\$ sudo -u postgres psql -c \"$1\"${C_RST}"
  sudo -u postgres psql -v ON_ERROR_STOP=1 -c "$1"
}

echo ""
echo "${C_BOLD}── 1. force-terminate live connections${C_RST}"
run_psql_admin "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='$PG_DB' AND pid <> pg_backend_pid();" >/dev/null 2>&1 || true

echo ""
echo "${C_BOLD}── 2. drop${C_RST}"
run_psql_admin "DROP DATABASE IF EXISTS $PG_DB;"

echo ""
echo "${C_BOLD}── 3. recreate${C_RST}"
run_psql_admin "CREATE DATABASE $PG_DB OWNER $PG_USER;"

echo ""
echo "${C_BOLD}── 4. verify${C_RST}"
if [ "$DRY_RUN" -eq 1 ]; then
  echo "  ${C_DIM}[dry] PGPASSWORD=… psql -tAc 'SELECT 1'${C_RST}"
else
  PROBE=$(PGPASSWORD="$PG_PASS" psql -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" -d "$PG_DB" -tAc "SELECT 1;" 2>&1)
  if [ "$PROBE" = "1" ]; then
    echo "  ${C_OK}✓ probe ok — empty database ready${C_RST}"
  else
    echo "  ${C_BAD}✗ probe failed: $PROBE${C_RST}"
    exit 1
  fi
fi

echo ""
echo "${C_OK}reset complete.${C_RST}"
echo "  Next boot of ${C_DIM}cargo run -p api${C_RST} will replay all migrations against the empty db."
