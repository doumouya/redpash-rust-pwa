#!/usr/bin/env node
/* Purpose: red→green tests for auth-audit's Cat-4 scope_parent_id / parent-bind detector.
   Doc: docs/internal/code/tools/audit-suite/auth-audit.md */
/* ──────────────────────────────────────────────────────────────────────────
   Tester-owned (CAS_26EC04CAF5934A0996B7A04C8FA55534, sibling of CAS_DD6F…).
   The coder owns audit.js; this file is the executable contract for AC-5/AC-6.

   These tests are TEST-FIRST: they start RED because audit.js does not yet
   (a) `module.exports` the three classifiers + hasAuthAck, or (b) emit a
   `scopeParentLeaks` array in audit.json. That is the correct red state — the
   detector does not exist yet.

   Verification approach (per the approved spec, "How the negative case is
   exercised"):
     • AC-5 — unit-level: import the exported classifiers and assert the CLASS
       (guarded / guard-removed / read-only / ACK'd) is recognised, on plain
       strings (no .rs edit). The classifiers take `(params, body)` like the
       existing `callsOwnershipGate(body)` / `isMutation(body)`.
     • AC-6 — integration-level: run `node audit.js` over the live tree and
       assert `scopeParentLeaks` is EMPTY (objects.rs::create + connectors.rs::
       create are guarded), AND that the guard-removed twin string IS flagged
       by the classifier combination (the RED regression case, proved at the
       string level so no .rs file is edited).

   Run:  node tools/auth-audit/test/scope-parent.test.js
   (node:test built-in harness — no new dependency; node:assert/strict only.)
   ────────────────────────────────────────────────────────────────────────── */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const AUDIT_DIR = path.join(__dirname, '..');
const AUDIT_JS = path.join(AUDIT_DIR, 'audit.js');
const AUDIT_JSON = path.join(AUDIT_DIR, 'audit.json');

/* The exact module.exports surface the coder must expose from audit.js
   (guarded by `if (require.main === module) { …run… }` so `node audit.js`
   behaviour is unchanged). If any of these is missing, the require below
   yields `undefined` and the AC-5 tests fail at the first assert — the
   intended red signal. */
const audit = require(AUDIT_JS);

/* ── Fixtures: faithful to the real objects.rs::create shape ───────────────
   (mirrors backend/crates/api/src/routes/objects.rs lines 95-162 verbatim in
   the load-bearing tokens: `body.scope_parent_id`, `crate::rbac::require_grant`,
   the entity_data INSERT, `.bind(&body.scope_parent_id)`). Strings stand in for
   the comment/string-STRIPPED `body` that findHandlers() hands a classifier —
   so they carry no // comments (strip() would have blanked them anyway). */

const PARAMS_WITH_BODY =
  'State(state): State<AppState>, headers: HeaderMap, ' +
  'Path(type_id): Path<String>, Json(body): Json<CreateBody>';

// GUARDED twin — reads body.scope_parent_id, require_grant on the parent, binds
// it into the entity_data INSERT. This is the post-d3f933a objects.rs::create.
const GUARDED_BODY = `
  let caller = super::resolve_user_rid(&state, &headers).await?;
  if let Some(parent) = body.scope_parent_id.as_deref() {
    let kind = state.type_cache.object_kind(parent);
    crate::rbac::require_grant(&state, &caller, parent, kind, |g| {
      g.effective().is_some_and(|r| r >= Role::Member)
    }).await?;
  }
  let mut tx = state.db.begin().await?;
  crate::db::register_entity(&mut *tx, &rid, &type_id).await?;
  sqlx::query(
    "INSERT INTO entity_data (object_id, type_id, owner_id, scope_parent_id, data) VALUES (1, 2, 3, 4, 5)"
  )
  .bind(&rid).bind(&type_id).bind(&caller)
  .bind(&body.scope_parent_id).bind(&data_val)
  .execute(&mut *tx).await?;
`;

// GUARD-REMOVED twin — identical, but the require_grant block is deleted. THIS
// is the IDOR the sibling Case fixed; the detector MUST flag it.
const GUARD_REMOVED_BODY = `
  let caller = super::resolve_user_rid(&state, &headers).await?;
  let mut tx = state.db.begin().await?;
  crate::db::register_entity(&mut *tx, &rid, &type_id).await?;
  sqlx::query(
    "INSERT INTO entity_data (object_id, type_id, owner_id, scope_parent_id, data) VALUES (1, 2, 3, 4, 5)"
  )
  .bind(&rid).bind(&type_id).bind(&caller)
  .bind(&body.scope_parent_id).bind(&data_val)
  .execute(&mut *tx).await?;
`;

