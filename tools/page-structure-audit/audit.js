#!/usr/bin/env node
/* Purpose: layout-skeleton drift between pages.
 * Doc: docs/internal/code/tools/audit-suite/page-structure-audit.md */
// ─── page-structure-audit ──────────────────────────────────────────
// Surfaces structural drift between pages so "why does this page look
// different" becomes a finding instead of a bug. Em 2026-05-29: "diff the
// order of divs between pages to see some incoherence" + one canonical shell
// for every railed page.
//
// LEAN ADAPTATION (prerelease → lean):
//   Prerelease shipped pages as static partials in frontend/partials/*.html and
//   diffed their literal DOM (section.rp-shell > div.rp-shell-body >
//   main.rp-main > .rp-surface, with aside.rt-nav). The lean cut RETIRED that
//   tree: there are no page partials. A page is now a fragment mount point
//   (frontend/apps/<app>/<page>/<page>.html = `<div class="pg-…" data-pg>`) plus
//   a module (<page>.js) that builds its WHOLE railed shell by calling the one
//   shared composer, page-assembly's assemblePage(root, spec). The shell DOM
//   (div.rp-shell > div.rp-shell-body > header.rp-topbar + aside rail +
//   main.rp-surface) is therefore identical for every page by construction —
//   it lives in ONE file. So the prerelease "does this page's literal chain
//   match the canonical chain" check has exactly one lean analog:
//
//     CANONICAL CONFORMANCE — every authed, built page must assemble its shell
//     via assemblePage(...). A page that hand-rolls a shell (its own .rp-shell /
//     mountSurface / mountTopbar instead of the composer) is the structural-drift
//     finding this tool exists to catch — the lean form of "root isn't rp-shell".
//
//   And the prerelease container-comparison (the element tree inside
//   rt-nav / rp-main / rp-surface, page by page) has its lean analog in the
//   DECLARATIVE SPEC each page hands assemblePage: the page-to-page delta now
//   lives in which structural keys a page passes — rail (+ whether server-driven),
//   sections (+ their keys), actions, meta, head:false (full-bleed). We parse
//   each assemblePage(...) call (Acorn AST — the static-analysis carve-out from
//   no-frameworks, [[feedback-acorn-allowed-for-static-analysis]]) and emit a
//   presence matrix + per-page spec tree, the page-side analog of fe-inventory's
//   component enumeration and the foundation for the per-page docs.
//
//   rt-* is retired (CSS namespace is rp-*); the only rail reference here is the
//   `rail` spec key, not a class. login is exempt (standalone card, no shell) —
//   the lean form of prerelease's EXEMPT login.html.
//
// Findings:
//   • no-shell   — an authed/built page never calls assemblePage (hand-rolled
//                  shell, or an unmounted fragment) → structural drift
//   • orphan     — a page directory on disk with no `built` entry in APPS
//   • missing    — a `built` page in APPS with no <page>.js on disk
//
// Emits shell-structure.json (the spec-delta artifact — regenerable, gitignored).
// Acorn from tools/node_modules. Run: node tools/page-structure-audit/audit.js
// Exits 1 if any finding is raised (CI-gate parity with the other audits).

"use strict";
const fs = require("fs");
const path = require("path");
const acorn = require("acorn");

const REPO = path.resolve(__dirname, "..", "..");
const FE = path.join(REPO, "frontend");
const APPS_DIR = path.join(FE, "apps");
const APPS_JS = path.join(FE, "framework", "boot", "apps.js");

// Pages exempt from the canonical shell — standalone layouts with no rail/shell.
// (Lean form of prerelease's EXEMPT = login.html.)
const EXEMPT = new Set(["auth/login"]);

// The single canonical shell composer every railed page must go through.
const COMPOSER = "assemblePage";

// Structural spec keys we compare across pages (the page-to-page shell delta).
const SPEC_KEYS = ["rail", "sections", "actions", "meta", "head", "title"];

