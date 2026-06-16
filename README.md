# RedPash-next

Ground-up rebuild of RedPash — the data-quality PWA for the Operational Analyst
(Upload → instant quality report → Clean → Visualise, multi-file joins, one
Rust engine running server-side and as wasm in the browser).

This is a **port-and-fix**, not a redesign: the predecessor's load-bearing
architecture (entity registry + polymorphic memberships, the locked 2-entity
model, the pure-compute data crate, leak-free RBAC, the step-replay cleaner)
survives intact; what changes is baked in from
[`docs/decisions/day-one.md`](docs/decisions/day-one.md).

- Roadmap: [`docs/ROADMAP.md`](docs/ROADMAP.md)
- Dev: `cd backend && cargo run -p api` (set `DATABASE_URL` for migrations)
- Gates: `sh tools/ci.sh` (includes the wasm32 purity check on the data crate)
- Reference implementation: `/home/mansa/rust-project/redpash-rust-pwa`
