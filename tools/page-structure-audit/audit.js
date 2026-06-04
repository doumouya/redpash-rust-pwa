#!/usr/bin/env node
/* Purpose: layout-skeleton drift between page partials.
 * Doc: docs/internal/code/tools/audit-suite/page-structure-audit.md */
// ─── page-structure-audit ──────────────────────────────────────────
// Diffs the layout skeleton of every page partial so structural drift
// between pages surfaces as a finding instead of a "why does this page
// look different" bug. Em 2026-05-29: "diff the order of divs between
// pages to see some incoherence" + "rp-surface should be the default
// next div after rp-main on all pages".
//
// It parses frontend/partials/*.html, builds a shallow element tree of
// the layout containers, and checks each shell page's chain against the
// canonical skeleton:
//
//   section.rp-shell  >  header#rp-topbar
//                     >  div.rp-shell-body  >  aside.rt-nav
//                                           >  main.rp-main  >  .rp-surface (first child)
//
// Findings (one per deviation):
//   • root      — page root isn't section.rp-shell
//   • body      — body wrapper isn't div.rp-shell-body
//   • main      — page main isn't main.rp-main
//   • surface   — main's first element child isn't .rp-surface
//
// PLUS a container-comparison report: for rt-nav / rp-main / rp-surface it
// enumerates the element tree inside each container and compares it page-by-
// page (a presence matrix + per-page tree), so the structural DELTA between
// pages is explicit — the page-side analog of fe-inventory's component
// enumeration, and the foundation for the dedup pass + the per-page docs.
// Emits shell-structure.json (the delta artifact — regenerable, gitignored).
//
// No deps. Run: node tools/page-structure-audit/audit.js
// Exits 1 if any chain deviation is found (CI-gate parity with the other audits).

"use strict";
const fs   = require("fs");
const path = require("path");

const PARTIALS_DIR = path.resolve(__dirname, "../../frontend/partials");

// Pages exempt from the shell chain — standalone layouts with no rail.
const EXEMPT = new Set(["login.html"]);

// Layout containers we track; inline/leaf tags are ignored so the tree
// stays at the skeleton level.
const STRUCTURAL = new Set(["section", "div", "main", "aside", "header", "nav", "form"]);
// Void elements never open a scope.
const VOID = new Set(["area","base","br","col","embed","hr","img","input","link","meta","param","source","track","wbr"]);

// ── tiny HTML skeleton parser ───────────────────────────────────────
// Strips comments, walks tags with a stack, records a tree of the
// structural elements only (tag + id + classes + children).
function parseSkeleton(html) {
  const src = html.replace(/<!--[\s\S]*?-->/g, "");
  const tagRe = /<(\/?)([a-zA-Z][\w-]*)((?:"[^"]*"|'[^']*'|[^>])*?)(\/?)>/g;
  const root = { tag: "#root", id: null, classes: [], children: [] };
  const stack = [root];
  let m;
  while ((m = tagRe.exec(src)) !== null) {
    const closing = m[1] === "/";
    const tag = m[2].toLowerCase();
    const attrs = m[3] || "";
    const selfClose = m[4] === "/";
    if (!STRUCTURAL.has(tag)) continue;
    if (closing) {
      // Pop to the nearest matching open tag (tolerate stray closes).
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i].tag === tag) { stack.length = i; break; }
      }
      continue;
    }
    const idM = attrs.match(/\bid\s*=\s*"([^"]*)"/);
    const clsM = attrs.match(/\bclass\s*=\s*"([^"]*)"/);
    const node = {
      tag,
      id: idM ? idM[1] : null,
      classes: clsM ? clsM[1].trim().split(/\s+/).filter(Boolean) : [],
      children: [],
    };
    stack[stack.length - 1].children.push(node);
    if (!selfClose && !VOID.has(tag)) stack.push(node);
  }
  return root;
}

const sel = (n) => n ? n.tag
  + (n.id ? "#" + n.id : "")
  + (n.classes.length ? "." + n.classes.join(".") : "") : "(none)";
const has = (n, c) => !!n && n.classes.includes(c);

// Locate the chain nodes. `main` = the first <main> anywhere; `body` =
// its parent; `root` = the top structural child; `surface` = main's
// first element child.
function findMain(node, parent) {
  if (node.tag === "main") return { main: node, body: parent };
  for (const c of node.children) {
    const r = findMain(c, node);
    if (r) return r;
  }
  return null;
}

function auditPartial(file) {
  const html = fs.readFileSync(path.join(PARTIALS_DIR, file), "utf8");
  const tree = parseSkeleton(html);
  const root = tree.children[0] || null;          // top <section>
  const mainHit = findMain(tree, null);
  const main = mainHit ? mainHit.main : null;
  const body = mainHit ? mainHit.body : null;
  const surface = main && main.children[0] ? main.children[0] : null;

  const findings = [];
  if (!has(root, "rp-shell"))
    findings.push(["root", "root is " + sel(root) + ", expected section.rp-shell"]);
  if (!has(body, "rp-shell-body"))
    findings.push(["body", "body wrapper is " + sel(body) + ", expected div.rp-shell-body"]);
  if (!main || main.tag !== "main" || !has(main, "rp-main"))
    findings.push(["main", "main is " + sel(main) + ", expected main.rp-main"]);
  if (!has(surface, "rp-surface"))
    findings.push(["surface", "main's first child is " + sel(surface) + ", expected .rp-surface"]);

  return {
    chain: { root: sel(root), body: sel(body), main: sel(main), surface: sel(surface) },
    findings,
    tree,
  };
}

