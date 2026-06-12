# Spec: objects.rs `scope_parent_id` IDOR — regression test + auth-audit guard
Case: CAS_DD6F55FB1B1446138936DBF66A74DBDB  ·  type: bug  ·  area: backend/crates/api (routes/objects.rs, tests) + tools/auth-audit

> The FIX is already done + pushed (commit d3f933a — the `require_grant` ≥Member guard on
> `scope_parent_id` in `objects.rs::create`). This spec is for the **regression test that proves
> the fix** plus an **auth-audit static rule that catches the whole class**. It does NOT change
> the handler. Runbook: `docs/internal/runbooks/objects-scope-parent-idor.md`.

## Problem / intent
`POST /api/objects/:type` accepts a caller-supplied `scope_parent_id`. Before d3f933a it was bound
straight into the `entity_data` INSERT with no authorization, letting any authenticated user graft
an object into a scope they don't belong to (cross-tenant injection — it then surfaces to that
scope's members via the list REACH clause and hands its admins cascade write). The fix gates the
parent with `require_grant(... |g| g.effective() >= Role::Member)`. We need (1) a regression test
locking that behavior in, and (2) an auth-audit detector so this class of miss fails the tool, not
the user. There is **no HTTP+DB+seeded-membership integration-test harness** in `routes/` yet;
establishing the right approach is the crux of this spec.

## Acceptance criteria (numbered — tests map 1:1 to these)

**Deliverable 1 — regression test** (the four rows of the runbook table, each its own test case):
- **AC-1: foreign-parent injection is denied (the bug, now fixed).** A caller who is a Member of
  scope A only, calling `create` with `scope_parent_id = B` where the caller has **no** membership
  reaching B, gets a `404` (`AppError.status == StatusCode::NOT_FOUND`). No `entity_data` row is
  written for the attempted object.
- **AC-2: own-parent attach is allowed.** A caller who is a Member of scope A, calling `create`
  with `scope_parent_id = A`, gets `201 CREATED`; the persisted `entity_data` row has
  `scope_parent_id = A`, `owner_id = caller`, and an `owner` membership edge is auto-created for
  the caller on the new object.
- **AC-3: omitted parent is allowed (unchanged).** Any authenticated non-admin caller, calling
  `create` with `scope_parent_id` omitted (`None`), gets `201 CREATED` with `scope_parent = None`
  on the persisted row. (Proves the guard only fires when a parent is supplied.)
- **AC-4: platform admin bypasses the guard (intended).** A platform-admin caller
  (`users.role = 'admin'`), calling `create` with `scope_parent_id = B` (a scope the admin has no
  membership on), gets `201 CREATED`. (Proves the `is_platform_admin` bypass inside `require_grant`
  is intentional, not a hole.)

**Deliverable 2 — auth-audit extension** (`tools/auth-audit/audit.js`):
- **AC-5: a new detector flags scope-parent writes missing a reach check.** A new Cat-4
  ("scope-parent-injection") classifier reports any route handler that (a) reads a caller-supplied
  parent/scope id (a `Json`/`Query`/`Form` body field named `scope_parent_id`, or any field
  matching `/(scope_parent|parent)_id/`) **and** (b) writes it into the DB (binds it into an
  `INSERT`/`UPDATE`, or passes it to a `db::*`/`register_*` mutation) **without** a `require_grant`
  / `require_view` / `require_action` call in the same handler body. The detector respects the
  existing `AUTH-AUDIT-ACK` annotation and `HELPER_NAMES`/extractor-shape filters.
- **AC-6: the detector is green on the current (fixed) tree and red on a reverted handler.** Run
  against the live `objects.rs` (post-d3f933a), `objects.rs::create` is **not** flagged (the
  `require_grant` call satisfies (c)). The report surfaces the new category in `audit.json`
  (`scopeParentLeaks`) + the HTML (a new card + tab/section) + the console summary; counts roll up
  like the existing categories. A handler that binds `scope_parent_id` with the guard deleted IS
  flagged (verified by the tester with a throwaway fixture string, not by editing `objects.rs`).

