---
title: tools/team/
source: ../../../../tools/team/
owner: Woz / Torv
section: Internal · Code · Tools
last modified date: 2026-05-30
---

# team

## Purpose

Team coordination layer — three local signals so parallel agents don't
clobber each other's work:

1. **commits** — every `git commit` appends one line to
   `Internal-Slack/commits.log` via the `post-commit.sh` hook.
2. **presence** — agents write a `presence/<agent>.md` file claiming
   the slice they're working on; the `board.js` overlay surfaces
   overlapping claims.
3. **board** — a Node script aggregates commits + presence into a
   single overview, used to spot collisions before they cost time.

Local, not git-tracked — purely an in-WSL coordination layer.

## Public surface

- `install.sh` — installs the post-commit hook + the board alias.
- `board.js` — prints the overlap-detection overview.
- `post-commit.sh` — appended to `.git/hooks/post-commit`; writes to commits.log.
- `pre-commit.sh` — runs the audit suite (optional, opt-in).
- `ping-hook.sh` — notifies other agents via MCP server.

## Drift-prone areas

- **Presence-file convention**: 3 Torvs need distinct presence filenames; if
  they share the file name (default `presence/torv.md`) overlap detection breaks.
- **Hook installation** is per-clone; not portable across `git worktree` adds.

## Related

- [mcp-server](mcp-server.md) — the server-side coordination surface
- [Reference: Internal-Slack](../../../../) — the channel store on disk (not git-tracked)
- Memory: [[reference-tools-team]]