// ── container comparison — the page-by-page shell delta ─────────────
// Beyond the 4-node chain check, enumerate the element tree INSIDE each
// shell container (rt-nav / rp-main / rp-surface) and compare it across
// pages, so structural delta (what each page adds/omits/varies) is
// explicit. This is the page-side analog of fe-inventory's component
// enumeration — the foundation for the dedup pass + the per-page docs.
const CONTAINERS = ["rt-nav", "rp-main", "rp-surface"];
const TREE_DEPTH = 2;   // container > child > grandchild

function findByClass(node, cls) {
  if (!node) return null;
  if (has(node, cls)) return node;
  for (const c of node.children) { const r = findByClass(c, cls); if (r) return r; }
  return null;
}
// role key: tag + classes, id-independent (ids are page-specific, e.g. #rpHomeView)
function childKey(n) { return n.tag + (n.classes.length ? "." + n.classes.join(".") : ""); }
function subtree(node, maxDepth, depth) {
  depth = depth || 0;
  return { sel: sel(node), key: childKey(node),
           children: depth < maxDepth ? node.children.map((c) => subtree(c, maxDepth, depth + 1)) : [] };
}
function compareContainers(pages) {   // pages: { file: tree }
  const out = {};
  for (const cls of CONTAINERS) {
    const perPage = {}, trees = {}, presence = {};
    for (const [file, tree] of Object.entries(pages)) {
      const node = findByClass(tree, cls);
      if (!node) { perPage[file] = null; continue; }     // container absent on this page
      trees[file] = subtree(node, TREE_DEPTH);
      const kids = node.children.map(childKey);
      perPage[file] = kids;
      // presence counts DISTINCT pages (a key repeated within a page counts once)
      kids.forEach((k) => { const a = presence[k] || (presence[k] = []); if (a.indexOf(file) < 0) a.push(file); });
    }
    out[cls] = { perPage, presence, trees };
  }
  return out;
}

function main() {
  const files = fs.readdirSync(PARTIALS_DIR).filter((f) => f.endsWith(".html")).sort();
  const rows = [];
  let total = 0;
  for (const f of files) {
    if (EXEMPT.has(f)) { rows.push({ file: f, exempt: true }); continue; }
    const r = auditPartial(f);
    total += r.findings.length;
    rows.push({ file: f, ...r });
  }

  console.log("\n  page-structure-audit — layout skeleton across page partials\n");
  console.log("  canonical: section.rp-shell > div.rp-shell-body > main.rp-main > .rp-surface\n");
  const W = 17;
  const pad = (s) => (s + " ".repeat(W)).slice(0, W);
  console.log("  " + pad("page") + pad("body") + pad("main") + "surface");
  for (const r of rows) {
    if (r.exempt) { console.log("  " + pad(r.file) + "(exempt — standalone layout)"); continue; }
    const mark = r.findings.length ? "✗" : "✓";
    console.log("  " + mark + " " + pad(r.file)
      + pad(r.chain.body.replace(/^div\./, "."))
      + pad(r.chain.main.replace(/^main\./, "").replace(/^main$/, "main(no class)"))
      + r.chain.surface.replace(/^div\./, ".").replace(/#[^.]*/, ""));
  }

  console.log("\n  deviations:");
  let any = false;
  for (const r of rows) {
    if (r.exempt || !r.findings.length) continue;
    any = true;
    console.log("    " + r.file);
    for (const [kind, msg] of r.findings) console.log("      [" + kind + "] " + msg);
  }
  if (!any) console.log("    none — every page conforms to the canonical chain.");

  // ── container comparison (the shell delta between pages) ──────────
  const pages = {};
  for (const r of rows) if (!r.exempt) pages[r.file] = r.tree;
  const names = Object.keys(pages).map((f) => f.replace(/\.html$/, ""));
  const cmp = compareContainers(pages);

  console.log("\n  ══ shell delta — element trees inside rt-nav / rp-main / rp-surface ══");
  for (const cls of CONTAINERS) {
    const { presence, trees } = cmp[cls];
    console.log("\n  ── ." + cls + " — direct children (presence across " + names.length + " pages) ──");
    const keys = Object.keys(presence).sort((a, b) => presence[b].length - presence[a].length);
    if (!keys.length) console.log("    (no structural children parsed)");
    for (const k of keys) {
      const at = presence[k].map((f) => f.replace(/\.html$/, ""));
      const all = at.length === names.length;
      const tag = all ? "[all]   " : "[" + at.length + "/" + names.length + "] ";
      console.log("    " + tag + k + (all ? "" : "  → " + at.join(", ")));
    }
    console.log("    per-page tree:");
    for (const [file, t] of Object.entries(trees)) {
      const line = (n, d) => "      " + "  ".repeat(d) + (d ? "" : file.replace(/\.html$/, "") + ": ") + n.sel;
      const walk = (n, d) => { console.log(line(n, d)); n.children.forEach((c) => walk(c, d + 1)); };
      walk(t, 0);
    }
  }

  const stamp = new Date().toISOString().slice(0, 10);
  fs.writeFileSync(path.join(__dirname, "shell-structure.json"),
    JSON.stringify({ generatedAt: stamp, containers: CONTAINERS, pages: names, delta: cmp }, null, 2));
  console.log("\n  delta artifact: tools/page-structure-audit/shell-structure.json");

  console.log("\n  " + (total ? "✗ " + total + " deviation(s)" : "✓ all pages conform") + "\n");
  process.exit(total ? 1 : 0);
}

main();
