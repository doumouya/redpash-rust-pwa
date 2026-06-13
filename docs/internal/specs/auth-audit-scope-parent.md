---
case_id: CAS_26EC04CAF5934A0996B7A04C8FA55534
title: auth-audit — scope_parent_id / parent-bind detector (Cat-4)
area: tools/auth-audit
type: task
sibling_of: CAS_DD6F55FB1B1446138936DBF66A74DBDB
date: 2026-06-12
status: spec — awaiting Checkpoint 1
---

# Spec: auth-audit detector for unchecked `scope_parent_id` / parent binds (Cat-4)
Case: CAS_26EC04CAF5934A0996B7A04C8FA55534  ·  type: task  ·  area: tools/auth-audit/audit.js (+ its atomic doc)

> **Sibling of CAS_DD6F55FB1B1446138936DBF66A74DBDB** (the objects.rs `scope_parent_id` IDOR).
> The runtime FIX (`require_grant ≥Member` guard on `scope_parent_id` in `objects.rs::create`) and
> the Rust regression test both **already landed** (commits d3f933a, b060a69, 8699679). This Case
> is the **static-analysis guard** — split off from that Case's AC-5/AC-6 at its Checkpoint 1 — so
> the whole *class* of "read a caller-supplied parent id, bind it to a write, no reach check" fails
> the audit tool instead of a user. Runbook for the class:
> `docs/internal/runbooks/objects-scope-parent-idor.md`.

