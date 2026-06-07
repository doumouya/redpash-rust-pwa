---
title: Stack — Tools
section: Internal
last modified date: 2026-06-07
---

# Stack — Tools

`tools/` is the codebase's immune system. RedPash is built by a solo
founder directing AI agents on a shared branch; nobody is reading every
diff. So the defenses are encoded, not remembered: a static check fails
the tool instead of failing the user. This doc explains how the pieces
fit and *why* each exists — the per-tool mechanics live in the survival
docs linked at the bottom.

Four families:

1. **The audit suite** — static analyzers, one per slice of the codebase.
2. **doc-gen** — generators that derive mechanical doc content from a
   single source of truth, so docs can't drift from the code.
3. **page-verify** — the runtime check that drives real pages in a
   browser, the one defense a static scan can't give.
4. **team coord** — append-only signals so parallel agents don't clobber
   each other.

---

## The audit suite

`sh tools/audit.sh` is the master runner. Its one clever move is
**auto-discovery**: it globs `tools/*-audit/audit.js` and runs every
match. Adding a new audit folder is picked up the day it lands — no edit
to `audit.sh`, no central registry to keep in sync. This is deliberate:
the suite is meant to grow whenever a class of bug slips through, and the
friction of "also register it somewhere" is exactly what kills that habit.

Each `tools/<x>-audit/audit.js` scans one slice and writes its report
(`audit.html` and/or `report.html`) next to itself. The runner derives a
canonical tool name from the folder (`tools/css-tab-compare-audit/` →
`tab-compare`, stripping the `-audit` suffix and a leading `css-` family
prefix) so it lines up with the persistence layer's `tool` CHECK.

What's live today (22 folders match the glob): the CSS family
(`css-audit`, `css-cross-page-audit`, `css-tab-compare-audit`,
`uniformity-audit`, `class-count-audit`), the structural scanners
(`js-audit`, `rs-audit`, `rs-perf-audit`, `html-audit`,
`page-structure-audit`), the seam checks (`crossing-audit` for the JS↔Rust
`/api` boundary, `api-doc-audit`, `list-endpoint-rbac-audit`,
`connectors-audit`), the foundation-contract checks (`redtable-audit`,
`fe-framework-audit`, `ui-doc-audit`, `ui-snapshot-audit`,
`ui-runtime-audit`), the security/observability checks (`auth-audit`,
`observability-audit`), and the meta-audit that enforces this whole docs
tree (`doc-coverage-audit`). The cadence doc's table lags reality — the
glob is the source of truth, not any hand-maintained list.

The audits are **static**: pure source scans (regex walks, and Acorn-AST
parsing in `js-audit` under the no-frameworks carve-out for `tools/*`).
They don't need a compiler or a server, so they run anywhere and stay a
meaningful regression signal even when one parallel lane has left the tree
in a compile-broken intermediate state.

### Persistence and trend reading

Tools that emit `audit.json` are ingested into Postgres (`audit.run` +
one `audit.finding` per finding) via the `redpash-audit-ingest` binary,
which `audit.sh` pre-builds once so the per-tool loop runs native. The
`INGEST_TOOLS` allow-list in `audit.sh` gates which tools get persisted;
the table's `tool` CHECK constraint must be relaxed (a migration) before a
new tool's findings can land. After ingest, `audit.run_diff(cur, prev)`
classifies each finding as `new` / `fixed` / `regressed` / `improved` /
`unchanged`, and the binary prints a one-line "since last run" diff per
tool. That diff is the whole point: a misplaced selector or a class
divergence shows up as a `new`/`regressed` row inline, the moment it's
introduced.

### The CI gate

`tools/ci-audit/check.sh` wraps the suite for enforcement: it runs
`audit.sh`, queries `audit.run_diff` per ingested tool, and exits non-zero
with a markdown regression table if any tool gains `new` or `regressed`
findings. `fixed` / `improved` / `unchanged` never fail — the large
backlog of legitimate pre-existing candidates reads as `unchanged` and is
not a failure. This is the fidelity floor: green means no *new* drift, not
zero findings.

