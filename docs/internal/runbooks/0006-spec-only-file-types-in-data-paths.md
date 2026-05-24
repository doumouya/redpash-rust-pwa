---
title: 0006 — Spec-only file types leak into data-file code paths
section: Internal
order: 6
last modified date: 2026-05-24
---

# 0006 — Spec-only file types leak into data-file code paths

**Date:** 2026-05-24 · **Area:** backend (files / joins) + frontend (workspace) · **Status:** resolved (commits `220296a`, `c68a1a6`, `6f1b70c`, `f49e030`)

## Problem Statement

Em hit a polling 500-loop in the API log:

```
WARN  read /home/mansa/redpash-data-prerelease/: Is a directory (os error 21)
ERROR response failed status=500
```

repeating every ~5s, then later — after a partial fix — a 400-bleed:

```
GET /api/files/FIL_640EB92…/joins → 400 Bad Request
{ "error": "FIL_640EB92… is a dashboard — no underlying data file",
  "kind": "not_a_data_file" }
```

The two error shapes had different surface paths but **the same root
cause class**: spec-only file types (chart, dashboard) sharing the
`project_files` table were leaking into code paths that assume every
`project_files` row points at an on-disk CSV blob.

## Troubleshooting steps

1. **Read the EISDIR path.** `read /home/mansa/redpash-data-prerelease/`
   ends with a trailing slash — that's the **data root**, not a file.
   Something resolved a file path to the bare data dir.

2. **Trace the read.** `grep "tokio::fs::read" backend/crates/api/src/`
   pointed at `routes::files::hydrate` line 1306-1308:
   ```rust
   let path = state.data_dir.join(&meta.storage_path);
   let bytes = tokio::fs::read(&path).await.map_err(…)?;
   ```
   `path.display()` matched the log format. `meta.storage_path` had to
   be empty or whitespace.

3. **Trace the empty `storage_path`.** `grep "storage_path" db.rs`
   surfaced `db::insert_chart` and `db::insert_dashboard`:
   ```rust
   INSERT INTO project_files
       (…, file_type, storage_path, spec)
       VALUES (…, 'chart',     '', $5)
   ```
   By design — charts and dashboards carry their config in the `spec`
   JSONB column, not as on-disk bytes.

4. **Map the call paths.** Two FE flows hit data endpoints with
   chart/dashboard RIDs:
   - Workspace's `loadFile` round-trips through `/api/files/:rid` to
     read the envelope and dispatch by `file_type` (intended).
   - The joins detector enumerates sibling files via
     `db::list_files_in_project_except` and hydrates each one to
     compute distinct-value overlap (intended for CSVs; broken for
     siblings of mixed types).

5. **First fix candidates and the fix order chosen.** Belt-and-
   suspenders at four layers (each a real fix, each a different
   abstraction level):
   - `hydrate` itself — Gus's defense-in-depth (`220296a`).
   - `get_summary` — short-circuit non-CSV envelope (`c68a1a6`).
   - Workspace data-panel refreshes — gated to CSV branch
     (`6f1b70c`).
   - Joins sibling SQL — `file_type = 'csv'` filter (`f49e030`).

## RCA

**Root cause:** the `project_files` table is a polymorphic carrier.
A row's interpretation depends on `file_type`:

| `file_type` | Where the payload lives | Has `storage_path` |
|---|---|---|
| `'csv'` | on-disk blob at `data_dir / storage_path` | yes |
| `'chart'` | `project_files.spec` JSONB column | **no, empty by construction** |
| `'dashboard'` | `project_files.spec` JSONB column | **no, empty by construction** |

The polymorphism is by design — the 2026-05-22 object-model
unification ([[object-model]]) made `project_files` the single carrier
table for every "file kind" the workspace exposes, including
chart and dashboard rows. The design choice is good. The
discipline gap was every consumer that *implicitly* assumed
"every project_files row → CSV blob" — they were correct under
the old schema and silently wrong after the unification.

**The deep cause:** there's no compile-time signal that "this code
path needs a CSV". Rust's type system sees `String` for `rid`;
the file_type only manifests at runtime via the DB lookup. The
implicit contract ("I'll only be called with CSV rids") was
spread across hydrate, get_summary, the joins detector, the FE
loader, and a handful of other endpoints. Each one assumed the
caller respected the contract; no one enforced it.

## Solution

Four fixes, four layers, none redundant:

