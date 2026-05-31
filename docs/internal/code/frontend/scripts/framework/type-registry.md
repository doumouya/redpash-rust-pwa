---
title: frontend/scripts/framework/type-registry.js
source: ../../../../../frontend/scripts/framework/type-registry.js
owner: Torv
section: Internal · Code · Frontend · scripts · framework
last modified date: 2026-06-01
---

# type-registry.js

## Purpose

The FE-side cache of `/admin/types`. Lazily fetches the backend's TypeDefinition list on first access, caches in memory, exposes typed accessors for the framework primitives (cell-editor, future list-page, future filter-builder) to look up types + fields without re-fetching per call.

Backed by the TypeDefinition spec (`docs/internal/specs/type-definition.md` §4.1) and the live wire shape `Internal-Slack/data/spike-results/typedef-admin-types-live.json`.

## Public surface

```js
import { typeRegistry } from "/scripts/framework/type-registry.js";

await typeRegistry.getType("case");        // → TypeDefinition | null
await typeRegistry.getField("case", "title"); // → FieldDef | null
await typeRegistry.all();                  // → TypeDefinition[]
typeRegistry.invalidate();                 // drop cache; next access re-fetches
```

- `getType(typeId)` — returns the full TypeDefinition or `null` if unknown.
- `getField(typeId, fieldKey)` — convenience for the common dispatch pattern (cell-editor needs a single FieldDef to dispatch on).
- `all()` — for code that needs to enumerate (e.g. a future Admin tab listing all types).
- `invalidate()` — for explicit cache flush; intended to be called after `/admin/fields` PUT since that's the only mutation that affects the served TypeDefinition shape today.

## Drift-prone areas

- **Cache freshness** — `/admin/types` doesn't push invalidations; callers that mutate `/admin/fields` must call `invalidate()` afterwards. Until a real consumer surfaces this need, the registry is fetch-once + manual-flush.
- **Backend wire shape** — must match `docs/internal/specs/type-definition.md` §2. If the backend `TypeList` / `TypeDefinition` DTOs in `shared/src/type_def.rs` change, this module + every consumer breaks.
- **Inflight coalescing** — concurrent first-time accesses share a single inflight Promise so we don't issue duplicate fetches; error path nulls `inflight` so a retry can fire fresh.

## Status

Phase A shipped 2026-06-01. Built-ready, unwired per [[build-ready-dont-wire]] — no consumer in v1 (cell-editor.js extraction lands separately as CAS_8A210C7A).

## Related

- [framework/index](index.md) — landing.
- [TypeDefinition spec](../../../../specs/type-definition.md) — the wire contract.
- [api.js](../api.md) — fetch layer this consumes.
- Cases: CAS_0FBF301F (TypeDefinition L0) / CAS_8A210C7A (first consumer).
- Memory: [[framework-vertical-agnostic]] / [[data-format-open-ended]] (related, post-v1 codec registry).
