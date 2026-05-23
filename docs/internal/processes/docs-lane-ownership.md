---
title: Docs lane ownership
section: Internal
order: 52
last modified date: 2026-05-24
owner: Torv
status: stub
---

# Docs lane ownership

> **TODO (Torv).** Formalise the rule minted 2026-05-23 — captured initially as a feedback memory `[[feedback_docs_lane_ownership]]`.

The rule: at docs-refresh time, distribute updates by lane ownership
rather than centralising under one editor. Each agent is the SME for
their own lane's docs; inconsistencies surface when each slice is
written by whoever's closest to the code.

To cover:

- **The lane map** (also in [`../index.md`](../index.md))
- **The "one slice per agent" review discipline** at refresh time
- **What goes public vs internal** — feature docs in `docs/`, why/how/wire in `docs/internal/`
- **How to spot a doc that's drifted out of lane** (e.g. a Torv doc making claims about the data crate's polars features)
- **The escalation when lanes overlap** — co-authored docs (omnisearch, prefs) get a line per author at the top
