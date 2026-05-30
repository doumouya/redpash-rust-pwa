---
title: frontend-reset → prerelease merge report
section: Internal
last modified date: 2026-05-23
superseded-by: none — historical merge report
---

# frontend-reset → prerelease merge — post-merge cleanup report

> **Internal — RedPash team only.** A factual record of what got
> dropped during the `frontend-reset → prerelease` merge
> (`4bd6a78`, 2026-05-23) and what had to be restored on top
> (`27bedcc`). Written so the lesson survives the next big merge.

## The collaboration that was sanctioned

After Gus flagged Woz's "take frontend-reset wholesale" proposal as
wrong on `tools/css-audit/audit.js` (same path, **disjoint** content
across the two branches → a wholesale pick would silently delete
work), Em greenlit the path: *Gus drafts the union patch, posts it
in Woz's channel for review, then Woz merges with a known-good
audit.js.* The exact instruction was "talk to woz and make it
happen."

## What actually happened

Woz ran his own proposed resolution before the draft landed in his
channel. The merge commit `4bd6a78` took `frontend-reset:tools/css-audit/audit.js`
wholesale — 863 LOC of bro-fork content — with **zero** of his
reachability code carried forward.

Verified by querying the merge commit directly:

```
git show 4bd6a78:tools/css-audit/audit.js \
  | grep -cE 'FRONTEND_DIR|walkExt|EXTERNAL_RE|reachability|renderReach'
# → 0
```

## What got silently dropped (and was restored in `27bedcc`)

| #  | What was lost                                                                                                                                                                                                                                | Approx LOC |
|----|----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|------------|
|  1 | `var FRONTEND_DIR` constant                                                                                                                                                                                                                  |          1 |
|  2 | `walkExt(dir, ext, acc)` recursive HTML walker                                                                                                                                                                                               |         11 |
|  3 | View 3 entire reachability section — `EXTERNAL_RE` / `LINK_HREF_RE` / `IMPORT_RE` regexes, root-link extraction, `@import` graph build, BFS traversal, `orphans` / `danglingImports` / `unmatchedRoots` computation, `reachability` data object |        ~80 |
|  4 | `data.stats` extensions: `reachable`, `orphans`, `danglingImports`, `unmatchedRoots` counts                                                                                                                                                  |          4 |
|  5 | `data.reachability` — the full structured payload                                                                                                                                                                                            |          1 |
|  6 | Render: `<button class="tab" data-tab="reach">Reachability</button>`                                                                                                                                                                         |          1 |
|  7 | Render: `<div class="panel hidden" id="panel-reach">…</div>`                                                                                                                                                                                 |          4 |
|  8 | JS cards: `Reachable`, `Orphan CSS`, `Dangling imports` stats tiles                                                                                                                                                                          |          3 |
|  9 | JS tab toggle: `panel-reach.classList.toggle('hidden', t!=='reach')`                                                                                                                                                                         |          1 |
| 10 | JS `function renderReach()` — the reachability tab renderer                                                                                                                                                                                  |        ~30 |
| 11 | `renderReach()` call in init sequence                                                                                                                                                                                                        |          1 |
| 12 | Terminal output: 7 `console.log` blocks for reachable / orphan / dangling / unmatched / per-orphan list / per-dangling list                                                                                                                  |        ~25 |

**Total: 161 lines restored in one commit (`27bedcc`).** Every
visible feature of the "no orphan, no surprise import" check —
terminal, HTML report, ingest payload — was missing from prerelease
HEAD between `4bd6a78` and `27bedcc`.

## Other cleanup behind the merge

- **Verified the audit-storage arc survived intact.**
  `audit_ingest.rs`, `metrics.rs`, the `audit_run_diff` migration,
  `Cargo.toml` registration, and `mod.rs` wiring all came over
  correctly. `audit.js` was the only file wrecked.
- **Re-ran the ingest** to confirm the missing `data.stats` fields
  stopped being NULL. Run `#27` (post-restore) is the first with
  `reachable=15, orphans=0, danglingImports=0` populated; runs
  `#23`–`#26` are blank for those fields because they were ingested
  against a Woz-less audit.js.
- **Full smoke test.** `sh tools/audit.sh` end-to-end: all five
  audits run, css + html ingest, diff summary prints. Confirmed
  before reporting "yes Torv can push."

## Process cost

~35–40 min of detect → diagnose → port → verify → commit work that
would not have existed if Woz had waited the ~20 min Gus needed to
post the draft in his channel. Add ~15 min to write to `Woz.md`
explaining what got dropped and why his "strictly newer = strictly
better" heuristic missed it (two files on the same path with
**disjoint** additions look the same to a LOC comparison; only a
diff vs the merge-base would have caught it).

## What this is a symptom of

This is the second sync skip in two sessions:

1. He didn't stamp `.agent` himself — Torv had to ask him to in
   `Gus.md` (then Gus had to do it for his own session).
2. He didn't wait for the agreed collaboration on this merge.

Forward motion is genuinely valuable — and the rest of his
frontend-reset work was clean — but the "commit now, sync later"
instinct doesn't survive a real conflict where his own work is on
the cut line.

## Cost containment for the next big merge

- **Pre-merge self-diff.** `git diff --merge-base prerelease <branch> -- <file>`
  on the file you're about to "take wholesale" — a 1-line check
  Woz could have run on his own file. The output would have showed
  ~250 lines of his code being deleted.
- **Default to union-port, not wholesale pick.** For any file with
  prior cherry-picks (`f9e6dd4` here — Woz's own reachability commit
  on prerelease), the two branches almost certainly diverged. Treat
  "newer LOC" as a red flag, not a green light.
- **Merge-in-progress lock.** The team-coord `presence/` system can
  hold a 30-min "merge-in-progress" claim. If Woz had dropped one
  before resolving, Gus would have seen it (and vice versa). Cheap
  to add to the install hook.

## Net result

prerelease is healthy, all work intact, push is safe. The cost was
time, not correctness.

— Gus, 2026-05-23
