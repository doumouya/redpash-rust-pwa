# Brainstorming: store audit results in Postgres

Persist the output of the `tools/*-audit/audit-bro.js` runs into Postgres
so codebase health is **trackable over time** — "conflicts went 46 → 38",
"this divergence is new since Tuesday", "that component candidate got
bigger". Today each run overwrites a standalone HTML report; there's no
history, no diff, no trend.

This is the working scratchpad. Final form is a migration + an ingest
path; this captures the reasoning and the open calls.

Related: `tools/css-audit/audit-bro.js`, `tools/html-audit/audit-bro.js`,
and the parked `/api/dev/audit/:tool` endpoint idea (see below — this
folds into it).

---

## Why bother

The two audits already produce rich structured data — they just throw the
history away. Each `node audit-bro.js` writes one `audit-bro.html` and
clobbers the last one. So:

- No trend. You can't answer "is the CSS getting cleaner or worse?"
- No diff. "Did my refactor fix conflicts or just move them?" needs eyeballing two reports side by side.
- No accountability. A regression (new conflict introduced) is invisible until someone re-runs and notices.

Postgres gives all three for the price of one table-pair + an ingest step.

---

## What the audits produce

Both scripts build a `data` object before rendering. That object IS the
payload to store.

**CSS audit** (`css-audit/audit-bro.js`):
- `stats` — `{files, rules, declarations, classes, multiFileClasses, conflictSelectors, dupSelectors, conflictProps, divergentClasses}`
- `selectorConflicts[]` — per exact selector declared 2+ places: `{selector, atContext, instances[], props[], conflictCount, duplicateCount, fileCount, …}`
- `classIndex[]` — per class: `{cls, fileCount, ruleCount, divergentCount, selectors[], divergent[]}`
- `files[]` — per file: `{path, group, lines, rules}`

**HTML audit** (`html-audit/audit-bro.js`):
- `stats` — `{files, elements, candidates, slotted, totalSaved, biggest}`
- `candidates[]` — per component candidate: `{name, label, tier, occ, fileCount, size, saved, propCount, hasSlot, members[], props[], skeleton, callSite}`
- `byFile[]` — per file: `{path, lines, covered, pct, candidates}`

---

## Two granularities — "track changes" needs both

- **Run-level** — one row per script execution. Timestamp + git context + headline `stats`. Powers trend lines.
- **Finding-level** — one row per individual conflict / divergence / candidate, carrying a **stable key** so the same finding lines up across runs. Powers new / fixed / regressed diffs.

Run-level alone answers "is the number going up." Finding-level answers
"*which* ones, and did my change fix them or shuffle them." The ask —
*track changes* — wants the second. So: both.

---

## Proposed schema — 2 tables

```sql
CREATE SCHEMA IF NOT EXISTS audit;

CREATE TABLE audit.run (
  id          BIGSERIAL    PRIMARY KEY,
  tool        TEXT         NOT NULL CHECK (tool IN ('css','html')),
  ran_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  git_sha     TEXT,                       -- `git rev-parse HEAD` at run time
  git_branch  TEXT,                       -- `git rev-parse --abbrev-ref HEAD`
  stats       JSONB        NOT NULL,       -- headline numbers (shape per tool)
  payload     JSONB        NOT NULL,       -- the FULL report `data` object
  UNIQUE (tool, git_sha, ran_at)           -- cheap dedupe guard
);
CREATE INDEX audit_run_tool_time_idx ON audit.run (tool, ran_at DESC);

CREATE TABLE audit.finding (
  run_id       BIGINT  NOT NULL REFERENCES audit.run(id) ON DELETE CASCADE,
  tool         TEXT    NOT NULL,
  kind         TEXT    NOT NULL,   -- selector_conflict | class_divergence | component_candidate
  finding_key  TEXT    NOT NULL,   -- STABLE identity across runs — see below
  severity     INTEGER,            -- the metric you track: conflictCount / divergentCount / saved
  detail       JSONB   NOT NULL,   -- the individual finding object
  PRIMARY KEY (run_id, finding_key)
);
CREATE INDEX audit_finding_key_idx ON audit.finding (tool, kind, finding_key);
```