## Problem / intent
`tools/auth-audit/audit.js` walks every backend route handler and today flags only the generic
"ownership leak" (a `Path(rid)` handler missing an `ensure_*_owner`/`require_member` gate). It does
NOT recognize the IDOR class the sibling Case fixed: a handler that **reads a caller-supplied parent/
scope id from the request body** and **binds it into a DB write** with **no reach check on that id**.
We need a precise new detector so that class fails the tool. Precision is the whole job here:
auth-audit's existing Cat-1 heuristic already reports `objects.rs::create` as a **false positive**
(`no-ensure-owner` — it doesn't recognize `require_grant`; see `audit.json` `leaks[]`), so the new
detector must (a) recognize `require_grant`/`require_view`/`require_action` on the bound id and (b)
NOT add to that noise — it must be GREEN on the now-fixed `objects.rs::create`.

## Acceptance criteria (numbered — tests map 1:1 to these)

> Numbering continues the sibling Case (AC-1..AC-4 were the Rust regression test, already shipped).

- **AC-5: a new Cat-4 detector flags scope-parent writes missing a reach check.** Extend `audit.js`
  with a classifier that flags a handler when ALL of:
  1. it **reads a caller-supplied parent/scope id** — a `#[derive(Deserialize)]` body-struct field
     or a destructured `Json(...)`/`Query(...)`/`Form(...)` binding whose name matches
     `/\b(scope_parent|parent)_id\b/` (v1 field-name set — see "What it flags vs ignores"); AND
  2. that value **reaches a DB write** — it appears in an `INSERT`/`UPDATE` SQL string in the same
     handler body that also has a `.bind(&…<that field>…)` (e.g. `.bind(&body.scope_parent_id)`),
     OR it is passed to a `db::(insert|update|create|register)_…` / `register_entity` mutation call;
     AND
  3. there is **no reach check** in the same handler body — no `require_grant` / `require_view` /
     `require_action` call (the Cat-4 gate set), AND no `AUTH-AUDIT-ACK` annotation, AND the handler
     is not a `HELPER_NAMES` entry / non-extractor helper (reuse the existing filters verbatim).
  The finding is emitted in a **new category** that matches the SHAPE of the existing detectors:
  a `scopeParentLeaks` array in `audit.json` (rows `{ file, name, kind: 'scope-parent-injection',
  detail }`), a new headline stat `scopeParentLeaks`, a new card + tab/panel/table in `report.html`,
  and a new line in the console summary. Counts roll up exactly like `leaks`/`auditGaps`.

- **AC-6: the detector is GREEN on the current fixed tree and RED on a guard-removed negative case.**
  Running `node tools/auth-audit/audit.js` against the live tree:
  - `objects.rs::create` is **NOT** in `scopeParentLeaks` (it reads `body.scope_parent_id`, binds it
    into the `entity_data` INSERT, AND calls `require_grant` on `parent` — condition 3 fails, so no
    flag). `connectors.rs::create` is **NOT** flagged (it reads `project_id` — outside the v1 field
    set — and guards with `require_grant`; green either way). I.e. `scopeParentLeaks` is **empty (0)**
    on the current tree.
  - A handler that reads `scope_parent_id` and binds it into a write **with the reach check removed**
    **IS** flagged. This negative case is exercised by a **committed fixture**, NOT by editing
    `objects.rs` (see "How the negative case is exercised"). The verification asserts: detector
    flags the guard-removed fixture, AND does not flag the guarded twin.

## What it flags vs ignores (the exact contract)

**Flags** (a Cat-4 finding) iff `readsScopeParent(params, body) && bindsParentToWrite(body) &&
!callsReachGate(body) && !hasAuthAck(ackBody)` for a handler that already passes the existing
extractor-shape + `HELPER_NAMES` filters.

- `readsScopeParent(params, body)` — true if the comment/string-stripped `body` (or `params`)
  contains a token matching `/\b(scope_parent|parent)_id\b/` that is sourced from the request body
  (a `body.<field>` access, a `Json(...)`/`Query(...)`/`Form(...)` destructure, or a same-file
  `#[derive(Deserialize)]` struct field — the spec-simple v1 is the body-token regex, since
  `findHandlers` already hands us the per-handler `body`). v1 field-name set is **exactly**
  `scope_parent_id` and any `…parent_id` (`/\b(scope_parent|parent)_id\b/`). **`project_id`,
  `owner_id`, `source_file_id`, `rid` are deliberately OUT of v1** — see Risk 2.
- `bindsParentToWrite(body)` — true if the body contains an `INSERT`/`UPDATE` SQL string AND a
  `.bind(` whose argument references the parent field (`/\.bind\(\s*&?\s*(?:body\.)?\w*(scope_parent|parent)_id\b/`),
  OR the parent field is passed to a `db::(insert|update|create|register)_\w+\s*\(` /
  `register_entity\s*\(` call in the same body.
- `callsReachGate(body)` — a NEW recognizer (do not widen the existing `callsOwnershipGate`, which
  feeds Cat-1; keep Cat-4's gate set separate so the two categories stay independent). True if body
  matches `/\b(?:crate::)?rbac::(?:require_grant|require_view|require_action)\s*\(/` OR
  `/\b(?:super::)?(?:require_grant|require_view|require_action)\s*\(/`. (Recognizing these here is the
  precision fix the sibling reviewer called for — Cat-1's gate set does not know `require_grant`,
  which is why `objects.rs::create` is a Cat-1 false positive today; Cat-4 must not repeat that.)
- Reuses the existing `hasAuthAck(h.ackBody)` annotation verbatim (`// AUTH-AUDIT-ACK: <reason>`) and
  the existing `HELPER_NAMES` + extractor-shape skip filters in the main `forEach` — a Cat-4 hit on
  an ACK'd handler goes to a `scopeParentAck` list (mirror of `acknowledged`) OR is simply suppressed;
  **decision for the coder: mirror the `acknowledged` pattern** (own ACK bucket) for parity.

**Ignores** (no Cat-4 finding):
- `objects.rs::create` post-d3f933a — has `require_grant` (condition 3 fails). **Primary green case.**
- `connectors.rs::create` — reads `project_id` (outside v1 field set) AND has `require_grant`.
  Secondary green case (a guarded write-into-parent that must stay quiet).
- any handler that reads a parent id but only **reads** it (no INSERT/UPDATE/`db::*` mutation).
- any handler carrying `// AUTH-AUDIT-ACK:` on the binding (routes to the ACK bucket, not a leak).

## How the negative case is exercised (AC-6 RED proof — the crux)

The detector's classifiers (`readsScopeParent`, `bindsParentToWrite`, `callsReachGate`) take **plain
strings** (a handler `params` + `body`), exactly like the existing `callsOwnershipGate(body)` /
`isMutation(body)`. So the negative case is proved at the **string/unit level**, with NO edit to any
`.rs` route file. **Chosen approach (decision for Em — Risk 1):**

- Add `tools/auth-audit/test/scope-parent.test.js` — a dependency-free Node assert script (`require
  ('assert')`, run via `node tools/auth-audit/test/scope-parent.test.js`, exit non-zero on failure)
  that `require()`s the three classifiers from `audit.js` and asserts:
  - **GUARDED twin** (a `create`-shaped string that reads `body.scope_parent_id`, binds it into an
    INSERT, AND calls `require_grant`) → NOT flagged.
  - **GUARD-REMOVED twin** (the same string with the `require_grant` block deleted) → flagged.
  - **read-only** (reads `scope_parent_id`, never binds/writes) → NOT flagged.
  - **ACK'd** (guard removed but `// AUTH-AUDIT-ACK:` present) → routed to ACK bucket, not a leak.
- This forces a tiny refactor: the three classifiers + `hasAuthAck` must be **`module.exports`-ed**
  from `audit.js` (today it is a top-to-bottom script with no exports). The export block is guarded
  so the script still runs standalone when invoked directly (`if (require.main === module) { …run… }`)
  — the established pattern for making a Node CLI script unit-testable without a framework (no-frameworks
  carve-out already covers `tools/*` static analysis; plain `node:assert` adds no dependency).
- The two real-tree green assertions (AC-6 first bullet — `scopeParentLeaks` empty, `objects.rs::
  create` and `connectors.rs::create` absent) are proved by **running the audit and asserting on
  `audit.json`**: `node tools/auth-audit/audit.js && node -e "assert(JSON.parse(fs.readFileSync(
  'tools/auth-audit/audit.json')).scopeParentLeaks.length === 0)"`. The tester wires both halves
  (unit script for RED, audit-run-assert for GREEN) — that pairing is the AC-6 check.

> If Em prefers a **fixture `.rs` file** under `tools/auth-audit/test/fixtures/` that the audit is
> pointed at via its existing `process.argv[2]` backendDir arg instead of a unit script, that is the
> alternative in Risk 1 — but it re-walks a throwaway crate and is heavier than asserting on the
> exported classifiers. Recommended: the unit script.

## API contracts (exact — no guessing)

### The detector fits the existing scan model (NOT a new parser)
`audit.js` is a **regex + brace-counting heuristic over comment/string-stripped Rust text** — acorn
parses the *JS tooling itself*, never the Rust target (`audit.js:33-39` header). The pipeline is
`strip(text)` (`audit.js:58-64`, position-preserving) → `findHandlers(raw, stripped)`
(`audit.js:72-101`, returns `{ name, params, body, ackBody, start, end }`) → per-handler classifiers
in the main `forEach` (`audit.js:263-301`). The new detector is **three classifier functions + report
plumbing**, added alongside the existing `callsOwnershipGate`/`isMutation`/`callsEventRecord`
(`audit.js:164-189`). **Do not restructure the walker** (`strip`/`findHandlers`/`matchBraces`/
`hasAuthAck` are untouched except for the `module.exports` guard above).

### Existing functions to reuse (name them; do not reinvent)
- `strip(text)` — `audit.js:58`. Comment/string stripper, byte-position preserving.
- `findHandlers(raw, stripped)` — `audit.js:72`. Per-handler `{ name, params, body, ackBody }`.
- `hasAuthAck(rawBody)` — `audit.js:111`. The `// AUTH-AUDIT-ACK: <reason>` recognizer — reuse as-is.
- `HELPER_NAMES` (`audit.js:207`) + the extractor-shape gate (`audit.js:268-271`) — reuse verbatim so
  Cat-4 doesn't fire on pure helpers / non-extractor fns.
- The main `paths.forEach` walk (`audit.js:248-301`) — ADD the Cat-4 classify + push inside it; do not
  add a second walk.

### New classifier signatures (mirror `callsOwnershipGate(body)` shape — `audit.js:164`)
```js
function readsScopeParent(params, body) { /* /\b(scope_parent|parent)_id\b/ sourced from body */ }
function bindsParentToWrite(body)       { /* INSERT/UPDATE + .bind(&…parent_id) OR db::*_/register_entity */ }
function callsReachGate(body)           { /* rbac::require_grant|require_view|require_action */ }
```

### `audit.json` output shape (the new category — parallel to `leaks`/`auditGaps`, `audit.js:311-326`)
```json
"stats": { … , "scopeParentLeaks": 0 },
"scopeParentLeaks": [
  { "file": "crates/api/src/routes/<f>.rs", "name": "<handler>",
    "kind": "scope-parent-injection",
    "detail": "reads caller-supplied parent id + binds it to a write without require_grant/require_view" }
],
"scopeParentAck": [ { "file": …, "name": …, "reason": "<ACK text>", "detail": … } ]
```
On the current tree the contract is **`scopeParentLeaks: []` and `stats.scopeParentLeaks: 0`**.

### Report + console plumbing (parallel to the existing wiring)
- New stat in `data.stats` (`audit.js:314-321`) + new card in the `cards` array
  (`audit.js:424-431`) — class `bad` when `>0`, else `ok` (mirror `Ownership leaks`).
- New tab button + `<div class="panel hidden" id="panel-scopeparent">` + `<table id="t-scopeparent">`
  (`audit.js:344-374`) + the tab-switch array (`audit.js:439`) — mirror the `audit`/`leaks` panel.
- New `renderRows('t-scopeparent', D.scopeParentLeaks, 3)` + count wiring (`audit.js:447-452`).
- New console line in the summary (`audit.js:471-476`) — `scope-parent leaks  N  ⚠/✓`, plus a
  top-10 dump block mirroring the `leaks`/`auditGaps` blocks (`audit.js:478-491`).

### Atomic-doc touch-policy (REQUIRED in the same commit)
Editing `tools/auth-audit/audit.js` requires updating its mirror doc
`docs/internal/code/tools/audit-suite/auth-audit.md` in the SAME commit (CLAUDE.md touch-policy;
enforced by `tools/doc-coverage-audit`). Add the Cat-4 detector to "Public surface" + "Drift-prone
areas". **Also fix two stale lines while there** (in-scope per [[keep-comments-truthful]]): the doc
says the inline opt-out is `// auth-audit-allow: ownership` but the code keys on `// AUTH-AUDIT-ACK:`
(`audit.js:112`); and the audit-cadence table (`docs/internal/processes/audit-cadence.md:64`) /
this doc imply `audit.html` but the tool emits `report.html` (`audit.js:48`). Correct the doc to the
real annotation + output filename.

## Scope boundaries
- **In:** the Cat-4 detector (3 classifiers + the in-walk classify/push) in `tools/auth-audit/
  audit.js`; the `scopeParentLeaks` (+ `scopeParentAck`) arrays/stat/card/tab/console plumbing; the
  `module.exports` + `require.main` guard refactor to make the classifiers unit-testable; the
  `tools/auth-audit/test/scope-parent.test.js` unit script; the GREEN audit-run-assert; and the
  `auth-audit.md` atomic-doc update (incl. the two stale-line fixes).
- **Out:** **any change to backend Rust** (`objects.rs`, `connectors.rs`, `rbac.rs` — the fix +
  regression test already shipped; do NOT touch them); the Cat-1 `no-ensure-owner` false positive on
  `objects.rs::create` (a separate, known Cat-1 precision gap — out of scope here, flag in Risks);
  widening the v1 field-name set beyond `scope_parent|parent_id`; ingesting auth-audit into the
  `audit.run`/`audit.finding` store (auth-audit is not in `INGEST_TOOLS` — leaving it out is status quo).
- **Reuses (name these; don't reinvent):** `strip`, `findHandlers`, `hasAuthAck`, `HELPER_NAMES`, the
  extractor-shape gate, and the `leaks`/`acknowledged`/`auditGaps` push+sort+render pattern — the new
  category is a copy of that pattern with new predicates, NOT new machinery.

## Risks / open questions for Em
1. **How to TEST a JS audit detector (the crux).** Three options: (a) **unit script** that imports the
   exported classifiers and asserts on guarded/guard-removed/read-only/ACK'd strings — RED proof with
   zero `.rs` edits, plus a separate audit-run-assert for the GREEN tree (recommended — cheapest,
   precise, no throwaway crate); (b) a **fixture `.rs` crate** under `tools/auth-audit/test/fixtures/`
   the audit is pointed at via `process.argv[2]` — heavier, re-walks a fake crate; (c) **no automated
   test**, just a manual `node audit.js` + eyeball — rejected (a regression net with no regression test
   is the failure mode this Case exists to close). **Recommended: (a).** Confirm, or pick (b)?
2. **v1 field-name set precision (avoiding false positives).** v1 flags only `/\b(scope_parent|parent)
   _id\b/`. Broadening to **every** `*_id` body field that reaches a write would catch more of the
   class but risks a flood of false positives (`project_id`, `owner_id`, `source_file_id`,
   `member_redpash_id` are all caller/route-supplied ids that ARE legitimately bound to writes after
   their own checks). The sibling bug was specifically `scope_parent_id`; keeping v1 narrow keeps the
   detector at zero false positives on the current tree. **Confirm the narrow v1 set, broaden later in
   response to a finding (per [[feedback-process-oriented]])** — or start broad and ACK the noise?
3. **The existing Cat-1 false positive on `objects.rs::create`.** auth-audit's `leaks[]` lists
   `objects.rs::create` as `no-ensure-owner` today — a false positive (Cat-1's gate set doesn't know
   `require_grant`). This Case deliberately does NOT fix Cat-1 (out of scope — Cat-4 is independent).
   But it's noise in the same report. **Fold a Cat-1 gate-set widening (teach `callsOwnershipGate`
   about `require_grant`/`require_view`) into this Case, or file it as a third sibling?** Recommend a
   separate sibling so this Case stays single-purpose, but flagging since it touches the same file.
4. **`scopeParentAck` bucket vs simple suppression.** When an ACK'd handler would be a Cat-4 hit, do we
   surface it in a `scopeParentAck` list (parity with `acknowledged`, visible-but-acknowledged) or just
   suppress it? Recommend the bucket for parity + auditability. Confirm.
5. **Module-export refactor of `audit.js`.** Making the classifiers testable means adding
   `module.exports` + an `if (require.main === module)` guard around the run body — a small structural
   change to a working script. It keeps `node audit.js` behavior identical. Confirm this refactor is
   acceptable (it's the minimum needed for option 1's unit test).