### The cadence

Live practice: run `sh tools/audit.sh` before each commit, and **between
slices** during any multi-slice decomposition campaign (after every 2–3
slices, or before every push-request). If a tool reports `new`/`regressed`
rows, stop and bisect *now* — the slice that surfaced it is the cheapest
commit to blame; later slices stacking on top multiply the cost. Findings
trigger a small immediate cleanup, never a deferred big-bang pass: small +
frequent so cleaning never becomes a job.

A new audit tool is added when a class of bug the existing suite *missed*
shows up. The trigger is the escaped bug, not anticipation — the catalogs
each audit tracks expand in response to findings.

### doc-coverage-audit — the audit that guards the docs

One audit deserves a callout because it enforces the touch-policy in
`CLAUDE.md`: editing a source file requires updating its atomic doc in the
same commit. `doc-coverage-audit` checks both directions — every source
file under `tools/`, `frontend/scripts/`, `backend/crates/` has a doc
under `docs/internal/code/<mirrored-path>.md`, and every source carries a
2-line `Doc:` breadcrumb pointing back. It flags `missing_doc`,
`missing_breadcrumb`, `stale_doc` (source touched >14 days after its doc),
and `wrong_breadcrumb`. It also checks navigational consistency of the
`docs/internal/` tree itself. This is what keeps the code/ survival layer
— the layer this doc's "Source files" section links into — actually
reachable and current.

---

## doc-gen — facts that can't drift

`tools/doc-gen/gen.js` fixes the doc-duplication problem at the root.
Schemas, route tables, and component inventories were hand-described in
multiple places (the schema was *tripled*: a 54KB `schema.md`, 14
object-metadata specs, plus per-object docs). Hand-copied facts drift the
moment the code changes.

doc-gen derives the mechanical *what* from the one source and writes it
into a **generated region** of the canonical doc, bounded by markers:

```
<!-- doc-gen:schema:users START — generated from live DB; do not hand-edit -->
...generated table...
<!-- doc-gen:schema:users END -->
```

The tool only ever rewrites *between* the markers. The human "why /
how-it-works" prose around them is never touched. Re-run on a schema
change and the table updates while the prose survives — you cannot
duplicate or drift a fact that's generated from its source.

The single source of truth differs by what's being generated:

- **Schema** (phase 1) — the *live DB*, not the migration files.
  doc-gen introspects `information_schema` + `pg_catalog` via the system
  `psql` (no Node DB dependency — same read-only posture as the shell
  audits; DSN from `backend/.env`, auto-detecting `:5432`→`:5433`). The
  applied DB state is the truth because static replay of `init.sql` plus
  N `ALTER`s (CHECK/rename changes) is brittle.
- **Routes** — consumed from `tools/lib/rust-routes.js` (the api-doc
  lane), not re-parsed here.
- **Components** — the FE inventory enumerator in `tools/lib/`.

Each run also emits a `*.contract.json` (the parity artifact), the basis
for an audit-side check that the generated docs and the live source still
agree. Output lands under `tools/doc-gen/out/` as the proof home until a
generated region is wired into its canonical doc.

---

## page-verify — the runtime defense

Everything above is static. The one thing a source scan *cannot* catch is
a rename that compiles and parses but silently breaks behavior — the
classic being a `rt-*`→`rp-*` markup rename that misses a JS selector, so
the rail renders but a tab click does nothing, with no parse error.

`tools/page-verify/verify.js` is the active runtime check for that gap.
It is deliberately **not** a `tools/*-audit/` member: it launches a real
headless browser and needs the dev server up, so it must stay out of the
always-run static suite (which runs anywhere, no server). Per railed page
it asserts: the rail renders on the framework `rp-rail*` atoms; the rail
subtree has zero residual `rt-*` (migration complete *within* the rail);
a rail tab click actually *activates* (JS lockstep is functional, not just
renamed); `--rp-accent` resolves under every theme; and the console is
clean through load + interaction.