## API contracts (exact — no guessing)

### The route under test
- `objects::create` — module-private `async fn` in
  `backend/crates/api/src/routes/objects.rs:95-162`. Signature:
  ```rust
  async fn create(
      State(state):  State<AppState>,
      headers:       HeaderMap,
      Path(type_id): Path<String>,
      Json(body):    Json<CreateBody>,
  ) -> Result<(StatusCode, Json<ObjectView>), AppError>
  ```
  `CreateBody { data: Map<String, Value>, scope_parent_id: Option<String> }`
  (`objects.rs:44-49`). Returns `(StatusCode::CREATED, Json<ObjectView>)` on success;
  `Err(AppError)` carries `.status` (`StatusCode`) on failure (`error.rs:44-53`). **Because
  `create` is module-private, the test MUST live inside `objects.rs` in a `#[cfg(test)] mod`** (so
  it can name `create`, `CreateBody`, `require_type`) OR call the handler through the assembled
  `routes()` Router over HTTP (heavier). Recommended: in-module direct call asserting on the
  `Result` — see Risks for the trade-off.
- The IDOR guard being proved (`objects.rs:115-121`):
  ```rust
  if let Some(parent) = body.scope_parent_id.as_deref() {
      let kind = state.type_cache.object_kind(parent);
      crate::rbac::require_grant(&state, &caller, parent, kind,
          |g| g.effective().is_some_and(|r| r >= Role::Member)).await?;
  }
  ```

### RBAC fns the guard composes (do not re-implement)
- `rbac::require_grant(state: &AppState, caller: &str, object: &str, label: &str, rule: impl Fn(Grant) -> bool) -> Result<(), AppError>`
  — `rbac.rs:246-262`. Platform-admin bypass first (`is_platform_admin`), else `resolve_grant` +
  `rule`; **404 leak-free on deny**.
- `rbac::Grant { direct: Option<Role>, scope: Option<Role> }` + `Grant::effective() -> Option<Role>`
  (`rbac.rs:63-82`). `rbac::Role { Viewer < Member < Admin < Owner }` (`rbac.rs:27-33`, derived `Ord`).
- `rbac::is_platform_admin(state, caller)` — `rbac.rs:226-235`: true iff `caller == state.dev_user`
  (fast-path) OR `users.role = 'admin'`. **Test consequence:** to exercise a *non-admin* caller the
  test must NOT let the caller be `state.dev_user` (that fast-paths the bypass and hides the guard).
- `type_cache.object_kind(rid) -> &'static str` — `type_cache.rs:232-240`: prefix→type, unknown
  prefix → `"unknown"` (default-denied). The `label` passed to `require_grant`.

### Seed shape the test must construct (exact schema — these are the contracts the harness writes)
- `entities(id TEXT PK, type TEXT CHECK type IN ('user','company','project','case','team'))`
  (`init.sql:22-27` + `20260531000000:15-17`). A scope used as a `scope_parent_id` should be a real
  registered entity, e.g. a `company` row (so `object_kind('CMP_…') = "company"`).
- `users(redpash_id TEXT PK, username UNIQUE, display_name NOT NULL, role TEXT …)` (`init.sql:30+`;
  `role` added by `20260531000002_users_role.sql` — `'admin'` ⇒ platform admin). Membership
  subjects MUST exist here (`memberships.member_redpash_id REFERENCES users`).
- `companies(redpash_id TEXT PK REFERENCES entities(id), name, slug UNIQUE)` (`init.sql:55-62`) —
  scopes A and B are companies; their `redpash_id` is the `entities.id`.
