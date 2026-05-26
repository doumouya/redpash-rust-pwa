#!/usr/bin/env bash
# Re-exec under bash when invoked via `sh script.sh` (which ignores the
# shebang). Uses `[[ ]]`, array literals, and `<<<` here-strings; dash
# chokes on all three.
if [ -z "${BASH_VERSION-}" ]; then exec bash "$0" "$@"; fi
# ── db-setup.sh ──────────────────────────────────────────────────────────────
# Idempotent Postgres setup for the RedPash dev stack. Sibling of
# `install-stack.sh` (which apt-installs postgresql + postgresql-client
# without configuring them) and `stack-version.sh` (which probes the
# binary floor). This script picks up after the install step:
#
#   1. ensures psql is installed (apts it if missing)
#   2. ensures the postgres service is running (WSL has no systemd by
#      default — sudo service is the lever)
#  ★ 2.5 EARLY VERIFY — `psql DATABASE_URL → 1`. If the URL already
#      connects, steps 3, 4, 5 are skipped entirely: role + database +
#      auth are demonstrably already configured for the cluster that's
#      actually answering. Avoids two classes of false negative:
#        • sudo without a TTY (agent shell, CI) — sudo prompts then
#          fails, so `sudo -u postgres psql` introspection returns
#          empty even when the role exists;
#        • multi-cluster hosts (WSL 26.04 with 22.04's PG14 also up
#          on :5432) — `sudo -u postgres psql` reaches the LOCAL
#          cluster, but `psql DATABASE_URL` reaches whichever cluster
#          owns the port; the two queries see different state.
#   3. creates the `mansa` role w/ login + superuser + password
#   4. creates the `redpash_prerelease` database owned by that role
#   5. flips localhost auth in pg_hba.conf from peer / ident → md5 so
#      the user:password URL is honored. scram-sha-256 is left alone:
#      PG15+ default, already works with user:pass URLs without churn.
#   6. probes the canonical DATABASE_URL with `SELECT 1`
#   7. writes backend/.env if missing
#
# The api crate's `sqlx::migrate!` auto-applies the 30+ migrations on
# first boot — this script gets you to the point where the api can
# connect; it does NOT run migrations itself.
#
# Convention (from 22.04's backend/.env):
#
#   DATABASE_URL=postgres://mansa:mansa@localhost:5432/redpash_prerelease
#
# Each component is overridable via env var if you need to diverge:
#   PG_USER PG_PASS PG_HOST PG_PORT PG_DB
#
# Exit codes:
#   0 — every step landed; SELECT 1 returned 1
#   1 — at least one step failed; SELECT 1 didn't return 1
#
# Usage:
#   sh tools/db-setup.sh                  # set up everything
#   sh tools/db-setup.sh --dry-run        # print what would happen, no changes
#   sh tools/db-setup.sh --no-env         # don't write/touch backend/.env

set -u

# ── argv ────────────────────────────────────────────────────────────────────
DRY_RUN=0
TOUCH_ENV=1
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --no-env)  TOUCH_ENV=0 ;;
    -h|--help)
      sed -n '/^# ── db-setup.sh/,/^$/p' "$0" | sed 's/^# //;s/^#//'
      exit 0 ;;
    *) echo "unknown argument: $arg (try --help)"; exit 2 ;;
  esac
done

# ── color tags (mirrors install-stack.sh) ───────────────────────────────────
if [ -t 1 ] && command -v tput >/dev/null 2>&1; then
  C_OK=$(tput setaf 2); C_WARN=$(tput setaf 3); C_BAD=$(tput setaf 1)
  C_DIM=$(tput setaf 8 2>/dev/null || tput setaf 7); C_RST=$(tput sgr0); C_BOLD=$(tput bold)
else
  C_OK=""; C_WARN=""; C_BAD=""; C_DIM=""; C_RST=""; C_BOLD=""
fi
TAG_OK="${C_OK}✓${C_RST}"
TAG_WORK="${C_WARN}→${C_RST}"
TAG_BAD="${C_BAD}✗${C_RST}"
# Drive-by: TAG_WARN was referenced in step 7 but never defined — would
# crash on `set -u` if the "DATABASE_URL differs" branch fired.
TAG_WARN="${C_WARN}!${C_RST}"
TAG_SKIP="${C_DIM}∘${C_RST}"

