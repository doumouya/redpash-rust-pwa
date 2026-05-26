---
title: Audit-ingest explode contract — per-tool finding_key + severity
section: Internal
order: 39
last modified date: 2026-05-26
owner: Gus
status: live (ui-snapshot landed; tab-compare / cross-page / parallel stubbed pending Woz spec)
---

# Audit-ingest explode contract

`redpash-audit-ingest` (`backend/crates/api/src/bin/audit_ingest.rs`)
persists one `tools/<tool>-audit/audit.json` run into
`audit.run` + `audit.finding` per [mig 028][m028]. The `explode()`
function in that binary is per-tool: each match arm reads the tool's
canonical `audit.json` shape and emits one or more `Finding` rows.

This doc is the canonical contract for what each tool's explode
expects on the wire. Source-of-truth for the JS-side shape is each
tool's own `audit.js` header block; this doc mirrors them in one
place so a Rust contributor extending the ingest binary doesn't have
to chase per-tool comments.

[m028]: ../../../backend/migrations/20260528000001_audit_storage.sql

## Invariant: `finding_key` is the diff axis

`audit.run_diff(cur_id, prev_id)` is a self-join on `finding_key`.
Same key across runs + same severity → `unchanged`. Same key + different
severity → `regressed` / `improved`. Key in cur but not prev → `new`.
Key in prev but not cur → `fixed`.

The rule that drops out: **the `finding_key` MUST be stable across runs
for findings that represent the same logical-thing**, and MUST carry
no value-data that would drift between runs (timestamps, hashes of
content, etc). The severity is the channel for "this is the same
finding but the value changed."

## Invariant: canonical tool names (no `css-` prefix)

`audit.run.tool` values are the canonical short-form per
[mig 20260613000001][m613] — `css`, `html`, `tab-compare`,
`cross-page`, `parallel`, `ui-snapshot`. The audit.sh script applies
`${tool#css-}` after `basename -audit` so `tools/css-cross-page-audit/`
ingests as `cross-page`, NOT `css-cross-page` (which would fail the
CHECK).

[m613]: ../../../backend/migrations/20260613000001_relax_audit_tool_check.sql

---

## Per-tool explode shapes

### `css` (live since mig 028)

**Source:** `tools/css-audit/audit.json`
**Top-level fields read:** `selectorConflicts[]`, `classIndex[]`

| kind | finding_key | severity | detail |
|---|---|---|---|
| `selector_conflict` | `{atContext} \|\|\| {selector}` | `conflictCount` | full item |
| `class_divergence` | `{cls}` (only if `divergentCount > 0`) | `divergentCount` | full item |

### `html` (live since mig 028)

**Source:** `tools/html-audit/audit.json`
**Top-level fields read:** `candidates[]`

| kind | finding_key | severity | detail |
|---|---|---|---|
| `component_candidate` | `{name}/{tier}` | `saved` | item minus `skeleton` + `callSite` (already in `run.payload`) |

### `ui-snapshot` (live since this commit — Woz spec'd on Gus.md 23:21)

**Source:** `tools/ui-snapshot-audit/audit.json` (emitted by
`tools/ui-snapshot-audit/audit.js` from snapshots captured by the SPA's
`?audit=1` mode)
**Top-level fields read:** `findings[]`

The JS side pre-formats every finding with its own `finding_key`,
`severity`, and `kind`. The Rust explode is a **straight projection**
— no derivation logic, just unpack each `findings[]` item into a
`Finding` row.

| kind | finding_key | severity | detail |
|---|---|---|---|
| `atom_style` | `{route}#{atom}#{prop}@{theme}` (e.g. `#/profile#.rp-page__section#box-shadow@dark`) | `djb2(value) & 0x7fffffff` (positive int4) | full item |
| `atom_missing` | `{route}#{atom}@{theme}` (no prop) | `0` (constant — missingness has no value to hash) | full item |

