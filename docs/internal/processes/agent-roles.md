# Process: agent role system (architect / tester / coder / reviewer / ops)

> Status: **live since 2026-06-08** — validated end-to-end by Case CAS_DD6F55FB (the
> `objects.rs` `scope_parent_id` IDOR regression tests, landed 2026-06-12). That run's lessons
> + a full 49-finding independent review:
> [`../specs/agent-system-review-2026-06-12.md`](../specs/agent-system-review-2026-06-12.md).
> Phase 2 (tdd-guard hard enforcement) + Phase 3 (role-marker + PreToolUse role-guard) pending
> (see [Rollout](#rollout)). This doc is the authoritative description of the role system.

## Why this exists
The project outgrew single-person oversight. The fix is **role specialization + a trust
layer**: declarative role agents with scoped tools, driven by an orchestrator, where the
**automated gates** (not Em) decide whether a role's output is trustworthy — so Em reviews
**decisions and exceptions, not every line.**

The design is grounded in ChatDev (Qian et al., ACL 2024, https://aclanthology.org/2024.acl-long.810/),
whose ablation shows **role specialization is the #1 quality lever**. We map its ideas onto
infrastructure we already own:

| ChatDev idea | RedPash realization |
|---|---|
| Roles in system prompts (#1 lever) | `.claude/agents/*.md` with scoped `tools:` allowlists |
| Communicative dehallucination (ask for the exact detail before coding) | the **skills** (`redpash-polars`, `rust-data-engine`, …) as the coder's signature oracles |
| Memory split — pass only the *solution* forward | the **Case** as the handoff bus; each role loads fresh from `case_get` |
| "Output needs manual revision" (their #1 limitation) | our **gate suite** (26 audits, `cargo test`, `ci-audit`, page-verify) as the trust layer |

## The model
- **Roles are hats, not daemons.** They are subagents dispatched by an orchestrator, not 5
  always-on processes. The 3-Torv parallel model persists; any Torv can wear a role.
- **The Case is the single source of truth + the handoff bus.** Spec, acceptance criteria,
  status, and audit trail live in the Case (Postgres, via `redpash-slack` MCP `case_*`). Each
  role is dispatched with the Case ID and loads its own clean context from it — the coder never
  inherits the architect's brainstorming tokens. On-disk mirror/fallback: `docs/internal/specs/<id>.md`.
- **Gates are the trust layer.** A role's output is trusted only when its gate is green:
  tester→`cargo test` + tdd-guard; reviewer→`sh tools/audit.sh` + `sh tools/ci-audit/check.sh`;
  ops→`build-wasm.sh` + `health-check.sh`.
- **Two human checkpoints only:** (1) Em approves the spec, (2) Em approves the push.
- **Circuit breaker:** ≤3 retries/gate, ≤8 role-hops/feature; a TEST-DRIFT yield is a separate
  ≤2-round-trip budget (not a gate failure). Any cap → stop + escalate to Em with the ledger.
- **State ledger:** `docs/internal/state/current_feature.md` holds ephemeral run-state only
  (checklist, gate results, retry counters) so the orchestrator survives context bloat / restart.
- **The sim:** [`frontend/orchestrator-sim.html`](../../../frontend/orchestrator-sim.html)
  visualizes the chain (DAG, breaker counters, return paths). It sits outside every audit's
  scan path — update it whenever the ledger template or the chain changes, or it silently
  becomes a lying spec.

## The roles

| Role | Can | Cannot | Gate it must pass |
|---|---|---|---|
| **architect** | read code/docs/skills; write spec doc + Case | edit source; no Bash at all | Em approves the spec (Checkpoint 1) |
| **tester** | write/run tests; `page-verify` | edit non-test source | tests map 1:1 to acceptance criteria; tdd-guard (Rust, Phase 2) |
| **coder** | edit/write source; run `cargo test --jobs 4`; commit `-o` | edit test files; push; self-spec | tester's red tests go green |
| **reviewer** | read; run audits read-only; weigh orchestrator-dispatched specialist findings; comment/transition Case | edit/write source (flags, never fixes) | `audit.sh` + `ci-audit` clean; coverage adequate |
| **ops** | build/CI/deploy Bash; push (sole pusher, on Em's confirm) | — | build + `health-check` + `ci-audit` green |

Full per-role contracts: `.claude/agents/{architect,coder,reviewer,tester,ops}.md`.

## The loop (`/feature "X"`)
architect (Case + spec) → **CHECKPOINT 1: Em approves** → tester (red tests 1:1 with the ACs) →
coder (implement from Case + skills until green; atomic docs) → reviewer (audit + ci-audit +
read-only specialists; comments the Case) → **CHECKPOINT 2: Em approves push** → ops (build,
push, close Case). **Test-first:** the tester's red tests precede the coder (tdd-guard requires a
failing test before impl); TEST-DRIFT is adjudicated against the Case. Gate failures loop back
under the circuit breaker. Orchestration playbook: `.claude/commands/feature.md`.

### The TEST-DRIFT escape valve
Because the coder cannot edit tests (so it can't cheat a red test green by weakening it), a
*flawed test* would deadlock a correct coder. Resolution: the coder emits a `TEST-DRIFT:`
`case_comment` **citing the specific acceptance criterion** and yields to the tester; the tester
fixes the test or re-affirms it. Both check against the **Case**, never against each other. An
unresolved dispute means the Case is ambiguous → escalate to Em (the spec's approver). This
turns the deadlock into a useful signal — it surfaces underspecified requirements.

## Resource budget (local, 32 GB host)
WSL2 must be unlocked (`~/.wslconfig`: `memory=24GB processors=14 swap=2GB`, then
`wsl --shutdown`) — by default it only sees ~half the RAM. The orchestrator serializes heavy
builds and passes `--jobs 4` so peak RAM stays under the cap and never reaches swap. (Claude
runs server-side; local RAM only fuels tool execution — it does not scale agents. Cowork is a
cloud runtime, not a local-RAM lever, and sends code off-device — against our data-sovereignty
stance — so local is the default.)

## Rollout
- **Phase 1A + 1B (live):** all five roles + the full `/feature` chain (both checkpoints) —
  validated end-to-end by CAS_DD6F55FB (2026-06-08 → 2026-06-12). Lessons that run surfaced:
  the regression lane (fix-pre-exists → tests born green, coder skipped), the reviewer→tester
  loop for test-hygiene findings, and the runbook/atomic-doc gates assuming a coder commit
  that never happened — see the [review](../specs/agent-system-review-2026-06-12.md).
- **Phase 2:** tdd-guard (hard on Rust via cargo reporter) + `node:test` FE harness
  (`tools/test-fe.sh` now exists as a tolerant stub — explicit n/a + exit 0 until
  `frontend/tests/` lands).
- **Phase 3:** `.agent-role` marker (session-id-stamped — a bare marker would wrongly constrain
  the other parallel Torvs) + PreToolUse role-guard hard-block (recommended, not optional: every
  path/command-level boundary is currently prompt discipline) + `board.js` role/path-violation
  flag. The MCP wiring itself is DONE (e0a21cc, via user-level `~/.claude.json`) — the remaining
  wiring task is a committed project `.mcp.json` so a fresh clone resolves `case_*`.

Designed to lift wholesale into the `starter-pack` for any future project.