run() {
  if [ "$DRY_RUN" -eq 1 ]; then
    echo "  ${C_DIM}[dry] $*${C_RST}"
    return 0
  fi
  echo "  ${C_DIM}\$ $*${C_RST}"
  "$@"
}
run_sudo() {
  if [ "$DRY_RUN" -eq 1 ]; then
    echo "  ${C_DIM}[dry] sudo $*${C_RST}"
    return 0
  fi
  echo "  ${C_DIM}\$ sudo $*${C_RST}"
  sudo "$@"
}

# ── config (env-overridable) ────────────────────────────────────────────────
# PG_PORT default discovery: PG 14 (Ubuntu 22.04) clusters on 5432 but
# PG 18 (Ubuntu 26.04) clusters on 5433 when 22.04's cluster co-existed
# on the same host, and that "next port up" assignment can stick on a
# fresh single-cluster install too. Hardcoding 5432 made the script's
# step-6 self-verify fail on the 26.04 retirement host even though
# the role + db were correctly created on the live cluster via
# `sudo -u postgres psql` (which uses the local socket, port-agnostic).
# Detect the live cluster's port via pg_lsclusters; fall back to 5432
# only if detection fails (e.g. pg_lsclusters unavailable).
detect_pg_port() {
  if command -v pg_lsclusters >/dev/null 2>&1; then
    pg_lsclusters -h 2>/dev/null \
      | awk '$4 == "online" { print $3; exit }'
  fi
}
PG_USER="${PG_USER:-mansa}"
PG_PASS="${PG_PASS:-mansa}"
PG_HOST="${PG_HOST:-localhost}"
PG_PORT="${PG_PORT:-$(detect_pg_port)}"
PG_PORT="${PG_PORT:-5432}"
PG_DB="${PG_DB:-redpash_prerelease}"

DB_URL="postgres://${PG_USER}:${PG_PASS}@${PG_HOST}:${PG_PORT}/${PG_DB}"

# Resolve backend/.env path relative to this script (so the install
# works no matter where it's invoked from).
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="$REPO_ROOT/backend/.env"

FAILED=0
ALREADY_OK=0

# verify_connection — same path the api crate's sqlx pool will use.
# No sudo, no superuser; just the user/pass URL the .env will carry.
verify_connection() {
  PGPASSWORD="$PG_PASS" psql -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" \
    -d "$PG_DB" -tAc "SELECT 1;" 2>/dev/null | tr -d '[:space:]' \
    | grep -q '^1$'
}

# ── header ──────────────────────────────────────────────────────────────────
echo ""
echo "${C_BOLD}RedPash db-setup${C_RST}    $(date '+%FT%T%z')"
echo "  target: ${DB_URL}"
echo "  envfile: ${ENV_FILE}$([ "$TOUCH_ENV" -eq 0 ] && echo ' (skipped via --no-env)')"
[ "$DRY_RUN" -eq 1 ] && echo "  ${C_WARN}DRY RUN — no changes will be made${C_RST}"
echo ""

# ── 1. postgresql installed? ────────────────────────────────────────────────
echo "${C_BOLD}── 1. postgresql binary${C_RST}"
if command -v psql >/dev/null 2>&1; then
  echo "  $TAG_OK psql present: $(psql --version | head -1)"
else
  echo "  $TAG_WORK psql missing — installing"
  run_sudo apt-get update -qq || FAILED=$((FAILED + 1))
  run_sudo apt-get install -y --no-install-recommends postgresql postgresql-client || FAILED=$((FAILED + 1))
  if ! command -v psql >/dev/null 2>&1 && [ "$DRY_RUN" -eq 0 ]; then
    echo "  $TAG_BAD psql still missing after apt — check distro repo"
    exit 1
  fi
fi

# ── 2. service running? ─────────────────────────────────────────────────────
echo ""
echo "${C_BOLD}── 2. postgres service${C_RST}"
if [ "$DRY_RUN" -eq 0 ] && pgrep -x postgres >/dev/null 2>&1; then
  echo "  $TAG_OK postgres process already running"
else
  echo "  $TAG_WORK starting postgres"
  run_sudo service postgresql start || FAILED=$((FAILED + 1))
fi

