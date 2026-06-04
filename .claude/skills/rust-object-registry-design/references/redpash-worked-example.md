# Worked example — the RedPash backend object-registry

This is the method applied to the live RedPash backend (case `CAS_0FBF301F` [FRAMEWORK-L0]). It shows
what "done" looks like and gives the reference-verified call sites to lift. Re-verify the line numbers
before editing (the codebase moves) — rust-analyzer rooted at `backend/`, or grep, both work because the
symbol names are unique.

## The verdict that motivated it

The backend has a *more principled* data model than a typical REST backend (polymorphic `entities`,
one `memberships` edge, type-agnostic `resolve_grant`) but a *less flexible* extension mechanism: adding
an entity took ~8–12 artifacts (the Kafka `connection` addition was exhibit A — a CHECK-enum migration +
`db/connectors.rs` + `routes/connectors.rs` + RBAC + audit). The frontend adds a capability with one
`register(name, mount)` call. The registry refactor closes that gap.

## Seam map (reference-verified)

The exact blast radius — the consumers each stage touches. (Grep/read-verified; the rust-analyzer LSP
needs the session rooted at the Cargo workspace `backend/`, not the cwd, or it indexes nothing.)

- **`default_registry()`** (`field_perms.rs:204`) — **5 consumers**: `field_perms.rs:197` (`find_default`),
  `:315` (`require_fields`); `type_registry.rs:169`/`:175`; `routes/admin.rs:1334` (`/admin/fields` grid).
  Stage 1 redirects all 5 to the DB-backed cache.
- **`builtin_types()` / `builtin_type()`** (`type_registry.rs:168`/`:174`) — **1 consumer**:
  `routes/admin.rs:1487`/`:1506` (the `/admin/types` handler). The whole type registry has one read site.
- **`register_entity()`** (`db/entities.rs:21`) — **7 insert sites**: `db/mod.rs:1119` (company)/`:1289`
  (team)/`:1947` (case); `db/projects.rs:43`/`:387`; `db/connectors.rs:71`; `db/users.rs:304`.
- **`resolve_grant()`** (`rbac.rs:117`) — **7 consumers, all polymorphic** (`field_perms.rs:299`,
  `routes/members.rs:90`, `pipeline.rs:95`, `routes/admin.rs:1618`, `rbac.rs:215`/`:252`/`:441`). RBAC is
  already type-agnostic — Stage 2/3 reuse it unchanged.
- **`require_fields()`** (`field_perms.rs:286`) — **6 PATCH-handler sites** (`routes/companies.rs:162`,
  `charts.rs:108`, `cases.rs:332`, `files/mod.rs:363`, `dashboards.rs:67`/`:165`) = the per-resource
  duplication Stage 2 absorbs.
- **`validate_value()`** (`validate_rules.rs:314`) — already **wired at `routes/demo.rs:217`** with ~25
  passing tests (incl. Gemini/Copilot red-team batches). Not dead — there's a working call to copy.
- **Role allow-lists** — const arrays at `routes/admin.rs:1859–1862` (`PROJECT_ROLES`/`COMPANY_ROLES`/
  `CASE_ROLES`/`TEAM_ROLES`) + `*_CONTEXT_ROLES` (`:1868–1881`), consumed in `create_membership`
  (`:1923–1926`) + `:1738`. Stage 1 demotes them to `type_scope_roles` rows.
- **`FieldRow`** (`field_perms.rs:107`) — `object`/`field`/`data_type`/`editor`/`options` are
  `&'static str`; the only internal comparisons are `field_perms.rs:197` + `:319`. `type_registry`
  already `.to_string()`s every field into `FieldDef`, so the wire shape is unaffected by a
  `&'static str → String` change. Blast radius = `field_perms` internal + the `fld()` builder. (Per the
  interner lesson, this is cheap — intern/cache once.)
- **RBAC SQL** — `GRANT_SQL` `cascade_scopes` (`rbac.rs:95–113`) **and** `EDGES_SQL` (`:156–169`) carry
  per-type UNION arms. Stage 3 adds the `entity_data.scope_parent_id` arm to **both** (enforcement ↔
  audit must stay in sync — `rbac.md` "keep in sync" rule).

## The staged arc (decompose, each slice shippable)

- **Stage 0 — cheapest proof (~20 LOC, no schema).** Drop `#![allow(dead_code)]` from `validate_rules.rs`
  + `codec_registry.rs`; after the existing `require_fields()` call at `cases.rs:332` (perm-gate →
  data-gate), call `validate_value` on the `status` field (its enum options come from `default_registry`
  at `field_perms.rs:229`), copying the working call shape at `demo.rs:217`. Verify: `PATCH` bad status →
  `400 rule_code=data_type`; good → `200`. Proves the pipeline + the O(F) payoff before any infra.
- **Stage 1 — registries → data.** New `type_definitions` / `type_fields` / `type_scope_roles` tables,
  seeded byte-identically from the builtins (`Interner::prefill` pattern). `AppState` gains
  `Arc<TypeDefCache>` loaded after a retryable `seed_builtins` (order: migrate → seed → cache, never cache
  before seed). Redirect the 5 `default_registry` + 1 `builtin_types` consumers to the cache; demote the
  role const arrays. Relax `entities.type` CHECK → validate in app-layer against the registry. Back-compat
  for the 7 builtins is the bar.
- **Stage 2 — generic handler.** `generic_resource(type) -> Router` (generalize `members.rs`) reusing
  `resolve_grant` + type-derived audit; a generic `/api/objects/:type/:rid` PATCH that runs
  `require_fields` then `validate_rules` (merge current stored values before cross-field `expression`
  rules). Mount additively; migrate the smallest module (`connectors`) to a thin shim as proof.
- **Stage 3 — `register_type` + custom objects.** `entity_data (object_id PK → entities CASCADE, type_id →
  type_definitions RESTRICT, owner_id, scope_parent_id, data JSONB)`; `POST /api/admin/types` →
  `register_type_tx` (model on rustc's `Providers`); custom CRUD flows through the Stage-2 handler over
  JSONB; add the `entity_data` cascade arm to `GRANT_SQL` **and** `EDGES_SQL`. Resolved: users stay a
  rel-only subject (not a TypeDefinition); comments stay an implicit relation.

## Decisions that were locked (and why)

- **One canonical table set** (`type_definitions/...`) — Stage 2 reads it; no second `object_types` pair.
- **Hybrid-C storage** — builtins keep typed tables; custom → `entity_data` JSONB (one-polymorphic-table
  + disposability, no `ALTER TABLE` per type). **Polars validates this**: `DataType::Object(name)` sits
  among Polars' typed variants as the type-erased escape hatch — exactly typed-known + one-open-variant
  (see `references/polars-registry-patterns.md`).
- **`rid_prefix` UNIQUE for user-defined types only** (`dashboard` shares `FIL_` with `file` — don't
  rewrite live rids).
- **Single-source rule after Stage 1** — builtin field changes ship as a migration that updates the
  seeded rows; never let code-side `default_registry` diverge from the DB.

## Coordination note

This touches files active in the case-RBAC lane (`state.rs`, `field_perms.rs`, `type_registry.rs`,
`admin.rs`, `rbac.rs`). Claim on the `CAS_0FBF301F` thread + check presence/commits.log before starting;
`git commit -o <files>`; the `entities.type` CHECK ALTER takes an `ACCESS EXCLUSIVE` lock — announce it.