- `memberships(object_redpash_id, member_redpash_id, role CHECK IN ('owner','admin','member','viewer'), context_role NOT NULL DEFAULT '')`,
  PK `(object_redpash_id, member_redpash_id, role, context_role)`
  (`init.sql:113-124` renamed by `20260531000001` + widened by `20260531000000:37-39`). Seed a
  Member edge: `INSERT INTO memberships (object_redpash_id, member_redpash_id, role, context_role)
  VALUES (A, caller, 'member', '')`. **Column is `member_redpash_id`, NOT `user_redpash_id`** (post-rename).
- The object type to create: use a **registered custom/non-grid type already in the seed**, e.g.
  `connection` (`type_id='connection'`, `rid_prefix='CON_'`, `20260607000000:72`) — it routes
  through the `entity_data` path (not a builtin reach provider) and `type_cache.is_type("connection")`
  is true. Pass a body whose `data` fields all exist in that type's catalog (or `{}`), since
  `validate_fields` 400s an unknown field (`objects.rs:70-89`). `connection`'s seeded fields are in
  `20260607000000` (`name`/`kind`/`topic`/…); `data: {}` is the safest minimal body.
- `entity_data(object_id PK → entities CASCADE, type_id → type_definitions, owner_id, scope_parent_id, data JSONB)`
  — `20260607000002_entity_data.sql`. **`scope_parent_id` has NO FK** (any rid is bindable — that's
  why the guard, not a constraint, is the control).

### Caller identity in the test (how to make a specific non-admin user the caller)
`create` resolves the caller via `super::resolve_user_rid(&state, &headers)` (`me.rs:332-351`):
session cookie `rp_session` → `db::find_session_user` → that user; else (OAuth disabled) →
`state.dev_user`. Two viable seeding strategies (tester picks one, document it):
  1. **Session cookie:** seed a `users` row + `db::create_session(pool, caller_rid, ttl)`
     (`db/sessions.rs:10`) and pass `HeaderMap` with `Cookie: rp_session=<sid>`. Caller = that user,
     non-admin (so the guard runs). Cleanest for AC-1/2/3.
  2. **dev_user swap (admin case):** set `state.dev_user = Arc::new(admin_rid)` to exercise AC-4's
     platform-admin bypass without seeding `users.role='admin'` — OR seed `users.role='admin'` +
     a session, whichever the harness finds simpler. Pick ONE and be consistent.

### auth-audit detector contract (`tools/auth-audit/audit.js`)
- It's an Acorn-free, regex+brace-counting Node static-analysis script (the no-frameworks
  tooling carve-out applies). New classifier mirrors the existing `callsOwnershipGate` /
  `isMutation` shape (`audit.js:164-179`):
  - `readsScopeParent(params, body)` — body/extractor references a caller-supplied parent id:
    a struct field or destructure named `scope_parent_id`, or matching `/\b(scope_parent|parent)_id\b/`
    sourced from `Json`/`Query`/`Form`/`body.` (not from a DB read of an existing row).
  - `bindsScopeParentToWrite(body)` — that value reaches a write: appears in an `INSERT`/`UPDATE`
    SQL string with a `.bind(&…scope_parent…)`/`.bind(&body.scope_parent_id)`, or is passed to a
    `db::(insert|update|create|register)_…`/`register_entity` call.
  - `callsReachGate(body)` — extend the gate set to also recognize
    `require_grant` / `require_view` / `require_action` (today `callsOwnershipGate` only knows
    `ensure_*_owner` / `require_member` / `db::company_role` / `db::users_share_company`).
  - Flag = `readsScopeParent && bindsScopeParentToWrite && !callsReachGate && !AUTH-AUDIT-ACK`.
- Output plumbing parallel to the existing `leaks`/`auditGaps` arrays: a `scopeParentLeaks` array
  in `audit.json` (`audit.js:311-326`), a `'Scope-parent injection'` card (`audit.js:424-431`) +
  tab/panel/table (`audit.js:344-367`) + `renderRows` wiring (`audit.js:447-452`) + a console line
  (`audit.js:471-476`).