**Diff semantics** (per Woz's 23:21 walkthrough):
- value drift → severity change → surfaces as `regressed`/`improved`
- atom appearing on a route → `new`
- atom disappearing → `fixed`

**Verified end-to-end** 2026-05-26 against the first dog-food run:
424 findings (392 `atom_style` + 32 `atom_missing`) ingested cleanly
into `audit.finding`; sample finding_key reads
`#/profile#.rt-btn#line-height@dark` with severity `2119002650`.

### `tab-compare` (stubbed, pending Woz spec)

**Source:** `tools/css-tab-compare-audit/audit.json`
**Status:** the explode arm currently logs a warning and emits zero
findings. `audit.run` row IS still inserted (so the run baseline +
payload are captured for future re-explode), but no `audit.finding`
rows persist.

Observable shape of `audit.json` today (sample data has all drift
arrays empty, so stubbing is a no-op against today's run):

```
{
  "tool": "css-tab-compare",
  "ran_at": "...",
  "pairs": [
    {
      "a": "monitoring:events",
      "b": "home:projects",
      "crossPrefix": [],       // drift signal — empty in current sample
      "misnamedShared": [],    // drift signal — empty in current sample
      "mixed": [],             // drift signal — empty in current sample
      "onlyA": [...class names],          // inventory, not drift
      "onlyB": [...class names],          // inventory, not drift
      "shared": [...class names],         // inventory, not drift
      "inventory": { ... }                // per-tab catalog
    }
  ]
}
```

**Likely explode shape** (pending Woz's canonical spec — DO NOT
implement on this guess; the items inside `crossPrefix` etc. may be
strings OR objects, and the diff semantics for the inventory arrays
are not yet defined):

- One finding per item in each of `crossPrefix` / `misnamedShared` /
  `mixed` per pair.
- `finding_key` shape: `{pair.a} || {pair.b} || {item_id}` for
  pair-scoped findings.
- `severity` for drift arrays: probably `1` per occurrence, OR a
  weight per the kind. TBD.

### `cross-page` (stubbed, pending Woz spec + emit)

**Source:** `tools/css-cross-page-audit/audit.json` — **not yet
emitted**. `tools/css-cross-page-audit/audit.js` exists but no
`audit.json` artifact in the tree today per the audit-cadence inv-
entory.

**Status:** explode arm stubbed (warns + emits zero findings) so the
INGEST_TOOLS extension can include `cross-page` without breakage; the
arm activates the moment the audit gains its emit + Woz spec'd
finding shape.

### `parallel` (stubbed, two coordination items above explode)

**Source:** `tools/css-parallel/parallels.json` — note **non-canonical
filename** (`parallels.json` not `audit.json`) AND non-canonical dir
(`tools/css-parallel/` not `tools/css-parallel-audit/`).

**Status:** explode arm stubbed; two upstream coordination items must
land before the arm is reachable from `tools/audit.sh`:
1. Filename override at the binary's `let path = ...` site (line ~36)
   — currently hardcoded to `audit.json` for the auto-derived path.
   `--file` can be passed explicitly as a workaround in the meantime.
2. The audit.sh for-loop's `tools/*-audit/` glob doesn't match
   `tools/css-parallel/`; either rename the dir to `-audit` or
   extend the glob (see audit.sh's pending `find tools/*/audit.js`
   refactor flagged on Woz.md 23:26).

Once both gates pass, the `parallels.json` shape is well-defined per
the existing `tools/css-parallel/audit.js` header — straight per-item
explode like `css`.

---

## How to add a new tool

1. **Migration**: amend the [latest CHECK-relax mig][m613] (DROP + ADD
   with the new tool name) — or add a new mig if the latest is on
   origin.
2. **`tools/audit.sh`**: add the canonical tool name (no `css-`
   prefix) to `INGEST_TOOLS`. The for-loop's `basename -audit` +
   `${tool#css-}` normalisation handles the directory-to-canonical
   bridge.
3. **`audit_ingest.rs`**: extend the `ALLOWED` array in `parse_args`
   AND add a new match arm in `explode`. Per-finding the contract is
   `Finding { kind, key, severity: Option<i32>, detail: Value }` —
   key MUST be diff-stable (no value embedded), severity MUST be a
   positive int4 (Postgres int4 column type).
4. **This doc**: add a "Per-tool explode shapes" subsection with the
   canonical finding_key + severity + detail mapping.
5. **Smoke test**: run the binary directly with `--tool <new-name>
   --file <path-to-audit.json>` against a real artifact; verify
   `SELECT kind, COUNT(*) FROM audit.finding WHERE run_id = ...
   GROUP BY kind` matches expectations.

---

## See also

- [`tools/audit-storage-brainstorming.md`](../../../tools/audit-storage-brainstorming.md) — original schema design rationale.
- [`docs/internal/processes/audit-cadence.md`](../processes/audit-cadence.md) — the audit suite's run cadence + "Capture → audit → CI chain" + the registered tool list.
- [`docs/internal/architecture/roadmap-webassembly.md`](../architecture/roadmap-webassembly.md) §8 — the audit chain upgrade Phase C surfaces (the `rs-audit` `wasm32 build status` row that lands once the wasm bundle becomes a tracked metric).
