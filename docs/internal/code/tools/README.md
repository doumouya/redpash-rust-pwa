# Tools — the solo-dev + AI immune system

`tools/` is the codebase's immune system. RedPash is built by a solo founder
directing AI agents on a shared branch; nobody is reading every diff. So the
defenses are **encoded, not remembered**: a static check fails the *tool*
instead of failing the user. This README is the index for `tools/` — it lays
out how the pieces fit and *why* each exists; the per-tool mechanics live in the
script headers and the per-dir `README.md` files cited below.

This doc was **restored on lean** — it lived at `docs/internal/stack/tools.md` on
`prerelease` and was dropped in the graduation. It is rebuilt against the lean
tree, which is materially smaller than prerelease: the Postgres audit-trail, the
`tools/audit.sh` suite runner, `doc-gen`, `page-verify`, and the `tools/team/`
coordination harness were **not** ported. Where prerelease leaned on those, this
doc states the lean equivalent (or the absence) rather than the prerelease shape.

There are two layers:

1. **The CI gate** — [`tools/ci.sh`](../../../../tools/ci.sh) is the one command a
   fresh clone runs to know the tree is sound: purity, compile, tests, the audit
   ratchet, the FE tests, the FE build.
2. **The audit suite** — `tools/*-audit/audit.js`, one static analyzer per slice
   of the codebase, auto-discovered and ratcheted against a committed baseline.

Supporting these: the wasm/FE **build scripts**, the **shared libraries** in
`tools/lib/`, the **MCP server**, the **wasm benchmark** harness, and the tracked
**git hooks**.

---

## `tools/ci.sh` — the host gate

[`ci.sh`](../../../../tools/ci.sh) is the whole CI gate, runnable from a fresh
clone. Its exit code is the **failure count** (health-check style — `0` means
clean), so it composes into any outer runner. It resolves `node` from `nvm` for
non-interactive shells, then runs, in order:

1. `sh tools/purity-check.sh` — the wasm-purity gate (below).
2. `cargo check --workspace` (backend).
3. `cargo test --workspace` (backend).
4. `sh tools/ci-audit/check.sh` — the audit-suite ratchet (below).
5. `sh tools/test-fe.sh` — the frontend `node:test` gate.
6. `sh tools/build-fe.sh` — the hashed release build, which self-checks the
   shipped module graph so a typo'd import fails *here* instead of 404-ing at
   runtime.

`ci.sh` gates the `lean` → `prerelease`/`main` promotion. Anything that has to
hold before code ships goes through one of these six steps.

### `purity-check.sh` — one engine, two surfaces

[`purity-check.sh`](../../../../tools/purity-check.sh) is the mechanical "one
engine, two surfaces" gate. The `data` crate must compile to
`wasm32-unknown-unknown` at every commit with **zero io / http / threads / time**
— that purity is the entire reason the same compute engine runs byte-identical on
the server and in the browser (see
[`../backend/data-engine.md`](../backend/data-engine.md)). In the predecessor this
rule was held by convention and a grep; here it fails the build:

```sh
RUSTFLAGS='--cfg getrandom_backend="wasm_js"' \
    cargo check --target wasm32-unknown-unknown -p data
```

(The `getrandom_backend` flag is the same one `build-wasm.sh` passes — `getrandom`
0.3 needs the `wasm_js` backend cfg to build for `wasm32`.)

---

## The audit suite — static analyzers, one per slice

Each `tools/<name>-audit/audit.js` scans **one slice** of the codebase (a CSS
family, the JS↔Rust seam, the Rust structure, the docs spine, …), writes its
report (`report.html` / `audit.json`) next to itself, and exits with its
violation count. The audits are **static**: pure source scans — regex walks, and
Acorn-AST parsing in `js-audit` under the [no-frameworks](../../../decisions/day-one.md)
carve-out for `tools/*`. They need no compiler and no server, so they run anywhere
and stay a meaningful regression signal even when one parallel lane has left the
tree compile-broken.

### Auto-discovery + the ratchet — `tools/ci-audit/`

[`tools/ci-audit/check.sh`](../../../../tools/ci-audit/check.sh) is the suite
runner and the CI fidelity floor. Its one clever move is **auto-discovery**: it
globs `tools/*-audit/audit.js` and runs every **git-tracked** match (untracked
`*-audit/` dirs in a working tree are ignored as debris, so the suite is
reproducible from a fresh clone). Adding a new audit folder is picked up the day
it's committed — no edit to `check.sh`, no central registry to keep in sync. This
is deliberate: the suite is meant to grow whenever a class of bug slips through,
and the friction of "also register it somewhere" is exactly what kills that habit.

After running the suite, [`ratchet.mjs`](../../../../tools/ci-audit/ratchet.mjs)
compares each tool's violation count against
[`baseline.json`](../../../../tools/ci-audit/baseline.json) (per-tool counts).
It exits:

- `0` — every tool is at or below its baseline (`fixed` / `improved` /
  `unchanged` are all wins);