It auto-dev-logs (needs the server running with `REDPASH_DEV_LOGIN=1`,
default base `http://127.0.0.1:8080`) and drives a fresh-profile system
Chrome / chromium (or Playwright's bundled chromium), sidestepping the
recurring browser-MCP profile-contention block. Usage:
`node tools/page-verify/verify.js --pages profile,docs --themes new-dark`.
If the server isn't reachable or dev-login fails, it exits 2 (skip), not
1 (fail) — a missing server isn't a regression. It complements
`ui-runtime-audit` (the static `?audit` capture-vs-enumeration lane):
that one diffs a snapshot, this one drives the page end-to-end.

---

## team coord — parallel agents without lock files

Three Torv instances share one tree and one branch. `tools/team/` gives
them three append-only signals so they don't clobber each other — no
daemon, no lock files, just markdown plus git hooks:

1. **commits** — a `post-commit` hook appends one line per commit to
   `Internal-Slack/commits.log`, so everyone sees who landed what without
   a DM.
2. **presence** — each agent maintains `Internal-Slack/presence/<agent>.md`
   listing the paths under their active claim.
3. **overlaps** — `tools/team/board.js` reads both and flags any two
   agents claiming the same path (or a parent/child of it) as a collision.
   Run it before claiming a new folder.

`tools/team/install.sh` (once per clone) installs two hooks. Besides the
`post-commit` broadcast, the **`pre-commit` gate** runs the correctness
checks that used to be manual, each firing only when its file kind is
staged so a frontend-only commit never pays the Rust compile:

- Staged frontend `*.js` → ESM syntax check (`node --check
  --input-type=module`, forcing a *module* parse — plain `node --check`
  reads `.js` as CommonJS and silently passes a broken ES module, the
  exact duplicate-declaration / parse-error class that blanks the page).
- Any frontend `*.js` staged → the js-audit anti-pattern gate (blocks on
  `esc`/`cssEsc` redefinition, themeless `echarts.init`, a data endpoint
  with no `file_type` gate, …).
- Any backend `*.rs` staged → `cargo check -p api`.

Bypass with `--no-verify` only when you know why. `tools/team/verify.sh`
audits `commits.log` for git commits that never made it into the log.

This is the same philosophy as the audit suite, applied to coordination:
encode the discipline so a slip fails a check, not a teammate's afternoon.

---

## Source files

- [`tools/shell/audit.md`](../code/tools/shell/audit.md) — `tools/audit.sh`, the auto-discovering master runner
- [`tools/audit-suite/`](../code/tools/audit-suite/index.md) — per-audit survival docs (one per `tools/*-audit/`)
- [`tools/audit-suite/doc-coverage-audit.md`](../code/tools/audit-suite/doc-coverage-audit.md) — the doc/breadcrumb drift enforcer
- [`tools/audit-suite/ci-audit.md`](../code/tools/audit-suite/ci-audit.md) — the `audit.run_diff`-backed CI gate
- [`tools/audit-suite/css-audit.md`](../code/tools/audit-suite/css-audit.md) — most mature audit; sets the shape new ones follow
- [`tools/doc-gen/gen.md`](../code/tools/doc-gen/gen.md) — `tools/doc-gen/gen.js`, generated-region fact generator
- [`tools/page-verify/verify.md`](../code/tools/page-verify/verify.md) — runtime page-driver / migration verifier
- [`tools/team.md`](../code/tools/team.md) — presence files, commit broadcast, pre-commit gate, board overlay
- [Tools — atomic docs index](../code/tools/index.md) — the full per-unit map of `tools/`
- [Audit cadence](../processes/audit-cadence.md) — when/how often the suite runs
