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

## Rust internals — `redpash-audit-ingest`

The binary at `backend/crates/api/src/bin/audit_ingest.rs`. Read
JSON → capture git context → INSERT run + explode findings, all
in one transaction. The diff print happens after commit.

### main() flow

```rust
#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<()> {
    let _ = dotenvy::dotenv();
    let _ = dotenvy::from_filename("backend/.env");
    let _ = dotenvy::from_filename("../.env");

    let (tool, file) = parse_args()?;
    let path = file.unwrap_or_else(|| {
        PathBuf::from("tools")
            .join(format!("{tool}-audit"))
            .join("audit.json")
    });

    let raw = std::fs::read_to_string(&path)?;
    let data: Value = serde_json::from_str(&raw)?;
    let stats = data.get("stats").cloned().ok_or(...)?;

    let git_sha = git(&["rev-parse", "HEAD"]).ok();
    let git_branch = git(&["rev-parse", "--abbrev-ref", "HEAD"]).ok();

    let db_url = std::env::var("DATABASE_URL")?;
    let pool = PgPoolOptions::new().max_connections(2).connect(&db_url).await?;

    let mut tx = pool.begin().await?;

    let run_id: i64 = sqlx::query_scalar(
        "INSERT INTO audit.run (tool, git_sha, git_branch, stats, payload)
         VALUES ($1, $2, $3, $4, $5) RETURNING id")
        .bind(&tool).bind(&git_sha).bind(&git_branch)
        .bind(&stats).bind(&data)
        .fetch_one(&mut *tx).await?;

    let findings = explode(&tool, &data)?;
    for f in &findings {
        sqlx::query(
            "INSERT INTO audit.finding (run_id, tool, kind, finding_key, severity, detail)
             VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (run_id, finding_key) DO NOTHING")
            .bind(run_id).bind(&tool).bind(&f.kind).bind(&f.key)
            .bind(f.severity).bind(&f.detail)
            .execute(&mut *tx).await?;
    }
    tx.commit().await?;

    // Diff summary against prior run
    print_diff_summary(&pool, &tool, run_id).await?;
    Ok(())
}
```

### Why current-thread tokio

`#[tokio::main(flavor = "current_thread")]` — the ingest is a
single SQL transaction. A multi-threaded runtime would mean two
worker threads + a slightly bigger binary for nothing. The CLI's
job is "do this one transaction, commit, exit"; sequential is
correct.

### The `.env` lookup walk

```rust
let _ = dotenvy::dotenv();                          // PWD
let _ = dotenvy::from_filename("backend/.env");     // when run from repo root
let _ = dotenvy::from_filename("../.env");          // when run from inside backend/
```

Defensive across the two natural invocation paths (`sh tools/audit.sh`
runs from repo root; `cargo run --bin redpash-audit-ingest` runs
from `backend/`). Each call is a no-op if the file isn't there.

### `explode` — per-tool finding extraction

