#!/usr/bin/env node
/* Purpose: tester-owned red->green checks for the lean cleanup (CAS_C8A9...).
   Doc: docs/internal/code/tools/lean-cleanup-check/lean-cleanup.test.md */
/* ──────────────────────────────────────────────────────────────────────────
   Tester-owned executable contract for CAS_C8A9A3EC0935498880A468625FE3F490
   ("Lean cleanup"). The CODER cannot edit this file. The CODER does the
   deletions; these assertions go GREEN when the deletions land.

   This is a DELETION/REFACTOR cleanup, so the checks are GATE-shaped, not
   classic unit-TDD. Each test maps 1:1 to a numbered acceptance criterion in
   docs/internal/specs/lean-cleanup.md / the Case, resolved by the
   CHECKPOINT-1 APPROVED comment (authoritative scope):

     AC-1  CSS reachability — every sheet in main.css @import closure, zero
           orphans, zero dangling imports. REGRESSION GUARD (green today).
           Oracle: tools/css-audit/audit.json reachability.{orphans,danglingImports}.
     AC-2  partials — every frontend/partials/*.html is the `partial:` of one of
           the 5 ROUTES in frontend/scripts/main.js; no orphans. REGRESSION GUARD.
     AC-3  admin.css (the /database console sheet) deleted + dropped from the
           main.css @import list. RED now (file present), GREEN after.
     AC-4  the 6 orphan framework sheets (comments/profile-record/settings-config/
           avatar-upload/filter-panel/tools-panel.css) deleted + their @import
           lines dropped. RED now, GREEN after. (The "no half-delete" floor is
           ALSO covered structurally by AC-1's dangling_imports==[].)
     AC-8  every DEAD route module is GONE: routes/<name>.rs deleted, its
           `mod <name>;` decl removed, its `.nest("/<path>", ...)` removed from
           routes/mod.rs. DEAD set (CP-1 approved): demo, docs, companies, teams,
           users, members. RED now, GREEN after.
     AC-9  LIVE surfaces survive — the router must STILL nest the KEEP routes
           and STILL declare their mods (admin/cases kept whole/trimmed, never
           removed). Guards against an over-zealous deletion that breaks
           monitoring's /admin/users, /admin/steps/stats, /cases/categories.
     AC-10 each deleted route module's atomic doc (docs/.../routes/<name>.md) is
           deleted in the same change; no dangling Doc: breadcrumb to a deleted
           module remains in the tree. RED now, GREEN after.

   AC-5/AC-6/AC-7(machinery) are Rust #[cfg(test)] tests living in
   backend/crates/api/src/rbac.rs (the gate behaviour can only be exercised in
   Rust). AC-7(build/test green), AC-11(audit baseline) and AC-12(page-verify)
   are existing gates the reviewer/ops run — named in the Case summary, not
   reimplemented here. The AC-11 baseline is captured in ./baseline.json.

   Run:  node tools/lean-cleanup-check/lean-cleanup.test.js
   or via the FE gate once relocated:  sh tools/test-fe.sh
   (node:test built-in harness — node:assert/strict only; repo rule, no JS fw.)
   ────────────────────────────────────────────────────────────────────────── */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..', '..');
const r = (...p) => path.join(REPO, ...p);
const exists = (rel) => fs.existsSync(r(rel));
const read = (rel) => fs.readFileSync(r(rel), 'utf8');

/* ── AC-1: CSS reachability — zero orphans, zero dangling imports ──────────
   Reuse the EXISTING css-audit reachability pass (it BFSes the @import graph
   rooted at the HTML <link>s + main.css and set-diffs against every .css under
   styles/). We do NOT reimplement the graph walk — css-audit IS the oracle.
   Green today (regression guard); the deletions must keep it green, and a
   half-delete (an @import left pointing at a deleted sheet) surfaces here as a
   non-empty danglingImports — which is exactly the AC-4 "no half-delete" floor. */
