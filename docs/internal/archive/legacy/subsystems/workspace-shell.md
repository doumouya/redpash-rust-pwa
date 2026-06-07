---
title: Workspace shell
section: Internal
order: 29
last modified date: 2026-05-24
owner: Torv
status: stub
---

# Workspace shell

> **TODO (Torv).** Fill after the step-history UI lands.

To cover:

- The four-pane layout: rail (`.rt-nav`) + toolbar + body (table or chart) + side panels (filter, tools)
- Rail: project groups + file tabs; lazy load on group expand; deep-link via `#/workspace?project=<rid>`
- Toolbar: filter toggle + search + mode buttons + undo/redo/refresh + rownum + rows-per-page + columns + export + tools toggle
- State: `activeFileRid`, `activeColumns`, `activeSteps`, `currentPage`, `pageSize`, `sortKeys`, `activeFilter`, `searchQ`
- Server-side filter + sort + search via `PageQuery.{filters, sorts, q}` (post-WS#2)
- Edit / delete via step engine (`set_cell`, `drop_rows`)
- Wasm warm-up: `getEngine()` fire-and-forget at mount
- Upload: multipart POST → refresh rail → auto-open new file
- See also: [architecture/redtable-unification.md](../architecture/redtable-unification.md) for the WS#5 target
