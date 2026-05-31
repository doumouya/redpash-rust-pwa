---
title: frontend/scripts/framework/
source: ../../../../../frontend/scripts/framework/
owner: Torv
section: Internal · Code · Frontend · scripts · framework
last modified date: 2026-06-01
---

# framework

## Purpose

The vertical-agnostic FE primitives — modules that consume a `TypeDefinition` (from `/admin/types`) and produce list / edit / chip / form UI without knowing what type they're rendering. Lifted out of page-bound implementations (today: `pages/home.js` cell-editor closures) so the same primitives work on CRM today + every future vertical's TypeDefinitions tomorrow.

Strategic frame: [[decades-of-innovation]] — RedPash ships CRM as the first embodiment; the framework primitives are what every other vertical reuses. The cross-vertical bar applies: every primitive here must work for company / case today AND for fake `RealEstateListing` / `BankingAccount` / `KafkaEvent` tomorrow with zero source changes.

## Public surface (v1)

- [type-registry.js](type-registry.md) — fetch + cache `/admin/types`, expose `getType(id)` / `getField(typeId, key)` / `all()` / `invalidate()`.
- [editor-registry.js](editor-registry.md) — open editor registry. `register({ id, buildOn, buildOff, readValue })` + `lookup(id)` with universal `text` fallback.
- [editor-text.js](editor-text.md) — registers `text`. Contenteditable + data-full / data-trunc / data-prefix render rules.
- [editor-chip-enum.js](editor-chip-enum.md) — registers `chip-enum`. `<select>` swap, chip-render dispatch via `ctx.renderChip`.
- [editor-entity-picker.js](editor-entity-picker.md) — registers `entity-picker`. Text input + rid resolution (search wiring pending real consumer, see [[build-ready-dont-wire]]).

## Public surface (planned, not in v1)

- `cell-editor.js` — the orchestrator. Consumes a `TypeDefinition` + a row, decorates editable cells, dispatches edit-mode on/off to `editorRegistry.lookup(field.editor)`. Extracted from `pages/home.js` per CAS_8A210C7A.
- `chip-registry.js` — open chip-render registry (parallel pattern to editor-registry). Lands with the chip-render contract hardening per CAS_BF208AA8.
- `list-page.js` (long-horizon) — auto-build a list tab from a TypeDefinition + `ui_hints.default_columns`.
- `filter-builder.js` (long-horizon) — emit query AST from a TypeDefinition's `fields[]` (per [[redtable-query-builder]]).

## Architecture (spec lineage)

The TypeDefinition contract is fixed by [`docs/internal/specs/type-definition.md`](../../../../specs/type-definition.md) v1 (commit 24ac527 + collaborative-row amendment 38825d9). Backend serves `/admin/types` per §4.1; FE primitives here are the spec's §5 (presentation) + §7.2 (FE implementation sequence) being shipped.

§5 disposability rule that this folder enforces: **backend treats `editor` as an opaque string + never validates against an FE-known list**. The FE editor-registry's universal `text` fallback is the safety net — an unknown editor id silently downgrades to text, never fails the cell. Customer-supplied editors register the same way as v1 builtins; no backend deploy required.

## Drift-prone areas

- **TypeDefinition wire shape** — fixed by `docs/internal/specs/type-definition.md`. Any change to `/admin/types` response shape must update the spec + this folder's consumers in lockstep.
- **Editor contract** — `{ id, buildOn, buildOff, readValue }` per spec §5.2. New editors must implement all four; the editor-registry validates on `register()`. The `ctx` object is editor-specific + lives in the editor's atomic doc.
- **Universal `text` fallback** — every framework consumer relies on `editor-text.js` being imported before any other editor. Missing-`text` is a hard error not a graceful downgrade (the registry will return null on lookup). cell-editor.js when extracted must import `editor-text.js` first.

## Status

Phase A shipped 2026-06-01 — 5 modules + this index. Built-ready, unwired per [[build-ready-dont-wire]]: the primitives compile + register; the consumer (`cell-editor.js`, CAS_8A210C7A) lands separately + rewires `home.js` to consume the framework instead of its closures.

## Related

- [TypeDefinition spec](../../../../specs/type-definition.md) — the wire contract this folder consumes.
- [home.js atomic doc](../pages/home.md) — current consumer of the closure-form cell-editor; rewired when CAS_8A210C7A lands.
- Memory: [[framework-layer]] / [[disposability-design-principle]] / [[framework-vertical-agnostic]] / [[data-format-open-ended]] / [[decades-of-innovation]] / [[build-ready-dont-wire]].
- Cases: CAS_0FBF301F (TypeDefinition L0 contract) / CAS_8A210C7A (cell-editor extraction) / CAS_75A0D1FD (v1.1 codec registry, post-v1) / CAS_BF208AA8 (chip-render hardening, bundled with cell-editor).
