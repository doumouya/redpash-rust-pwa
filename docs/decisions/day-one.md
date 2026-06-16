# Day-one locked decisions

The ten things the predecessor repo (`redpash-rust-pwa`) proved are ~10× costlier to
retrofit than to bake in. Each carries the incident or finding that locked it
(source: the 2026-06-12 7-lens architecture read + 49-finding agent-system review).
These bind every phase; changing one is an Em-level decision, not a refactor.

1. **RID prefixes are unique per type.** Dashboard = `DSH_`. The predecessor shared
   `FIL_` between file and dashboard and resolved by registry ordinal — a permanent
   trap for anyone minting or parsing ids.
2. **Users and files are registered entities from birth.** "Share one file with one
   person" was inexpressible in the predecessor because files weren't entities; its
   file RBAC rode a special-cased cascade arm instead of the uniform edge.
3. **`entity_data.scope_parent_id` has a real FK** (`REFERENCES entities ON DELETE
   SET NULL`). The CAS_DD6F55FB IDOR guard covers create-time only; the DB must make
   dangling/foreign parents unrepresentable.
4. **One canonical `FilterNode` DTO** (`shared/src/filter.rs`) consumed by paging,
   persisted steps, group_by pre-filters, and the wasm wrapper. The predecessor's
   flat-vs-tree split was the only reason filter/search couldn't run client-side.
5. **One RBAC gate generation.** `require_action` (tier floor ∩ company contract) is
   the only handler-facing gate, in a typed extractor, wired from the first route.
   The predecessor accreted three coexisting gate idioms; the audit found owner-only
   legacy gates on endpoints whose siblings were reach-aware.
6. **Cascade arms are data** — `type_definitions.scope_parents`. GRANT_SQL and the
   EDGES introspection are *generated* from these rows. The predecessor kept three
   hand-synced copies of the cascade with a "keep in sync" comment.
7. **Content-hash discipline for ALL static assets**, not just the wasm. The
   predecessor's heuristic-cached JS forced developing against Firefox private
   windows.
8. **Observability tables are time-partitioned at schema birth.** Retention = DROP
   PARTITION. The predecessor's acknowledged open item; DELETE-based retention never
   got circled back to.
9. **Workflow identity never reads `context_role`.** Case reporter/assignee are
   typed FK columns (workflow refs, not access edges); `context_role` is cosmetic
   free text — the predecessor's shipped code string-keyed reporter resolution on
   it, so renaming a label broke identity.
10. **dev-login is compile-profile-gated** (`#[cfg(debug_assertions)]`-class, not an
    env var); cookies get one Secure/CSRF flip point; default bind is loopback. A
    single mis-set env var in the predecessor meant any-user session minting.

Standing inheritance (not renumbered because they were already right): leak-free
404-never-403; auto-grant-owner in every create tx; derive-don't-store; bytes
immutable + steps replayed; open registries (codec/rule/list/type) over closed
enums; no frameworks; pipeline-as-the-only-write-path; fire-and-forget
observability; "Rust owns data, JS owns pixels".
