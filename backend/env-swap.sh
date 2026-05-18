#!/usr/bin/env bash
# env-swap.sh — flip backend/.env between .env.main and .env.prerelease.
#
# With no arg, picks the env matching the current git branch:
#   prerelease → .env.prerelease
#   anything else → .env.main
# With an explicit arg (main | prerelease), forces that target.
#
# Safe to re-run: only repoints the .env symlink, never edits a file.
set -euo pipefail

cd "$(dirname "$0")"

target="${1:-}"
if [ -z "$target" ]; then
  branch="$(cd .. && git rev-parse --abbrev-ref HEAD)"
  case "$branch" in
    prerelease) target="prerelease" ;;
    *)          target="main" ;;
  esac
fi

case "$target" in
  main)       link=".env.main" ;;
  prerelease) link=".env.prerelease" ;;
  *) echo "usage: $0 [main|prerelease]" >&2; exit 1 ;;
esac

if [ ! -f "$link" ]; then
  echo "error: $link does not exist" >&2
  exit 1
fi

ln -sfn "$link" .env
echo ".env → $link"
grep -E "^DATABASE_URL|^REDPASH_DATA_DIR" "$link"
