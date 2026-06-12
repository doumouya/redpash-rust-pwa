---
title: Audit cadence
section: Internal
order: 51
last modified date: 2026-05-26
owner: Torv
status: stub
---

# Audit cadence

> **TODO (Torv).** Formalise the existing practice into a written rule.
> The audit-tool list below was extended 2026-05-25 (Woz) and again
> 2026-05-26 (Woz) — `ci-audit` (merge-gate wrapper) + `ui-snapshot`
> (computed-style atom-catalog audit) — to honestly reflect what
> `sh tools/audit.sh` runs today + what the CI enforcement layer looks
> like. The rest of the doc still needs Torv's formalisation.

The current practice (live since 2026-05-21):

1. `sh tools/audit.sh` runs every `tools/*-audit/audit.js` before each commit (auto-discovery — adding a new audit folder requires no edit to `audit.sh`)
2. Findings (from tools that emit `audit.json`) ingested into `audit.run` + `audit.finding` (the audit-storage subsystem). The `INGEST_TOOLS` list in `audit.sh` gates which tools' JSON gets persisted — extending it needs the schema's `tool` CHECK relaxed.
3. New findings trigger a small, immediate cleanup — *not* a deferred big-bang pass
4. Trend reading: `audit.run_diff()` SQL surfaces drift between runs

## Slice-grain runs during decomp campaigns