// READ-ONLY — reads scope_parent_id but never binds it to a write. Not a leak.
const READ_ONLY_BODY = `
  let caller = super::resolve_user_rid(&state, &headers).await?;
  let scope = body.scope_parent_id.clone();
  Ok(Json(ObjectView { scope_parent: scope, data: data_val }))
`;

// ACK'd — guard removed, but an inline AUTH-AUDIT-ACK annotation present. The
// raw (un-stripped) body is what hasAuthAck reads (the annotation is a comment).
const ACK_RAW_BODY = `
  // AUTH-AUDIT-ACK: admin-only seeding path, parent reach intentionally skipped
  let caller = super::resolve_user_rid(&state, &headers).await?;
  sqlx::query("INSERT INTO entity_data (object_id, scope_parent_id, data) VALUES (1, 2, 3)")
    .bind(&body.scope_parent_id).bind(&data_val)
    .execute(&state.db).await?;
`;

/* ════════════════════════════════════════════════════════════════════════
   AC-5 — the detector recognises the CLASS at the classifier level.
   (Each predicate + each verdict is asserted on plain strings.)
   ════════════════════════════════════════════════════════════════════════ */

test('AC-5: audit.js exports the three classifiers + hasAuthAck', () => {
  // The module.exports surface the unit tests require (coder must expose these).
  assert.equal(typeof audit.readsScopeParent, 'function', 'readsScopeParent must be exported');
  assert.equal(typeof audit.bindsParentToWrite, 'function', 'bindsParentToWrite must be exported');
  assert.equal(typeof audit.callsReachGate, 'function', 'callsReachGate must be exported');
  assert.equal(typeof audit.hasAuthAck, 'function', 'hasAuthAck must be exported');
});

test('AC-5: readsScopeParent — true when a scope_parent_id body field is read', () => {
  assert.equal(audit.readsScopeParent(PARAMS_WITH_BODY, GUARDED_BODY), true,
    'body.scope_parent_id read → readsScopeParent true');
  assert.equal(audit.readsScopeParent(PARAMS_WITH_BODY, GUARD_REMOVED_BODY), true);
  assert.equal(audit.readsScopeParent(PARAMS_WITH_BODY, READ_ONLY_BODY), true,
    'read-only still READS the parent id');
});

test('AC-5: bindsParentToWrite — true only when the parent id reaches an INSERT/UPDATE .bind', () => {
  assert.equal(audit.bindsParentToWrite(GUARDED_BODY), true,
    'INSERT entity_data + .bind(&body.scope_parent_id) → binds to write');
  assert.equal(audit.bindsParentToWrite(GUARD_REMOVED_BODY), true);
  assert.equal(audit.bindsParentToWrite(READ_ONLY_BODY), false,
    'read-only never writes the parent id → not bound to a write');
});

test('AC-5: callsReachGate — recognises require_grant/require_view/require_action', () => {
  assert.equal(audit.callsReachGate(GUARDED_BODY), true,
    'crate::rbac::require_grant(...) → reach gate present');
  assert.equal(audit.callsReachGate(GUARD_REMOVED_BODY), false,
    'guard deleted → no reach gate');
  // The gate set is exactly require_grant / require_view / require_action.
  assert.equal(audit.callsReachGate('crate::rbac::require_view(&state, &u, &p, "project").await?;'), true);
  assert.equal(audit.callsReachGate('crate::rbac::require_action(&state, &u, &p, k, |g| true).await?;'), true);
  // Must NOT be satisfied by a Cat-1 ownership gate (those feed callsOwnershipGate).
  assert.equal(audit.callsReachGate('super::ensure_owner(&state, &caller, &rid).await?;'), false,
    'ensure_owner is a Cat-1 gate, not a Cat-4 reach gate');
});

test('AC-5: GUARD-REMOVED twin IS flagged (reads + binds + no reach gate + no ACK)', () => {
  const flagged =
    audit.readsScopeParent(PARAMS_WITH_BODY, GUARD_REMOVED_BODY) &&
    audit.bindsParentToWrite(GUARD_REMOVED_BODY) &&
    !audit.callsReachGate(GUARD_REMOVED_BODY) &&
    !audit.hasAuthAck(GUARD_REMOVED_BODY);
  assert.equal(flagged, true, 'guard-removed scope-parent write → scopeParentLeaks hit');
});