## Scope boundaries
- **In:** the regression test (AC-1..4) for `objects.rs::create`; a small reusable seed/teardown
  helper for the in-`objects.rs` test module (seed two companies + a member + optional session;
  delete same-objects on teardown so the live `redpash_prerelease` DB stays clean); the auth-audit
  Cat-4 detector + its report plumbing (AC-5..6).
- **Out:** any change to `objects.rs::create`'s logic (the fix shipped); changes to `rbac.rs`;
  PATCH/DELETE/GET handlers; a generic HTTP test server / `tower::ServiceExt::oneshot` harness
  (recommended deferred — see Risks); the `field_perms` field-grade path. Builtins are unaffected
  (they don't route through `entity_data`).
- **Reuses (name these; don't reinvent):** the `#[tokio::test] #[ignore]` live-DB pattern from
  `postgres_loader.rs:587-621` (connect `127.0.0.1:5433`, `mansa/mansa`, `redpash_prerelease`,
  run via `cargo test -p api -- --ignored`); `crate::db::register_entity` (`db/entities.rs:21`);
  `crate::db::create_session` (`db/sessions.rs:10`); `crate::id::new(prefix)` for minting test rids;
  `crate::rbac::{require_grant, Role, Grant, is_platform_admin}`; `type_cache.object_kind`. For the
  audit: the existing `findHandlers`/`strip`/`matchBraces`/`hasAuthAck` machinery — only ADD a
  classifier + report rows, do not restructure the walker.

## Risks / open questions for Em
1. **Test-harness approach (the crux).** Recommended: an **in-`objects.rs` `#[cfg(test)] mod`,
   `#[tokio::test] #[ignore]`** test that builds an `AppState` against the live
   `redpash_prerelease` (the established dogfood pattern) and **calls `create(...)` directly**,
   asserting on the returned `Result` (`StatusCode` on Ok, `AppError.status` on Err). This avoids
   standing up an axum server and needs no public-visibility change to `create`. Trade-off: it runs
   only on demand (`--ignored`, real DB), so it is NOT in the default `cargo test` gate — same as
   every existing dogfood test. **Alternative** (heavier, deferred): a true HTTP harness via
   `tower::ServiceExt::oneshot` against `objects::routes()`, which would also exercise routing/
   extractors and could later run in CI against an ephemeral Postgres. **Decision for Em: ship the
   in-module dogfood test now (cheap, proves the fix), and file the HTTP/CI harness as a separate
   follow-up?** Or invest in the HTTP harness immediately?
2. **`AppState` construction in-test.** `AppState::init()` (`state.rs:80`) does migrate + bootstrap
   + OAuth + internal-company resolution — fine to call once against the live DB, but it sets
   `dev_user` to the bootstrap user. The test must build/clone an `AppState` whose `dev_user` is a
   throwaway so the **non-admin caller is genuinely non-admin** (else the `is_platform_admin`
   fast-path hides the guard). Confirm the tester may construct `AppState` field-by-field (it's
   `pub`-fielded) rather than via `init()` — or that swapping `dev_user` on a cloned state is OK.
3. **Live-DB seeding hygiene.** Tests write to the shared `redpash_prerelease`. Mandate
   unique minted rids (`crate::id::new`) + a teardown that deletes exactly the seeded
   entities/users/companies/memberships/entity_data (cascade off `entities` covers most). Per the
   "test uploads → scratch" memory, nothing should linger in shared workspaces. OK to require a
   teardown block, or prefer a transaction rolled back at end?
4. **Split the auth-audit rule into its own Case?** AC-5/6 are a `tools/` static-analysis change
   independent of the Rust test and could land in parallel under a different role/lane. **Keep both
   deliverables in this one Case, or split the audit extension into a sibling Case** so the test can
   ship the moment it's green?
5. **Which object type to create.** Spec recommends the seeded `connection` type (custom-path,
   `data: {}`). If Em would rather the test register a throwaway type via `register_type` to avoid
   any coupling to `connection`'s catalog, that's a slightly larger seed — flag if preferred.
