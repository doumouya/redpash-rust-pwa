---
title: frontend/scripts/autocomplete.js
source: ../../../../frontend/scripts/autocomplete.js
owner: Torv
section: Internal · Code · Frontend · scripts
last modified date: 2026-05-30
---

# autocomplete.js

## Purpose

Typeahead + chip-picker atom backed by column-index.js distinct-values cache. Two consumer surfaces (filter-predicate single-value inputs + the chip-picker multi-value input) share one debounced suggestion engine.

## Public surface

- attachAutocomplete(input, ctx) — single-value typeahead.
- attachChipPicker(host, ctx) — multi-value with chip render.
- Both back-pressure through column-index for fetched values.

## Drift-prone areas

- column-index API shape; suggestion-render markup also referenced by CSS atoms (.rt-suggestion-*).

## Related

- [Frontend pillar landing](../../index.md)
