---
title: Architecture — index
section: Internal
order: 10
last modified date: 2026-05-24
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
| [roadmap-webassembly](roadmap-webassembly.md) | WASM phasing; runtime-neutral DTOs as a hard rule |
| [ui-shell-pattern](ui-shell-pattern.md) | `.rp-shell` rail-page layout; `.rp-shell--wide` modifier; consumed by `/home` and `/monitoring` |