Convention adopted 2026-05-27 (per Em's routing call) for any
multi-slice decomposition campaign (the god-object cleanup that
started that day; the pattern generalises):

- Run `sh tools/audit.sh` **between slices, not just at session-end**.
- Cadence: after every 2-3 slices, OR before every push-request,
  whichever comes first.
- Eyeball the per-tool diff summary the binary prints
  (`vs audit.run #N: X new · Y fixed · Z regressed · W improved`).
- If any tool reports `new` or `regressed` rows, **stop + investigate
  before continuing**. The slice that surfaced the regression is the
  cheapest commit to bisect against; later slices stacking on top
  multiply the bisect cost.

The cost is low — the suite runs in seconds and the ingest is
fire-and-forget. The earned value is that a misplaced selector / a
class divergence / a structural drift surfaces within one slice
rather than at PR-review time. Em's framing: "errors will be
spotted faster for direct resolution."

The audit's static-analysis side (every `tools/*-audit/audit.js`) is
unaffected by `cargo check` state, so a compile-broken intermediate
state in one lane (common during parallel-session decomposition)
does NOT invalidate the audit signal — the static suite stays a
meaningful regression check throughout.

## Current audit suite

| Tool | What it catches | Output |
|---|---|---|
| `tools/js-audit/` | Acorn-AST scan of `frontend/scripts/` — duplicate symbols, dead modules, god-objects, pattern catalog regressions | `report.html` |
| `tools/rs-audit/` | Rust-internal — LOC per crate, repeated lines, big match blocks, pattern catalog (extracted/live/declined) | `report.html` |
| `tools/css-audit/` | CSS conflicts / duplication / orphan rules / dangling `@import`s / reachability over the @import graph | `audit.html` + `audit.json` |
| `tools/html-audit/` | Partial-HTML duplication / componentisation candidates | `audit.html` + `audit.json` |
| `tools/crossing-audit/` | JS↔Rust seam — `/api/*` calls without a route (dangling) + route-table + DTO surface diff | `report.html` |
| `tools/redtable-audit/` | Foundation `.rt-*` invariants (R-2…R-6 rules — `.rt-*` overrides outside canonical files, retired wrap/pager classes, modes:true stubs, pager-shaped non-pager classes) | stdout pass/fail |
| `tools/auth-audit/` | Route auth-posture — ownership-gate hygiene (Cat-1), scope-parent/parent-bind IDOR (Cat-4), audit-trail completeness (Cat-3) | `report.html` + `audit.json` |
| `tools/observability-audit/` | Cross-cutting observability invariants — event capture, log levels, perf marks, error airlock; meta-check `X-AUD` (counts other tools' `audit.json` artifacts as a freshness signal) | stdout + `audit.json` |
| `tools/css-tab-compare-audit/` | Cross-tab CSS naming-leak detector — same-role-different-name candidates, mixed-prefix violations (`.rt-mon-*`), misnamed shared atoms (list-page.js atoms with page-prefix names) | `audit.html` + `audit.json` |
| `tools/ui-snapshot-audit/` | **Computed-style drift on the foundation atom catalog** — reads JSON snapshots captured by the SPA's `?audit=1` mode (`frontend/scripts/audit/snapshot.js`), emits one finding per (route × atom × prop × theme) with a value-hash severity. Drift surfaces as `regressed`/`improved` via `audit.run_diff()`. | `audit.json` |

Added 2026-05-25: `css-tab-compare-audit` (`516fc48`). Added 2026-05-26:
`ui-snapshot` (`c119cee`). Today's suite count: **10**.

## Capture → audit → CI chain

Beyond the per-tool audits above, the **fidelity-floor enforcement
layer** is `tools/ci-audit/check.sh` (`2a9eb0e`) — a single-script
wrapper that runs `sh tools/audit.sh`, queries
`audit.run_diff(latest, prev)` per ingested tool, and exits 1 with
a markdown regression table when any tool gains `new` or `regressed`
findings vs its previous run. Designed for CI / pre-push hook
integration.

```
  sh tools/audit.sh                    ← run the per-tool suite + ingest
  audit.run / audit.finding            ← Postgres persistence (mig 028)
  audit.run_diff(cur, prev)            ← classifier function (mig 030)
  sh tools/ci-audit/check.sh           ← exit-code wrapper (Layer 1b)
```

`fixed` / `improved` / `unchanged` findings don't fail CI — only
`new` + `regressed` do. The 100+ legitimate `css-parallel` candidates
already in the DB read as `unchanged` and are not failures.

### UI snapshot — the page audits itself

The `ui-snapshot` tool is the only audit whose source data isn't in
the repo — it lives in the rendered DOM. The SPA's `?audit=1` URL
parameter triggers a per-page-mount capture that downloads
`ui-snapshot__<route>__<theme>.json` per route. Manual workflow:

1. Open the SPA with `?audit=1` (e.g. `http://localhost:8080/?audit=1`).
2. Navigate through every page that needs coverage.
3. Each page-mount downloads one JSON file (route + theme in the name).
4. Move the downloaded files into `tools/ui-snapshot-audit/snapshots/`.
5. `node tools/ui-snapshot-audit/audit.js` emits `audit.json` for ingest.
6. `sh tools/ci-audit/check.sh` then catches any drift vs the previous run.

#### v2 — capturing interactive states

The v1 walker captures default page state only. Many atoms live
behind interactions (`.rt-card` on `/monitoring` mounts on
request-row click; tabs on Home/Monitoring swap visible content
without a page navigation; etc.). v2 adds two paths to capture
those states without breaking the v1 baseline:

- **Auto on tab switch.** A `MutationObserver` watches for
  `.rp-chip.is-active` class transitions anywhere on the page;
  on a tab switch it debounces 250 ms and re-captures with
  `state = <new chip's data-value or textContent>`. Same atoms,
  different state name, separate finding_keys.
- **Manual.** A floating "📸 Capture" bar lands bottom-right in
  audit mode with a state-tag input. Click anytime to record the
  current DOM state with whatever tag you type. For programmatic
  use (devtools, future test harnesses), `window.__rpCapture(state)`
  bypasses the UI.

Filename + finding_key encoding:

| State | Filename | finding_key |
|---|---|---|
| default (page mount) | `ui-snapshot__<route>__<theme>.json` | `<route>#<atom>#<prop>@<theme>` |
| tagged (tab / manual) | `ui-snapshot__<route>__<theme>__<state>.json` | `<route>:<state>#<atom>#<prop>@<theme>` |

v1 captures (no `state` field) default to `state="default"` on
ingest — backward compatible, finding_keys unchanged.

Source-of-truth for the atom catalog + tracked properties:
`frontend/scripts/audit/snapshot.js` (`ATOM_CATALOG` + `TRACKED_PROPS`).
v1 is conservative — catalog expands in response to findings, not in
anticipation (per [[feedback-process-oriented]]).

Why computed-style, not pixel-diff: pixel-diff (BackstopJS / Playwright
`toHaveScreenshot()` / reg-suit) carries font-rendering + anti-alias
noise that has nothing to do with our actual UI changes. The
computed-style snapshot tracks the **design-system contract**
(token → atom → rendered value) instead.

To cover (Torv):

- The "small + frequent beats big + rare" rule (`[[feedback_cleaning_cadence]]`)
- The merge gate: `audit.sh` clean → push allowed
- When to add a new audit tool (the trigger: a class of bug the existing suite missed)
- The audit-storage subsystem reference for the trend-reading side
- The `INGEST_TOOLS` schema CHECK + how to add a new tool's findings to the persisted set
