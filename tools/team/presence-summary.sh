#!/usr/bin/env sh
# Purpose: surface Torv presence files as conversation context
#          (called by the SessionStart + UserPromptSubmit hooks).
# Doc: docs/internal/code/tools/team.md
#
# Hooked by .claude/settings.json. Two modes (CAS_70E63F8D, Torv-FE
# ACK'd option 2 — keep cold context rich, keep per-turn refresh cheap):
#
#   (no arg) / full  — SessionStart: print BOTH presence files in full.
#                      A fresh session needs the whole picture once.
#   trim             — UserPromptSubmit: per-Torv header + state + the
#                      "currently claimed" block + mtime-age only
#                      (~200B vs ~6KB). The age stamp is the cheapest
#                      "something changed — open the file" signal; if a
#                      Torv's age resets or state shifts, read the full file.
#
# Files expected at $HOME/Internal-Slack/presence/Torv-{FE,BE}.md per
# Fix A. Missing files render as a gentle "(file missing)" nudge, never
# a hook failure. Output -> stdout, surfaced as injected context.

MODE="${1:-full}"
PRES_DIR="${HOME}/Internal-Slack/presence"
FE="${PRES_DIR}/Torv-FE.md"
BE="${PRES_DIR}/Torv-BE.md"

# Minutes since last modification — stale-at-a-glance signal.
age_min() {
    f="$1"
    if [ ! -f "$f" ]; then printf 'n/a'; return; fi
    now=$(date +%s)
    mtime=$(stat -c %Y "$f" 2>/dev/null || echo "$now")
    printf '%dm' "$(( (now - mtime) / 60 ))"
}

# Full file with a labelled header (SessionStart).
emit_full() {
    f="$1"; label="$2"; lane="$3"
    printf '### %s  (%s — %s ago)\n\n' "$label" "$lane" "$(age_min "$f")"
    if [ -f "$f" ]; then cat "$f"; else
        printf '(file missing — create %s with your current claim + file list + ETA)\n' "$f"
    fi
    printf '\n\n'
}

# Compact summary (UserPromptSubmit): header + state line + the
# "currently claimed" block (until the next "## "), nothing else.
emit_trim() {
    f="$1"; label="$2"; lane="$3"
    printf '### %s  (%s — %s ago)\n' "$label" "$lane" "$(age_min "$f")"
    if [ ! -f "$f" ]; then printf '  (file missing)\n\n'; return; fi
    grep -m1 '^state:' "$f" | sed 's/^/  /'
    awk '/^## currently claimed/{f=1;next} /^## /{f=0} f && NF {print "  " $0}' "$f" | head -6
    printf '\n'
}

printf '## Team presence (live state from Internal-Slack/presence/)\n\n'

if [ "$MODE" = "trim" ]; then
    emit_trim "$FE" "Torv-FE" "frontend / architecture lane"
    emit_trim "$BE" "Torv-BE" "backend / RBAC lane"
else
    emit_full "$FE" "Torv-FE.md" "frontend / architecture lane"
    emit_full "$BE" "Torv-BE.md" "backend / RBAC lane"
fi