- `1` — some tool climbed above baseline (a `new`/`regressed` finding), with a
  markdown regression table on stdout;
- `2` — environment problem (node missing, malformed/absent baseline).

The large backlog of legitimate pre-existing candidates lives in the baseline as
the floored count, so it never blocks. **Green means no *new* drift, not zero
findings.** After an intentional, reviewed change to an audited surface, accept
the new counts with `sh tools/ci-audit/check.sh --update-baseline`;
`--no-run` ratchets the existing `audit.json` outputs for fast iteration. See
[`tools/ci-audit/README.md`](../../../../tools/ci-audit/README.md).

> **Why a file baseline and not Postgres.** Prerelease backed this on the
> Postgres audit-trail (`audit.run` / `audit.finding`, the `audit.run_diff(cur,
> prev)` classifier) fed by a `redpash-audit-ingest` binary, with a separate
> `tools/audit.sh` as the suite runner. **None of that DB machinery was ported to
> lean** — "Audits-as-CI ratchet (findings in Postgres, `run_diff` SQL)" was an
> explicit later-phase roadmap goal. So lean adapts the *contract*, not the
> *backend*: the suite runner is inlined into `check.sh` (same `tools/*-audit/`
> glob `audit.sh` used), and the diff is a committed file baseline read by
> `ratchet.mjs` with the same new/regressed-only-fail semantics. `baseline.json`
> retires in favour of `audit.run_diff` if the Postgres ratchet ever lands. The
> in-app audit *trail* schema this would feed is documented at
> [`../backend/monitoring.md`](../backend/monitoring.md).

### What's live today

The tracked suite (every dir carrying an `audit.js` in `baseline.json`) covers:

- **CSS / theme** — `css`, `css-cross-page`, `css-tab-compare`, `uniformity`,
  `class-count`, `theme-coverage`, `retired-class`.
- **Frontend structure** — `js`, `html`, `page-structure`, `redtable`,
  `rail-create`, `ui-doc`, `ui-snapshot`, `ui-runtime`, `fe-framework`,
  `ui-fork` (the FE-fork R1–R9 gate — runs inside the ci-audit ratchet like
  every other audit, not as a standalone `ci.sh` step).
- **Backend / seam** — `rs`, `rs-perf`, `crossing` (the JS↔Rust `/api` seam),
  `api-doc`, `list-endpoint-rbac`, `auth`, `admin-scope`, `connectors`,
  `case-coverage`, `observability`.
- **Meta / governance** — `doc-coverage` (the docs-spine enforcer, below),
  `capability` (the anti-amnesia gate, below), `privacy`, `claude-refs`.

The glob is the source of truth, not any hand-maintained list — the set above is
a snapshot, `baseline.json` is the live roster.

### The governance audits worth calling out

- **`doc-coverage-audit`** enforces the lean docs spine — the contract this very
  README is part of. It is a *curated topic-doc* enforcer (not the predecessor's
  per-file atomic-doc mirror): it flags `index_missing` (every `.md` under
  `docs/` has a row in [`../../../INDEX.md`](../../../INDEX.md)), `index_dangling`
  + `orphan_link` (every relative `.md` link resolves to a real file — this is
  what would FAIL the build on a dangling link in this doc), `redmap_missing`
  (every non-spec doc mapped in [`../../../REDMAP.md`](../../../REDMAP.md)), and a
  retired-naming check (the dropped post-rebuild era titles + DB names are
  banned). It is why a restored doc must add its INDEX + REDMAP rows and keep
  every link live in the same commit.
- **`capability-audit`** is the anti-amnesia gate. The lean graduation re-landed
  from memory, so anything unremembered was silently lost; this tool extracts the
  live capability manifest from the tree and diffs it against the committed
  ledger ([`../../capability-ledger.md`](../../capability-ledger.md)), failing CI
  on a `DROPPED` capability. It is the enforcement arm of
  [disposability-requires-a-ledger](../../../decisions/disposability-requires-a-ledger.md).
- **`claude-refs-audit`** keeps the `/feature` orchestrator honest: every gate
  script and doc a `.claude/` role prompt names must exist on disk, so a renamed
  gate or relocated reading-list doc fails *this* tool, not a cold subagent
  mid-dispatch. Context in
  [`../../specs/agent-system-review-2026-06-12.md`](../../specs/agent-system-review-2026-06-12.md).

### Cadence

Run the suite before each commit and **between slices** of any multi-slice
campaign (after every 2–3 slices, or before a push-request). If a tool reports
`new`/`regressed` rows, stop and bisect *now* — the slice that surfaced it is the
cheapest commit to blame; later slices stacking on top multiply the cost.
Findings trigger a small immediate cleanup, never a deferred big-bang pass: small
+ frequent so cleaning never becomes a job. A new audit tool is added when a class
of bug the existing suite *missed* shows up — the trigger is the escaped bug, not
anticipation.

---

## Build scripts — the wasm/FE pipeline

