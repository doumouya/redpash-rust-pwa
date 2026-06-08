#!/usr/bin/env node
/* Purpose: fail when a USER-facing surface (a page not marked admin:true, or any module it transitively imports) calls an /admin/* endpoint — an RBAC admin-scope leak.
 * Doc: docs/internal/code/tools/audit-suite/admin-scope-audit.md */
/* ──────────────────────────────────────────────────────────────────────────
   RedPash admin-scope-audit — user-surface /admin/* leak gate.

   The bug class (Lane 1, 2026-06-08): user-facing pages were reading
   platform-admin endpoints (`/admin/users`, `/admin/charts`, …). Those are
   gated by `require_platform_admin_mw` and return ALL rows — so a non-admin
   user gets 403/empty, and an admin sees the whole platform where they should
   see only their own RBAC reach. The fix is to read user-scoped, reach-filtered
   endpoints; `/admin/*` belongs to the Admin app ONLY (monitoring / admin-console
   / database — the routes flagged `admin: true` in main.js).

   This gate makes the rule structural so it can't regress:

     1. Parse main.js ROUTES → which page entry-scripts are `admin: true`.
     2. Build the import graph from every entry → which modules each page can load.
        A module is "user-reachable" if ANY non-admin page can reach it (so a
        shared module like framework/editor-entity-picker.js counts as a user
        surface the moment a user page imports it).
     3. Scan every .js under frontend/scripts (recursively) for `/admin/...` in
        STRING / TEMPLATE literals (AST-precise — comments/identifiers can't trip it).
     4. A `/admin/*` literal in a user-reachable module = a leak (exit 1), unless
        consciously allowlisted below with a reason.

   Same shape as list-endpoint-rbac-audit (the backend side): build the detector
   for the bug class so one finding becomes N. [[build-for-unknown-failures]] /
   [[feedback-acorn-allowed-for-static-analysis]] (Acorn is the tools/ carve-out).
   ────────────────────────────────────────────────────────────────────────── */
'use strict';
const fs = require('fs');
const path = require('path');
const acorn = require('acorn');

const ROOT = process.cwd();
const FE = path.join(ROOT, 'frontend');
const SCRIPTS = path.join(FE, 'scripts');

// ── allowlist: /admin/* usages on user surfaces we've CONSCIOUSLY accepted ──
// Key "<rel-from-frontend>::<admin-path>" → reason. Empty = strict. An entry
// here documents an intentional exception (e.g. config metadata, not user data)
// so the gate stays green without hiding the decision.
const ALLOW = {
  // 'scripts/framework/type-registry.js::/admin/types': 'field-shape config metadata, not per-user data',
};

// ── fs walk ─────────────────────────────────────────────────────────────────
function walk(dir, ext, out) {
  if (!fs.existsSync(dir)) return out;
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) walk(p, ext, out);
    else if (d.name.endsWith(ext)) out.push(p);
  }
  return out;
}

function parse(file) {
  const text = fs.readFileSync(file, 'utf8');
  return acorn.parse(text, { ecmaVersion: 2024, sourceType: 'module', locations: true });
}

// Minimal recursive AST walker (acorn-walk isn't vendored). Calls visit(node)
// for every node carrying a .type.
function walkAst(node, visit) {
  if (!node || typeof node.type !== 'string') return;
  visit(node);
  for (const key of Object.keys(node)) {
    if (key === 'loc' || key === 'start' || key === 'end') continue;
    const v = node[key];
    if (Array.isArray(v)) v.forEach((c) => c && typeof c.type === 'string' && walkAst(c, visit));
    else if (v && typeof v.type === 'string') walkAst(v, visit);
  }
}

