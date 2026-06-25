# Portfolio build-engine — Torv addendum (deltas on top of `-p.md`)

> **Sibling to [`portfolio-foundation.md`](portfolio-foundation.md) and [`portfolio-foundation-p.md`](portfolio-foundation-p.md)**
> — a separate file to avoid collision. **Coordination only** (lives on `lean`); no code, nothing RedPash-branded goes
> to the clean repo. I reviewed `-p.md` (2026-06-23) and **endorse it** — all-JSONB `entity_data`, the `workflows`
> table, DB-as-source-of-truth for orchestrator state, the **enforcement-gates-ARE-the-product** reframe, the ci.sh
> fold/drop list, the RBAC v1-vs-resolver split, and the baggage list are all correct; I won't re-litigate them. This
> file adds **only the deltas** my just-shipped `lean` work contributes (the F50/F29 orchestrator-reference fixes + the
> `claude-refs` audit, the docs-currency close-gate, the `scope_parent_id` IDOR, and lean's `cases.rs` workflow
> internals). — **Torv, 2026-06-25.**

## Delta 1 — the ci.sh fold list is missing the audit that protects the agent chain itself

`-p.md`'s fold list (case-coverage · capability · doc-coverage · privacy · auth · rs · rs-perf · api-doc ·
list-endpoint-rbac · observability) is right but **omits the one audit that guards the orchestrator's own integrity.**

This session on `lean` I hit **F50**: the `/feature` role prompts dispatched gate scripts (`tools/audit.sh`,
`health-check.sh`, `page-verify`) that **did not exist** — a cold dispatch would have errored, or a tolerant wrapper
would have **silently skipped the gate** and let a review "pass." **F29** is the fix I then shipped: a `claude-refs`
audit that scans the agent prompts (`.claude/agents`, the `/feature` command, the skills) for command + reading-list-doc
references that don't resolve, and **fails the ratchet** — so a renamed gate or relocated doc fails the *tool*, not a
live run. (It immediately surfaced 8 real dead references on lean.)

For a build-engine whose **entire credibility is "every app was built through the agent chain,"** the audit that keeps
that chain's own references honest is not optional — it's load-bearing. **Fold a neutralized `agent-refs-audit` into
`tools/ci-audit/` from the first commit.** It's ~150 lines, auto-discovered by the ratchet, and it's the cheapest
insurance on the dogfooding promise. (Pair note: `-p.md` already lists `case-coverage` — same philosophy, different
target; `agent-refs` guards the *prompts*, `case-coverage` guards the *commits*.)

## Delta 2 — generalize docs-currency into pluggable "close preconditions"

`-p.md` correctly names **docs-currency** as one of the four gates. The *shape* I shipped generalizes cleanly and the
5-role chain wants the generalization: lean's gate is `is_doc_gated_close(from,to)` → on `enters_terminal`, the cases
PATCH refuses `422 docs_not_reconciled` unless a commit reconciled the docs.

Make it a **set of close preconditions per workflow**, not a single hardcoded docs check:
- `docs-reconciled` — precondition #1 (already shipped);
- `tests-green` — the natural #2 for the Tester/Reviewer roles (no `done` Case whose tests didn't pass);
- `reviewer-approved` — the natural #3 (the Reviewer gate as data, not etiquette).

One `case_close_checks` table + one named, unit-testable rule the engine evaluates on the terminal transition (lean's
`is_doc_gated_close` is the exact pattern to copy — keyed on terminality, so reopen/same-state re-drop are exempt for
free). **This is what makes "built through the system" verifiable beyond docs** — a recruiter browsing a `done` Case
knows its tests + review + docs all cleared, because the engine refused to close it otherwise.

## Delta 3 — the four invariants the `workflows` table must encode

`-p.md` says "the v0's `states[]`/`transitions{}`/`initial` shape is right" — true. But lean's `cases.rs::mod workflow`
paid real cost for four invariants the data-driven table must carry, or the build-engine re-learns them:

1. **Permissive transitions, not strict-forward.** Lean allows forward + one-step-back + reopen-from-terminal — a
   kanban drag routinely moves a card back a column; forbidding it `422`s a recoverable mis-click. Illegal *skips*
   (`backlog→done`) stay rejected. (Strict-forward is then a per-workflow data toggle, not a code change.)
2. **Terminality = the LAST state in the ordered `states[]`**, *not* "no outgoing edges" — the terminal state allows
   reopen, so it has outgoing edges. Encode terminality as ordering, or the close-gate misfires.
3. **An `enters_terminal(from,to)` predicate** (terminal `to`, non-terminal `from`) is the hook Delta 2's
   close-preconditions fire on — derive it from the ordered states, don't hardcode the literal terminal name.
4. **A DB `CHECK`/enum backstop** on `cases.status` so a write that bypasses the engine still can't land an unknown state.

## Delta 4 — `scope_parent_id` needs a real FK (the IDOR backstop)

`-p.md` Q3 keeps `entity_data.scope_parent_id` + `type_definitions.scope_parents` (correct, minimal). Add the
**non-negotiable invariant** my IDOR work this session makes concrete: **`scope_parent_id REFERENCES entities ON DELETE
SET NULL`.** The lean bug (`objects.rs::create` `scope_parent_id` injection, day-one #3) was exactly a caller-supplied
parent with *no* FK — you could graft a row under a tenant you can't reach. The create handler still checks reach
(`require >= member` on the supplied parent), but the **FK is the backstop that makes a dangling or foreign parent
unrepresentable**, and `ON DELETE SET NULL` keeps the cascade clean. Ship `scope_parent_id` as a real FK from v1, never
a bare `text` — retrofitting the FK after data exists is the painful path.

## Everything else: concur with `-p.md`

The reframe (gates-as-product), the data-model answers (Q1–Q2, Q5–Q7), the RBAC v1-vs-resolver split + the
owner-invariant + leak-free-404, the orchestrator port + the two checkpoints + the circuit breaker, the connectors
contract, and the baggage list — I reviewed them against the same `lean` surfaces and have nothing to add or correct.
The four deltas above are the only places my freshest shipped work changes or sharpens the picture.

*— Torv. Owners: the high-leverage one is **Delta 1** (fold `agent-refs` into the v1 ci.sh) — without it the
"built-through-the-system" claim has no guard on the very chain that builds it.*
