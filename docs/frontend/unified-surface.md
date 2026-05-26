---
title: Unified surface
section: Frontend
order: 6
last modified date: 2026-05-26
---

# Unified surface — RedPash as one window

> **Future milestone — a later prerelease.** Not current scope. The
> four pages (Cleaner, Designer, Publisher, and the browse surface)
> ship and harden first; the unified surface composes them afterwards.
> This doc locks the *concept* so it can't drift — the same reason the
> [object model](../objects/object-model.md) was written down.

## The idea

What if RedPash were a single window — like Excel or Google Sheets —
instead of a set of separate pages? One redtable surface hosts the
whole app: you upload, clean, design charts, and publish dashboards
without ever leaving it. Tabs, not page loads, move you around.

Mockup: `redpash-components/redpash-demo/redtable/redtable-page.html`.

## Two tab rows

The surface has two stacked rows of tabs, and they behave differently —
that distinction is the heart of the design.

### Parent tabs — isolation

The top row. One tab per object type — Projects, Files, Charts,
Dashboards, Events, Cases… Each parent tab is an **isolated context**:
its own schema, its own filter / sort / selection state. Switching
parent tabs switches *what you are looking at* entirely; nothing leaks
across the boundary.

The row is **per-user** — each tab carries a remove (×), and a trailing
"+" adds back any hidden type. A support user keeps Events / Cases; an
HR user drops them. Everyone organises their own redtable.

### Child tabs — shared data

The second row, inside a parent context. One tab per item in the
current dataset — e.g. inside a project: an Overview tab plus one tab
per file. Child tabs **share the same underlying data**: flipping
between file tabs is moving within one project, not loading a new
world.

So the rule is: **parent tabs isolate, child tabs share.**

## One panel, swapped tools

There is a single shared redtable panel (`.rp-rt-panel`) — it is not
duplicated per page; surfaces *borrow* it. Two side panels re-tool it
in place:

- **Left** — `Filters` (predicate filter) · group-by / matrix /
  aggregation / window / Top-N tools.
- **Right** — `Tools` (the cleaning toolset) · `Charts`.

The same data surface is the **Cleaner** or the **Designer** depending
on which side-panel tab is live. Cleaner and Designer stop being
separate pages and become tool modes over one table.

## Component inventory

The surface is a small, stable set of **atoms** dropped into a fixed
**skeleton**. This is the factorisation that makes it cheap to build
and fast to rebuild — you assemble known parts, you don't redesign.

**The skeleton** — structural slots, top to bottom:

| Slot | Holds |
|------|-------|
| Topbar | glass buttons |
| Parent-tabs | the tab strip + a `(+)` icon → dropdown with autocomplete (adds an object-type tab) |
| Header | title · glass buttons · cleanness-score component |
| Child-tabs | the second tab row |
| Toolbar | search input · glass buttons · pill-shape dropdowns |
| Left panel | filter |
| Right panel | tools / charts |
| Body | panel components · table data rows |
| Pagination | page strip |

**The atoms** — reused across every slot: glass button · pill-shape
dropdown · search input · `(+)` autocomplete dropdown · cleanness-score
component · table data row.

## Why the object model makes this cheap

The [locked object model](../objects/object-model.md) is the engine for
this. Because every artifact is a typed row in the one `project_files`
table, a parent tab is just a filter:

```
Charts tab      →  project_files WHERE file_type = 'chart'
Dashboards tab  →  project_files WHERE file_type = 'dashboard'
Files tab       →  project_files WHERE file_type = 'csv'
```

Those are exactly the *Designer view* and *Publisher view* the object
model already defines. Separate `reports` / `dashboards` tables would
have forced every parent tab to carry its own schema and query path;
one table makes the whole one-window surface a `WHERE` clause.

## Status & sequencing

- **Now** — the dual-tab rows already exist in the Cleaner and the
  Designer. That is the seed of this surface, not throwaway UI.
- **Next** — finish and harden the four pages as standalone surfaces
  (Cleaner, Designer, Publisher, browse).
- **This milestone** — compose them into the single window.
- **Deferred into this milestone** — the tab CSS rename
  (`rp-tab` / `rp-sub-tab`, parent isolates child) and the resolution
  of the current CSS drift. Both belong here, not as a piecemeal pass
  beforehand.

Park until the four pages are solid.