// ── AST helpers ─────────────────────────────────────────────────────
function parse(src) {
  return acorn.parse(src, { ecmaVersion: "latest", sourceType: "module" });
}
function walk(node, visit) {
  if (!node || typeof node !== "object") return;
  visit(node);
  for (const k in node) {
    const v = node[k];
    if (Array.isArray(v)) v.forEach((c) => walk(c, visit));
    else if (v && typeof v.type === "string") walk(v, visit);
  }
}

// Read the APPS registry by parsing boot/apps.js and finding the `built` pages
// declared in the object-array literal (no hardcoded page list — the registry
// is the source of truth, exactly as the router/topbar/launcher read it).
function readBuiltPages() {
  const src = fs.readFileSync(APPS_JS, "utf8");
  const ast = parse(src);
  let appsArr = null;
  walk(ast, (n) => {
    if (
      n.type === "VariableDeclarator" &&
      n.id && n.id.name === "APPS" &&
      n.init && n.init.type === "ArrayExpression"
    ) appsArr = n.init;
  });
  const out = []; // { app, page, built }
  if (!appsArr) return out;
  const prop = (obj, name) =>
    obj.properties.find((p) => p.key && (p.key.name || p.key.value) === name);
  const litVal = (node) =>
    node && node.type === "Literal" ? node.value : undefined;
  for (const appObj of appsArr.elements) {
    if (!appObj || appObj.type !== "ObjectExpression") continue;
    const appId = litVal(prop(appObj, "id") && prop(appObj, "id").value);
    const pagesProp = prop(appObj, "pages");
    if (!appId || !pagesProp || pagesProp.value.type !== "ArrayExpression") continue;
    for (const pgObj of pagesProp.value.elements) {
      if (!pgObj || pgObj.type !== "ObjectExpression") continue;
      const pgId = litVal(prop(pgObj, "id") && prop(pgObj, "id").value);
      const builtNode = prop(pgObj, "built");
      const built = builtNode ? litVal(builtNode.value) === true : false;
      if (pgId) out.push({ app: appId, page: pgId, built });
    }
  }
  return out;
}

// Discover page modules on disk: frontend/apps/<app>/<page>/<page>.js
function discoverPageModules() {
  const out = []; // { app, page, rel, file }
  if (!fs.existsSync(APPS_DIR)) return out;
  for (const app of fs.readdirSync(APPS_DIR, { withFileTypes: true })) {
    if (!app.isDirectory()) continue;
    const appDir = path.join(APPS_DIR, app.name);
    for (const pg of fs.readdirSync(appDir, { withFileTypes: true })) {
      if (!pg.isDirectory()) continue;
      const file = path.join(appDir, pg.name, `${pg.name}.js`);
      if (fs.existsSync(file))
        out.push({
          app: app.name,
          page: pg.name,
          rel: `apps/${app.name}/${pg.name}`,
          file,
        });
    }
  }
  return out;
}

// For a page module, find every assemblePage(root, {SPEC}) call and summarise
// the structural spec. A page may call it more than once (e.g. workspace mounts
// an empty-state shell then a head:false full-bleed loaded view) — we record
// each call as a variant so the head:false delta stays visible.
function analyzePage(file) {
  const src = fs.readFileSync(file, "utf8");
  let ast;
  try {
    ast = parse(src);
  } catch (e) {
    return { parseError: e.message, calls: [], usesComposer: false };
  }
  const calls = [];
  walk(ast, (n) => {
    if (
      n.type === "CallExpression" &&
      n.callee.type === "Identifier" &&
      n.callee.name === COMPOSER
    ) {
      const specArg = n.arguments[1];
      calls.push(summariseSpec(specArg));
    }
  });
  return { parseError: null, calls, usesComposer: calls.length > 0 };
}

