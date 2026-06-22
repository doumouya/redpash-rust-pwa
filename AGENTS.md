# AGENTS.md — operating envelope for non-Claude agents (OpenCode et al.)

The harness-neutral envelope for agents that aren't Claude Code (which reads `CLAUDE.md`).
**Read [`CLAUDE.md`](CLAUDE.md) and [`docs/REDMAP.md`](docs/REDMAP.md) for the full conventions** —
this file is only the lane, the non-negotiables, and the cautions for a local/open model.

## Your lane

Work here: `frontend/apps/**` (the pages), `docs/**`, tests (`backend/crates/api/tests/**`,
`**/*.test.*`), `tools/` scripts, and bulk / codemod sweeps.

**Off-limits** — the `opencode.json` permission config hard-blocks these; don't fight it, file a
Case describing the need instead:

- the Rust backend — `backend/crates/**` (the object model, RBAC, the sealed upload pipeline,
  the cases workflow gate) and `backend/migrations/**` (checksum-protected, never edited);
- the frontend **framework** layer — `frontend/framework/**`, `frontend/wasm/**` (the reusable
  atoms / registry / engine; a subtle break here costs everyone);
- the rules + enforcement — `CLAUDE.md`, `AGENTS.md`, `opencode.json`, `tools/hooks/**`,
  `tools/ci-audit/**`.

## Non-negotiables (enforced at git/DB — they WILL block you, by design)

- **Case-first.** Before non-trivial work, open a Case via the `redpash` MCP (`case_create` →
  `case_comment` the decisions → `case_set_status`). The pre-push hook **rejects a push** whose
  commits lack a `CAS_<id>` ref (unless the subject is a `chore/docs/style/ci/build/test/
  meta/process/merge` prefix).
- **Never push.** `git push` is denied — pushing is Em's call alone. Leave commits on `lean`.
- **Parallel-safe commits.** Commit ONLY what you changed: `git commit -o <pathspecs>`. NEVER
  `git add -A` or bare `git commit` — three agents share this branch.
- **Docs stay current.** A change to a documented surface updates its `docs/internal/code/` doc
  + REDMAP/INDEX in the *same* commit, with a `Docs:` trailer (or `Docs: n/a — <reason>`).
  Closing a Case is **refused (`422 docs_not_reconciled`)** until its docs are reconciled — that
  is the gate working, not a bug.
- **No frameworks.** Vanilla Rust + vanilla JS; no new front/back framework dependency.

## You're a local model — work to your strengths

Prefer small, **verifiable** diffs a gate can check (`cargo test`, `node tools/*-audit/*`,
`sh tools/ci.sh`). Defer architecture, RBAC, schema, and anything subtle to a Case for Em or
Claude. When unsure about the foundation, open a Case and ask — never guess.
