---
title: Internal · Code · Frontend · scripts/tools — atomic docs
section: Internal · Code · Frontend · scripts · tools
order: 13
last modified date: 2026-05-30
---

# scripts/tools — atomic docs

Frontend-side cleaning-tool catalog. The Workspace's tools panel reads
from here: `catalog.js` declares every tool kind (snake_case_columns,
fill_nulls, replace_text, …); `actions.js` declares the GLOBAL +
SELECT action wiring; `fields.js` renders the per-tool param fields in
the cleaning-modal sheet.

**Coverage at baseline (2026-05-30):** 3 atomic units, 0 documented.

## Files

| File | Atomic doc | Role |
|---|---|---|
| `catalog.js` | [catalog.md](catalog.md) | `TOOLS` — every cleaning-tool kind with its label, icon, blurb, fields |
| `actions.js` | [actions.md](actions.md) | `GLOBAL_ACTIONS` (4) + `SELECT_ACTIONS` (9) — the action sets the cleaning toolbar exposes |
| `fields.js` | [fields.md](fields.md) | per-type field renderers (text, enum, column-picker, multicolumn, boolean) |

## Related

- [Scripts pillar landing](../../index.md)
- [Subsystem: step-engine](../../../../subsystems/step-engine.md)
- [Object: step kinds catalog](../../../../../objects/step.md)
