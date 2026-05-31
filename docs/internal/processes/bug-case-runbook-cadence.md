---
title: Bug → case → runbook cadence
section: Internal
order: 53
last modified date: 2026-05-31
owner: Torv
status: live
---

# Bug → case → runbook cadence

The discipline this codifies: **when we hit a non-trivial bug, we file
a case at discovery; when we fix it, we write a runbook capturing the
reasoning; the case closes with a backlink to the runbook.**

Em 2026-05-31: *"I believe now we should fill a case when we find a
bug and linked them to a runbook when fixed, we never document these
and I'm convinced it's not a viable long term plan."*

The cost saved over time is large. Commit messages capture the *what*
but not the *why* — they don't surface during future investigations,
they don't aggregate into pattern catalogs, and they don't compound
into "lessons we've already learned." Today's debugging session
([runbook 0007](../runbooks/0007-column-drag-reorder-cluster.md)) is
the worked example: four interrelated bugs in the same neighborhood,
each teaching a different lesson, all of which would have stayed
locked in `git log` if we hadn't agreed to document them.

## The cadence

```
  ┌─────────────┐    ┌─────────────┐    ┌─────────────┐    ┌─────────────┐
  │  Discovery  │───▶│   Case      │───▶│    Fix      │───▶│   Runbook   │
  └─────────────┘    │  (opened)   │    └─────────────┘    │  (written)  │
                     └─────────────┘                       └──────┬──────┘
                            ▲                                     │
                            │                                     │
                            └──────────── case closes ◀───────────┘
                                          with runbook link
```

### 1. Discovery → case

When a non-trivial bug surfaces (user-visible misbehaviour, broken
contract, off-by-one in a shipped feature, regression on an
established surface), file a case via the MCP cases system *at
discovery time*, before fixing. The case lives at the cases system
URL — categorise as `bug`, link the surface, paste the symptom verbatim
from whoever surfaced it.

What counts as non-trivial — judgement call, but the heuristic:

- Anything that **changed a fix-level commit message** ("fix:", "fix(...)" prefix)
- Anything that required **live debugging** to diagnose
- Anything that surfaced **a class of mistake** (positional indexing under reorder, race between two paint passes, etc.) — even if the immediate fix is one line

What does NOT need a case:

- A typo or formatting fix.
- A code-style refactor with no behaviour change.
- A doc-only change.
- A test-only change.

### 2. Case → fix

Normal fix workflow — claim the case (presence/<agent>.md), branch off
prerelease, do the work, push.

### 3. Fix → runbook

When the fix lands, write a runbook entry at
`docs/internal/runbooks/NNNN-short-slug.md` (next available number,
zero-padded, sequential). Format follows the
[runbooks index](../runbooks/index.md): five sections (Problem
Statement / Troubleshooting steps / RCA / Solution / Post Checking)
plus a "Discipline this updates" close-out and a "Linked" list.

**Write the runbook while the context is fresh** — that night, or the
same day. Memory of "why exactly we ruled out X first" decays fast.

For interrelated bugs surfaced in one diagnostic arc (today's 0007 is
the worked example: 4 commits, 4 distinct root causes, all in the same
neighborhood), prefer **one consolidated runbook** with the layers
called out as numbered subsections, not N separate runbooks. The
diagnostic arc *is* the lesson; splitting it loses the through-line.

### 4. Case ↔ runbook link

When the runbook lands, close the case with a comment that includes
the runbook URL. The runbook's "Linked" section names the case ID
back. Bidirectional link.

### Backfill is fine

If a fix shipped before the case was opened, write the runbook
post-hoc and open the case retroactively with the runbook link
attached. The point is the documentary record, not the rigid ordering.
Runbook 0007 was backfilled this way.

## What the commit message should reference

Every fix-level commit body should end with a runbook line:

```
Runbook: docs/internal/runbooks/NNNN-short-slug.md
Case: <MCP case id, when filed>
```

When a fix is the Nth layer of an existing runbook (e.g. a follow-up
to 0007), append to the existing runbook and reference it by its
existing number — don't open a new one for what's the same incident
class.

## Why not just rely on git log

Git log captures the diff and the message. It does not capture:

- *Why we ruled out hypothesis A before landing on hypothesis B.*
- *What the visible symptom looked like* (Em's screenshots, console
  errors, video clips).
- *The class of mistake* — the pattern that other agents should look
  for next time.
- *The discipline rule* — the one-line summary of what to do next
  time, lifted out of the specific incident.
- *Cross-references* to the atomic doc / memory / case system that
  give the next agent a richer entry point.

Runbooks are the *human-written companion* to the
[Events](../subsystems/events-and-logs.md) system: Events captures
*what* failed at runtime; runbooks capture *why* it failed and *how
it was fixed*. (Phrasing from the runbooks index, 2026-05-24.)

## Tooling we could add (deferred, but worth noting)

- **`tools/runbook-audit/`** — read-only static check: scan recent
  `git log` for commits whose subject matches `^fix(...:?` and report
  any whose body lacks a `Runbook: …` line. Flag as a `missing_runbook`
  finding. Adds the discipline to the pre-commit / pre-push surface
  without nagging on non-fix work.
- **MCP case template** — make the `case_create` MCP tool accept a
  runbook number field that auto-populates the close-out comment when
  the runbook lands. Removes the manual back-and-forth.

These are tooling layers we'll build when the cadence is muscle
memory. For now: the discipline is the cadence, the cadence is the
file you're reading.

## Linked

- The first runbook written under this cadence — [0007](../runbooks/0007-column-drag-reorder-cluster.md).
- The runbooks index — [runbooks/index.md](../runbooks/index.md).
- The events subsystem (the runtime companion to runbooks) — [events-and-logs](../subsystems/events-and-logs.md).
- Related discipline — [process-oriented](../../../../home/mansa/.claude/projects/-home-mansa/memory/feedback_process_oriented.md): fix it once, encode the fix in a runbook/audit, never solve the same recurring problem manually.
