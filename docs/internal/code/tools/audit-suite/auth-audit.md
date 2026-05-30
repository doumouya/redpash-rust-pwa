---
title: tools/auth-audit/audit.js
source: ../../../../../tools/auth-audit/audit.js
owner: Gus
section: Internal · Code · Tools · audit-suite
last modified date: 2026-05-30
---

# auth-audit

## Purpose

Ownership-hygiene scanner — Em-greenlit RBAC prep (2026-05-24): *a
mechanical regression net for ownership hygiene BEFORE the RBAC
workstream lands. RBAC on a leaky surface = leaky RBAC.* Walks every
backend route handler and, for each handler that path-extracts a
resource id, checks that an ownership gate appears before any `db::*`
mutation OR `Json(...)` return. For mutation handlers, checks that
`event::record` fires for the audit trail.

## Public surface

- Scans `backend/crates/api/src/routes/**/*.rs`.
- Emits `report.html` + `audit.json` (ingest-compatible).
- Auto-discovered as `auth`.
- Inline opt-out: `// auth-audit-allow: ownership` / `// auth-audit-allow: audit-trail` on the handler.

## Drift-prone areas

- **Detection of "ownership gate"** keys on `ensure_owner` / `*_owner` helpers. A new ownership-check pattern needs adding to the recognised set.
- **`event::record` detection** is regex over the handler body; obfuscated through a helper fn would slip past.
- The audit prerequires the RBAC workstream's vocabulary; will need a refresh after Phase RBAC lands.

## Related

- [Audit-suite landing](index.md)
- [Subsystem: api-routes](../../../subsystems/api-routes.md)
- [Master runner: audit.sh](../shell/audit.md)
