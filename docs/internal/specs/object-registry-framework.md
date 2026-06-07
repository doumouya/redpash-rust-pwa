---
title: Object-registry framework — staged implementation arc
section: Internal
order: 68
last modified date: 2026-06-07
owner: Torv
status: spec v1 — scope approved by Em 2026-06-07 ("full framework implementation", arc 0→3, slice-by-slice with verify+commit gates). Coordination case CAS_0FBF301FDD0F4EF49AD6BF0E3FE105FC. Sibling of [type-definition.md](type-definition.md) (the wire contract this arc stores).
---

# Object-registry framework — staged implementation arc

## 0. Why this exists

[[decades-of-innovation]] in one line: **adding a capability must be a data
insert, not code surgery.** The opposite — a new entity type costing a
migration + a new `db/` module + a new `routes/` module + RBAC wiring + audit
wiring (the Kafka `connection` addition was exhibit A: ~8–12 artifacts) — is the
rigidity tax. The frontend already adds a capability with one `register(name,
mount)` call; this arc closes the same gap on the backend so a new type, vertical,
or user-defined custom object costs a row, not a redeploy.

This spec is the **what + the commitment**. The **how** (method, the
reference-verified seam map, the proven-registry precedents) lives in the repo
skill [`.claude/skills/rust-object-registry-design/`](../../../.claude/skills/rust-object-registry-design/SKILL.md)
and its `references/redpash-worked-example.md` — this spec references that arc,
it does not duplicate it. The **wire contract** the arc stores is
[type-definition.md](type-definition.md) (v1 shape + v2 validation).

## 1. Current state (verified 2026-06-07)

The *machinery* exists; **0 of the 4 arc stages are wired.**

Built (prior Torv-BE sessions, CAS_0FBF301F / CAS_C7AEBE83):
- `codec_registry.rs` — open registry, `data_type` is a `String`, codecs
  self-register. The reference shape.
- `validate_rules.rs` (+ `validate_expr.rs`) — open `RuleRegistry`
  (range/length/enum_subset/expression/decimal), two-tier validator, ~25 tests,
  wired at `routes/demo.rs`. `RealEstateListing` + `BankingAccount` pass
  zero-framework-change.
- `field_perms.rs` — `FieldRow` = `FieldDef` (data_type/editor/options/perm_class
  /rel), 5 perm classes incl. `collaborative`.
- `type_registry.rs` — `builtin_types()` / `builtin_type()`; `GET /api/admin/types`.
- `field_validate.rs` — registry-driven `validate_format` + `validate_ref`, 8
  tests, **deliberately unwired** (the validator the custom-object PATCH endpoint
  will consume — [[build-ready-dont-wire]]).

Not built (this arc):
- No `validate_value` call on a live PATCH path (Stage 0).
- No `type_definitions` / `type_fields` / `type_scope_roles` tables; registries
  are still code-side `Vec` lookups (Stage 1).
- No generic resource handler / `/api/objects/:type/:rid` (Stage 2).
- No `entity_data` table / `register_type` (Stage 3).

## 2. The staged arc (each slice independently shippable)

The standing bar at every stage: **back-compat for the 7 builtins** (user /
company / project / case / team / file / chart) — byte-identical wire output,
`sh tools/audit.sh` green, `cargo test --workspace` green.

| Stage | Deliverable | Acceptance bar |
|---|---|---|
| **0 · proof** (~25 LOC, no schema) | **Replace** the inline `case.status` `matches!` (cases.rs:306-310) with a registry-driven `validate_value` (def from `find_default("case","status")`), copying the working shape at `demo.rs`. (The inline check runs *before* the perm-gate, so an additive call would be dead — it must replace it.) | `PATCH` bad status → `400` (registry `rule_code`; the invalid-status body changes from `kind=invalid` to the registry code — no client depends on the old text, verified); good → `200`. Proves the pipeline + O(F) payoff before any infra. |
| **1 · registries → data** | `type_definitions` / `type_fields` (with an `ordinal` for field order) / `type_scope_roles` (with `is_default`) migrations, **seed embedded in the migration** (`INSERT … ON CONFLICT DO NOTHING`), incl. a `connection` type+fields. `AppState` gains `Arc<TypeDefCache>` (order: migrate→seed→cache); the cache **re-derives** per-role cells/editor in Rust (stores inputs only). Redirect the 5 `default_registry` + 1 `builtin_types` consumers + the role const arrays + `put_field`. **`object_kind` becomes registry-driven and FIXES the `TEM_`/`TEAM` mis-dispatch** (Em — see §3a). `entities.type` CHECK → FK to `type_definitions` (`NOT VALID`→`VALIDATE`). | Lookups are data; builtins byte-identical; `object_kind` regression-tested to new outputs; CHECK→FK announced (ACCESS EXCLUSIVE). |
| **2 · generic handler** | `generic_resource(type) -> Router` (generalize `members.rs`) + `/api/objects/:type/:rid` PATCH running `require_fields` then `validate_rules` (merge stored values before cross-field `expression` rules), reusing type-agnostic `resolve_grant`. Migrate `connectors` to a thin shim as proof. | One generic PATCH gates + validates any builtin; `connectors` shim is behavior-identical. |
| **3 · register_type + custom objects** | `entity_data (object_id PK → entities CASCADE, type_id → type_definitions RESTRICT, owner_id, scope_parent_id, data JSONB)`. `POST /api/admin/types` → `register_type_tx` (model on rustc `Providers`). Custom CRUD flows through the Stage-2 handler over JSONB. Add the `entity_data.scope_parent_id` cascade arm to **both** `GRANT_SQL` and `EDGES_SQL`. | A user-defined `RealEstateListing` flows end-to-end (create / list / PATCH / RBAC / audit) with **zero source changes** — the [[disposability-design-principle]] acceptance criterion. |