- [`build-wasm.sh`](../../../../tools/build-wasm.sh) builds the `data` crate's
  browser engine in a 4-stage pipeline: `cargo build` (wasm32 release, `getrandom`
  `wasm_js` backend) → `wasm-bindgen --target web` → `wasm-opt -Oz` →
  **content-hash rename** (`data_bg.<hash12>.wasm` + loader URL rewrite). The hash
  *is* the cache version: new bytes → new hash → new URL, so the service worker's
  cache-first can never serve a stale engine and nobody hand-bumps a cache number.
- [`build-wasm-gluesql.sh`](../../../../tools/build-wasm-gluesql.sh) builds the
  on-device GlueSQL store (`frontend/wasm-src/gluesql`) — the customer-data engine
  (GlueSQL + IndexedDB) shipped beside the Polars engine. Same 4-stage +
  content-hash pipeline, but a **separate, self-isolated** crate whose
  `idb`/`getrandom-js` deps never touch the pure `data` crate or the native build.
  (Engine roles by job are decided in
  [`../../../decisions/client-data-engines.md`](../../../decisions/client-data-engines.md).)
- [`build-fe.sh`](../../../../tools/build-fe.sh) → `build-fe.mjs` is the hashed
  release build of the frontend; it self-checks the shipped module graph (a typo'd
  import fails the build, not runtime). Known dist-bloat case:
  [`../../specs/build-fe-wasm-src.md`](../../specs/build-fe-wasm-src.md).
- [`test-fe.sh`](../../../../tools/test-fe.sh) runs the `node:test` harness over
  `frontend/tests/*.test.js` — `node:test` only, no JS test framework (repo rule).
- [`wasm-smoke.mjs`](../../../../tools/wasm-smoke.mjs) loads the built engine in a
  **node** host (no browser), enumerates every export, and exercises `parse_score`
  including a lazy-collect path — the check that caught the predecessor's
  `.enable_time` runtime panic that a green `cargo check` hid.

---

## Shared libraries — `tools/lib/`

One extraction lives in one place so a fix lands for every consumer at once.

- [`rust-routes.js`](../../../../tools/lib/rust-routes.js) is the **single**
  code-side API surface parser — an Axum route extractor (flat `src/*.rs` modules
  + the `files/` directory module, rooted at `main.rs`, HTTP methods per route,
  generic nest-gate detection). Every tool that needs the code-side route set
  consumes this lib (`api-doc-audit` today; `crossing-` / `list-endpoint-rbac-`
  when they need it), so the extraction logic isn't re-implemented per audit. It
  parses against the route catalog in [`../backend/api-routes.md`](../backend/api-routes.md).
- `fe-inventory.js` is the frontend component-inventory enumerator the FE audits
  share.

---

## MCP server — `tools/mcp-server/`

`tools/mcp-server/` is the MCP server that exposes the cases + internal-slack
surfaces to other agents (the canonical-file transport that retires cross-host
channel divergence). On lean only the compiled `dist/` ships
(`server.js` + `handlers.js` + `cases.js` + `slack.js` + the `transports/`); the
SDK dependency is the [no-frameworks](../../../decisions/day-one.md) carve-out for
agent tooling. The cases surface it fronts is the backend
[`../backend/cases.md`](../backend/cases.md).

---

## wasm-bench — is client-side wasm fast enough to be the default?

[`tools/wasm-bench/`](../../../../tools/wasm-bench/README.md) times the **same ops
on both surfaces** (native server vs the `-Oz` shipped wasm in a node host) across
a row-count sweep, to answer with numbers: the **wasm tax** per op (read the
ratio, not machine-relative ms) and **the cliff** — the row count where each op
crosses ~100 ms / ~1 s and the client path should hand off to the server. It is
the measure-first input to the "one engine, two surfaces, gated by capacity"
decision; results live under `tools/wasm-bench/results/` and `CEILING.md`.

---

## Git hooks — `tools/hooks/`

`tools/hooks/` holds **version-controlled** git hooks plus a non-destructive
installer (`.git/hooks/` isn't tracked, so the hooks live here and get copied in).
`sh tools/hooks/install.sh` (once per clone) copies each hook into `.git/hooks/`,
overwriting **only** that hook and deliberately *not* setting `core.hooksPath`, so
any other installed hook keeps working — idempotent, safe to re-run. The tracked
`pre-push` hook runs the local gate before a push leaves the machine. This is the
same philosophy as the audit suite, applied to git: encode the discipline so a
slip fails a check, not a teammate's afternoon.

---

## Related

- [Tools — backend index](../backend/README.md) — the three-crate workspace the
  audits and build scripts target
- [Day-one decisions](../../../decisions/day-one.md) — the no-frameworks
  carve-out, unique-prefix-per-type, the IDOR guard the audits enforce
- [Capability ledger](../../capability-ledger.md) — what `capability-audit` diffs
  the tree against
- [docs/ index](../../../INDEX.md) · [REDMAP](../../../REDMAP.md) — the docs spine
  `doc-coverage-audit` enforces
- [Runbook 0011](../../runbooks/0011-object-kind-prefix-mismatch.md) — a worked
  example of the drift class the registry-driven audits exist to catch
