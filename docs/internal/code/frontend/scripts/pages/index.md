---
title: Internal · Code · Frontend · scripts/pages — atomic docs
section: Internal · Code · Frontend · scripts · pages
order: 11
last modified date: 2026-05-30
---

# scripts/pages — atomic docs

One controller per route partial. The hash router in
[`../main.md`](../main.md) wires the partial fetch + controller mount.
Large pages (cases, home, monitoring) have sub-page modules under their
own subdir; small ones (login, docs, profile, settings) are single
files.

**Coverage at baseline (2026-05-30):** 8+ atomic units across this dir
and its 3 sub-page subdirs.

## Page controllers (root)

| File | Atomic doc | Route | Role |
|---|---|---|---|
| `login.js` | [login.md](login.md) | `#/login` | sign-in landing + CSV demo upload (client-side WASM) |
| `docs.js` | [docs.md](docs.md) | `#/docs` + `#/docs/<slug>` | markdown viewer |
| `home.js` | [home.md](home.md) | `#/home` | authenticated landing — rail-shell + LIST_VIEWS tabs |
| `monitoring.js` | [monitoring.md](monitoring.md) | `#/monitoring` | rail-shell, observability tabs (Requests/Events/Runs/Findings/Steps/Charts/Optimization/User Activity) |
| `workspace.js` | [workspace.md](workspace.md) | `#/workspace` | the unified surface — cleaner + report builder + designer + dashboard builder |
| `profile.js` | [profile.md](profile.md) | `#/profile` | identity card, usage strip, plan |
| `settings.js` | [settings.md](settings.md) | `#/settings` | UI preferences, sentinel chips, About row |
| `cases.js` | [cases.md](cases.md) | `#/cases` | kanban + detail page |

## Sub-page subdirs

These have multi-file controllers — usually one main controller + tab/section sub-controllers.

- [`cases/`](cases/) — cases-page sub-modules (kanban paint, detail render, comments)
- [`home/`](home/) — per-tab list-view configs
- [`monitoring/`](monitoring/) — per-tab paint + tabs.js (MON_TABS + MON_GROUPS)

## Related

- [Scripts pillar landing](../../index.md)
- [Subsystem: workspace-shell](../../../../subsystems/workspace-shell.md)
- [Architecture: ui-shell-pattern](../../../../architecture/ui-shell-pattern.md)
