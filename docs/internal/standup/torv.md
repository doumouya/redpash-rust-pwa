---
title: Standup — Torv
section: Standup
order: 4
last modified date: 2026-05-21
---

# Standup — Torv

*Docs · REDMAP / INDEX / schema, runbook, references. Newest first.*

## 2026-05-21

- Shipped: cleaner `+` buttons de-modaled — inline picker dropdown
  (`148c93e`); redtable project + file tab strips centred (`6d5d047`);
  cleaner-page **Tab strip** doc synced to both (`73a7d80`).
- Workstream 4 kickoff — built the Excel edge-case **fixture set**: 22
  deliberately dirty, mostly multi-sheet `.xlsx` files in
  `…/Projet Data/excel files/`, reproducible via
  `_generate_excel_edge_cases.py` (openpyxl). Plus the
  [Excel edge-case catalog](../excel-edge-cases/index.md) — 41 classes
  (EXL-01…41), all `open`, mapped to fixture + algorithm.
- Scaffolded this standup log (per-contributor files).
- Next: runbook `0002` for the `parse.rs` 2-column header bug once a fix
  lands; copy a fixture subset into `crates/data/tests/` so `score_dir.rs`
  is reproducible — **needs Em's §4 call** (faithful transcode vs nasty set).
- Heads-up: the 15 `Book1*.xlsx` placeholders in `excel files/` are
  OneDrive-locked — couldn't delete them. Harmless; real fixtures are all
  `xlsx_*.xlsx`. Delete them from Windows when convenient.

<!-- Append newer entries above this line. -->
