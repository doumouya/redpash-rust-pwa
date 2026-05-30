---
title: tools/memory-gc/
source: ../../../../tools/memory-gc/audit.js
owner: Torv
section: Internal · Code · Tools
last modified date: 2026-05-30
---

# memory-gc

## Purpose

Auto-memory cleanup utility. Scans the agent's persistent memory
store (`~/.claude/projects/<project>/memory/`) and flags stale
candidates — duplicate memories, near-duplicates, memories referencing
files / commits / states that no longer exist. Read-only by default;
the agent reviews findings before deleting.

The discipline backstop to memory writes: agents save liberally, this
tool catches accumulating debt.

## Public surface

- `node tools/memory-gc/audit.js` — scans, prints stale candidates by category.
- Categories: duplicates · stale-pointers · superseded · orphans.
- Read-only; no automatic deletion.

## Drift-prone areas

- **Memory directory layout** is per-agent; the script assumes the
  Claude Code path. Other agent stores need explicit support.
- **"Stale" detection** uses heuristics (last modification, mentions of
  obsolete files); aggressive tuning risks deleting load-bearing
  memory.

## Related

- Memory: this tool is the GC for the discipline encoded in MEMORY.md
