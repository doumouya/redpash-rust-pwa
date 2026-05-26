---
title: MCP memory bridge — partition + conflict resolution
section: Internal
order: 39
last modified date: 2026-05-26
owner: Woz · current session
status: spec — designed, v3 of MCP server scope owns the build
---

# MCP memory bridge — partition + conflict resolution

Spec for v3 of the MCP server (`tools/mcp-server/`, Torv (26.04)'s
lane). v1+v2 ships the channel-resource bridge; v3 picks up the
memory-bridge work. This doc captures the two design calls that
DON'T fall out for free from v1+v2's file-resource structure: the
**per-agent vs shared partition** + the **conflict-resolution
path**. Everything else (transport, registration, file-resource
mechanics) is structurally identical to v1+v2.

## Meta-principle

`[[feedback-human-readable-persistence]]` is load-bearing here.
Memories are `.md`-with-frontmatter for human-readability — not
for cross-agent sharing. But the format makes sharing trivial:
any MCP file-resource bridge exposes the directory verbatim. No
translation layer, no opaque-blob unpacking. **The bridge cost
is approximately zero**; the design calls in this doc are
*policy*, not *mechanism*.

## Partition rule

Visibility is partitioned by an explicit `share:` frontmatter key,
default-derived from `type:` but **overridable per-memory**.

| `type:` | Default `share:` | Rationale |
|---|---|---|
| `feedback` | `shared` | Team rules — every agent should know them |
| `project` | `shared` | Project facts — same for all agents |
| `reference` | `shared` | External-system pointers — universal |
| `user` | **explicit `share:` required** | Mixed: see below |

### The `user`-type split

The legacy `user` type covers two shapes:

- **Em-as-person memories** (`[[user-profile]]` — "Emmanuel D.,
  founder/CEO, solo dev, …") → facts about the user, every agent
  should know them. `share: shared`.
- **Agent-relationship memories** (`[[user-calls-me-wozniak]]` —
  per-agent identity; Torv has his own equivalent) → per-agent
  identity/relationship state. `share: per-agent`.

Frontmatter override makes it explicit:

    ---
    name: user-profile
    type: user
    share: shared       # facts about Em
    ---

    ---
    name: user-calls-me-wozniak
    type: user
    share: per-agent    # this agent's relationship with Em
    ---

### Migration

Existing memories without `share:` default-derive at read time
per the table above. Lazy migration on natural writeback: when an
agent updates a memory it learned something new about, the
writeback bakes in the explicit `share:` if `type: user`. No
bulk-migration commit; other types adopt defaults silently.

## Conflict resolution — audit-on-conflict, Em-as-resolver

When `mcp.write_memory` is invoked with a `name:` that already
exists in the shared pool AND body differs, **the conflict is
signal, not noise** — two agents who independently converged on
adjacent variants of the same lesson is exactly what the shared
pool exists to capture. Auto-merging loses the signal.

### Mechanism

1. **No auto-merge, no last-write-wins.** Both versions persist
   on disk under conflict-naming (`<name>.conflict.<agent>.md`).
2. **Write a finding** to `audit.run` with `tool=mcp-memory`,
   both versions' diffs, writer agent IDs. Same shape as every
   other audit entry.
3. **Canonical `<name>.md` stays** at whichever version was the
   most recent Em-resolved. Resolution is a manual `mv` +
   close-the-audit-row.
4. **Read side** — agents fetch the canonical version only.
   Conflict variants live in the audit table, never leak into
   agent context as competing guidance.

### Em-as-resolver, explicitly

Resolution is **a human call**, not an automatable rule. Em
reviews conflict findings the same way he reviews any audit
finding; picks canonical or writes a merged version; runs the
resolution. Same separation-of-concerns the demo-route bridge
used ([[wasm-phase-c-spike]]'s §6): foundation surfaces conflicts
honestly, policy layer (Em) decides outcomes. Transparency over
magic; no clever auto-resolution.

## Out of scope (v4+)

- Cross-agent link traversal when `[[memory-B]]` lives in a
  different agent's per-agent pool — undefined; punt.
- Memory deletion semantics across the shared pool — punt.
- Per-memory version history beyond conflict-snapshots — punt.

## Status footer

**Designed, not built.** v3 of the MCP server scope; build is
Torv's lane per [[project-torv-lane]] + the forthcoming
[[project-mcp-server-lane]] memory. The two non-trivial calls
(partition rule + conflict resolution) are frozen here so they
don't drift while v1+v2 ships.

— Woz · current session