// ── module resolution (mirror the browser's /scripts/* + relative imports) ──
function resolveSpec(spec, fromFile) {
  if (!spec) return null;
  let p;
  if (spec.startsWith('/scripts/')) p = path.join(FE, spec);            // app-absolute
  else if (spec.startsWith('./') || spec.startsWith('../')) p = path.resolve(path.dirname(fromFile), spec);
  else return null;                                                     // bare/external — skip
  if (!path.extname(p)) p += '.js';
  return p;
}

// imports (static + dynamic + re-export) of one module → resolved file paths
const importCache = new Map();
function importsOf(file) {
  if (importCache.has(file)) return importCache.get(file);
  const out = new Set();
  try {
    walkAst(parse(file), (n) => {
      if ((n.type === 'ImportDeclaration' || n.type === 'ExportNamedDeclaration' || n.type === 'ExportAllDeclaration') && n.source) {
        const r = resolveSpec(n.source.value, file);
        if (r) out.add(r);
      } else if (n.type === 'ImportExpression' && n.source && n.source.type === 'Literal') {
        const r = resolveSpec(n.source.value, file);
        if (r) out.add(r);
      } else if (n.type === 'CallExpression' && n.callee && n.callee.type === 'Import'
                 && n.arguments[0] && n.arguments[0].type === 'Literal') {
        const r = resolveSpec(n.arguments[0].value, file);
        if (r) out.add(r);
      }
    });
  } catch (_) { /* parse failure reported separately by js-audit */ }
  importCache.set(file, out);
  return out;
}

// transitive reachable set from an entry file
function reachable(entry) {
  const seen = new Set();
  const stack = [entry];
  while (stack.length) {
    const f = stack.pop();
    if (seen.has(f) || !fs.existsSync(f)) continue;
    seen.add(f);
    for (const dep of importsOf(f)) stack.push(dep);
  }
  return seen;
}

// ── 1. ROUTES from main.js → entries with admin flag ────────────────────────
function loadRoutes() {
  const mainFile = path.join(SCRIPTS, 'main.js');
  const entries = [];
  walkAst(parse(mainFile), (n) => {
    if (n.type === 'VariableDeclaration') {
      for (const d of n.declarations) {
        if (d.id && d.id.name === 'ROUTES' && d.init && d.init.type === 'ObjectExpression') {
          for (const prop of d.init.properties) {
            const routeKey = prop.key && (prop.key.value || prop.key.name);
            if (!prop.value || prop.value.type !== 'ObjectExpression') continue;
            let script = null, admin = false;
            for (const p2 of prop.value.properties) {
              const k = p2.key && (p2.key.name || p2.key.value);
              if (k === 'script' && p2.value.type === 'Literal') script = p2.value.value;
              if (k === 'admin' && p2.value.type === 'Literal') admin = p2.value.value === true;
            }
            if (script) entries.push({ route: routeKey, file: resolveSpec(script, mainFile), admin });
          }
        }
      }
    }
  });
  return entries;
}

// ── 2. classify every module: which user routes reach it ────────────────────
const entries = loadRoutes();
const userReaches = new Map();   // module file → Set(user route keys)
const adminReachable = new Set();
for (const e of entries) {
  if (!e.file) continue;
  const set = reachable(e.file);
  for (const m of set) {
    if (e.admin) adminReachable.add(m);
    else {
      if (!userReaches.has(m)) userReaches.set(m, new Set());
      userReaches.get(m).add(e.route);
    }
  }
}

// ── 3. scan every module for /admin/* in string + template literals ─────────
const ADMIN_RE = /\/admin\/[A-Za-z0-9_\-/]*/g;
function relFE(file) { return path.relative(FE, file).split(path.sep).join('/'); }

const findings = [];      // user-surface leaks (gate)
const okAdmin = [];       // admin-only surfaces (informational)
const unreachable = [];   // not reached by any route (dead/util) — informational

