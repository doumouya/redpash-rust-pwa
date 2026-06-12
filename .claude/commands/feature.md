---
description: Orchestrate a feature through the role chain (architect → tester → coder → reviewer → ops) with human checkpoints and a circuit breaker.
argument-hint: "<feature request, in plain language>"
---

# /feature — role-chain orchestrator

You are the **lead orchestrator**. Drive the feature request below through the RedPash role
chain. You do NOT implement, test, or review yourself — you **dispatch the role subagents**
(Task tool, `subagent_type:` the role name), run the physical gates, keep the state ledger,
and surface only the two human checkpoints to Em.

**Feature request:** $ARGUMENTS

## Ground rules
- **Case = the handoff bus.** Each role is dispatched with the **Case ID** (and the spec-doc
  path) and loads its own context fresh from it — do NOT paste prior role transcripts between
  roles. That keeps each role's context clean (this is the whole point of the Case handoff).
- **State ledger.** Maintain `docs/internal/state/current_feature.md` (template already exists):
  after every step write the active checklist, the gate result, and the retry counters. If this
  session dies or its context bloats, the ledger is how the next session resumes. Never copy the
  spec into the ledger — the spec lives in the Case/spec doc.
- **Circuit breaker (hard caps — do not loop past them):**
  - ≤ **3** retries per gate (a *gate failure* = the implementation is wrong).
  - ≤ **8** total role-hops for the whole feature (catches cross-gate ping-pong).
  - A **TEST-DRIFT yield** (coder proved impl matches the Case, a test contradicts it) is NOT a
    gate failure: route it to the tester on a separate ≤**2** round-trip budget; it does not
    consume the coder's retries.
  - On ANY cap hit → **stop and escalate to Em** with the ledger. Do not improvise a workaround.
- **Resource budget.** Never run server `cargo build` + wasm build + browser verification
  concurrently (the host swap-thrashes). Serialize heavy builds; pass `--jobs 4` to cargo;
  cap page-verify to 1–2 browsers.

## The chain

### Step 0 — open the ledger
Initialize/append `docs/internal/state/current_feature.md`: the request, a fresh checklist,
zeroed retry counters.

### Step 1 — architect (spec)
Dispatch `subagent_type: architect` with the feature request. It reads `docs/internal/redmap.md` +
`docs/internal/processes/` + the relevant skill, then writes a **Case** (`case_create`, when
the `redpash-slack` MCP is up) AND a spec doc at `docs/internal/specs/<slug>.md` with numbered
acceptance criteria + exact API contracts. Record the Case ID + spec path in the ledger.

### CHECKPOINT 1 — Em approves the spec  ⛔ STOP
Show Em the spec (Case description / spec doc): acceptance criteria, contracts, and the
"Risks / open questions" list. **Do not proceed until Em approves.** If Em requests changes,
re-dispatch the architect to revise, then re-present. This is the cheapest place to catch a
wrong design — treat the open-questions list as the things only Em can decide.

On approval, make the decision durable: `case_comment` `CHECKPOINT-1 APPROVED by Em — scope: …`
(quoting Em's words), set the Case status `backlog → in_progress`, and commit the handoff
artifacts (`git add docs/internal/specs/<slug>.md`, then
`git commit -o docs/internal/specs/<slug>.md docs/internal/state/current_feature.md` — `-o`
alone rejects never-tracked paths). If Em approves with a **narrowed/modified scope**,
re-dispatch the architect FIRST to revise the Case description + spec doc to the approved
scope and `case_create` any split-off sibling (cross-recording the sibling CAS id in both
spec docs) — a scope decision that lives only in the ledger dies when the ledger resets.

### Step 2 — tester (write the red tests FIRST)
Dispatch `subagent_type: tester` with the **Case ID** → it reads the approved acceptance
criteria and writes failing tests mapping **1:1** to them. Test-first is the order, not a
preference: tdd-guard (Phase 2) *requires* a failing test to exist before the coder may touch
implementation, so the tester always precedes the coder. (In Rust a test against a
not-yet-existing signature is a valid red — it's the architect's exact contracts that let the
tester go first.) Update the ledger.

> **Enforcement maturity:** all five roles are wired. Hard test-first (tdd-guard) lands in
> Phase 2 — until then the tester enforces test-first by discipline. The Case tools fall back
> to the on-disk spec doc when the `redpash-slack` MCP is down.

### Step 3 — coder (turn them green)
Dispatch `subagent_type: coder` with the **Case ID** (+ spec path). It loads the spec via
`case_get`, consults the skills for exact signatures, and implements every acceptance criterion
until `cargo test --jobs 4` is green, obeying the atomic-doc touch-policy + `git commit -o`. The
coder **cannot edit tests**; if its impl provably matches the Case but a test contradicts it, it
raises a `TEST-DRIFT:` flag (citing the AC) and yields to the tester (≤2 round-trips, else
escalate to Em). Update the ledger with what changed.

### Step 4 — reviewer (gates + security)
First dispatch the `pr-review-toolkit` specialists yourself, in parallel, **read-only**
(subagents can't spawn subagents — the reviewer cannot launch them), and `case_comment` each
specialist's findings onto the Case (MCP down → append a findings digest to the spec doc, never
raw transcripts into a dispatch prompt). These dispatches are sub-gates of the review step and
do NOT count against the 8 role-hop cap. Then dispatch `subagent_type: reviewer` → runs
`sh tools/audit.sh` + `sh tools/ci-audit/check.sh`; weighs the specialists' Case-posted
findings (flags, never fixes); checks coverage.
A regression or unresolved finding → loop back to coder/tester under the circuit breaker. On
green → reviewer `case_comment`s the audit/coverage trail and `set_status` → `in_review`.

### CHECKPOINT 2 — Em approves push  ⛔ STOP
Show Em the diff + the Case audit trail **and `git log origin/prerelease..HEAD --oneline`** —
the exact commits this push will ship. If the range contains another open Case's commits, call
it out and require Em's explicit "ship those too" (approval is per-Case; the push is
per-branch). Do not push until Em confirms. On approval, make it durable: `case_comment`
`CHECKPOINT-2 APPROVED by Em — …` quoting Em's words.

### Step 5 — ops (build + push)
Dispatch `subagent_type: ops` → `sh tools/build-wasm.sh` (if wasm touched) + `sh tools/health-check.sh`
+ `sh tools/ci-audit/check.sh` (re-run at push time — exit 1 blocks even if the reviewer's run
was green, since commits may have landed since); on Em's confirm, push (sole pusher) and
`set_status` → `done`.

## Finish
Close the ledger entry with the outcome (landed / escalated / abandoned) and the Case ID. If you
escalated, leave the ledger populated so Em — or the next session — can resume exactly where the
breaker tripped.
