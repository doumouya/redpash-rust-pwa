#!/bin/sh
# Install the team's post-commit hook into this clone's .git/hooks/.
# Idempotent — runs safely from any branch, overwrites any existing hook.

cd "$(dirname "$0")/../.." || exit 1     # → redpash-app/
HOOK_DIR=".git/hooks"
SRC="tools/team/post-commit.sh"
DEST="$HOOK_DIR/post-commit"

if [ ! -d "$HOOK_DIR" ]; then
  echo "no $HOOK_DIR — not a git clone?"
  exit 1
fi

cp "$SRC" "$DEST" && chmod +x "$DEST" \
  && echo "installed: $DEST  ←  $SRC" \
  || { echo "install failed"; exit 1; }

echo ""
echo "next: drop your agent name in /home/mansa/Internal-Slack/.agent"
echo "      and your claim in Internal-Slack/presence/<name>.md"
echo "      then \`node tools/team/board.js\` shows the team state."
