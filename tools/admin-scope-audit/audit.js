#!/usr/bin/env node
/* Purpose: fail when a USER-facing surface (a page in an app NOT marked admin:true,
 * or any module it transitively imports) calls an /admin/* endpoint — an RBAC
 * admin-scope leak.
 * Doc: docs/internal/code/tools/audit-suite/admin-scope-audit.md */
/* ──────────────────────────────────────────────────────────────────────────
   RedPash admin-scope-audit — user-surface /admin/* leak gate.

   The bug class (Lane 1, 2026-06-08): user-facing pages were reading
   platform-admin endpoints (`/admin/users`, `/admin/charts`, …). Those are
   gated by the platform-admin middleware and return ALL rows — so a non-admin
   user gets 403/empty, and an admin sees the whole platform where they should
   see only their own RBAC reach. The fix is to read user-scoped, reach-filtered
   endpoints; `/admin/*` belongs to the Admin app ONLY (org / console / registry /
   cases — the pages under the app flagged `admin: true` in the apps registry).

   This gate makes the rule structural so it can't regress:

     1. Parse the apps registry → which app each page belongs to and whether that
        app is `admin: true`. A page → its entry-script by the lean convention
        /apps/<app.id>/<page.id>/<page.id>.js (the router's own resolution).
     2. Build the import graph from every entry → which modules each page can load.
        A module is "user-reachable" if ANY non-admin page can reach it (so a
        shared framework module like framework/object-list/object-list.js counts
        as a user surface the moment a user page imports it).
     3. Scan every .js under frontend/ (framework + apps, recursively) for
        `/admin/...` in STRING / TEMPLATE literals (AST-precise — comments /
        identifiers can't trip it).
     4. A `/admin/*` literal in a user-reachable module = a leak (exit 1), unless
        consciously allowlisted below with a reason.

   Same shape as list-endpoint-rbac-audit (the backend side): build the detector
   for the bug class so one finding becomes N. [[build-for-unknown-failures]] /
   [[feedback-acorn-allowed-for-static-analysis]] (Acorn is the tools/ carve-out).

   LEAN ADAPTATION (vs the prerelease ancestor): the page registry moved from a
   `ROUTES` table in scripts/main.js (per-page `{script, admin}`) to the `APPS`
   array in frontend/framework/boot/apps.js, where the admin flag lives on the
   APP and a page resolves to /apps/<app>/<page>/<page>.js by convention. Imports
   are relative (no `/scripts/` app-absolute prefix), so module resolution drops
   that prefix and resolves `/apps/…` + `./` + `../` against frontend/. The scan
   root is frontend/ (framework + apps); there is no frontend/scripts/ in lean.
   The ALLOW{} list is reset to empty — the prerelease entries referenced pages
   (home.js, the chart banks) that the lean cut removed; lean has no leaks today.
   ────────────────────────────────────────────────────────────────────────── */
'use strict';
const fs = require('fs');
const path = require('path');
const acorn = require('acorn');

const ROOT = process.cwd();
const FE = path.join(ROOT, 'frontend');
const APPS_FILE = path.join(FE, 'framework', 'boot', 'apps.js');

// ── allowlist: /admin/* usages on user surfaces we've CONSCIOUSLY accepted ──
// Key "<rel-from-frontend>::<admin-path>" → reason. Empty = strict. An entry
// here documents an intentional exception (e.g. config metadata, not user data)
// so the gate stays green without hiding the decision.
//
// Reset to empty for lean: the prerelease entries (scripts/pages/home.js, the
// chart banks, the memberships-edge deferral) all referenced surfaces the lean
// cut removed. Lean has no user-surface /admin/* leaks today — the only /admin/*
// literal lives in the admin app (apps/admin/console/console.js), which is an
// admin surface, not a leak. Add an entry here ONLY for a conscious exception.
const ALLOW = {
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

// ── module resolution (mirror the browser's relative + /apps/* imports) ──────
// Lean imports are relative (./, ../) or app-absolute (/apps/…, /wasm/…). There
// is no /scripts/ prefix (that was the prerelease layout). App-absolute specs
// resolve against frontend/.
function resolveSpec(spec, fromFile) {
  if (!spec) return null;
  let p;
  if (spec.startsWith('/')) p = path.join(FE, spec);                   // app-absolute (/apps/…, /wasm/…)
  else if (spec.startsWith('./') || spec.startsWith('../')) p = path.resolve(path.dirname(fromFile), spec);
  else return null;                                                    // bare/external — skip
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

// ── 1. APPS registry → page entries with the app's admin flag ────────────────
// frontend/framework/boot/apps.js exports `APPS = [{ id, admin?, pages: [{ id,
// built }] }]`. A page resolves to /apps/<app.id>/<page.id>/<page.id>.js (the
// router convention). The admin flag is per-APP; every page in an admin app is
// an admin surface. Unbuilt pages have no entry file — skip them.
function loadEntries() {
  const entries = [];
  walkAst(parse(APPS_FILE), (n) => {
    if (n.type === 'VariableDeclaration') {
      for (const d of n.declarations) {
        if (!(d.id && d.id.name === 'APPS' && d.init && d.init.type === 'ArrayExpression')) continue;
        for (const appNode of d.init.elements) {
          if (!appNode || appNode.type !== 'ObjectExpression') continue;
          let appId = null, admin = false, pagesNode = null;
          for (const p of appNode.properties) {
            const k = p.key && (p.key.name || p.key.value);
            if (k === 'id' && p.value.type === 'Literal') appId = p.value.value;
            if (k === 'admin' && p.value.type === 'Literal') admin = p.value.value === true;
            if (k === 'pages' && p.value.type === 'ArrayExpression') pagesNode = p.value;
          }
          if (!appId || !pagesNode) continue;
          for (const pg of pagesNode.elements) {
            if (!pg || pg.type !== 'ObjectExpression') continue;
            let pageId = null, built = false;
            for (const pp of pg.properties) {
              const k = pp.key && (pp.key.name || pp.key.value);
              if (k === 'id' && pp.value.type === 'Literal') pageId = pp.value.value;
              if (k === 'built' && pp.value.type === 'Literal') built = pp.value.value === true;
            }
            if (!pageId || !built) continue;
            const file = path.join(FE, 'apps', appId, pageId, pageId + '.js');
            entries.push({ route: '#/' + pageId, app: appId, file, admin });
          }
        }
      }
    }
  });
  return entries;
}

// ── 2. classify every module: which user routes reach it ────────────────────
const entries = loadEntries();
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

walk(FE, '.js', []).forEach(recordHits);

// ── 4. report ───────────────────────────────────────────────────────────────
findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
okAdmin.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
unreachable.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);

console.log('RedPash admin-scope-audit');
console.log('  entries: ' + entries.length + ' page(s) ('
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
console.log('  endpoint; /admin/* is for the Admin app only (org/console/registry/cases):');
console.log('');
for (const f of findings) {
  console.log('      ' + f.file + ':' + f.line + '   ' + f.ep + '   ← reached by: ' + f.reachedBy.join(', '));
}
console.log('');
console.log('  fix: use the user-scoped endpoint (e.g. /admin/charts → /charts) or allowlist with a');
console.log('  reason in ALLOW{} if it is genuinely non-user-data config. (Lane 1 — admin-scope sweep.)');
process.exit(1);