### Why `payload` JSONB stays as source of truth

`audit.run.payload` holds the entire `data` object. `audit.finding` is a
**derived projection** exploded from it at ingest time. Rationale:

- The audit output shape evolves (we just changed the divergence algorithm 376 → 32). Typed columns would need a migration every time. JSONB doesn't care.
- If the explode logic changes, you re-run it against stored `payload`s — the raw truth is never lost.
- `payload` lets you **re-render any historical report**: feed an old `payload` back through the audit script's `renderHtml()` and you get that run's HTML, exactly as it was.

`stats` is duplicated out of `payload` only because trend queries hit it
constantly — a top-level column is cheaper to index/query than reaching
into a big JSONB.

---

## The crux: the stable `finding_key`

Change-tracking only works if the *same* finding gets the *same* key in
every run. Per tool/kind:

| Tool · kind | `finding_key` | Stable because |
|---|---|---|
| css · `selector_conflict` | `atContext + ' \|\|\| ' + selector` | the selector text *is* the identity |
| css · `class_divergence` | the class name (`.cls`) | one finding per divergent class; `severity = divergentCount` tracks better/worse |
| html · `component_candidate` | `name + '/' + tier` | survives members shifting between runs |

CSS keys are clean — selectors are stable strings. **HTML is the fuzzy
one** and the single real design call: the audit clusters by subtree
hash, but the markup *changes* between runs, so a hash key makes every
edited component look "deleted + re-added." Keying on `name/tier`
(`modal-overlay/slotted` stays itself as occurrences come and go) is less
precise but far more stable for trend tracking. Accept the imprecision —
a candidate that genuinely splits into two is rare, and the `payload`
still has the exact detail if you need to dig.

`severity` per kind: `conflictCount` (selector_conflict), `divergentCount`
(class_divergence), `saved` (component_candidate). One integer per
finding, so regression queries are a plain `>` comparison.

---

## Where the write happens

**Don't** add a `pg` dependency to the audit scripts — keep them
zero-dependency Node (that's a deliberate property — see the tools-suite
thinking). Instead:

1. Each `audit-bro.js` gains **one line** — alongside the `.html` write,
   also emit the raw `data` as `audit-bro.json`:
   ```js
   fs.writeFileSync(path.join(__dirname, 'audit-bro.json'),
                    JSON.stringify(data));
   ```
2. The **Rust backend ingests** — it already owns the sqlx pool. It reads
   `audit-bro.json`, captures git SHA/branch via `std::process::Command`,
   inserts one `audit.run` row, explodes `payload` into `audit.finding`
   rows, all in one transaction.

This folds straight into the parked **`/api/dev/audit/:tool`** endpoint.
That endpoint already wants to: spawn `node audit-bro.js`, then let the
browser open the report. Add a third step in the middle — ingest the
freshly-written `audit-bro.json` — and one click gives you: regenerated
report + a new tracked run + the diff-ready findings. Three jobs, one
endpoint, `#[cfg(debug_assertions)]`-gated so it's compiled out of
release builds.

Ingest is also runnable standalone (CLI subcommand / tiny script) for
backfilling or CI, independent of the button.

---

## What it unlocks — the change-tracking queries

```sql
-- Trend: conflict count over time
SELECT ran_at, git_sha, (stats->>'conflictSelectors')::int AS conflicts
FROM audit.run WHERE tool = 'css' ORDER BY ran_at;

-- New findings since the previous run (anti-join the last two runs)
WITH runs AS (
  SELECT id, row_number() OVER (ORDER BY ran_at DESC) rn
  FROM audit.run WHERE tool = 'css'
)
SELECT f.kind, f.finding_key, f.severity
FROM audit.finding f
JOIN runs cur  ON cur.id = f.run_id AND cur.rn = 1
WHERE NOT EXISTS (
  SELECT 1 FROM audit.finding p
  JOIN runs prev ON prev.id = p.run_id AND prev.rn = 2
  WHERE p.finding_key = f.finding_key
);

-- Regressions: a finding whose severity rose run-over-run
-- (same shape — join cur/prev on finding_key, filter cur.severity > prev.severity)
```

