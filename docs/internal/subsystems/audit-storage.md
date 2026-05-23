---
title: Audit storage
section: Internal
order: 22
last modified date: 2026-05-24
owner: Gus
status: filled
---

# Audit storage

The audit suite tracks codebase health over time. Each
`tools/<x>-audit/audit.js` Node script scans one slice of the
repo (CSS conflicts, HTML duplication, JS LOC, …) and produces a
report; for the subset that ships structured findings (today: css,
html), the runs are persisted in Postgres so the team can answer
"is this getting better or worse?" and "what's new since last
run?" — not just "what does it look like right now?"

This is the disk-resident counterpart to the `[[cleaning-cadence]]`
rule: the audit-system surfacing an edge-case finding is the
trigger to open a small cleaning pass.

Source of truth: `tools/`, `backend/migrations/20260528000001_audit_storage.sql`,
`backend/migrations/20260604000001_audit_run_diff.sql`,
`backend/crates/api/src/bin/audit_ingest.rs`,
`tools/audit.sh`, `tools/audit-storage-brainstorming.md` (the
original design doc).

## The audit suite

```
tools/
├── audit.sh              ← runner: discovers, runs, ingests, reports
├── crossing-audit/audit.js   — JS ↔ Rust /api seam (crossings / dangling / unused)
├── css-audit/audit.js        — CSS conflicts / duplication / reachability
├── html-audit/audit.js       — HTML structure / duplication / component candidates
├── js-audit/audit.js         — frontend JS LOC, unreachable modules, dup symbols
└── rs-audit/audit.js         — backend Rust LOC, repeated lines, big match blocks
```

Each script is **zero-dependency Node** — `audit.sh` doesn't
`npm install` anything. The scripts walk the repo with `fs`, parse
with hand-rolled state machines (CSS, HTML) or naïve splits (LOC),
and write `report.html` next to themselves.

CSS + HTML additionally write `audit.json` — the source-of-truth
payload `redpash-audit-ingest` reads to persist to the DB.

## Tables: `audit.run` + `audit.finding`

Schemas in [monitoring-schemas](../specs/monitoring-schemas.md) §3-§4.
Recap:

- **`audit.run`** — one row per `audit.js` execution. Carries
  `tool`, `ran_at`, `git_sha`, `git_branch`, headline `stats`
  JSONB, and the full `payload` JSONB. The `payload` is the source
  of truth — `audit.finding` is a derived projection re-runnable
  from it.
- **`audit.finding`** — exploded per-finding rows. Keyed by
  `(run_id, finding_key)`. The `finding_key` is stable across runs:

| Tool · kind | `finding_key` |
|---|---|
| css · `selector_conflict` | `atContext ' \|\|\| ' selector` |
| css · `class_divergence` (only when `divergentCount > 0`) | the class name |
| html · `component_candidate` | `name '/' tier` (e.g. `modal-overlay/slotted`) |

Stable keys are what make change-tracking a self-join — same key
across runs = same finding.

`audit.run.tool` is CHECK-constrained to `('css','html')`. Adding
a new auditable tool to the storage layer means relaxing the
CHECK (a one-line migration) and teaching the ingest binary the
new tool's explode shape.

## Ingest — `redpash-audit-ingest`

Binary at `backend/crates/api/src/bin/audit_ingest.rs`. Built by
`cargo build --bin redpash-audit-ingest`; lives at
`backend/target/debug/redpash-audit-ingest` (or release).

```
redpash-audit-ingest --tool <css|html> [--file <path-to-audit.json>]
```

Steps (one transaction):

1. Read `tools/<tool>-audit/audit.json` (or `--file` if provided).
2. Capture `git rev-parse HEAD` + `git rev-parse --abbrev-ref HEAD`
   via `std::process::Command`.
3. `INSERT INTO audit.run` with tool / git context / stats /
   payload.
4. Explode `payload` per tool's known shape into `audit.finding`
   rows. Trim heavy strings (`skeleton`, `callSite` for HTML
   candidates) from `finding.detail` — they're already in
   `run.payload` and would bloat the finding table.
5. Look up the previous run for the same tool and call
   `audit.run_diff(cur_id, prev_id)`. Print the summary inline:

```
audit.run #28  tool=css  branch=prerelease  sha=4bd6a78  findings=4
  vs audit.run #27: no change
```

The diff line is the load-bearing output — it's how the cleaning
cadence rule's "trigger is an audit-system edge-case finding"
gets seen at run time.

## Diff function — `audit.run_diff(cur, prev)`

SQL function (migration 024) returning one row per finding
classified as `new | fixed | regressed | improved | unchanged`:

```sql
SELECT status, kind, finding_key, severity_cur, severity_prev
  FROM audit.run_diff(cur_run_id, prev_run_id);
```

| Status | Meaning |
|---|---|
| `new` | finding_key in cur, not in prev |
| `fixed` | finding_key in prev, not in cur |
| `regressed` | in both, cur.severity > prev.severity |
| `improved` | in both, cur.severity < prev.severity |
| `unchanged` | in both, severities equal |

`severity` semantics per kind: `conflictCount` (selector_conflict),
`divergentCount` (class_divergence), `saved` (component_candidate).
Always an integer; `>` comparison is valid across all kinds.

The function joins on `(kind, finding_key)` — defensive against a
future explode that lets the same key mean different things across
kinds.

## The runner — `tools/audit.sh`

One command, full sweep:

```
$ sh tools/audit.sh
════════════════════════  css  ════════════════════════
  files scanned         15
  rules parsed          318
  ...
  reachable sheets      15 of 15
  orphan CSS            0
  dangling @imports     0
audit.run #11  tool=css  branch=prerelease  sha=fcb5212  findings=4
  vs audit.run #9: no change
════════════════════════  html  ════════════════════════
  ...
audit.run #12  tool=html  branch=prerelease  sha=fcb5212  findings=0
  vs audit.run #10: no change
```

What the runner does:

1. Pre-build `redpash-audit-ingest` so the per-tool loop runs the
   native binary, not cargo.
2. Auto-discover `tools/*-audit/audit.js` files. Running each.
3. For tools in the inline `INGEST_TOOLS=" css html "` list (kept
   in sync with the schema CHECK), invoke the ingest binary after
   the run.
4. Print the "since last run" diff inline.
5. Exit non-zero if any step failed.

This is the surface the cleaning-cadence rule expects to run on:
the cadence trigger is a "new" / "regressed" finding in the
output; the visible delta is what justifies opening a small
cleaning pass.

## The two API surfaces

`/api/monitoring/audit-runs` and `/api/monitoring/audit-findings`
read the tables for the Monitoring page tabs. See [api-routes](api-routes.md)
+ [monitoring-schemas](../specs/monitoring-schemas.md) §3-§4 for
the wire shape.

These are read-only — the only writer to `audit.*` is
`redpash-audit-ingest` (or a future `/api/dev/audit/:tool` endpoint;
see `tools/audit-storage-brainstorming.md` Phase 4, parked).

## When to add a new auditable tool

The four currently-tracked dimensions (css conflicts / html dupes /
JS LOC / Rust LOC) are the ones with clear improvement metrics.
Add a new dimension when:

- There's a *measurable* property of the codebase that drifts —
  not "code quality" (vague) but "count of stray .css imports"
  (countable), "n routes without a doc entry" (countable), etc.
- The drift has historically caught a real bug — i.e. the audit's
  payoff is concrete, not hypothetical.
- The scan is fast enough to run on every commit's worth of work
  without becoming friction (target: <5s, runs in audit.sh's
  natural cadence).

Mechanics:

1. Create `tools/<name>-audit/audit.js` — zero deps, walks the
   repo via `fs`, builds a `data` object with `stats` + the
   structured findings.
2. If the tool ships findings worth tracking over time: emit
   `audit.json` next to `audit.html`, relax the CHECK in
   `audit.run`'s schema to include the new tool name, teach
   `redpash-audit-ingest::explode()` how to enumerate its
   findings (per-tool match arm).
3. Add the tool to `INGEST_TOOLS` in `tools/audit.sh`.
4. Add the matching list endpoint case in
   `routes/monitoring.rs::list_audit_findings`'s filter UI if
   the kind needs custom rendering.

The discipline: **the audit's stats become a public number on the
monitoring page.** Don't add an audit whose stats you don't want
to look at every week — the surface enforces honesty.

## Cross-cuts

- **The cadence rule names this loop.** See [processes/audit-cadence](../processes/audit-cadence.md).
  Audits aren't a quarterly cleanup — they're a per-session trigger.
- **`payload` is the source of truth, `finding` is a projection.**
  If the explode logic changes (a new kind, a different key shape),
  re-explode from stored payloads — never hand-edit findings.
- **Zero deps.** The audit scripts deliberately don't `npm install`
  anything. The audit suite has to survive a fresh checkout +
  `node` being available; nothing else.
- **Dev-meta, not app data.** The tables live in the `audit`
  schema (not `public`) to signal they're tooling metadata. Prod
  deployments carry the tables (the migration runs) but they're
  harmless if unpopulated.