```rust
fn explode(tool: &str, data: &Value) -> Result<Vec<Finding>> {
    let mut out = Vec::new();
    match tool {
        "css" => {
            // selectorConflicts[] — kind = "selector_conflict"
            //   key = atContext + " ||| " + selector
            //   severity = conflictCount
            if let Some(arr) = data.get("selectorConflicts").and_then(Value::as_array) {
                for item in arr {
                    let selector = item.get("selector").and_then(Value::as_str).unwrap_or("");
                    let at_ctx   = item.get("atContext").and_then(Value::as_str).unwrap_or("");
                    let sev      = item.get("conflictCount").and_then(Value::as_i64).map(|v| v as i32);
                    out.push(Finding {
                        kind: "selector_conflict".into(),
                        key:  format!("{at_ctx} ||| {selector}"),
                        severity: sev,
                        detail: item.clone(),
                    });
                }
            }
            // classIndex[] — kind = "class_divergence", filter divergentCount > 0
            //   key = cls (the class name)
            //   severity = divergentCount
            if let Some(arr) = data.get("classIndex").and_then(Value::as_array) {
                for item in arr {
                    let dvg = item.get("divergentCount").and_then(Value::as_i64).unwrap_or(0);
                    if dvg <= 0 { continue; }
                    let cls = item.get("cls").and_then(Value::as_str).unwrap_or("").to_string();
                    out.push(Finding {
                        kind: "class_divergence".into(),
                        key:  cls,
                        severity: Some(dvg as i32),
                        detail: item.clone(),
                    });
                }
            }
        }
        "html" => {
            // candidates[] — kind = "component_candidate"
            //   key = name + "/" + tier
            //   severity = saved
            //   detail: skeleton + callSite TRIMMED (already in payload)
            if let Some(arr) = data.get("candidates").and_then(Value::as_array) {
                for item in arr {
                    let name = item.get("name").and_then(Value::as_str).unwrap_or("");
                    let tier = item.get("tier").and_then(Value::as_str).unwrap_or("");
                    let sev  = item.get("saved").and_then(Value::as_i64).map(|v| v as i32);
                    let mut detail = item.clone();
                    if let Some(obj) = detail.as_object_mut() {
                        obj.remove("skeleton");
                        obj.remove("callSite");
                    }
                    out.push(Finding {
                        kind: "component_candidate".into(),
                        key:  format!("{name}/{tier}"),
                        severity: sev,
                        detail,
                    });
                }
            }
        }
        _ => unreachable!("--tool validated upstream"),
    }
    Ok(out)
}
```

**Detail-trim for HTML** drops `skeleton` (full HTML snippet) and
`callSite` (rendered example) from `finding.detail` because both
are large and already live in `run.payload`. Cuts finding-table
row size from ~2-8 KB to ~200-500 B per row. The CLI prints a
running count; for 200+ findings per run that compounds.

### Print diff summary

```rust
async fn print_diff_summary(pool: &sqlx::PgPool, tool: &str, run_id: i64) -> Result<()> {
    let prev_id: Option<i64> = sqlx::query_scalar(
        "SELECT id FROM audit.run WHERE tool = $1 AND id < $2
          ORDER BY id DESC LIMIT 1")
        .bind(tool).bind(run_id)
        .fetch_optional(pool).await?;

    let Some(prev) = prev_id else {
        println!("  (no prior {tool} run — baseline established)");
        return Ok(());
    };

    let counts: Vec<(String, i64)> = sqlx::query_as(
        "SELECT status, COUNT(*)::bigint
           FROM audit.run_diff($1, $2)
          WHERE status <> 'unchanged'
          GROUP BY status")
        .bind(run_id).bind(prev)
        .fetch_all(pool).await?;

    let n = |k: &str| counts.iter().find(|(s, _)| s == k).map(|(_, c)| *c).unwrap_or(0);
    let new_ = n("new"); let fixed = n("fixed");
    let regr = n("regressed"); let impr = n("improved");
    if new_ + fixed + regr + impr == 0 {
        println!("  vs audit.run #{prev}: no change");
    } else {
        println!("  vs audit.run #{prev}: {new_} new · {fixed} fixed · {regr} regressed · {impr} improved");
    }
    Ok(())
}
```

`audit.run_diff` is the SQL function (see below) — does the heavy
lifting; the binary just GROUPs the result.

## SQL internals — `audit.run_diff(cur_id, prev_id)`

The change-tracking function. Parameterized projection over
`audit.finding`:

```sql
CREATE OR REPLACE FUNCTION audit.run_diff(cur_id BIGINT, prev_id BIGINT)
RETURNS TABLE (
    status        TEXT,
    kind          TEXT,
    finding_key   TEXT,
    severity_cur  INTEGER,
    severity_prev INTEGER
)
LANGUAGE SQL
STABLE
AS $$
    WITH
      cur  AS (SELECT kind, finding_key, severity FROM audit.finding WHERE run_id = cur_id),
      prev AS (SELECT kind, finding_key, severity FROM audit.finding WHERE run_id = prev_id)
    SELECT 'new'::TEXT,
           c.kind, c.finding_key, c.severity, NULL::INTEGER
      FROM cur c
      LEFT JOIN prev p USING (kind, finding_key)
     WHERE p.finding_key IS NULL
    UNION ALL
    SELECT 'fixed'::TEXT,
           p.kind, p.finding_key, NULL::INTEGER, p.severity
      FROM prev p
      LEFT JOIN cur c USING (kind, finding_key)
     WHERE c.finding_key IS NULL
    UNION ALL
    SELECT CASE
             WHEN c.severity IS DISTINCT FROM p.severity
                  AND c.severity > p.severity THEN 'regressed'
             WHEN c.severity IS DISTINCT FROM p.severity
                  AND c.severity < p.severity THEN 'improved'
             ELSE 'unchanged'
           END,
           c.kind, c.finding_key, c.severity, p.severity
      FROM cur c
      JOIN prev p USING (kind, finding_key);
$$;
```

**Three-branch UNION ALL** because the relationships are:

| Branch | Cur ∩ Prev | Status |
|---|---|---|
| Anti-join cur → prev | cur only | `new` |
| Anti-join prev → cur | prev only | `fixed` |
| Inner join | both | `regressed` / `improved` / `unchanged` per severity |

`STABLE` because it only reads — callers can include `run_diff` in
SELECT lists without forcing a fresh execution per row.

**`IS DISTINCT FROM`** handles NULL severity correctly — a NULL
vs an INTEGER comparison via `=` is NULL (treated as false in
WHERE), but DISTINCT FROM returns a proper boolean. Matters when
a kind's severity is genuinely nullable (today none, but the
column allows it).

## Node internals — the audit scripts

The Node scripts are zero-dep — they walk the repo via `fs`,
parse with hand-rolled state machines, and emit reports. The
algorithms are documented inline in each script's header comment;
here's a survey of the two that ingest:

### css-audit's selector tokenizer

Hand-rolled because regex-based CSS parsing misses `@media` /
`@supports` contexts. The state machine tracks:

- `atContext` stack — `@media (min-width: 600px) { ... }`'s
  context is `media (min-width: 600px)`, preserved per rule.
- `selector` string — split on `,` after the at-context is
  closed.
- `decls` array of `{prop, val, important}` per selector.

Output: `selectorConflicts[]` keyed by `(atContext, selector)` —
any pair declared in 2+ files (whether or not the value
conflicts). `dupSelectors` counts ALL such; `conflictSelectors`
counts the subset where actual property values differ.

### html-audit's subtree-hashing

Three-tier match (per the doc's frontmatter):

- `exact` — byte-identical subtree (post-whitespace-normalize)
- `class` — identical tag tree + identical class lists
- `struct` — identical tag tree; classes/attrs vary → props
- `slotted` — identical leading + trailing children + variable
  middle → middle becomes `<slot>`

For each element, computes three hashes (one per tier) and
clusters by hash. Clusters with `count ≥ 2` and `estimated_saved
≥ MIN_SAVED = 5` become candidates. The reachability tab uses
`walkExt('.html', ...)` to BFS the @import graph (per Woz's
reachability check).

## Adding a new audit-ingest target

To make a new tool's findings persistable:

1. Relax `audit.run.tool` CHECK to include the new name (a 1-line
   migration: `ALTER TABLE audit.run DROP CONSTRAINT run_tool_check;
   ALTER TABLE audit.run ADD CONSTRAINT run_tool_check CHECK (tool
   IN ('css','html','<new>'));`).
2. Teach `explode()` the new tool's payload shape: add a match
   arm, define the `(kind, finding_key)` extraction.
3. Pick a stable `finding_key` that survives refactors but
   uniquely identifies the finding. The CSS selector text was
   stable; HTML's `name/tier` was the pragmatic choice for
   subtree-hashed candidates. Document the choice in the
   storage-brainstorming doc.
4. Add the tool to `INGEST_TOOLS=" ... "` in `tools/audit.sh`.
5. Test: run the audit twice; the second invocation should
   print `vs audit.run #N: no change` (idempotence sanity).