# ── 2.5 early verify ────────────────────────────────────────────────────────
# If the URL already connects, role + db + auth are already configured for
# the cluster actually answering :5432 — skip every sudo-gated step below.
echo ""
echo "${C_BOLD}── 2.5. early verify (DATABASE_URL)${C_RST}"
if [ "$DRY_RUN" -eq 1 ]; then
  echo "  ${C_DIM}[dry] psql $DB_URL -tAc 'SELECT 1'${C_RST}"
elif verify_connection; then
  echo "  $TAG_OK URL already connects — skipping role/db/hba steps"
  ALREADY_OK=1
else
  echo "  $TAG_WARN URL does not connect yet — falling through to role/db/hba fix-up"
fi

# Detect the cluster's pg_hba.conf path. Only needed if we're going to
# touch it (i.e. early-verify failed). Move the discovery inside the
# fall-through block to avoid sudo prompts on the happy path.
PG_HBA=""

if [ "$ALREADY_OK" -eq 0 ]; then
  if [ "$DRY_RUN" -eq 0 ]; then
    PG_HBA=$(sudo -n find /etc/postgresql -name pg_hba.conf -type f 2>/dev/null | head -1)
    if [ -z "$PG_HBA" ]; then
      # Fall back to a SHOW from inside postgres if sudo find fails.
      PG_HBA=$(sudo -u postgres psql -tAc "SHOW hba_file;" 2>/dev/null | head -1)
    fi
  fi

  # ── 3. role exists? ───────────────────────────────────────────────────────
  echo ""
  echo "${C_BOLD}── 3. role '$PG_USER'${C_RST}"
  if [ "$DRY_RUN" -eq 1 ]; then
    echo "  ${C_DIM}[dry] CREATE ROLE $PG_USER WITH LOGIN SUPERUSER PASSWORD '<redacted>'${C_RST}"
  else
    ROLE_EXISTS=$(sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='$PG_USER';" 2>/dev/null | tr -d '[:space:]')
    if [ "$ROLE_EXISTS" = "1" ]; then
      echo "  $TAG_OK role already exists — leaving as-is (use ALTER ROLE manually to change password)"
    else
      echo "  $TAG_WORK creating role"
      sudo -u postgres psql -v ON_ERROR_STOP=1 <<SQL
DO \$\$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='$PG_USER') THEN
    CREATE ROLE $PG_USER WITH LOGIN SUPERUSER PASSWORD '$PG_PASS';
  END IF;
END \$\$;
SQL
      [ $? -eq 0 ] || FAILED=$((FAILED + 1))
    fi
  fi

  # ── 4. database exists? ───────────────────────────────────────────────────
  echo ""
  echo "${C_BOLD}── 4. database '$PG_DB'${C_RST}"
  if [ "$DRY_RUN" -eq 1 ]; then
    echo "  ${C_DIM}[dry] CREATE DATABASE $PG_DB OWNER $PG_USER${C_RST}"
  else
    DB_EXISTS=$(sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='$PG_DB';" 2>/dev/null | tr -d '[:space:]')
    if [ "$DB_EXISTS" = "1" ]; then
      echo "  $TAG_OK database already exists"
    else
      echo "  $TAG_WORK creating database"
      run_sudo -u postgres createdb -O "$PG_USER" "$PG_DB" || FAILED=$((FAILED + 1))
    fi
  fi

  # ── 5. localhost auth = md5 ──────────────────────────────────────────────
  echo ""
  echo "${C_BOLD}── 5. localhost auth (pg_hba.conf)${C_RST}"
  if [ "$DRY_RUN" -eq 1 ]; then
    echo "  ${C_DIM}[dry] sed peer|ident → md5 on host all all 127.0.0.1/32 + ::1/128${C_RST}"
  elif [ -z "$PG_HBA" ]; then
    echo "  $TAG_BAD couldn't locate pg_hba.conf — skipping (DATABASE_URL probe may fail)"
    FAILED=$((FAILED + 1))
  else
    # Only patch peer / ident — scram-sha-256 (PG15+ default) already
    # works with user:pass URLs, no need to churn it.
    CURRENT_AUTH=$(sudo grep -E '^host\s+all\s+all\s+127\.0\.0\.1/32\s+' "$PG_HBA" 2>/dev/null | awk '{print $5}' | head -1)
    case "$CURRENT_AUTH" in
      md5)
        echo "  $TAG_OK localhost auth already md5 in $PG_HBA"
        ;;
      scram-sha-256)
        echo "  $TAG_OK localhost auth is scram-sha-256 (PG15+ default) — works with user:pass URLs, no patch needed"
        ;;
      peer|ident)
        echo "  $TAG_WORK flipping $CURRENT_AUTH → md5 in $PG_HBA"
        sudo cp "$PG_HBA" "$PG_HBA.bak.$(date +%s)"
        sudo sed -i -E 's#^(host\s+all\s+all\s+127\.0\.0\.1/32\s+)(peer|ident)#\1md5#' "$PG_HBA"
        sudo sed -i -E 's#^(host\s+all\s+all\s+::1/128\s+)(peer|ident)#\1md5#' "$PG_HBA"
        echo "  ${C_DIM}\$ sudo service postgresql restart${C_RST}"
        sudo service postgresql restart || FAILED=$((FAILED + 1))
        ;;
      "")
        echo "  $TAG_WARN no host all all 127.0.0.1/32 line in $PG_HBA — manual review needed"
        ;;
      *)
        echo "  $TAG_WARN localhost auth = $CURRENT_AUTH (custom) — leaving alone"
        ;;
    esac
  fi
