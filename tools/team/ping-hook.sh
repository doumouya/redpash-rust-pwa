#!/usr/bin/env bash
# Re-exec under bash when invoked via `sh script.sh` (sibling pattern
# with install-stack.sh / db-setup.sh).
if [ -z "${BASH_VERSION-}" ]; then exec bash "$0" "$@"; fi
# ── tools/team/ping-hook.sh ─────────────────────────────────────────────────
# Claude Code `UserPromptSubmit` hook — surfaces new Internal-Slack
# entries in this agent's inbox since the previous prompt, by printing
# them to stdout (which the Claude Code hook runtime injects into the
# next turn's context). Silent when no new pings — no per-turn noise.
#
# Wire in ~/.claude/settings.json:
#
#   "hooks": {
#     "UserPromptSubmit": [
#       { "hooks": [
#         { "type": "command",
#           "command": "bash /home/mansa/rust-project/redpash-rust-pwa/tools/team/ping-hook.sh" }
#       ] }
#     ]
#   }
#
# Per [[user-calls-me-torv]] + [[reference-channel-ping-protocol]] —
# the hook respects whatever Internal-Slack/.agent says ("Torv" / "Gus"
# / "Woz" / etc.) and reads that agent's `.md` inbox. Pull mechanism,
# not push, but automated — closes the "Em has to type 'check ping'
# before every turn" loop. The "check ping" manual flow still works
# unchanged for explicit re-reads + cross-channel checks.
#
# Hard requirements on the hook (a slow/broken hook degrades every
# conversation turn):
#   • Sub-50ms execution in the common no-new-pings case
#   • `exit 0` on every error path; never break the prompt flow
#   • Quiet stdout when nothing's new; only emit on real new entries
# ────────────────────────────────────────────────────────────────────────────

set -u

SLACK="${REDPASH_SLACK_DIR:-/home/mansa/Internal-Slack}"
LAST_SEEN_FILE="$HOME/.claude/internal-slack-last-seen"

# Defensive — every "no" answer below exits silent so the hook never
# breaks the prompt flow. The conversation continues without the hook's
# context injection; that's the right failure mode.
[ -d "$SLACK" ] || exit 0

AGENT=$(cat "$SLACK/.agent" 2>/dev/null | tr -d '[:space:]')
[ -z "$AGENT" ] && exit 0

INBOX="$SLACK/${AGENT}.md"
[ -f "$INBOX" ] || exit 0

# Bootstrap: first hook fire ever (or after a manual rm of the marker)
# initialises the last-seen to NOW and exits silent. Don't dump the
# entire inbox history on first run.
if [ ! -f "$LAST_SEEN_FILE" ]; then
  date '+%Y-%m-%d %H:%M' > "$LAST_SEEN_FILE"
  exit 0
fi

LAST_SEEN=$(cat "$LAST_SEEN_FILE" 2>/dev/null)
if [ -z "$LAST_SEEN" ]; then
  date '+%Y-%m-%d %H:%M' > "$LAST_SEEN_FILE"
  exit 0
fi

# Walk the inbox: for each entry block (delimited by an
# `### YYYY-MM-DD HH:MM — …` header), buffer the block; emit it if
# its header timestamp is strictly greater than LAST_SEEN. ISO-shaped
# timestamps sort lexicographically — string comparison gives the
# correct chronological order without any date arithmetic.
NEW_ENTRIES=$(awk -v cutoff="$LAST_SEEN" '
  /^### [0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2} —/ {
    if (in_match && buf != "") print buf
    stamp = substr($0, 5, 16)
    in_match = (stamp > cutoff)
    buf = $0 "\n"
    next
  }
  { if (in_match) buf = buf $0 "\n" }
  END { if (in_match && buf != "") print buf }
' "$INBOX")

# Only emit + update the marker when there's something to show.
# Avoids the marker creeping forward on silent fires (which would
# create a tiny race window where an entry written during the
# hook's awk pass could be missed by the next fire).
if [ -n "$NEW_ENTRIES" ]; then
  echo "[ping-hook] new entries in ${AGENT}.md since ${LAST_SEEN}:"
  echo
  printf '%s\n' "$NEW_ENTRIES"
  date '+%Y-%m-%d %H:%M' > "$LAST_SEEN_FILE"
fi

exit 0