function recordHits(file) {
  let ast;
  try { ast = parse(file); } catch (_) { return; }
  const hits = [];
  walkAst(ast, (n) => {
    let str = null, line = null;
    if (n.type === 'Literal' && typeof n.value === 'string') { str = n.value; line = n.loc.start.line; }
    else if (n.type === 'TemplateLiteral') {
      for (const q of n.quasis) {
        const raw = q.value.cooked != null ? q.value.cooked : q.value.raw;
        if (raw && raw.indexOf('/admin/') !== -1) {
          let m; ADMIN_RE.lastIndex = 0;
          while ((m = ADMIN_RE.exec(raw)) !== null) hits.push({ ep: m[0], line: q.loc.start.line });
        }
      }
      return;
    }
    if (str && str.indexOf('/admin/') !== -1) {
      let m; ADMIN_RE.lastIndex = 0;
      while ((m = ADMIN_RE.exec(str)) !== null) hits.push({ ep: m[0], line });
    }
  });
  if (!hits.length) return;

  const rel = relFE(file);
  const isUser = userReaches.has(file);
  const isAdmin = adminReachable.has(file);
  // de-dup identical (endpoint,line)
  const seen = new Set();
  for (const h of hits) {
    const key = h.ep + '@' + h.line;
    if (seen.has(key)) continue;
    seen.add(key);
    const rec = { file: rel, line: h.line, ep: h.ep };
    if (isUser) {
      const allowKey = rel + '::' + h.ep;
      if (ALLOW[allowKey]) { okAdmin.push({ ...rec, allowed: ALLOW[allowKey] }); }
      else { rec.reachedBy = [...userReaches.get(file)].sort(); findings.push(rec); }
    } else if (isAdmin) okAdmin.push(rec);
    else unreachable.push(rec);
  }
}

walk(SCRIPTS, '.js', []).forEach(recordHits);

// ── 4. report ───────────────────────────────────────────────────────────────
findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
okAdmin.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
unreachable.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);

console.log('RedPash admin-scope-audit');
console.log('  entries: ' + entries.length + ' routes ('
  + entries.filter((e) => e.admin).map((e) => e.route).join(', ') + ' = admin) · '
  + 'user-reachable modules: ' + userReaches.size);
console.log('');

if (okAdmin.length) {
  console.log('  ok (admin-app surface or allowlisted) — ' + okAdmin.length + ':');
  for (const f of okAdmin) console.log('      ' + f.file + ':' + f.line + '  ' + f.ep + (f.allowed ? '   [allow: ' + f.allowed + ']' : ''));
  console.log('');
}
if (unreachable.length) {
  console.log('  info (not reached by any route — dead/util) — ' + unreachable.length + ':');
  for (const f of unreachable) console.log('      ' + f.file + ':' + f.line + '  ' + f.ep);
  console.log('');
}

// audit.json worklist (machine-readable; not ingested — no schema row needed)
const outDir = path.join(ROOT, 'tools', 'admin-scope-audit');
try {
  fs.writeFileSync(path.join(outDir, 'audit.json'),
    JSON.stringify({ findings, okAdmin, unreachable, entries: entries.map((e) => ({ route: e.route, admin: e.admin })) }, null, 2));
} catch (_) { /* best-effort */ }

if (!findings.length) {
  console.log('  OK — no user-surface /admin/* leaks.');
  process.exit(0);
}
console.log('  FAIL — ' + findings.length + ' user-surface /admin/* leak(s). A user page (or a module it');
console.log('  imports) calls an admin-only endpoint. Repoint to the user-scoped, RBAC-reach');
console.log('  endpoint; /admin/* is for the Admin app only (monitoring/admin-console/database):');
console.log('');
for (const f of findings) {
  console.log('      ' + f.file + ':' + f.line + '   ' + f.ep + '   ← reached by: ' + f.reachedBy.join(', '));
}
console.log('');
console.log('  fix: use the user-scoped endpoint (e.g. /admin/charts → /charts) or allowlist with a');
console.log('  reason in ALLOW{} if it is genuinely non-user-data config. (Lane 1 — admin-scope sweep.)');
process.exit(1);
