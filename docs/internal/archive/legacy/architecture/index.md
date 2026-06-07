---
title: Architecture — index
section: Internal
order: 10
last modified date: 2026-05-26
---

# Architecture

The **why** of RedPash. Each doc here captures a design choice that
binds future work — supersession moves the doc to `archive/`, not
edit-in-place. New decisions land as new files; revisions retitle
+ link back to the predecessor.

| Doc | What it locks |
|---|---|
| [js-rust-boundary](js-rust-boundary.md) | Rust owns data, JS owns pixels; no JS data engine; wire is the only boundary |
| [object-model](object-model.md) | 2 entities (Project, File); one `project_files` table for every file kind; stage computed via the `file_stages` view |
| [redtable-unification](redtable-unification.md) | WS#5 — one `.rt-surface` atom, three consumers (Workspace, Monitoring lists, Home admin tabs) |
| [data-shape-index](data-shape-index.md) | 3-redtable model (cols × stats / cols × distinct / rows × quality) + PWA-FS data-plane abstraction; the data layer underneath the redtable atom |
| [columns-redtable](columns-redtable.md) | Table 1 of the data-shape index as a UI — cleaning tools as a redtable toolbar |
| [roadmap-webassembly](roadmap-webassembly.md) | WASM phasing; runtime-neutral DTOs as a hard rule |
| [ui-shell-pattern](ui-shell-pattern.md) | `.rp-shell` rail-page layout; `.rp-shell--wide` modifier; consumed by `/home` and `/monitoring` |

## Snapshots

Snapshots are dated point-in-time reads of the codebase against a
locked architecture doc above. They don't bind future work — they
record where we are, flag what's drifted, and propose follow-ups.
Rerun + supersede when the next big move in that layer lands.

| Snapshot | What it reads |
|---|---|
| [objects-survey-2026-05-26](objects-survey-2026-05-26.md) | All 16 `shared::*` DTO modules vs the locked object-model — 12 clean, 4 carry comment-only drift, 0 broken. Four-diff fix shape + audit-tool proposal. |
| [edge-compute-tradeoffs-2026-05-27](edge-compute-tradeoffs-2026-05-27.md) | Honest framing of what client-side parse + rescue actually buys vs. the marketing-style "$0 / zero-trust / serverless-routing" pitch. Real moat is the `unwrap_csv` rescue heuristic; WASM is implementation, not product. Phase D is the unlocked question. |
