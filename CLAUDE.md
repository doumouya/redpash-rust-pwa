# Project conventions — RedPash-next

Ground-up rebuild of RedPash executing the approved roadmap at
[`docs/ROADMAP.md`](docs/ROADMAP.md). The predecessor repo
(`/home/mansa/rust-project/redpash-rust-pwa`) is the reference implementation —
port-verbatim items are listed in the roadmap; its docs/internal tree holds the
WHY behind every inherited rule.

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
  body; `Co-Authored-By:` for AI contributors. Run `sh tools/ci.sh` before commit.
- **Never push without Em's explicit confirmation.**

## Layout

- `backend/crates/{api,data,shared}` — the three-crate workspace (edge / engine / DTOs).
- `backend/migrations/` — designed schema; one consolidated init + focused follow-ups,
  each header carrying the WHY.
- `frontend/` — vanilla-JS PWA (Phase 5+; framework-first: atoms + registry before pages).
- `tools/` — purity-check, ci, and (Phase 7) the audit suite.
- `docs/` — ROADMAP, decisions, and (as phases land) the internal docs spine.
