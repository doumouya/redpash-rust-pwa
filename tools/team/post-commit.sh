#!/bin/sh
# RedPash team post-commit hook — broadcast every commit to
# Internal-Slack/commits.log so every agent sees who landed what.
#
# Installed into .git/hooks/post-commit by tools/team/install.sh.
# Single line per commit, tab-separated for easy parsing:
#   <ISO ts>\t<agent>\t<branch>\t<short sha>\t<subject>
#
# Agent identity is read from Internal-Slack/.agent (a single-line file
# each agent writes at session start). Unknown if the file is missing —
# not fatal; the log still records the commit.

SLACK="/home/mansa/Internal-Slack"
AGENT=$(cat "$SLACK/.agent" 2>/dev/null || echo "unknown")
TS=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
SHA=$(git rev-parse --short HEAD)
BRANCH=$(git rev-parse --abbrev-ref HEAD)
SUBJECT=$(git log -1 --format=%s)

mkdir -p "$SLACK"
printf '%s\t%s\t%s\t%s\t%s\n' "$TS" "$AGENT" "$BRANCH" "$SHA" "$SUBJECT" >> "$SLACK/commits.log"
