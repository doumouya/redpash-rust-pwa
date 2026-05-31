#!/usr/bin/env bash
# Purpose: seed RBAC-coverage fixtures (users + teams + memberships) so the
#   live UI has at least one holder of each role tier (Owner / Admin / Member /
#   Viewer) on each object kind (company / team / project / case). Idempotent
#   by name+handle; safe to re-run.
# Doc: docs/internal/code/tools/seed-rbac-coverage.md
#
# Usage:   sh tools/seed-rbac-coverage/seed.sh
# Env:     RP_API=http://localhost:8080/api  (default)
# Auth:    /auth/dev-login (dev binary; the WARN in the server log means it's
#          available — DON'T run this against a non-dev backend).

set -u
API="${RP_API:-http://localhost:8080/api}"
JAR="$(mktemp -t rp-seed.XXXXXX)"
trap 'rm -f "$JAR"' EXIT

c() { curl -sS -b "$JAR" -c "$JAR" -H "Content-Type: application/json" "$@"; }
j() { python3 -c "import sys,json; d=json.load(sys.stdin); $1"; }

# All progress goes to stderr so functions can return rids on stdout
# without log lines getting swept into the captured value.
log()  { printf '  %s\n' "$*" >&2; }
head() { printf '\n== %s ==\n' "$*" >&2; }

# ── auth ────────────────────────────────────────────────────────────────
head "auth"
status=$(c -o /dev/null -w '%{http_code}' -X POST "$API/auth/dev-login")
if [ "$status" != "204" ]; then
  echo "dev-login failed (HTTP $status). Is the backend up and REDPASH_DEV_LOGIN set?" >&2
  exit 1
fi
log "session minted"

# ── existing fixtures ───────────────────────────────────────────────────
head "discover companies"
RP_CO=$(c "$API/admin/companies?q=RedPash&size=1" | j "print((d.get('rows') or [{}])[0].get('redpash_id',''))")
AC_CO=$(c "$API/admin/companies?q=Acme&size=1"    | j "print((d.get('rows') or [{}])[0].get('redpash_id',''))")
log "RedPash=$RP_CO"
log "Acme=$AC_CO"
[ -z "$RP_CO" ] && { echo "RedPash company missing — backend bootstrap didn't run?" >&2; exit 1; }
[ -z "$AC_CO" ] && { echo "Acme company missing — re-run db-setup.sh to load seed companies." >&2; exit 1; }

PRJ=$(c "$API/projects?size=1" | j "print((d.get('items') or d.get('rows') or [{}])[0].get('redpash_id',''))")
log "first project=$PRJ"

# ── users — idempotent create-or-find by handle ─────────────────────────
# Each tuple: handle display_name [first last [email]]
USERS='
alice  Alice Owner    Alice  Owner    alice@redpash.dev
bob    Bob Admin      Bob    Admin    bob@redpash.dev
carol  Carol Member   Carol  Member   carol@redpash.dev
dave   Dave Viewer    Dave   Viewer   dave@redpash.dev
'