## 3. Locked decisions (from the worked example — do not relitigate)

- **One canonical table set** (`type_definitions/…`); no second `object_types` pair.
- **Hybrid-C storage** — builtins keep their typed tables + indexes; custom →
  `entity_data` JSONB. No `ALTER TABLE` per new type. (Polars' `DataType::Object(name)`
  validates the typed-known + one-open-variant split; `jsonb` is Postgres's own
  catalog escape hatch.)
- **`rid_prefix` UNIQUE for user-defined types only** — `dashboard` shares `FIL_`
  with `file`; don't rewrite live rids.
- **Single-source after Stage 1** — builtin field changes ship as a migration
  that updates the seeded rows; code-side `default_registry` never diverges.
- **Users stay a rel-only subject** (not a TypeDefinition); **comments stay an
  implicit relation.**

### 3a. Decisions made 2026-06-07 (this session, Em)

- **Fix `object_kind` inside the arc, don't preserve.** The audit found four
  code-side type registries already disagree (`default_registry` / `builtin_meta` /
  `object_kind` / `ref_target`), and `rbac::object_kind` (rbac.rs:373) matches prefix
  `"TEAM"`/`"DSH"` while teams mint `TEM_` and dashboards mint `FIL_` — so
  `object_kind("TEM_…")="unknown"` and the team contract-grant never fires. Em chose
  to **fix it in Stage 1** (make `object_kind` registry-driven off the seeded
  `rid_prefix`): `TEM_`→team corrected; `FIL_`→file canonical (dashboards share by
  design); dead `DSH` arm removed. The behavior change (team/dashboard contract grants
  begin firing) is **intentional**, pinned by regression tests on the new outputs +
  a runbook ([[discovered-bugs-diagnostic]]).
- **Stage 0 replaces, not adds.** The inline `case.status` `matches!` runs before the
  perm-gate; the registry validator replaces it (the invalid-status 400 body changes
  from `kind=invalid` to the registry `rule_code`; no client depends on the old text).

## 4. Execution protocol

- **Slice-by-slice.** One stage = one (or a few) commit(s). `cargo check` →
  `clippy -D warnings` → `cargo test --workspace` → `sh tools/audit.sh` → curl
  smoke against a dev instance (own bind, **not** Em's `:8080`) **before** each
  commit. Atomic doc updated in the same commit (touch-policy).
- **Seam re-verification** is a plan/edit-time step: the worked-example line
  numbers are re-verified with rust-analyzer rooted at `backend/` (or grep)
  immediately before editing each consumer, never trusted stale.
- **Push on Em's confirm** ([[push-policy]]). `git commit -o <named files>`
  ([[parallel-safe-commits]]).
- **Keep `GRANT_SQL` and `EDGES_SQL` in sync** (enforcement ↔ audit) — Stage 3
  touches both.

## 5. Coordination

Lane: **CAS_0FBF301F** (object-registry / TypeDefinition backend). Touches the
case-RBAC lane files (`state.rs`, `field_perms.rs`, `type_registry.rs`,
`routes/admin.rs`, `rbac.rs`). The Stage-1 `entities.type` CHECK relax takes an
**ACCESS EXCLUSIVE** lock — announce on the thread before applying. Claim on the
`CAS_0FBF301F` thread + `presence/Torv-BE.md` before touching shared files; the
cases MCP backend is down → file-based claim is the fallback.

## Related

- [type-definition.md](type-definition.md) — the wire contract this arc stores.
- Skill: [`.claude/skills/rust-object-registry-design/`](../../../.claude/skills/rust-object-registry-design/SKILL.md) — method + reference-verified seam map + proven-registry precedents (Postgres `pg_catalog`, rustc `Providers`, Polars `ObjectRegistry`).
- Memory: [[decades-of-innovation]] / [[disposability-design-principle]] / [[framework-vertical-agnostic]] / [[data-format-open-ended]] / [[build-ready-dont-wire]] / [[connector-through-framework]].
