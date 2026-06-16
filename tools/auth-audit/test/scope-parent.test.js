#!/usr/bin/env node
/* Purpose: red→green tests for auth-audit's Cat-4 scope_parent_id / parent-bind detector.
   Doc: docs/internal/code/backend/auth-audit.md (lean tree) */
/* ──────────────────────────────────────────────────────────────────────────
   The coder owns audit.js; this file is the executable contract for the Cat-4
   (scope_parent_id / parent-bind IDOR) detector.

   LEAN ADAPTATION: lean's objects.rs::create guards the caller-supplied
   scope_parent_id with `rbac::require_rule(...)` (prerelease used
   `require_grant`). callsReachGate() recognizes BOTH names, so the fixtures
   below use the real lean `require_rule` for the GUARDED twin while the
   classifier still accepts the legacy name. There is no connectors.rs in lean,
   so the integration test only asserts objects.rs::create stays green (the
   former connectors.rs::create assertion is dropped — nothing to flag).

   Verification approach:
     • Unit-level: import the exported classifiers and assert the CLASS
       (guarded / guard-removed / read-only / ACK'd) is recognised, on plain
       strings (no .rs edit). The classifiers take `(params, body)` like the
       existing isMutation(body) etc.
     • Integration-level: run `node audit.js` over the live lean tree and
       assert `scopeParentLeaks` is EMPTY (objects.rs::create is guarded by
       require_rule), AND that the guard-removed twin string IS flagged by the
       classifier combination (the RED regression case, proved at the string
       level so no .rs file is edited).

   Run:  node --test tools/auth-audit/test/scope-parent.test.js
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

/* The exact module.exports surface the unit tests require (coder must expose
   these; guarded by `if (require.main === module) { …run… }` so `node audit.js`
   behaviour is unchanged). If any is missing, the require below yields
   `undefined` and the unit tests fail at the first assert. */
const audit = require(AUDIT_JS);

/* ── Fixtures: faithful to the real lean objects.rs::create shape ──────────
   (mirrors backend/crates/api/src/objects.rs in the load-bearing tokens:
   `body.scope_parent_id`, `rbac::require_rule`, the entity_data INSERT,
   `.bind(&body.scope_parent_id)`). Strings stand in for the comment/string-
   STRIPPED `body` that findHandlers() hands a classifier — so they carry no
   // comments (strip() would have blanked them anyway). */

const PARAMS_WITH_BODY =
  'State(state): State<AppState>, caller: Caller, ' +
  'Path(type_id): Path<String>, Json(body): Json<CreateBody>';

// GUARDED twin — reads body.scope_parent_id, require_rule on the parent, binds
// it into the entity_data INSERT. This is the live lean objects.rs::create.
const GUARDED_BODY = `
  if let Some(parent) = body.scope_parent_id.as_deref() {
    let kind = state.type_cache.object_kind(parent);
    rbac::require_rule(&state.db, &state.type_cache, &caller, parent, kind, |g| {
      g.effective().is_some_and(|r| r >= Role::Member)
    }).await?;
  }
  let mut tx = state.db.begin().await?;
  crate::db::register_entity(&mut tx, &rid, &type_id).await?;
  sqlx::query(
    "INSERT INTO entity_data (object_id, type_id, owner_id, scope_parent_id, data) VALUES (1, 2, 3, 4, 5)"
  )
  .bind(&rid).bind(&type_id).bind(&caller.rid)
  .bind(&body.scope_parent_id).bind(&data_val)
  .execute(&mut *tx).await?;
`;

// GUARD-REMOVED twin — identical, but the require_rule block is deleted. THIS
// is the IDOR class the fix closed; the detector MUST flag it.
const GUARD_REMOVED_BODY = `
  let mut tx = state.db.begin().await?;
  crate::db::register_entity(&mut tx, &rid, &type_id).await?;
  sqlx::query(
    "INSERT INTO entity_data (object_id, type_id, owner_id, scope_parent_id, data) VALUES (1, 2, 3, 4, 5)"
  )
  .bind(&rid).bind(&type_id).bind(&caller.rid)
  .bind(&body.scope_parent_id).bind(&data_val)
  .execute(&mut *tx).await?;
`;

// READ-ONLY — reads scope_parent_id but never binds it to a write. Not a leak.
const READ_ONLY_BODY = `
  let scope = body.scope_parent_id.clone();
  Ok(Json(ObjectView { scope_parent: scope, data: data_val }))
`;

// ACK'd — guard removed, but an inline AUTH-AUDIT-ACK annotation present. The
// raw (un-stripped) body is what hasAuthAck reads (the annotation is a comment).
const ACK_RAW_BODY = `
  // AUTH-AUDIT-ACK: admin-only seeding path, parent reach intentionally skipped
  sqlx::query("INSERT INTO entity_data (object_id, scope_parent_id, data) VALUES (1, 2, 3)")
    .bind(&body.scope_parent_id).bind(&data_val)
    .execute(&state.db).await?;
`;

/* ════════════════════════════════════════════════════════════════════════
   Unit — the detector recognises the CLASS at the classifier level.
   (Each predicate + each verdict is asserted on plain strings.)
   ════════════════════════════════════════════════════════════════════════ */

test('exports the three classifiers + hasAuthAck', () => {
  assert.equal(typeof audit.readsScopeParent, 'function', 'readsScopeParent must be exported');
  assert.equal(typeof audit.bindsParentToWrite, 'function', 'bindsParentToWrite must be exported');
  assert.equal(typeof audit.callsReachGate, 'function', 'callsReachGate must be exported');
  assert.equal(typeof audit.hasAuthAck, 'function', 'hasAuthAck must be exported');
});

