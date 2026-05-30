---
title: Internal · Code · Tools · one-off — atomic docs
section: Internal · Code · Tools · one-off
order: 23
last modified date: 2026-05-30
---

# tools/{css-parallel, css-usage, csv-to-xlsx-rs} — atomic docs

Small one-off tools that don't fit the auto-discovered audit-suite or
shell-script categories. Either utilities (csv-to-xlsx-rs) or
specialized analyzers (the two css-* tools that extract specific
analyses from the wider `css-audit`).

**Coverage at baseline (2026-05-30):** 3 atomic units, 0 documented.

## Tools

| Dir | Atomic doc | Role |
|---|---|---|
| `css-parallel/` | [css-parallel.md](css-parallel.md) | parallel-CSS analyzer; extracted from `css-audit` for focused tracking of page-prefixed parallel classes |
| `css-usage/` | [css-usage.md](css-usage.md) | CSS-class-usage extractor: every selector + where it's consumed in HTML/JS |
| `csv-to-xlsx-rs/` | [csv-to-xlsx-rs.md](csv-to-xlsx-rs.md) | Rust-native CSV → XLSX converter; the seed of the export-to-xlsx workstream |

## Related

- [Tools pillar landing](../index.md)
- [Audit-suite siblings](../audit-suite/index.md) — the larger family these tools relate to