// Reduce an assemblePage spec object literal to a comparable shape: which
// structural keys it sets, the section keys, whether the rail is present and
// server-driven (has onRailTab), whether head:false (full-bleed), action count.
function summariseSpec(specArg) {
  const s = {
    keys: [],
    sections: [],
    rail: false,
    railServerDriven: false,
    actions: 0,
    head: true,
    title: null,
    activePageId: null,
  };
  if (!specArg || specArg.type !== "ObjectExpression") return s;
  for (const p of specArg.properties) {
    if (!p.key) continue;
    const name = p.key.name || p.key.value;
    if (SPEC_KEYS.includes(name)) s.keys.push(name);
    if (name === "activePageId" && p.value.type === "Literal")
      s.activePageId = p.value.value;
    if (name === "title" && p.value.type === "Literal") s.title = p.value.value;
    if (name === "head" && p.value.type === "Literal") s.head = p.value.value;
    if (name === "rail") {
      // rail can be `false` (opt out), an object literal, or a call/expr.
      if (p.value.type === "Literal" && p.value.value === false) {
        s.rail = false;
      } else {
        s.rail = true;
        if (p.value.type === "ObjectExpression")
          s.railServerDriven = p.value.properties.some(
            (q) => q.key && (q.key.name || q.key.value) === "onRailTab"
          );
        else s.railServerDriven = true; // built elsewhere (railSpec()) → assume driven
      }
    }
    if (name === "actions" && p.value.type === "ArrayExpression")
      s.actions = p.value.elements.length;
    if (name === "sections" && p.value.type === "ArrayExpression") {
      for (const e of p.value.elements) {
        if (e && e.type === "ObjectExpression") {
          const k = e.properties.find(
            (q) => q.key && (q.key.name || q.key.value) === "key"
          );
          s.sections.push(k && k.value.type === "Literal" ? k.value.value : "?");
        }
      }
    }
  }
  s.keys = [...new Set(s.keys)].sort();
  return s;
}