test('AC-1: the lean CSS deletions leave no half-delete (dangling @import) and no net-new orphan vs the committed baseline', () => {
  const auditJs = r('tools/css-audit/audit.js');
  // Run fresh so we read post-change state, not a stale audit.json.
  execFileSync('node', [auditJs], { cwd: REPO, stdio: 'ignore' });
  const j = JSON.parse(read('tools/css-audit/audit.json'));
  const reach = j.reachability || {};
  const orphans = (reach.orphans || []).slice().sort();
  const dangling = (reach.danglingImports || []).map((d) => (d && d.target) || d);

  // The CSS sheets THIS case deletes (AC-3 + AC-4). A dangling @import targeting
  // ANY of these is the exact half-delete AC-4 forbids (sheet removed, @import
  // line left behind → blanks the cascade). This is the sharp, foreign-WIP-proof
  // half-delete guard.
  const LEAN_DELETED = new Set([
    'admin.css',
    'framework/comments.css', 'framework/profile-record.css',
    'framework/settings-config.css', 'framework/avatar-upload.css',
    'framework/filter-panel.css', 'framework/tools-panel.css',
    // also bare basenames, in case css-audit reports the target unprefixed:
    'comments.css', 'profile-record.css', 'settings-config.css',
    'avatar-upload.css', 'filter-panel.css', 'tools-panel.css',
  ]);
  const half = dangling.filter((t) => LEAN_DELETED.has(t) || LEAN_DELETED.has(String(t).replace(/^framework\//, '')));
  assert.deepEqual(half, [],
    'HALF-DELETE: main.css still @import-s a sheet this case deleted (dangling import → blanks the cascade). ' +
    'The sheet and its @import line must be disposed together (AC-4). Offending targets: ' + JSON.stringify(half));

  // No NET-NEW orphan vs the committed baseline (orphans=[] there). A pre-existing
  // dangling/orphan from a concurrent Torv's unstaged WIP in the shared tree
  // (e.g. styles/prefs.css deleted-but-not-de-imported, UNRELATED to this Case —
  // flagged to the team separately) is excluded so it isn't mis-attributed here.
  const base = JSON.parse(read('tools/lean-cleanup-check/baseline.json')).css_audit;
  const baseOrphans = new Set(base.orphans || []);
  const newOrphans = orphans.filter((o) => !baseOrphans.has(o));
  assert.deepEqual(newOrphans, [],
    'lean cleanup introduced CSS sheets NOT reachable from the main.css @import closure (net-new orphans vs baseline): ' + JSON.stringify(newOrphans));
});

/* ── AC-2: partials ⇔ the 5 routes in main.js ─────────────────────────────
   Parse the ROUTES table in main.js for the `partial: "/partials/<x>.html"`
   targets; set-equality against the actual files in frontend/partials/. No
   orphan partial (a file no route loads) and no missing partial (a route whose
   partial file is absent). Regression guard — green today. */
test('AC-2: frontend/partials/ set-equals the partial: targets of the 5 main.js routes (no orphans)', () => {
  const main = read('frontend/scripts/main.js');
  const routesPartials = [...main.matchAll(/partial:\s*"\/partials\/([A-Za-z0-9_-]+\.html)"/g)]
    .map((m) => m[1]).sort();
  assert.ok(routesPartials.length >= 5,
    'expected the 5 lean routes to declare partials; main.js parse found: ' + JSON.stringify(routesPartials));
  const onDisk = fs.readdirSync(r('frontend/partials'))
    .filter((f) => f.endsWith('.html')).sort();
  const routed = [...new Set(routesPartials)].sort();
  assert.deepEqual(onDisk, routed,
    'frontend/partials/ files vs main.js partial: targets diverge — orphan partial or missing partial.\n' +
    '  on disk: ' + JSON.stringify(onDisk) + '\n  routed:  ' + JSON.stringify(routed));
});

/* ── AC-3: admin.css deleted + dropped from the @import list ───────────────
   RED now (the file exists + main.css:91 imports it). GREEN after the coder
   deletes both. We assert BOTH halves explicitly (file gone AND no @import),
   independent of AC-1's structural check, so the failure message names AC-3. */
test('AC-3: frontend/styles/admin.css is deleted and not @import-ed by main.css', () => {
  assert.equal(exists('frontend/styles/admin.css'), false,
    'frontend/styles/admin.css still present — the /database admin-SQL-console sheet must be deleted (CP-1: /database stays cut).');
  const main = read('frontend/styles/main.css');
  assert.ok(!/@import\s+["']admin\.css["']/.test(main),
    'main.css still @import-s "admin.css" (dangling import once the file is deleted).');
});

/* ── AC-4: the 6 orphan framework sheets deleted + de-imported ─────────────
   CP-1 approved: CUT all 6 (the framework-sandbox.html fixtures are acceptable
   collateral for a personal tool). RED now (sheets present + imported). */
const ORPHAN_FRAMEWORK_SHEETS = [
  'comments', 'profile-record', 'settings-config',
  'avatar-upload', 'filter-panel', 'tools-panel',
];
for (const sheet of ORPHAN_FRAMEWORK_SHEETS) {
  test(`AC-4: framework/${sheet}.css is deleted and not @import-ed by main.css`, () => {
    assert.equal(exists(`frontend/styles/framework/${sheet}.css`), false,
      `frontend/styles/framework/${sheet}.css still present — CP-1 approved cutting all 6 orphan framework sheets.`);
    const main = read('frontend/styles/main.css');
    const re = new RegExp('@import\\s+["\']framework/' + sheet.replace(/[-]/g, '\\$&') + '\\.css["\']');
    assert.ok(!re.test(main),
      `main.css still @import-s "framework/${sheet}.css" (dangling import once the file is deleted).`);
  });
}

/* ── AC-8: DEAD route modules removed (file + mod decl + .nest) ────────────
   CP-1 approved DEAD set: demo, docs, companies, teams, users, members.
   For each: routes/<name>.rs deleted, `mod <name>;` gone from routes/mod.rs,
   and no `.nest("/<path>", <name>::routes())` remains. `members` is nested
   under cases (`super::members::routes()`) not the /api root, so its check is
   file + mod-decl only (the cases /:rid/members .nest removal is asserted by
   the absence of `super::members` in cases.rs).
   RED now (all present). GREEN after deletion. */
const DEAD_ROUTES = [
  { mod: 'demo', nestPath: '/demo' },
  { mod: 'docs', nestPath: '/docs' },
  { mod: 'companies', nestPath: '/companies' },
  { mod: 'teams', nestPath: '/teams' },
  { mod: 'users', nestPath: '/users' },
  { mod: 'members', nestPath: null }, // nested under cases, not /api root
];
for (const { mod, nestPath } of DEAD_ROUTES) {
  test(`AC-8: DEAD route module \`${mod}\` is fully removed (file + mod decl${nestPath ? ' + nest' : ''})`, () => {
    assert.equal(exists(`backend/crates/api/src/routes/${mod}.rs`), false,
      `backend/crates/api/src/routes/${mod}.rs still present — DEAD route, CP-1 approved deletion.`);
    const modrs = read('backend/crates/api/src/routes/mod.rs');
    const modDecl = new RegExp('^\\s*mod\\s+' + mod + '\\s*;', 'm');
    assert.ok(!modDecl.test(modrs),
      `routes/mod.rs still declares \`mod ${mod};\` for a deleted module.`);
    if (nestPath) {
      const nest = new RegExp('\\.nest\\(\\s*"' + nestPath + '"');
      assert.ok(!nest.test(modrs),
        `routes/mod.rs still .nest("${nestPath}", ...) for a deleted module.`);
    }
  });
}

/* members.rs becomes dead only because the cases /:rid/members nest is removed.
   Assert the cases router no longer references it. RED now (cases.rs:51 nests it). */
test('AC-8: cases.rs no longer nests /:rid/members (members.rs is thereby dead)', () => {
  const cases = read('backend/crates/api/src/routes/cases.rs');
  assert.ok(!/super::members::routes\(\)/.test(cases) && !/\.nest\(\s*"\/:rid\/members"/.test(cases),
    'cases.rs still nests /:rid/members (super::members::routes()) — CP-1: trim cases CRUD incl. the members nest.');
});

/* ── AC-9: LIVE surfaces survive — KEEP routes still wired ─────────────────
   The deletions must NOT touch the surfaces monitoring depends on. admin is
   KEPT WHOLE; cases is TRIMMED but /cases/categories stays; the router must
   still nest /admin and /cases and still declare their mods. This is the
   anti-over-deletion guard. GREEN today; must STAY green. */
test('AC-9: router still nests + declares the KEEP routes monitoring depends on (admin, cases, monitoring, metrics)', () => {
  const modrs = read('backend/crates/api/src/routes/mod.rs');
  for (const keep of ['admin', 'cases', 'monitoring', 'metrics', 'me', 'auth', 'projects', 'files', 'events']) {
    assert.ok(new RegExp('^\\s*mod\\s+' + keep + '\\s*;', 'm').test(modrs),
      `routes/mod.rs dropped \`mod ${keep};\` — that is a KEEP route, must not be deleted.`);
    assert.ok(new RegExp('\\.nest\\(\\s*"/' + keep + '"').test(modrs),
      `routes/mod.rs dropped .nest("/${keep}", ...) — KEEP route, monitoring/live pages depend on it.`);
  }
});

test('AC-9: cases.rs still serves /cases/categories (monitoring CATALOG tab)', () => {
  const cases = read('backend/crates/api/src/routes/cases.rs');
  assert.ok(/\.route\(\s*"\/categories"/.test(cases),
    'cases.rs no longer routes /categories — monitoring CATALOG tab (monitoring.js:1270) regresses.');
  assert.ok(/list_categories/.test(cases),
    'cases.rs no longer references list_categories — the /cases/categories handler was over-trimmed.');
});

/* ── AC-10: deleted modules' atomic docs deleted; no dangling Doc breadcrumb ─
   For each DEAD module whose .rs is deleted, its atomic doc under
   docs/internal/code/backend/api/routes/<name>.md must be deleted in the same
   change (touch-policy), and no SURVIVING source file may carry a Doc: line
   pointing at a deleted route module's doc. RED now (docs present). The
   doc-coverage-audit (AC-11) catches stale/orphan docs structurally; this is
   the explicit per-module assertion. */
for (const { mod } of DEAD_ROUTES) {
  test(`AC-10: atomic doc routes/${mod}.md is deleted with its module`, () => {
    // Only assert the doc is gone once the source is gone (same-commit policy);
    // if the source still exists this test rides on AC-8's red. Asserting both
    // gone keeps the touch-policy honest.
    assert.equal(exists(`backend/crates/api/src/routes/${mod}.rs`), false,
      `precondition: routes/${mod}.rs must be deleted (AC-8) for the doc to be deletable.`);
    assert.equal(exists(`docs/internal/code/backend/api/routes/${mod}.md`), false,
      `docs/internal/code/backend/api/routes/${mod}.md still present — atomic-doc touch-policy: delete the doc in the same commit as its source.`);
  });
}

/* ── AC-7 (machinery deletion half): the dead multi-tenant RBAC machinery is
   GONE from rbac.rs ────────────────────────────────────────────────────────
   The neuter (AC-5/AC-6) makes the gates no-ops; the PAYOFF half of AC-7 is
   deleting the now-unreachable resolver + multi-tenant types so they don't
   linger as #[allow(dead_code)]. The CHECKPOINT-1 comment names the deep-delete
   set explicitly: resolve_grant / GRANT_SQL / EDGES_SQL / principals / Contract
   / Role. We assert the DEFINITIONS are gone (definition-shaped patterns so a
   mention in a doc-comment doesn't false-pass/fail), scanning rbac.rs with its
   own #[cfg(test)] modules + block comments stripped (so the tester's own
   neuter_tests references to the gate fns don't count).

   NOT asserted here (left to the compiler under AC-7's "zero new dead_code"):
   Grant (the closure-arg type in require_grant's UNCHANGED signature may need to
   survive) and Action (require_action's UNCHANGED signature keeps it). Their
   depth is the coder's call — the cargo build dead_code gate (AC-7) governs it.
   RED now (the machinery exists), GREEN after the deep-delete. */
test('AC-7: dead multi-tenant RBAC machinery is deleted from rbac.rs (resolve_grant / GRANT_SQL / EDGES_SQL / principals / Contract / load_contract / company_of / evaluate)', () => {
  let src = read('backend/crates/api/src/rbac.rs');
  // Strip block comments /* … */ and line comments // … and the whole
  // #[cfg(test)] tail, so neither doc prose nor the tester's own test module
  // (which references the gate fns) registers as a live definition.
  const cfgTest = src.indexOf('#[cfg(test)]');
  if (cfgTest !== -1) src = src.slice(0, cfgTest);
  src = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

  // Each entry: [human label, definition-shaped regex]. A match = still-present.
  const deadDefs = [
    ['fn resolve_grant',  /\bfn\s+resolve_grant\b/],
    ['const GRANT_SQL',   /\bGRANT_SQL\s*:/],
    ['const EDGES_SQL',   /\bEDGES_SQL\s*:/],
    ['fn principals',     /\bfn\s+principals\b/],
    ['fn load_contract',  /\bfn\s+load_contract\b/],
    ['struct Contract',   /\bstruct\s+Contract\b/],
    ['fn company_of',     /\bfn\s+company_of\b/],
    ['fn evaluate',       /\bfn\s+evaluate\b/],
  ];
  const stillPresent = deadDefs.filter(([, re]) => re.test(src)).map(([label]) => label);
  assert.deepEqual(stillPresent, [],
    'rbac.rs still defines dead multi-tenant RBAC machinery the CP-1 deep-delete should remove ' +
    '(neutered gates make these unreachable; leaving them is the #[allow(dead_code)] anti-pattern AC-7 forbids): ' +
    JSON.stringify(stillPresent));
});
