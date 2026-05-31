#!/usr/bin/env sh
# Purpose: surface both Torv presence files as conversation context
#          (called by the SessionStart + UserPromptSubmit hooks).
# Doc: docs/internal/code/tools/team/presence-summary.md
#
# Hooked by .claude/settings.json. Prints both presence files with a
# header so the active Torv sees "what's the team doing right now"
# at session start and again on every user prompt. Both files are
# expected at $HOME/Internal-Slack/presence/Torv-{FE,BE}.md per
# CAS_70E63F8D40C2443C926C2D0326A0141C Fix A (the per-Torv presence
# convention adopted after the 2026-05-31 "we are not surviving"
# audit-tool double-build incident).
#
# Output goes to stdout; Claude Code surfaces it as injected
# conversation context. Missing files render as "(file missing)"
# rather than failing — a fresh checkout on a new host gets a
# gentle nudge to set the file up, not a hook failure.

PRES_DIR="${HOME}/Internal-Slack/presence"
FE="${PRES_DIR}/Torv-FE.md"
BE="${PRES_DIR}/Torv-BE.md"

# Compact age helper — minutes since last modification. Lets the
# reader spot stale presence files at a glance.
age_min() {
    f="$1"
    if [ ! -f "$f" ]; then printf 'n/a'; return; fi
    # %Y = last-mod epoch on linux stat
    now=$(date +%s)
    mtime=$(stat -c %Y "$f" 2>/dev/null || echo "$now")
    diff=$(( (now - mtime) / 60 ))
    printf '%dm' "$diff"
}

cat <<HEADER
## Team presence (live state from Internal-Slack/presence/)

HEADER

printf '### Torv-FE.md  (frontend / architecture lane — %s ago)\n\n' "$(age_min "$FE")"
if [ -f "$FE" ]; then
    cat "$FE"
else
    printf '(file missing — fresh Torv-FE: create at %s with your current claim + file list + ETA)\n' "$FE"
fi

printf '\n\n'

printf '### Torv-BE.md  (backend / RBAC lane — %s ago)\n\n' "$(age_min "$BE")"
if [ -f "$BE" ]; then
    cat "$BE"
else
    printf '(file missing — fresh Torv-BE: create at %s with your current claim + file list + ETA)\n' "$BE"
fi

printf '\n'
