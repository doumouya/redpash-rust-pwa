#!/bin/sh
# Install the team's git hooks into this clone's .git/hooks/.
# Idempotent — runs safely from any branch, overwrites any existing hook.
#
#   post-commit → broadcast the commit to Internal-Slack/commits.log
#   pre-commit  → fast correctness gate (staged JS syntax + js-audit gate
#                 + cargo check when backend .rs is staged)

cd "$(dirname "$0")/../.." || exit 1     # → repo root
HOOK_DIR=".git/hooks"

if [ ! -d "$HOOK_DIR" ]; then
  echo "no $HOOK_DIR — not a git clone?"
  exit 1
fi

for hook in post-commit pre-commit; do
  SRC="tools/team/$hook.sh"
  DEST="$HOOK_DIR/$hook"
  cp "$SRC" "$DEST" && chmod +x "$DEST" \
    && echo "installed: $DEST  ←  $SRC" \
    || { echo "install failed: $hook"; exit 1; }
done

echo ""
echo "next: drop your agent name in /home/mansa/Internal-Slack/.agent"
echo "      and your claim in Internal-Slack/presence/<name>.md"
echo "      then \`node tools/team/board.js\` shows the team state."