test('AC-5: GUARDED twin is NOT flagged (require_grant present → condition 3 fails)', () => {
  const flagged =
    audit.readsScopeParent(PARAMS_WITH_BODY, GUARDED_BODY) &&
    audit.bindsParentToWrite(GUARDED_BODY) &&
    !audit.callsReachGate(GUARDED_BODY) &&
    !audit.hasAuthAck(GUARDED_BODY);
  assert.equal(flagged, false, 'guarded write must NOT be a leak (objects.rs::create stays green)');
});

test('AC-5: READ-ONLY parent read is NOT flagged (no write)', () => {
  const flagged =
    audit.readsScopeParent(PARAMS_WITH_BODY, READ_ONLY_BODY) &&
    audit.bindsParentToWrite(READ_ONLY_BODY) &&
    !audit.callsReachGate(READ_ONLY_BODY) &&
    !audit.hasAuthAck(READ_ONLY_BODY);
  assert.equal(flagged, false, 'reading a parent id without writing it is not a leak');
});

test("AC-5: ACK'd hit routes to the ACK bucket, not a leak", () => {
  // hasAuthAck returns the annotation reason (truthy) → suppresses the leak.
  assert.ok(audit.hasAuthAck(ACK_RAW_BODY), 'AUTH-AUDIT-ACK annotation recognised');
  const wouldLeakIgnoringAck =
    audit.readsScopeParent(PARAMS_WITH_BODY, ACK_RAW_BODY) &&
    audit.bindsParentToWrite(ACK_RAW_BODY) &&
    !audit.callsReachGate(ACK_RAW_BODY);
  assert.equal(wouldLeakIgnoringAck, true,
    'absent the ACK this would be a leak — so the ACK is what diverts it');
  const isLeak = wouldLeakIgnoringAck && !audit.hasAuthAck(ACK_RAW_BODY);
  assert.equal(isLeak, false, "ACK'd hit must NOT be a leak (goes to scopeParentAck bucket)");
});

/* ════════════════════════════════════════════════════════════════════════
   AC-6 — GREEN on the live tree, RED on the guard-removed regression.
   The GREEN half runs the real `node audit.js` and asserts on audit.json,
   exactly the spec's audit-run-assert. The RED half is the classifier
   combination above (a committed string fixture, no .rs edit).
   ════════════════════════════════════════════════════════════════════════ */

test('AC-6 GREEN: node audit.js emits scopeParentLeaks and it is EMPTY on the live tree', () => {
  execFileSync('node', [AUDIT_JS], { cwd: AUDIT_DIR, stdio: 'pipe' });
  const data = JSON.parse(fs.readFileSync(AUDIT_JSON, 'utf8'));

  assert.ok(Array.isArray(data.scopeParentLeaks),
    'audit.json must carry a scopeParentLeaks array (new Cat-4 category)');
  assert.equal(data.scopeParentLeaks.length, 0,
    'scopeParentLeaks must be empty — objects.rs::create + connectors.rs::create are guarded');
  assert.equal(data.stats.scopeParentLeaks, 0,
    'stats.scopeParentLeaks headline must be 0 on the current tree');

  // The two guarded writes must be absent by name (the precision contract).
  const names = data.scopeParentLeaks.map((r) => r.file + '::' + r.name);
  assert.ok(!names.some((n) => n.endsWith('objects.rs::create')),
    'objects.rs::create (guarded by require_grant) must NOT be flagged');
  assert.ok(!names.some((n) => n.endsWith('connectors.rs::create')),
    'connectors.rs::create (reads project_id, outside v1 set, guarded) must NOT be flagged');
});

test('AC-6 RED: the guard-removed regression twin IS flagged by the detector', () => {
  // Same predicate stack the in-walk classify/push uses. If a future change to
  // the live objects.rs dropped the require_grant guard, this combination —
  // which the audit applies per handler — would push a scopeParentLeaks row.
  const flagged =
    audit.readsScopeParent(PARAMS_WITH_BODY, GUARD_REMOVED_BODY) &&
    audit.bindsParentToWrite(GUARD_REMOVED_BODY) &&
    !audit.callsReachGate(GUARD_REMOVED_BODY) &&
    !audit.hasAuthAck(GUARD_REMOVED_BODY);
  assert.equal(flagged, true,
    'guard-removed scope-parent write must be RED (detector catches the regression)');
});