`fixed` is the same anti-join with `cur`/`prev` swapped. A small
`audit.run_diff(cur_id, prev_id)` SQL view or function could package
new / fixed / regressed into one call the report HTML renders as a
"since last run" panel.

---

## Open decisions

1. **Schema vs prefix** — `CREATE SCHEMA audit` (`audit.run`, `audit.finding`) keeps a clean namespace. Alternative: `audit_run` / `audit_finding` in `public`. Recommend the schema.
2. **Migration placement** — these are sqlx migrations like the rest (`backend/migrations/NNNN_audit_storage.sql`), so they ship to every environment. They're dev-meta, not app data. Either accept that (harmless empty tables in prod) or keep them in a separate, clearly-labelled migration. Recommend: one migration, labelled `-- dev-meta: audit tooling, not app data`.
3. **Findings now or later** — could ship run-only first (1 table, trends working in an afternoon) and add `audit.finding` + the explode in a second pass. Recommend both at once — the explode is ~40 lines and the diff queries are the actual point.
4. **`detail` trimming** — HTML `candidate.detail` carries `skeleton` + `callSite` (big strings). They're already in `run.payload`; trim them from `finding.detail` to keep that table lean. Minor.
5. **Payload retention** — a run every few commits → maybe hundreds of rows over months; `payload` is a few hundred KB each, so ~tens of MB total. Fine. If it ever matters: keep `run` + `finding` forever, null out `payload` for runs older than N. Not now.
6. **What counts as a "run"** — every button click? every commit (a git hook)? CI? Start with the button; the `UNIQUE (tool, git_sha, ran_at)` guard means re-running on the same commit just adds rows, harmless.

---

## Suggested phasing

| Phase | Work | Time |
|---|---|---|
| 0 | This doc — confirm schema + the HTML `finding_key` call | now |
| 1 | Migration: `audit` schema + `run` + `finding` tables | ~30 min |
| 2 | One-line `audit-bro.json` emit in both audit scripts | ~10 min |
| 3 | Rust ingest: read JSON + git context → insert `run`, explode `finding` (one TX). Standalone-runnable. | ~2–3 h |
| 4 | Fold ingest into `/api/dev/audit/:tool` (depends on that endpoint being built — see the parked button decision) | ~1 h |
| 5 | `audit.run_diff` view/function + a "since last run" panel in the report HTML | ~2 h |

Phases 1–3 stand alone and deliver tracked history immediately (ingest
runnable from the CLI). Phases 4–5 are the convenience layer and depend
on the button decision you parked.

---

## Handoff notes

- **`payload` is the source of truth; `finding` is derived.** Never hand-edit `finding` — re-explode from `payload`. This is what makes the schema survive audit-output changes.
- **The explode is per-tool.** CSS payload → walk `selectorConflicts[]` + `classIndex[]` (where `divergentCount > 0`). HTML payload → walk `candidates[]`. ~40 lines of Rust, one match on `tool`.
- **git context makes the trend meaningful.** A run without `git_sha` is just a timestamp; with it, you can pin "conflicts at commit X" and bisect a regression. Capture it at ingest, not in the Node script.
- **The HTML `finding_key` is the one fuzzy spot.** `name/tier` is the pragmatic choice. If it ever proves too lossy, the fallback is a key built from the *sorted set of member file paths* — more stable than a hash, more precise than the name. Don't reach for it until the name-key actually hurts.
- **Zero-dependency audit scripts is a deliberate property.** The only change to them is the single `audit-bro.json` write. Resist the urge to make them talk to Postgres directly — the Rust backend already has the pool, the git access, and the transaction.
- This pairs with the parked `/api/dev/audit/:tool` endpoint. If that lands as "backend dev endpoint" (option 1 from that decision), ingest is just a third line in the same handler. If it lands as "static open only," ingest runs as a standalone CLI step instead — still works, just not one-click.
