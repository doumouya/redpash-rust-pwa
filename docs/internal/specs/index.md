---
title: Specs — index
section: Internal
order: 30
last modified date: 2026-05-24
---

# Specs

The **what** — current wire contracts, schemas, surface plans.
Rewritten when the contract changes; superseded versions move to
`archive/`. Each spec is the source of truth for the wire it describes.

| Doc | Owner | What it pins |
|---|---|---|
| [admin-monitoring-surfaces](admin-monitoring-surfaces.md) | Torv | `/home` + `/monitoring` IA, endpoint list, shell pattern shared between them |
| [filter-dto](filter-dto.md) | Gus | `FilterNode` / `FilterOp` canonical — workspace filter UI + step engine + wasm wrapper all share |
| [monitoring-schemas](monitoring-schemas.md) | Gus | `events`, `request_log`, `audit.run`, `audit.finding` table shapes + wire projections |
| [optimization-map](optimization-map.md) | Gus | `optimization_points` table + live-measurement evaluator + Monitoring/Optimization tab wire |
| [user-preferences](user-preferences.md) | Gus | `user_preferences` table + PATCH protocol + key registry |
| [datasource-trait](datasource-trait.md) | Gus | DataSource / Entity / Reader trait sketch for the ETL-ELT workstream. **Status: sketch, no code lands from this doc** — alignment surface before the [[etl-elt-roadmap]] workstream picks it up. |
