---
title: 0021 — Rail search returned nothing for an exact file name (project-only match) — made file-aware
date: 2026-06-07
area: frontend/scripts/pages/{workspace,dashboard}.js
---

# 0021 — Rail search was project-name-only; made it file-aware

## Symptom (Em, live)

Typing the **exact name of a file** into the rail search box returned **no results** — on
both Workspace and the Dashboard/designer rail. Em: *"I have no results, even when I type the
exact name … it's working for projects but not for files inside."* His screenshot showed the
chart `matricule_count` plainly visible in an expanded Dashboard group, yet typing
"matricule" emptied the rail.

## Root cause

After the D0' `mountRail` adoption (runbook 0020), each page's `buildGroups()` filtered the
group list by **project name only**:

```js
// workspace.js (pre-fix)
function matchesFilters(p) {
  const ownerOk = ownerFilter === "all" || ownershipTokens(p).includes(ownerFilter);
  const q = railSearchQ.trim().toLowerCase();
  return ownerOk && (!q || (p.name || "").toLowerCase().includes(q));   // ← project name only
}
```

A query that matched no project name dropped the whole group — including any file whose name
*did* match. Two compounding gaps:

1. **No file-name matching.** The query was never tested against file/chart names.
2. **Lazy-load made it worse.** Files load per-group on first expand (`filesByGroup`), so even
   if file matching existed, files inside *collapsed/unloaded* groups weren't in memory to
   match against. Search was silently scoped to whatever happened to be expanded.

## Fix

`buildGroups()` is now **file-aware** on both pages, and search is **global** (loads every
group's files once on query):

- A group shows when its **project name OR any of its files** match `q`.
- A **file-only** match shows that group **expanded with just the matching files**
  (`shown = (q && !nameMatch) ? matchFiles : files`); a name match shows all files.
- `collapsed: q ? false : !expanded.has(id)` — matched groups auto-expand while searching,
  and the real `expanded` set is restored when the query clears.
- New `ensureAllFilesLoaded()` (idempotent, concurrent `Promise.all` over groups missing from
  `filesByGroup`) is fired from `search.onInput` so files inside not-yet-expanded groups also
  match. No prewarm in this path — only the file *names* are needed.
- Empty state: a searched-to-nothing rail shows **"No files or projects match …"** rather
  than a blank rail (`emptyText` into `setGroups`).

Page-specific invariants preserved across the new search path:

- **Workspace** keeps the data-only file filter (`f.file_type !== "chart"/"dashboard"`), the
  hidden-file/hidden-project filters, upload **ghost** tabs, and the per-row **Visualize**
  action. Ghosts are dropped from a *file-only* match (they're not search hits). The dead
  `matchesFilters` helper was inlined into `buildGroups` and removed.
- **Dashboard** keeps the inverse filter (`chart`/`dashboard` only) and stable roster-index
  mark colours.

## Verification

Live (chrome-devtools, `reload ignoreCache:true` — fresh modules past the dev no-cache trap,
CAS_35090747):

- Dashboard: typing **matricule** → group `Workspace` expanded with exactly `matricule_count`.
- Workspace: typing **address** → the previously-**unloaded** `sakila` group appears, expanded
  with `address` (proves the global `ensureAllFilesLoaded` path).
- Project-name search (`employees`) still returns both employees groups — no regression.
- No-match query → "No files or projects match …"; clearing restores the full 7-group roster.

`node --check` both pages · `page-verify --pages workspace,dashboard` PASS · doc-coverage clean
(both atomic docs updated in the same commit).

## Lesson

A lazy-loaded list makes "search" quietly **scope-limited to what's loaded** — the feature
looks present but only covers the expanded subset. When adding search over a lazily-hydrated
collection, the query handler must **hydrate the whole collection first** (or search the
server), not just filter the in-memory slice. Sibling of [[feedback_ui_equals_backend]] (a
UI search that silently under-covers is a real bug, not cosmetic).