// ── main ────────────────────────────────────────────────────────────
function main() {
  const built = readBuiltPages(); // [{app,page,built}]
  const builtKey = new Set(built.filter((b) => b.built).map((b) => `${b.app}/${b.page}`));
  const onDisk = discoverPageModules(); // [{app,page,rel,file}]
  const diskKey = new Set(onDisk.map((d) => `${d.app}/${d.page}`));

  const rows = []; // per-page analysis
  for (const d of onDisk) {
    const key = `${d.app}/${d.page}`;
    if (EXEMPT.has(key)) {
      rows.push({ ...d, key, exempt: true });
      continue;
    }
    const a = analyzePage(d.file);
    rows.push({ ...d, key, exempt: false, ...a });
  }

  const findings = []; // [kind, target, msg]
  // no-shell: a built, non-exempt page that never calls the composer.
  for (const r of rows) {
    if (r.exempt) continue;
    if (r.parseError) {
      findings.push(["parse", r.rel, "could not parse " + r.page + ".js — " + r.parseError]);
      continue;
    }
    if (!r.usesComposer)
      findings.push([
        "no-shell",
        r.rel,
        r.page + ".js never calls " + COMPOSER + "() — hand-rolled shell or unmounted fragment (expected the canonical composer)",
      ]);
  }
  // orphan: a page dir on disk not declared `built` in APPS.
  for (const d of onDisk) {
    const key = `${d.app}/${d.page}`;
    if (EXEMPT.has(key)) continue;
    if (!builtKey.has(key))
      findings.push(["orphan", d.rel, "page on disk has no `built` entry in boot/apps.js APPS"]);
  }
  // missing: a `built` page in APPS with no module on disk.
  for (const b of built) {
    if (!b.built) continue;
    const key = `${b.app}/${b.page}`;
    if (EXEMPT.has(key)) continue;
    if (!diskKey.has(key))
      findings.push(["missing", `apps/${b.app}/${b.page}`, "APPS marks this page `built` but apps/" + b.app + "/" + b.page + "/" + b.page + ".js is missing"]);
  }

  // ── console: conformance table ───────────────────────────────────
  console.log("\n  page-structure-audit — canonical shell across pages\n");
  console.log("  canonical: every railed page builds its shell via page-assembly's " + COMPOSER + "()");
  console.log("  shell DOM (one file): div.rp-shell > div.rp-shell-body > header.rp-topbar + rail + main.rp-surface\n");
  const W = 22;
  const pad = (s) => (String(s) + " ".repeat(W)).slice(0, W);
  console.log("  " + pad("page") + pad("composer") + pad("rail") + "sections / head");
  for (const r of rows) {
    if (r.exempt) {
      console.log("  - " + pad(r.rel) + "(exempt — standalone layout)");
      continue;
    }
    const ok = r.usesComposer && !r.parseError;
    const variants = r.calls || [];
    const railTag = variants.some((c) => c.rail)
      ? (variants.some((c) => c.railServerDriven) ? "rail (server)" : "rail")
      : "no rail";
    const secs = variants
      .map((c) => "[" + c.sections.join(",") + "]" + (c.head === false ? " head:false" : ""))
      .join(" + ") || "(none)";
    console.log(
      "  " + (ok ? "+" : "x") + " " + pad(r.rel) + pad(r.usesComposer ? COMPOSER + " x" + variants.length : "—") + pad(railTag) + secs
    );
  }

  // ── console: spec delta across pages ─────────────────────────────
  const pages = rows.filter((r) => !r.exempt && r.usesComposer);
  const names = pages.map((p) => p.rel);
  console.log("\n  ══ shell delta — declarative spec each page hands " + COMPOSER + " ══");

  // presence matrix of structural keys
  const presence = {};
  for (const r of pages) {
    const keys = new Set();
    for (const c of r.calls) for (const k of c.keys) keys.add(k);
    for (const k of keys) (presence[k] || (presence[k] = [])).push(r.rel);
  }
  console.log("\n  ── spec keys (presence across " + names.length + " pages) ──");
  const keyOrder = Object.keys(presence).sort((a, b) => presence[b].length - presence[a].length);
  if (!keyOrder.length) console.log("    (no spec calls parsed)");
  for (const k of keyOrder) {
    const at = presence[k];
    const all = at.length === names.length;
    const tag = all ? "[all]   " : "[" + at.length + "/" + names.length + "] ";
    console.log("    " + tag + k + (all ? "" : "  -> " + at.join(", ")));
  }

  console.log("\n  ── per-page spec tree ──");
  const delta = {};
  for (const r of pages) {
    delta[r.rel] = r.calls;
    r.calls.forEach((c, i) => {
      const label = r.calls.length > 1 ? r.rel + " [variant " + (i + 1) + "]" : r.rel;
      console.log("    " + label + ":");
      console.log("      title:    " + JSON.stringify(c.title));
      console.log("      rail:     " + (c.rail ? (c.railServerDriven ? "server-driven" : "static") : "none"));
      console.log("      sections: [" + c.sections.join(", ") + "]");
      console.log("      actions:  " + c.actions);
      console.log("      head:     " + (c.head === false ? "false (full-bleed)" : "band"));
    });
  }

  // ── console: deviations ──────────────────────────────────────────
  console.log("\n  deviations:");
  if (!findings.length) console.log("    none — every built page assembles its shell via the canonical composer.");
  for (const [kind, target, msg] of findings) console.log("    [" + kind + "] " + target + " — " + msg);

  // ── artifact ─────────────────────────────────────────────────────
  const stamp = new Date().toISOString().slice(0, 10);
  fs.writeFileSync(
    path.join(__dirname, "shell-structure.json"),
    JSON.stringify(
      {
        generatedAt: stamp,
        composer: COMPOSER,
        specKeys: SPEC_KEYS,
        pages: names,
        presence,
        delta,
        findings: findings.map(([kind, target, msg]) => ({ kind, target, msg })),
      },
      null,
      2
    )
  );
  console.log("\n  delta artifact: tools/page-structure-audit/shell-structure.json");

  console.log("\n  " + (findings.length ? "x " + findings.length + " finding(s)" : "+ all pages conform") + "\n");
  process.exit(findings.length ? 1 : 0);
}

main();
