# Project conventions — RedPash

Ground-up rebuild of RedPash — the data-quality PWA for the Operational Analyst. The
rebuild has **graduated**; what exists is the source of truth, indexed in
[`docs/internal/capability-ledger.md`](docs/internal/capability-ledger.md) and mapped
doc⇄code in [`docs/REDMAP.md`](docs/REDMAP.md). The locked architecture is
[`docs/decisions/day-one.md`](docs/decisions/day-one.md); the docs/internal tree holds the
WHY behind every inherited rule. (The original rebuild roadmap is retired — archived under
`docs/archive/`.)

## Binding rules

- **Day-one decisions** ([`docs/decisions/day-one.md`](docs/decisions/day-one.md))
  override convenience. Changing one is an Em-level decision.
- **The data crate is pure compute.** `sh tools/purity-check.sh` (wasm32 cargo
  check) must pass before every commit — no io/http/threads/time in
  `backend/crates/data`.
- **Derive, don't store.** Per-role field cells, project stage, report/dashboard
  are derived. A second storage path for one concept is a bug, not a feature.
- **One write path for files**: everything that produces a file goes through the
  pipeline function; `insert_file` is module-private to it.
- **Leak-free denials**: RBAC denial is 404, never 403 (403 only where reach is
  already proven).
- **No frameworks** (vanilla Rust + vanilla JS). Tooling carve-out for Node
  static-analysis scripts under `tools/` only.
- **Commit convention**: `area: imperative summary` subject; per-file changelog
  body; `Co-Authored-By:` for AI contributors; a `Docs:` trailer when a documented surface
  changed (else `Docs: n/a — <reason>`). Run `sh tools/ci.sh` before commit.
- **Never push without Em's explicit confirmation.**
- **Docs stay current.** A change that adds or alters a documented surface reconciles its
  docs in the same change — REDMAP + INDEX + the per-area `docs/internal/code/` doc. A Case
  can't reach `done` until it's reconciled (or a commit declares `Docs: n/a — <reason>`); the
  cases workflow engine enforces it.
- **Case-first by default**: non-trivial work opens a Case *before* coding and logs to it (full rule below);
  `/feature` is reserved for big/risky features.

## Case-first by default

Every **non-trivial** change — a feature, a logic bugfix, a multi-file edit, anything that will produce a commit —
starts by opening a **Case** and logging to it, so the work leaves an async trail Em reviews on his own schedule
(this is *"manage, not monitor"*). A `UserPromptSubmit` hook (`.claude/settings.json` → `.claude/case-first-reminder.txt`)
keeps it salient each turn.

1. **Open** — `mcp__redpash-slack__case_create` (title + a one-paragraph plan as the description); set `in_progress`.
2. **Log** — key decisions + what changed as `case_comment`s at meaningful checkpoints (not every micro-step).
3. **Close** — an outcome comment (what shipped + commit shas) + `case_set_status(in_review)` → `done` after the push. **Reconcile the docs first**: a commit referencing the Case updates REDMAP + INDEX + the per-area doc (or declares `Docs: n/a — <reason>`) — the `→ done` transition is refused otherwise (`422 docs_not_reconciled`).

**Commit on the branch; never push without Em** — the one hard gate; the Case thread is the review surface.
**Skip** for trivial one-line / doc / typo fixes, read-only investigation, and pure Q&A. Reserve the full **`/feature`**
role-chain (architect→tester→coder→reviewer→ops, two checkpoints, circuit breaker) for **big or risky** features.
If the Cases MCP is down, file an on-disk stub under `docs/internal/cases/` and promote via `case_create` when it's back.

## Layout

- `backend/crates/{api,data,shared}` — the three-crate workspace (edge / engine / DTOs).
- `backend/migrations/` — designed schema; one consolidated init + focused follow-ups,
  each header carrying the WHY.
- `frontend/` — vanilla-JS PWA (Phase 5+; framework-first: atoms + registry before pages).
- `tools/` — purity-check, ci, and (Phase 7) the audit suite.
- `docs/` — decisions, the capability ledger, and the internal docs spine (REDMAP/INDEX map it; `archive/` holds retired docs).
