# `tools/ci-audit/` — the CI fidelity floor

`check.sh` (the entry) + `ratchet.mjs` (the gate) + `baseline.json` (the
committed floor). Runs the audit suite, then fails CI only when a tool's
violation count climbs above its baseline.

## What it does

1. Auto-discovers every **git-tracked** `tools/*-audit/audit.js`, runs each one.
   In lean today that's `tools/ui-fork-audit/` alone; new audits are picked up
   the day they're committed — no edit here.
2. Computes a violation count per tool (from `audit.json` when the tool emits
   one, else from the audit's exit code).
3. Compares each count to `baseline.json`.
4. Exits `0` when every tool is at or below baseline; exits `1` with a markdown
   table when any tool is above baseline (a `new`/`regressed` finding).

`fixed` / `improved` / `unchanged` don't fail CI — only counts that climb
above the baseline do. After an intentional, reviewed change to an audited
surface, accept the new counts with `--update-baseline`.

## Usage

```sh
# Full run: audit suite + ratchet vs baseline. The default.
sh tools/ci-audit/check.sh

# Fast iteration: skip the suite run, ratchet the existing audit.json /
# exit-code outputs.
sh tools/ci-audit/check.sh --no-run

# Accept the current counts as the new baseline (after a reviewed change).
sh tools/ci-audit/check.sh --update-baseline
```

Exit codes:
- `0` — no regressions
- `1` — regressions detected (markdown table printed to stdout)
- `2` — environment problem (node missing, malformed/absent `baseline.json`)

## Why this shape (and how it differs from prerelease)

Prerelease backed this entirely on Postgres: the audit suite ran via a separate
`tools/audit.sh`, exploded findings into `audit.run` / `audit.finding`
(mig 028) through the `redpash-audit-ingest` binary, and the regression
classification (new / fixed / regressed / improved / unchanged) lived in the
`audit.run_diff(cur, prev)` SQL function (mig 030). `check.sh` was an ~80-LOC
shell wrapper around one `psql` query.

**None of that DB machinery exists in lean.** The audit-trail schema, the
ingest binary, and `tools/audit.sh` were not ported — the
"Audits-as-CI ratchet (findings in Postgres, `run_diff` SQL, only new/regressed
fail)" is an explicit **Phase 7** item in [`docs/ROADMAP.md`](../../docs/ROADMAP.md).
So this lean version adapts the *contract*, not the *backend*:

- The suite runner is **inlined** into `check.sh` (lean has no `tools/audit.sh`),
  globbing tracked `tools/*-audit/audit.js` — the same auto-discovery prerelease's
  `audit.sh` did.
- The diff is a **file baseline** (`baseline.json`: per-tool counts) read by
  `ratchet.mjs`, not a `psql` call. Same new/regressed-only-fail semantics.
- Node, not Rust/psql — the suite is already Node ([[feedback-no-frameworks]]
  static-analysis carve-out), and the gate stays in the same runtime.

This is the **interim stand-in** until Phase 7 lands the Postgres ratchet, at
which point `baseline.json` + `ratchet.mjs` are replaced by `audit.run_diff` and
the adaptation note in `check.sh`'s header retires.

## What's NOT in scope here

- The audit tools themselves — each lives in its own `tools/*-audit/` dir and
  emits its own report. Today only `ui-fork-audit` is committed; the rest land
  across Phase 5–7. (`doc-coverage-audit`, `auth-audit`, etc. exist as untracked
  stale prerelease copies in the working tree — they are **not** part of the
  floor until a lean-adapted version is committed, at which point this script
  picks them up automatically.)
- The Postgres audit-trail (`audit.run` / `audit.finding` / `audit.run_diff`)
  and the `redpash-audit-ingest` binary — Phase 7.

## Wiring into the gate

`tools/ci.sh` is the whole-CI gate. Once more audits are committed, add:

```sh
run sh tools/ci-audit/check.sh --no-run   # ratchet (suite already ran above)
```

Today `ci.sh` runs `tools/ui-fork-audit/audit.js` directly; this ratchet is
the layer that turns "N violations" into "did N get worse than the floor".