fi

# ── 6. probe DATABASE_URL ──────────────────────────────────────────────────
echo ""
echo "${C_BOLD}── 6. probe DATABASE_URL${C_RST}"
if [ "$DRY_RUN" -eq 1 ]; then
  echo "  ${C_DIM}[dry] psql $DB_URL -tAc 'SELECT 1'${C_RST}"
elif [ "$ALREADY_OK" -eq 1 ]; then
  echo "  $TAG_SKIP early verify already proved SELECT 1 — skipping re-probe"
else
  PROBE=$(PGPASSWORD="$PG_PASS" psql -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" -d "$PG_DB" -tAc "SELECT 1;" 2>&1)
  if [ "$PROBE" = "1" ]; then
    echo "  $TAG_OK SELECT 1 returned 1 — URL works"
  else
    echo "  $TAG_BAD probe failed: $PROBE"
    FAILED=$((FAILED + 1))
  fi
fi

# ── 7. backend/.env ────────────────────────────────────────────────────────
echo ""
echo "${C_BOLD}── 7. backend/.env${C_RST}"
if [ "$TOUCH_ENV" -eq 0 ]; then
  echo "  ${C_DIM}skipped via --no-env${C_RST}"
elif [ "$DRY_RUN" -eq 1 ]; then
  echo "  ${C_DIM}[dry] write DATABASE_URL to $ENV_FILE if missing${C_RST}"
else
  if [ -f "$ENV_FILE" ] && grep -q "^DATABASE_URL=" "$ENV_FILE"; then
    CUR_URL=$(grep "^DATABASE_URL=" "$ENV_FILE" | head -1 | cut -d= -f2-)
    if [ "$CUR_URL" = "$DB_URL" ]; then
      echo "  $TAG_OK DATABASE_URL already matches in $ENV_FILE"
    else
      echo "  $TAG_WARN existing DATABASE_URL differs from target — leaving as-is"
      echo "  ${C_DIM}    file:   $CUR_URL${C_RST}"
      echo "  ${C_DIM}    target: $DB_URL${C_RST}"
    fi
  else
    if [ -d "$(dirname "$ENV_FILE")" ]; then
      echo "  $TAG_WORK appending DATABASE_URL to $ENV_FILE"
      run sh -c "echo 'DATABASE_URL=$DB_URL' >> $ENV_FILE"
    else
      echo "  $TAG_BAD $(dirname "$ENV_FILE") doesn't exist — wrong invocation dir?"
      FAILED=$((FAILED + 1))
    fi
  fi
fi

# ── footer ──────────────────────────────────────────────────────────────────
echo ""
if [ "$DRY_RUN" -eq 1 ]; then
  echo "${C_WARN}dry-run complete — nothing was changed${C_RST}"
  exit 0
fi
if [ "$FAILED" -eq 0 ]; then
  echo "${C_OK}postgres ready.${C_RST}"
  echo ""
  echo "  Next: ${C_DIM}cd backend && cargo run -p api${C_RST}"
  echo "        (sqlx::migrate! applies the 30+ migrations on first boot)"
  exit 0
else
  echo "${C_BAD}$FAILED step(s) failed — see above${C_RST}"
  exit 1
fi
