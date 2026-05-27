---
title: Team coordination
section: Internal
order: 53
last modified date: 2026-05-27
owner: Torv
status: stable
---

# Team coordination

How parallel sessions in the same working directory coordinate without
collision. The team is **multiple agents on one machine** — Em as the
director, plus contributor agents on per-lane assignments (today: Torv,
Gus, Woz). All share `/home/mansa/rust-project/redpash-rust-pwa/` and
the `prerelease` branch. The surfaces below are what keep that workable.

## Surfaces

| Surface | Role |
|---|---|
| `Internal-Slack/<Agent>.md` | per-agent inbox — pings addressed to a specific agent |
| `Internal-Slack/broadcast.md` | team-wide announcements — one canonical post, no triplication |
| `Internal-Slack/.agent` | single-line file naming the currently-active agent identity for the session reading the channels |
| `tools/team/ping-hook.sh` | `UserPromptSubmit` hook that surfaces new entries in the active agent's inbox at the start of every turn |
| `tools/team/commits.log` | post-commit hook output — default visibility for slice-by-slice progress without per-slice channel pings |

## Per-agent channel discipline

Pings addressed to a single agent land on `Internal-Slack/<Agent>.md`.
The format is fixed (see [[reference-channel-ping-protocol]]):

- Header: `### YYYY-MM-DD HH:MM — <intent>: <subject>` where `<intent>`
  is one of `Asking for` / `Re` / `FYI`.
- Body: addressed to the channel owner; cites prior turns by date+time
  so the thread is followable without scrolling.
- Sign-off: `— <Agent> · 48` (the 48 suffix is post-2026-05-26
  consolidation shorthand; pre-consolidation entries use `— <Agent>
  (26.04)` or similar host-suffixes — historical, not required going
  forward).

Append at the **bottom** of the file. Never overwrite. The channels
are append-only by convention.

## When to use `broadcast.md` instead

A post belongs on `broadcast.md` when:

- The content needs to land identically in every agent's awareness
  (e.g. a campaign assignment table, a new team-wide convention, a
  shared playbook).
- Triplicating the same post into `Torv.md` + `Gus.md` + `Woz.md`
  would create three sources of truth for what is fundamentally one
  announcement.
- An ACK from each agent is needed — they reply on the same
  `broadcast.md` thread, so the full ACK loop lives in one place.

A post belongs on a per-agent channel when:

- It's a question / request directed at a single agent's lane.
- A reply is needed before the asker can proceed (the ping is
  load-bearing for one specific session, not the whole team).

The two surfaces compose: the broadcast announces a campaign; each
agent ACKs on broadcast; per-agent channels carry the lane-specific
follow-up questions that surface during execution.

## The ping-hook — pull automation

`tools/team/ping-hook.sh` is a `UserPromptSubmit` hook wired in
`~/.claude/settings.json`. On every user prompt:

1. Reads `Internal-Slack/.agent` to identify the active agent.
2. Scans `Internal-Slack/<Agent>.md` for entries with headers newer
   than the marker at `~/.claude/internal-slack-last-seen`.
3. If any are found, prints them to stdout — Claude Code injects the
   stdout into the next turn's context.
4. Updates the marker and exits.

The hook is **silent** in the common case (no new pings). Sub-50ms
per fire so it doesn't drag prompt latency. Every error path exits
zero — a broken hook never breaks the prompt flow.

The hook does NOT replace the manual `check ping` flow — Em can still
ask any agent to read the channels explicitly (incl. cross-channel
checks like "what did Gus say to Woz?"). The hook is a pull mechanism
that closes the gap of "Em has to type 'check ping' before every
turn."

## Parallel-safe commits

Concurrent sessions sharing the working directory means another
agent's WIP often appears in your `git status` between your own
calls. The discipline (see [[feedback-parallel-safe-commits]]):

- **Never** bare `git commit` — sweeps the whole index, including
  other lanes' staged work.
- **Always** `git commit -- <pathspecs>` or `git commit -o
  <pathspecs>` with explicit file lists.
- Before committing, re-run `git status` to confirm only your files
  are staged.

The post-commit hook publishes a line per commit to
`tools/team/commits.log`, which agents tail for default visibility
into what the other lanes are landing. Use it as your low-overhead
ambient signal so per-slice channel pings stay reserved for
cross-touch coordination.

## Identity routing

`Internal-Slack/.agent` is a single-line file holding the current
session's agent identity (`Torv` / `Gus` / `Woz`). The ping-hook
reads this to decide which `.md` inbox to surface. When the session
changes identity (e.g. Em starts a Gus session after a Torv session),
flip the file:

```
echo 'Gus' > /home/mansa/Internal-Slack/.agent
```

The marker at `~/.claude/internal-slack-last-seen` is **identity-
shared** — flipping `.agent` does not reset the marker, so the next
hook fire in the new identity only surfaces entries newer than the
last fire under the previous identity. This is fine for the common
case (Em hands off mid-day), but if you've just flipped and want to
see the active channel's full history, read the file explicitly.
