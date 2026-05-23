---
title: 0003 — Dead reference after function deletion
section: Internal
order: 3
last modified date: 2026-05-24
---

# 0003 — Dead reference after function deletion

**Date:** 2026-05-24 · **Area:** frontend / Workspace · **Status:** resolved (commit `8f8c4b0`)

## Problem Statement

Clicking any file tab in the Workspace rail flashed *"Couldn't load
file."* into the table area. Changing rows-per-page recovered the
table for that file. Clicking a different file repeated the failure;
clicking back to the original file repeated it again.

Backend logs showed no 4xx / 5xx for `/api/files/:rid` — the request
either succeeded or never landed. Browser console showed a silent
`ReferenceError`.

## Troubleshooting steps

1. **Reproduced the loop** — every fresh `loadFile(rid)` failed; only
   `refetchPage()` succeeded.
2. **Compared the two call paths.** `refetchPage` calls
   `fetchAndRender()` only. `loadFile` does more:

   ```js
   activeColumns = envelope?.columns || [];
   activeSteps   = envelope?.steps   || [];
   syncToolbar();
   ...
   rebuildColsDropdown(activeColumns);
   rebuildFilterCols(activeColumns);   // ← suspect
   await fetchAndRender();
   ```

3. **Narrowed to `rebuildFilterCols`** by elimination — the steps
   `refetchPage` skips were the candidates.
4. **Inspected the function:**

   ```js
   function rebuildFilterCols(columns) {
     filterCols = columns.map((c, i) => [i + 3, c.name]);
     groupList.innerHTML = "";
     groupCombo = "AND";
     activeFilter = null;
     if (filterCols.length) addGroup();
     refresh();                          // ← dead reference
   }
   ```

5. **`refresh()` no longer existed** — deleted in WS#2 (commit
   `11c2ca6`) along with `passFilter` / `passSearch` / `applySort`
   when the client-side data engine moved server-side.

## RCA

WS#2 swept out four client-side data-engine functions (`refresh`,
`passFilter`, `passSearch`, `applySort`). The sweep grepped for the
function definitions and their explicit call sites in the
filter-Apply / search-input / sort-header handlers — and patched all
of those.

It missed `rebuildFilterCols`'s tail call to `refresh()`. The miss
slipped because the function's name describes WHAT it rebuilds
(filter columns) not WHAT IT TRIGGERS at the end (a re-render of the
loaded rows). A name-based grep for "refresh" inside files I touched
in the WS#2 PR would have caught it; the grep I actually ran was for
the four function names *as definitions* and on the *known call
sites* I'd reasoned about.

The symptom — failure on first tab pick, success on rows-per-page,
failure on next tab pick — exactly matched the call-path asymmetry
between `loadFile` (calls `rebuildFilterCols`) and `refetchPage`
(doesn't). The user's reproduction notes pointed straight at the
culprit; the diagnosis took five minutes of grepping.

## Solution

Removed the dead call. The reset semantics that `refresh()` used to
provide (re-apply current filter to rendered rows) are now handled
by `fetchAndRender()`, which `loadFile` awaits one line after
`rebuildFilterCols`. There was no client-side state left that
needed a separate refresh pass.

```js
function rebuildFilterCols(columns) {
  filterCols = columns.map((c, i) => [i + 3, c.name]);
  groupList.innerHTML = "";
  groupCombo = "AND";
  activeFilter = null;
  if (filterCols.length) addGroup();
  // Server-side filter (WS#2) — no client-side refresh() needed here;
  // loadFile awaits fetchAndRender() right after this call which
  // sends the fresh (empty) filter set to the server.
}
```

Commit: `8f8c4b0`.

## Post Checking

After the fix:

1. Hard refresh `/workspace`. ✓
2. Click a file in the rail → table loads. ✓
3. Click a different file → table loads. ✓
4. Click back to the first file → table loads. ✓
5. Change rows-per-page → table refetches. ✓
6. Open filter panel → Apply a predicate → table refetches. ✓
7. Browser console: no ReferenceError. ✓

## The discipline this updates

When **deleting** a function during a refactor:

- ❌ "Grep for the function name as a definition + check the call sites I reasoned about."
- ✅ **"Grep for the function name as a CALL across the whole file (and the whole codebase if it's exported)."**

The asymmetry: a function definition has exactly one site; a function name as a call has N sites. Reasoning about call sites by their semantics (e.g. *"refresh is called from the filter-Apply handler"*) misses sites named for what they do upstream of the call (`rebuildFilterCols` doesn't sound like it refreshes anything).

Mechanical grep is the only way to be sure. Should be a step in the
WS-cleanup checklist for any function-deletion PR. Filed as a one-
line addition to [`../processes/ui-change-process.md`](../processes/ui-change-process.md)'s "before you delete" section when that doc gets filled in.

## Linked

- WS#2 server-side filter+sort PR — commit `11c2ca6`.
- The fix — commit `8f8c4b0`.
- Process doc this should update on next pass — [ui-change-process.md](../processes/ui-change-process.md).