test('readsScopeParent — true when a scope_parent_id body field is read', () => {
  assert.equal(audit.readsScopeParent(PARAMS_WITH_BODY, GUARDED_BODY), true,
    'body.scope_parent_id read → readsScopeParent true');
  assert.equal(audit.readsScopeParent(PARAMS_WITH_BODY, GUARD_REMOVED_BODY), true);
  assert.equal(audit.readsScopeParent(PARAMS_WITH_BODY, READ_ONLY_BODY), true,
    'read-only still READS the parent id');
});

test('bindsParentToWrite — true only when the parent id reaches an INSERT/UPDATE .bind', () => {
  assert.equal(audit.bindsParentToWrite(GUARDED_BODY), true,
    'INSERT entity_data + .bind(&body.scope_parent_id) → binds to write');
  assert.equal(audit.bindsParentToWrite(GUARD_REMOVED_BODY), true);
  assert.equal(audit.bindsParentToWrite(READ_ONLY_BODY), false,
    'read-only never writes the parent id → not bound to a write');
});

test('callsReachGate — recognises require_rule/require_grant/require_view/require_action', () => {
  assert.equal(audit.callsReachGate(GUARDED_BODY), true,
    'rbac::require_rule(...) → reach gate present (lean objects.rs::create)');
  assert.equal(audit.callsReachGate(GUARD_REMOVED_BODY), false,
    'guard deleted → no reach gate');
  // The gate set covers lean (require_rule/require_action/require_view) +
  // legacy prerelease (require_grant).
  assert.equal(audit.callsReachGate('rbac::require_view(&state.db, &tc, &c, &p, Action::View).await?;'), true);
  assert.equal(audit.callsReachGate('rbac::require_action(&state.db, &tc, &c, &p, Action::Edit).await?;'), true);
  assert.equal(audit.callsReachGate('crate::rbac::require_grant(&state, &u, &p, k, |g| true).await?;'), true);
});

test('GUARD-REMOVED twin IS flagged (reads + binds + no reach gate + no ACK)', () => {
  const flagged =
    audit.readsScopeParent(PARAMS_WITH_BODY, GUARD_REMOVED_BODY) &&
    audit.bindsParentToWrite(GUARD_REMOVED_BODY) &&
    !audit.callsReachGate(GUARD_REMOVED_BODY) &&
    !audit.hasAuthAck(GUARD_REMOVED_BODY);
  assert.equal(flagged, true, 'guard-removed scope-parent write → scopeParentLeaks hit');
});

test('GUARDED twin is NOT flagged (require_rule present → condition 3 fails)', () => {
  const flagged =
    audit.readsScopeParent(PARAMS_WITH_BODY, GUARDED_BODY) &&
    audit.bindsParentToWrite(GUARDED_BODY) &&
    !audit.callsReachGate(GUARDED_BODY) &&
    !audit.hasAuthAck(GUARDED_BODY);
  assert.equal(flagged, false, 'guarded write must NOT be a leak (objects.rs::create stays green)');
});

test('READ-ONLY parent read is NOT flagged (no write)', () => {
  const flagged =
    audit.readsScopeParent(PARAMS_WITH_BODY, READ_ONLY_BODY) &&
    audit.bindsParentToWrite(READ_ONLY_BODY) &&
    !audit.callsReachGate(READ_ONLY_BODY) &&
    !audit.hasAuthAck(READ_ONLY_BODY);
  assert.equal(flagged, false, 'reading a parent id without writing it is not a leak');
});

test("ACK'd hit routes to the ACK bucket, not a leak", () => {
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
   Integration — GREEN on the live lean tree, RED on the guard-removed twin.
   The GREEN half runs the real `node audit.js` and asserts on audit.json.
   The RED half is the classifier combination above (a committed string
   fixture, no .rs edit).
   ════════════════════════════════════════════════════════════════════════ */

test('GREEN: node audit.js emits scopeParentLeaks and it is EMPTY on the live tree', () => {
  execFileSync('node', [AUDIT_JS], { cwd: AUDIT_DIR, stdio: 'pipe' });
  const data = JSON.parse(fs.readFileSync(AUDIT_JSON, 'utf8'));

  assert.ok(Array.isArray(data.scopeParentLeaks),
    'audit.json must carry a scopeParentLeaks array (Cat-4 category)');
  assert.equal(data.scopeParentLeaks.length, 0,
    'scopeParentLeaks must be empty — objects.rs::create is guarded by require_rule');
  assert.equal(data.stats.scopeParentLeaks, 0,
    'stats.scopeParentLeaks headline must be 0 on the current tree');

  // The guarded write must be absent by name (the precision contract).
  const names = data.scopeParentLeaks.map((r) => r.file + '::' + r.name);
  assert.ok(!names.some((n) => n.endsWith('objects.rs::create')),
    'objects.rs::create (guarded by require_rule) must NOT be flagged');
});

test('RED: the guard-removed regression twin IS flagged by the detector', () => {
  // Same predicate stack the in-walk classify/push uses. If a future change to
  // the live objects.rs dropped the require_rule guard, this combination —
  // which the audit applies per handler — would push a scopeParentLeaks row.
  const flagged =
    audit.readsScopeParent(PARAMS_WITH_BODY, GUARD_REMOVED_BODY) &&
    audit.bindsParentToWrite(GUARD_REMOVED_BODY) &&
    !audit.callsReachGate(GUARD_REMOVED_BODY) &&
    !audit.hasAuthAck(GUARD_REMOVED_BODY);
  assert.equal(flagged, true,
    'guard-removed scope-parent write must be RED (detector catches the regression)');
});
