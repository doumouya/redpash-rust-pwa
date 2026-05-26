# `tools/ci-audit/` — the CI fidelity floor

Single script: `check.sh`. Wraps the existing audit suite + the
`audit.run_diff(cur, prev)` SQL function (mig 030) into a CI-friendly
exit-code wrapper.

## What it does

1. Runs `sh tools/audit.sh` (which executes every `tools/*-audit/audit.js`
   AND ingests the whitelisted tools into `audit.run` + `audit.finding`).
2. For each ingested tool, queries `audit.run_diff(latest, prev)`.
3. Counts findings with `status IN ('new', 'regressed')`.
4. Exits `0` when no regressions; exits `1` with a markdown table of
   regressions otherwise.

`fixed` / `improved` / `unchanged` findings don't fail CI — only new
additions to the noise floor (or escalations of existing findings)
trigger exit 1. The 102 legitimate `css-parallel` candidates already
present don't trigger a failure because they read `unchanged`.

## Usage

```sh
# Full run: audit suite + diff check. The default.
sh tools/ci-audit/check.sh

# Fast iteration: skip the audit run, just check the existing
# latest-vs-previous DB state for each tool.
sh tools/ci-audit/check.sh --no-run
```

Exit codes:
- `0` — no regressions
- `1` — regressions detected (markdown table printed to stdout)
- `2` — environment problem (missing `DATABASE_URL`, etc.)

## Why this shape

The diff machinery (`audit.run_diff`) is a Postgres function — the
classification logic (new / fixed / regressed / improved / unchanged)
already lives in SQL where it benefits from indexes + transactionality.
This script is just the wrapping: run the suite, query the function,
render the result. ~80 LOC of shell + one `psql` query.

Building a Node or Rust comparator would have re-implemented work that
already lives in mig 030. Shelling out to `psql` is the [[feedback-no-frameworks]]
choice — every dev box already has it from the backend setup.

## What's NOT in scope here

- The audit tools themselves — those live in their own `tools/*-audit/`
  dirs and emit `audit.json` independently.
- The ingest binary — `backend/crates/api/src/bin/redpash-audit-ingest.rs`,
  exploded findings into rows. Owned by the BE audit-trail lane.
- The `?audit=1` SPA self-report mode + the `ui-snapshot` audit tool —
  Layer 2 of the UX/UI automation lane; lands separately.

## Future work

When the BE lane broadens `redpash-audit-ingest` to handle additional
tools (`css-parallel`, `css-tab-compare`, `css-cross-page`, `ui-snapshot`),
this script needs zero changes — it queries the whole `audit.run` table
and naturally picks up new tools as they start writing rows.