1. **`hydrate` guards empty `storage_path` and 400s with
   `not_a_data_file`** ([220296a](https://github.com/doumouya/redpash-rust-pwa/commit/220296a)).
   Type-agnostic — any future spec-only file type (notebook,
   saved query) inherits the guard automatically. Defense in
   depth: every data-only endpoint (`/page`, `/uniques`, `/joins`,
   `/export`) routes through hydrate, so the guard is the
   universal backstop.

2. **`get_summary` returns a metadata-only envelope for non-CSV
   file_types** ([c68a1a6](https://github.com/doumouya/redpash-rust-pwa/commit/c68a1a6)).
   Preserves the intended FE flow: `loadFile` round-trips through
   `/api/files/:rid` for every rid and dispatches by
   `envelope.summary.file_type`. The fix prevents hydrate from
   being called at all when the rid is a chart/dashboard — the
   envelope returns cleanly with empty `columns` + `steps`.

3. **Workspace `loadFile` scopes data-panel refreshes to the CSV
   branch** ([6f1b70c](https://github.com/doumouya/redpash-rust-pwa/commit/6f1b70c)).
   `toolsCtrl.refresh()`, `joinsCtrl.refresh()`, and
   `reportCtrl.refresh()` operate on rows / columns / steps that
   don't exist for chart/dashboard rids. Moved them from above the
   `file_type` switch into the `else` (CSV) branch. Eliminates the
   spurious `/joins` 400s that fired on every dashboard click.

4. **Joins sibling query pins to `file_type = 'csv'`**
   ([f49e030](https://github.com/doumouya/redpash-rust-pwa/commit/f49e030)).
   `db::list_files_in_project_except` previously filtered
   `<> 'chart'` but not `<> 'dashboard'`. Flipped to the positive
   form `= 'csv'` so any new spec-only file type (notebook, saved
   query) is excluded by default without another query patch.

**What was deferred:**

- **FE-side optimization** — adding `data-file-type` to rail tab
  markup + an early dispatch in `loadFile` would skip the
  `/api/files/:rid` round-trip entirely for chart/dashboard rids.
  Marginal HTTP-call savings, not landing without [[data-shape-index]]
  consumer alignment.
- **Mechanical regression net** — the audit catalog could grow a
  pattern that detects "any code path that assumes every
  `project_files` row is a CSV". See "The discipline this updates"
  below.

## Post Checking

- Click a dashboard in the workspace rail → loads in designer mode,
  zero `/joins` / `/uniques` / `/page` calls in the network panel.
  ✓
- Open a CSV in a project that contains charts + dashboards →
  joins picker populates with only CSV siblings. ✓
- `cargo check --bin redpash-api` clean. ✓
- Audit suite green throughout the fix sequence — 0 ownership
  leaks, 0 audit-trail gaps, 0 extracted-pattern regressions
  across both rs-audit and js-audit. ✓
- Server log post-fix — no `Is a directory (os error 21)`, no
  `not_a_data_file` 400s from FE-driven flows. ✓

**Watching:** if a new endpoint gets added that calls `hydrate(rid)`
or queries `project_files` without a `file_type` filter, the audit
patterns proposed below (see "The discipline this updates") will
catch it before it ships.

## The discipline this updates

The `project_files` table is **polymorphic**. Every code path that
touches it must answer: *which file types am I serving?* The
answer should be **explicit in the code or query**, not implicit
in the caller's discipline.

Concrete rules:

| Surface | Discipline |
|---|---|
| **Rust SQL queries on `project_files`** | Add an explicit `WHERE file_type = …` (positive form) unless the consumer genuinely needs every type (e.g., rail list, `delete_file` cascade target). Negative-form (`<> 'chart'`) leaves dashboards and future spec-only types as silent bombs. |
| **Backend handlers extracting `Path(rid)`** | If the handler will read the on-disk blob (hydrate / page / export / etc.), it must either accept that hydrate's guard 400s on non-CSV (and let the FE handle the 400), or check `file_type` upfront via `find_file` and short-circuit. |
| **Frontend code firing data-only endpoints** | `/page`, `/uniques`, `/joins`, `/export`, `/steps` — never fire these without first knowing the rid points at a CSV. Read `summary.file_type` from `/files/:rid` and dispatch; or wire the file_type into the originating UI (rail tab `data-file-type`, future). |
| **New file types** | When a new spec-only `file_type` lands (notebook / saved query / …), the positive-form queries + hydrate guard cover it automatically. The negative-form queries are the trap. Audit on add. |

### Audit-pattern lifecycle (TDD-style validation)

A convention crystallized while landing this runbook's first
audit pattern (the js-audit `data-only endpoint without
file_type gate` PATTERNS entry, commit pending at write time):

1. **Ship the pattern unACK'd.** Add it to the catalog with no
   acknowledgements at the call sites yet.
2. **Run the audit, verify it flags the expected sites.** The hit
   count and file breakdown should match what a manual grep would
   produce. If it doesn't (false positives, false negatives,
   missed brittle regex shapes), iterate on the pattern *before*
   landing any acknowledgements — the unACK'd state is the
   testbed.
3. **Land the ACK comments in the same commit.** Each call site
   gains its `// <PATTERN>-ACK:` annotation with the caller-side
   intent in plain English. The annotation IS the contract — if
   the contract becomes false later (e.g. a future refactor
   makes the gating site dispatch to a non-CSV rid), the comment
   is the wrong artifact and the audit catches the slip the
   moment a contributor adds a new call site without an ACK.
4. **Re-run, confirm green.** Zero hits on the extracted
   pattern = the new regression net is live + the existing call
   sites are documented.

Same shape as the auth-audit pass that added `// AUTH-AUDIT-ACK:`
to the 6 dev-permissive admin handlers — ship the scanner,
verify it flags, ACK the intentional surfaces, ship the union
as one commit. Mirrors the discipline rule of [[build-tools-
proactively]] applied at audit-pattern granularity: encode the
lesson + verify the encoding, in one beat.

### Audit-tool additions this runbook earns

The right time to mechanize is when a class of bugs has hit
**three times** ([[refactor-decompose]]). This bug class has hit
once with multiple surfaces in one session — close to the
threshold. Three patterns worth queuing on the next audit-tool
pass:

1. **rs-audit pattern: `SELECT … FROM project_files`** queries
   without a `WHERE … file_type …` clause. Status: `declined` →
   `extracted` with ACK convention (Gus's reframe — match on the
   ACK comment, not the SQL shape; same forcing function as
   cat-1's `// AUTH-AUDIT-ACK:`). Every query site declares its
   intent via `// PROJECT-FILES-ACK: type=<any|csv|<concrete>>`
   or fails the audit. **Pending** — queued in Gus's lane.

2. **rs-audit pattern: `hydrate(state, &rid).await?`** call sites
   in handlers where the caller's `Path(rid)` could be any
   file_type (no preceding `find_file` + `file_type` check, no
   404-on-non-csv guard). Status: `live` — hydrate's own guard
   makes these correct-by-fallback, but tracking the count
   surfaces preventive opportunities; cross-module callers
   (outside `routes::files`) get a separate counter so layer
   violations stand out. **Pending** — queued in Gus's lane.

3. **js-audit pattern: `api.(get|post|put|delete)("/files/…/<csv-only-endpoint>")`**
   without a preceding `// DATA-ENDPOINT-ACK: caller-checks-file_type`
   annotation. Status: `extracted`, **shipped**. The endpoint
   set is a single constant in the audit (`page | uniques |
   joins | export | cleanness | sentinels | dedup | cast-preview
   | steps | snapshot`); adding a new data-only endpoint
   server-side now requires adding it to the constant or the
   audit underdetects. `scripts/api.js` is excluded (HTTP
   wrapper layer with no caller context — same exclusion shape
   as auth-audit's own source-set exemption). The 5 initial
   call sites carry their ACKs in the same commit per the
   lifecycle convention above.

Patterns 1 and 2 land at the next bandwidth gap in Gus's lane.
The discipline they enforce is identical to Pattern 3's, just on
the SQL and Rust call-site axes.

## Linked

- The four fixes — `220296a` (hydrate guard), `c68a1a6`
  (get_summary short-circuit), `6f1b70c` (FE data-panel scope),
  `f49e030` (joins sibling filter).
- The polymorphism rule — [[object-model]] (`project_files` as the
  single carrier table for every file kind).
- The DataSource trait sketch — [[datasource-trait]] — once
  shipped, `Reader::open` becomes the explicit "I want the
  on-disk frame" entry point; any call outside that path is a
  layer violation the audit catches structurally.
- The architecture doc — [[data-shape-index]] §9 RBAC touchpoints
  notes that the auth-audit covers data-plane (FS layer) +
  control-plane (`ensure_owner`); this runbook's file_type
  discipline is the **third** axis — neither auth nor data
  alone catches it.
- The audit catalog discipline — [[build-tools-proactively]] +
  [[process-oriented]] — encode the lesson once, never re-debug.
