---
title: Subsystems — index
section: Internal
order: 20
last modified date: 2026-05-24
---

# Subsystems

The **how it works** — one deep-dive per system. Lives as long as the
system does; rewritten when the system changes shape, not appended.

Most of these belong to Gus's lane (the engine, the routes, the
storage); a few are Torv's (workspace UI shell) or jointly authored.

| Doc | Owner | Status |
|---|---|---|
| [api-routes](api-routes.md) | Gus | stub — route map + auth posture |
| [audit-storage](audit-storage.md) | Gus | stub — audit JSON → DB → diff lifecycle |
| [data-engine](data-engine.md) | Gus | stub — data crate, polars feature matrix, dtype sniff |
| [events-and-logs](events-and-logs.md) | Gus | stub — events capture + request_log + monitoring reads |
| [omnisearch](omnisearch.md) | Gus (backend) + Torv (dropdown) | stub |
| [prefs](prefs.md) | Gus (table) + Torv (SWR + boot) | stub |
| [step-engine](step-engine.md) | Gus | stub — apply / replay / undo / redo / snapshots |
| [wasm-engine](wasm-engine.md) | Gus | stub — wasm-bindgen wrappers + build pipeline |
| [workspace-shell](workspace-shell.md) | Torv | stub — rail + table + filter + tools panels |
