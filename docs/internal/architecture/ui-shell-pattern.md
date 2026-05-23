---
title: UI shell pattern (`.rp-shell`)
section: Internal
order: 11
last modified date: 2026-05-24
owner: Torv
status: stub
---

# UI shell pattern

> **TODO (Torv).** Stub. Land content with the next workspace doc pass.

The rail-page shell used by `/home`, `/monitoring`, and `/docs`. Same
markup, opt-in `--wide` modifier for data-dense pages.

To cover:

- The three CSS atoms (`.rp-shell`, `.rp-shell-greeting*`, `.rp-shell-body`, `.rp-shell-main`, `.rp-shell-view`) — what each owns
- The `--wide` modifier — when to opt in vs keep the centred cap
- `.rt-nav` reuse — same component as Workspace's rail; different *semantic* (static groups on Home/Monitoring, dynamic on Workspace)
- The chip-row + list-pager atoms in shell.css — when to use
- How a future page (e.g. Logs, Org) would consume the shell
