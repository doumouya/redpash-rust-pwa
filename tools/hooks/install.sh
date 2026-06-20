#!/usr/bin/env sh
# Installs RedPash's tracked git hooks into .git/hooks — NON-destructively.
#
# Copies each hook in tools/hooks/ into .git/hooks/ (overwriting only that hook).
# Deliberately does NOT set core.hooksPath, so any other installed hook (e.g. the
# post-commit → commits.log hook) keeps working. Idempotent — safe to re-run.
#
# Run once per clone:  sh tools/hooks/install.sh
set -e

REPO="$(git rev-parse --show-toplevel)"
SRC="$REPO/tools/hooks"
DEST="$REPO/.git/hooks"
mkdir -p "$DEST"

for hook in pre-push; do
  cp "$SRC/$hook" "$DEST/$hook"
  chmod +x "$DEST/$hook"
  echo "installed: .git/hooks/$hook"
done

echo "done. Case-first is now enforced at push time (bypass: git push --no-verify)."
