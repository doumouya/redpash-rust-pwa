---
title: Internal · Code · Frontend · scripts/pages — atomic docs
section: Internal · Code · Frontend · scripts · pages
order: 11
last modified date: 2026-05-30
---

# scripts/pages — atomic docs

One controller per route partial. The hash router in
[`../main.md`](../main.md) wires the partial fetch + controller mount.
**LEAN build** — a personal single-user data tool, cut to the data surfaces
(workspace / dashboard / sheetwise / monitoring) + login. Monitoring keeps its
sub-page modules under its own subdir.

## Page controllers (root)

| File | Atomic doc | Route | Role |
|---|---|---|---|
| `login.js` | [login.md](login.md) | `#/login` | sign-in landing (dev-login front door) + CSV demo upload (client-side WASM) |
| `workspace.js` | [workspace.md](workspace.md) | `#/workspace` | the unified surface — cleaner + report builder + designer + dashboard builder |
| `dashboard.js` | [dashboard.md](dashboard.md) | `#/dashboard` | chart + dashboard designer |
| `sheetwise.js` | [sheetwise.md](sheetwise.md) | `#/sheetwise` | read-only SQL console + connector pulls |
| `monitoring.js` | [monitoring.md](monitoring.md) | `#/monitoring` | rail-shell, observability tabs |

## Sub-page subdirs

These have multi-file controllers — usually one main controller + tab/section sub-controllers.

- [`monitoring/`](monitoring/) — per-tab paint + tabs.js (MON_TABS + MON_GROUPS)

## Related

- [Scripts pillar landing](../../index.md)
- [Subsystem: workspace-shell](../../../../subsystems/workspace-shell.md)
- [Architecture: ui-shell-pattern](../../../../architecture/ui-shell-pattern.md)
