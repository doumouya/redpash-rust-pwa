---
title: CSV filesystem
section: Frontend
order: 7
last modified date: 2026-05-22
---

# CSV filesystem — a RedPash project as a folder of CSVs

> **Canary — brainstorm, not scope.** This page exists to *open* an
> idea, not lock one. Nothing here is committed. And remember
> `redtable-pro-max`: an idea that grew teeth before it proved itself
> nearly took the whole project down. So this stays a canary — small,
> caged, watched — until it earns a real spec.

## The idea

A RedPash project is *conceptually* a folder — the
[object model](../objects/object-model.md) says exactly that. What if
it could be **literally** a folder?

A project exports as a plain directory on disk:

```
Q4-sales/
├── contents.csv          ← the listing — one row per child, self-describing
├── raw-dossier.csv       ← the data files
├── clients-clean.csv
├── charts/
│   ├── contents.csv
│   ├── revenue-by-region.svg
│   └── revenue-by-region.json   ← the chart's ECharts option
└── dashboards/
    ├── contents.csv
    └── q4-overview.svg
```

The twist that makes it *RedPash*: the listing file is **itself a CSV**.
RedPash is a CSV tool — so its own project metadata is CSV, recursively.
The tool dogfoods its own format. `contents.csv` carries one row per
child — name, `file_type`, `updated_at`, `source_file_id` (the DAG
edge) — and it opens in Excel like any other CSV.

## Why it's worth a look

- **Identity.** "A CSV tool whose projects are themselves folders of
  CSVs" is a coherent, dogfooded story.
- **Portability.** A project becomes a plain folder — readable in any
  spreadsheet, syncable to Dropbox / git, handable to someone who's
  never heard of RedPash. The whole project stays legible without the
  app.
- **It's the natural export format** the day "native app", "PWA
  filesystem access", or "open a RedPash project from disk" becomes a
  real ask.

## The discipline — what this is NOT

This idea has a known way to kill itself. Stating it loudly up front:

- **Not a live storage layer.** Postgres stays the single source of
  truth. The CSV filesystem is a **read projection**, generated
  on-demand — never a dual-write.
- **The sync trap.** Dual-writing CSVs on every mutation means keeping
  Postgres and disk in lockstep — concurrent writes, schema evolution,
  partial failures. That is the blocker that parked this idea the first
  time round. Don't reopen it.
- **Not a speed play.** localStorage SWR caching already covers
  perceived speed. This is about the *artifact*, not latency.
- **Export-first.** Generating a folder is safe. *Importing* an edited
  folder back into Postgres reopens the entire sync problem — treat
  round-trip as a separate, much-later question (and maybe never).

## Open questions (the actual brainstorm)

- **`contents.csv` schema** — what columns? `name, file_type,
  updated_at, source_file_id, cleanness_pct`? One flat manifest at the
  root, or a `contents.csv` nested per subdirectory?
- **Charts on disk** — a chart is a chart-typed `project_files` row
  carrying an ECharts `option` + an SVG snapshot. Write both
  (`name.svg` + `name.json`)? Just the SVG? Does keeping the
  option-JSON make the folder re-importable later, or is that a trap?
- **The DAG edge** — `source_file_id` is how a chart points at its data
  file. In a flat folder that's just a column in `contents.csv` — but
  for a human reading the folder, is a relative path friendlier than a
  raw `FIL_` id?
- **Grouping** — sub-folders for the chart / dashboard groupings.
- **Generation mechanics** — `GET /api/projects/:rid/export` → a
  `.zip`? Or stream straight into a target directory via the PWA
  filesystem API?
- **Naming** — the locked model retired "report"; the folder names
  should follow it (`charts/`, `dashboards/`), not `reports/`.

## Status & sequencing

Canary. Pure brainstorm — no scope, no estimate, no owner.

**Trigger to revisit:** native-app / PWA-export becomes a real roadmap
item. Building it before then is premature — the artifact has no
consumer yet.

Until then: park it, and let the idea sit in the cage where we can keep
an eye on it.
