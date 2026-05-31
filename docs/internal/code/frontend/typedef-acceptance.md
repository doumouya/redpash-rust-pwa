---
title: frontend/typedef-acceptance.html + .js
source: ../../../../frontend/typedef-acceptance.html
owner: Torv
section: Internal · Code · Frontend
last modified date: 2026-06-01
---

# typedef-acceptance

## Purpose

§6 acceptance harness for CAS_0FBF301F TypeDefinition spec. The **disposability gate**: feed a fake `RealEstateListing` TypeDefinition the framework has never seen through the shipped primitives (`type-registry` / `editor-registry` / `cell-editor` / 3 editors) and prove the §6.2 bullets hold with **zero source changes**.

Standalone harness page — does NOT go through the SPA router, no auth, no `/api/admin/types` call. The fake TypeDefinition is supplied entirely in JS; framework primitives consume it as if the wire had served it. Same shape model as `frontend/wasm-bench.html` (the Phase C perf bench).

This is the **end-of-v1** proof. Phase A (primitives) + Phase B (cell-editor extraction) + Phase C (this) close out CAS_0FBF301F's §7.2 FE implementation sequence.

## How to run

1. `cargo run -p api` (serves `frontend/` statically; framework modules at `/scripts/framework/*`).
2. Open `http://localhost:8088/typedef-acceptance.html`.
3. Click **▶ Run §6 acceptance** — 12 bullets fire, pass/fail surface in the results panel.
4. The result object is also written to `window.__acceptanceResult` (for Playwright + CI hooks).

## What the harness verifies (FE-side §6.2 bullets)

| # | §6.2 bullet | Editor / behavior tested |
|---|-------------|--------------------------|
| 1 | address dispatches to text | editor-registry resolves `text`, buildOn sets contenteditable |
| 2 | list_price dispatches to text | same — different field, same editor |
| 3 | status dispatches to chip-enum | `<select>` swap, options=`[active, pending, sold]`, current pre-selected |
| 4 | listed_at NOT decorated | `editable: false` + `perm_class: readonly` → skipped |
| 5 | agent_id dispatches to entity-picker | text input + `data-relType="user"` + placeholder |
| 6 | data_full on description shows full text in edit-mode | buildOn expands `data-full` into textContent |
| 7 | (toggle off, fires the 5 remaining strip-mode bullets) | — |
| 8 | data_full + data_trunc render rules survive edit-mode toggle | text editor buildOff re-truncates to data_trunc |
| 9 | chip-enum buildOff restores chip via chipRender callback | the renderChip ctx callback path |
| 10 | entity-picker buildOff falls back to raw rid when renderRid not provided | the no-ctx default render path |
| 11 | §5.1 disposability — unknown editor id silently downgrades to text | the universal fallback (`editorRegistry.lookup` returns text on unknown id) |
| 12 | customer-supplied editor (fictional `quantum_state`) dispatches with zero source changes | `editorRegistry.register(...)` at runtime; the §6.2 cross-vertical bar made concrete |

## What this harness does NOT verify

Backend §6.2 bullets — they require the future custom-object PATCH endpoint that consumes a TypeDefinition (today's per-resource PATCH handlers don't):

- Write to `list_price` with `"abc"` → 400 per §4.2 data_type validation.
- Write to `status` with `"draft"` → 400 (not in options).
- Write to `agent_id` with a non-existent rid → 404.
- `listed_at` is read-only at every tier per `perm_class: readonly`.
- `agent_id` is owner-write only per `perm_class: owner_grade`.

Per [[build-ready-dont-wire]] — `field_validate.rs` (f2e88e2) is built-ready but unwired into per-resource handlers; the backend acceptance test runs when the custom-object PATCH endpoint lands (a v1.1 backend slice). The FE proof is what's testable today.

## Drift-prone areas

- **chipRender callback contract** — the harness's `stageChip` returns an HTML string (matches editor-chip-enum.buildOff's current contract). CAS_BF208AA8 hardens both renderer + buildOff to DOM-node-returning; this harness will follow that change in lockstep.
- **DOM shape expected by `cellEditor.decorate`** — `#rp-home-list-tbody` + `tr[data-rid]` + thead `th[data-col-key]`. Inherited from home.js's redtable. A future generic `list-page.js` will parameterize this; the harness has to follow.
- **Pure-DOM construction discipline** — buildRow + renderResults use `createElement` + `textContent` + `appendChild`, NO innerHTML. The chipRender path still uses innerHTML internally (in editor-chip-enum.buildOff per the current framework contract — gap closed by CAS_BF208AA8).

## Status

Phase C shipped 2026-06-01. v1 §6 acceptance closes CAS_0FBF301F's FE implementation sequence; v1 is **end-to-end provable** from this point. The harness stays as a regression guard — every future framework change re-runs it.

## Related

- [TypeDefinition spec §6](../../specs/type-definition.md) — the source of truth for the bullets.
- [framework/cell-editor](scripts/framework/cell-editor.md) — the orchestrator under test.
- [framework/editor-registry](scripts/framework/editor-registry.md) — the universal-fallback target.
- [framework/index](scripts/framework/index.md) — the framework landing.
- Cases: CAS_0FBF301F (parent / spec) / CAS_8A210C7A (Phase B extraction, this harness validates the extraction) / CAS_75A0D1FD (v1.1 codec registry, next) / CAS_BF208AA8 (chip-render hardening, follows in lockstep).
- Memory: [[disposability-design-principle]] / [[framework-vertical-agnostic]] / [[decades-of-innovation]] / [[build-ready-dont-wire]].
