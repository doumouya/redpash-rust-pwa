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
- `presence-summary.sh [trim]` — surfaces the Torv presence files (`Torv-FE.md` + `Torv-BE.md`, from `$HOME/Internal-Slack/presence/`) as conversation context, hooked in `.claude/settings.json`. **Two modes** (CAS_70E63F8D, option 2): the default (`SessionStart`) prints **both files in full** — cold context needs the whole picture once; `trim` (`UserPromptSubmit`) prints per-Torv **header + `state:` line + the "currently claimed" block + mtime-age** only (~1.2 KB vs ~8 KB) — the cheap per-turn refresh, where the age stamp is the "something changed, open the file" signal. Missing files render as `(file missing)`, never a hook error. Added 2026-05-31 per CAS_70E63F8D Fix A (after the "we are not surviving" double-build incident); the full/trim split keeps real-time visibility without per-prompt token churn.

## Drift-prone areas

- **Presence-file convention**: 3 Torvs need distinct presence filenames; if
  they share the file name (default `presence/torv.md`) overlap detection breaks.
- **Hook installation** is per-clone; not portable across `git worktree` adds.

## Related

- [mcp-server](mcp-server.md) — the server-side coordination surface
- [Reference: Internal-Slack](../../../../) — the channel store on disk (not git-tracked)
- Memory: [[reference-tools-team]]