# Returns the redpash_id of a user, creating it if absent. Echoes USR_… or "".
ensure_user() {
  handle="$1"; display="$2"; first="$3"; last="$4"; email="$5"
  rid=$(c "$API/admin/users?q=$handle&size=5" | j "
items = d.get('rows') or d.get('items') or []
for u in items:
    if (u.get('username') or '').lower() == '$handle'.lower():
        print(u.get('redpash_id','')); break
")
  if [ -n "$rid" ]; then
    log "user $handle exists → $rid"
    echo "$rid"; return
  fi
  body=$(python3 -c "import json;print(json.dumps({'username':'$handle','display_name':'$display','first_name':'$first','last_name':'$last','email':'$email'}))")
  resp=$(c -X POST "$API/users" -d "$body")
  rid=$(echo "$resp" | j "print(d.get('redpash_id',''))")
  if [ -z "$rid" ]; then
    log "user $handle CREATE FAILED: $resp"
  else
    log "user $handle created → $rid"
  fi
  echo "$rid"
}

head "users"
ALICE_RID=$(ensure_user alice "Alice Owner"  Alice Owner  alice@redpash.dev)
BOB_RID=$(  ensure_user bob   "Bob Admin"    Bob   Admin  bob@redpash.dev)
CAROL_RID=$(ensure_user carol "Carol Member" Carol Member carol@redpash.dev)
DAVE_RID=$( ensure_user dave  "Dave Viewer"  Dave  Viewer dave@redpash.dev)

# ── teams — create-or-find by (name, company) ──────────────────────────
# Echoes TEM_… or "".
ensure_team() {
  name="$1"; company="$2"
  rid=$(c "$API/admin/teams?q=$(printf %s "$name" | sed 's/ /%20/g')&size=10" | j "
import json
items = d.get('rows') or d.get('items') or []
for t in items:
    if t.get('name')=='$name' and t.get('company_id')=='$company':
        print(t.get('redpash_id','')); break
")
  if [ -n "$rid" ]; then
    log "team '$name' exists → $rid"
    echo "$rid"; return
  fi
  body=$(python3 -c "import json;print(json.dumps({'name':'$name','company_id':'$company'}))")
  resp=$(c -X POST "$API/teams" -d "$body")
  rid=$(echo "$resp" | j "print(d.get('redpash_id',''))")
  log "team '$name' created → ${rid:-FAILED ($resp)}"
  echo "$rid"
}

head "teams"
ENG_TEAM=$(   ensure_team "Engineering" "$RP_CO")  # Phase B already created this
OPS_TEAM=$(   ensure_team "Operations"  "$RP_CO")
INV_TEAM=$(   ensure_team "Investors"   "$RP_CO")
ANA_TEAM=$(   ensure_team "Analytics"   "$AC_CO")

# ── memberships — POST /admin/memberships (idempotent via 409 swallow) ──
# args: scope scope_id user_id role [context_role]
add_member() {
  scope="$1"; sid="$2"; uid="$3"; role="$4"; ctx="${5:-}"
  [ -z "$sid" ] || [ -z "$uid" ] && { log "skip $scope:$role — missing rid"; return; }
  body=$(python3 -c "import json,sys
b={'scope':'$scope','scope_id':'$sid','user_id':'$uid','role':'$role'}
if '$ctx': b['context_role']='$ctx'
print(json.dumps(b))")
  out=$(c -o /tmp/rp-seed-out -w '%{http_code}' -X POST "$API/admin/memberships" -d "$body")
  case "$out" in
    201) log "  + $scope/$role $uid → $sid${ctx:+ ($ctx)}" ;;
    409) log "  · $scope/$role $uid → $sid${ctx:+ ($ctx)} [exists]" ;;
    *)   log "  ! $scope/$role $uid → $sid HTTP $out: $(cat /tmp/rp-seed-out)" ;;
  esac
}

head "company memberships (RedPash)"
add_member company "$RP_CO" "$ALICE_RID" admin
add_member company "$RP_CO" "$BOB_RID"   member
add_member company "$RP_CO" "$CAROL_RID" member

head "company memberships (Acme)"
add_member company "$AC_CO" "$CAROL_RID" admin
add_member company "$AC_CO" "$DAVE_RID"  member

head "team memberships (Engineering)"
add_member team "$ENG_TEAM" "$ALICE_RID" admin  "Team Lead"
add_member team "$ENG_TEAM" "$BOB_RID"   member "Team Member"

head "team memberships (Operations)"
add_member team "$OPS_TEAM" "$ALICE_RID" owner  "Team Manager"
add_member team "$OPS_TEAM" "$CAROL_RID" admin  "Team Lead"
add_member team "$OPS_TEAM" "$DAVE_RID"  member "Team Member"

head "team memberships (Investors)"
add_member team "$INV_TEAM" "$BOB_RID"  owner  "Team Manager"
add_member team "$INV_TEAM" "$CAROL_RID" member "Team Member"

head "team memberships (Analytics)"
add_member team "$ANA_TEAM" "$CAROL_RID" admin  "Team Lead"
add_member team "$ANA_TEAM" "$DAVE_RID"  member "Team Member"

# ── project memberships — the only place 'viewer' exists for projects ──
if [ -n "$PRJ" ]; then
  head "project memberships (first project — covers project viewer tier)"
  add_member project "$PRJ" "$ALICE_RID" member "Data Analyst"
  add_member project "$PRJ" "$BOB_RID"   viewer "Reviewer"
  add_member project "$PRJ" "$CAROL_RID" member "Project Manager"
  add_member project "$PRJ" "$DAVE_RID"  viewer "Reviewer"
fi

# ── case memberships — covers case viewer tier + Watcher/Assignee ctx ──
CASE=$(c "$API/cases?size=1" | j "print((d.get('items') or d.get('rows') or [{}])[0].get('redpash_id',''))")
if [ -n "$CASE" ]; then
  head "case memberships ($CASE)"
  add_member case "$CASE" "$ALICE_RID" member "Watcher"
  add_member case "$CASE" "$BOB_RID"   member "Assignee"
  add_member case "$CASE" "$DAVE_RID"  viewer "Watcher"
fi

printf '\nDone. Coverage matrix:\n'
printf '  Owner  ─ on every object (creator-seated automatically + Operations team explicit)\n'
printf '  Admin  ─ companies + teams (Alice@RedPash, Carol@Acme, Alice@Eng, Carol@Ops/Ana)\n'
printf '  Member ─ every object (Bob/Carol/Dave spread across)\n'
printf '  Viewer ─ projects + cases (Bob+Dave on the first project; Dave on the first case)\n'
