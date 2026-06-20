# RedPash

Ground-up rebuild of RedPash — the data-quality PWA for the Operational Analyst
(Upload → instant quality report → Clean → Visualise, multi-file joins, one
Rust engine running server-side and as wasm in the browser).

This is a **port-and-fix**, not a redesign: the predecessor's load-bearing
architecture (entity registry + polymorphic memberships, the locked 2-entity
model, the pure-compute data crate, leak-free RBAC, the step-replay cleaner)
survives intact; what changes is baked in from
[`docs/decisions/day-one.md`](docs/decisions/day-one.md).

- What exists: [`docs/internal/capability-ledger.md`](docs/internal/capability-ledger.md) (the live capability index) + [`docs/REDMAP.md`](docs/REDMAP.md) (doc⇄code map)
- Dev: `cd backend && cargo run -p api` (set `DATABASE_URL` for migrations)
- Gates: `sh tools/ci.sh` (includes the wasm32 purity check on the data crate)
- This repo is the primary tree; the rebuild has graduated — the capability ledger records what shipped vs the remaining `[gap]`s.
