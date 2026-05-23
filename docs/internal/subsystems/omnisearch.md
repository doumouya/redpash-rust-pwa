---
title: Omnisearch
section: Internal
order: 25
last modified date: 2026-05-24
owners: Gus (backend) + Torv (dropdown UI)
status: stub
---

# Omnisearch

> **TODO (Gus).** Backend half: `routes/search.rs`, query shape, ranking.
> **TODO (Torv).** Frontend half: dropdown wiring in `topbar.js`, debounce, AbortController, keyboard nav.

To cover:

- The single `/api/search?q=&limit=` endpoint that powers the topbar omnibox
- Wire shape: `{ q, ms, results: [{ kind, rid, label, sub, hash }] }` — pre-built navigation hashes per result
- Ranking: prefix-match boost, kind grouping, limit
- Frontend dropdown: 200ms debounce, AbortController on each call (out-of-order safety), kind-grouped section headers, keyboard nav (↓/↑/Enter/Esc)
- Slice 3 (planned): nav shortcuts + actions, additive `kind` values, dispatch via the topbar action map — design captured in Gus.md
