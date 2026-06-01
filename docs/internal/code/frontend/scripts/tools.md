---
title: frontend/scripts/tools.js
source: ../../../../frontend/scripts/tools.js
owner: Torv
section: Internal · Code · Frontend · scripts
last modified date: 2026-05-30
---

# tools.js

## Purpose

Cleaning tools — the workspace tools panel, parameterised. One factory + N tool configs + a single form renderer composing 5 field-type renderers. Master/detail loop: list -> click -> form -> Apply -> POST /api/files/:rid/steps -> response file envelope -> table re-render without refetch.

Every tool sheet also offers **Preview**: `buildSheetSteps()` (the single step-list builder both Apply and Preview share) is dry-run via `POST /steps/preview`, the per-step `FrameDiff`s merged, and `renderStepPreview()` shows a Before|After diff panel; the user then commits (Apply) or backs out. This is the generalisation of the cast-only confirm (`renderCastConfirm`) to every tool — the restored "preview before you agree" feature.

## Public surface

- mountTools(panelBody, ctx) — mounts the columns-redtable + cleaning toolbar.
- Composes tools/{catalog, actions, fields}.js.
- Returns { refresh }.

## Drift-prone areas

- Step kind strings must match server data::steps::apply() dispatcher arms verbatim.
- `buildSheetSteps()` is the single source for the four apply branches (perColumn / mapCols / select / global); Apply and Preview MUST both route through it so they can't diverge.
- The preview diff shape (`FrameDiff`) is produced by `data::stats::diff_frames`; field names are a backend↔frontend seam.

## Related

- [Frontend pillar landing](../../index.md)
