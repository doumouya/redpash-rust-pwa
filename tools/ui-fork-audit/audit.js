#!/usr/bin/env node
/* ui-fork-audit — the MECHANICAL single-source-component guarantee.
   The predecessor's atoms forked because nothing stopped pages from
   overriding framework CSS (137 same-class divergences, #id-scoped
   overrides, byte-identical duplicate rules). Here forking is a CI failure.

   Rules (exit code = violation count):
     R1 every selector in apps css starts with that file's .pg-<app>-<page>
     R2 no .rp- selector outside framework/ css
     R3 no !important anywhere in frontend css
     R4 each .rp-<name> class owned by exactly ONE framework sheet
     R5 no #id selectors (allow #app in styles/base.css — the mount node)
     R6 @import only in styles/main.css; every sheet imported exactly once;
        all framework imports precede the first apps import
     R7 a --rp-* property SET in apps css must be a documented component knob
        (framework css header comment: `knobs: --rp-x --rp-y`)
     R8 no rp- class literals in apps js/html ('--rp-' var reads allowed)
     R9 no style= attrs / .style. writes in apps (framework allowlist:
        virtual-rows.js, menu.js — measured geometry) */

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..");
const FE = path.join(ROOT, "frontend");
const SKIP_DIRS = new Set(["vendor", "wasm", "dist", "node_modules"]);
const violations = [];

function flag(file, line, rule, msg) {
  violations.push({ file: path.relative(ROOT, file), line, rule, msg });
}

function walk(dir, exts, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.isDirectory()) {
      if (!SKIP_DIRS.has(ent.name)) walk(path.join(dir, ent.name), exts, out);
    } else if (exts.some((e) => ent.name.endsWith(e))) {
      out.push(path.join(dir, ent.name));
    }
  }
  return out;
}

/* ── CSS tokenizer: yields {selector, body, line} at any nesting depth ── */
function cssRules(text) {
  const noComments = text.replace(/\/\*[\s\S]*?\*\//g, (m) =>
    m.replace(/[^\n]/g, " ")
  );
  const rules = [];
  let buf = "";
  let depth = 0;
  let line = 1;
  let selLine = 1;
  for (let i = 0; i < noComments.length; i++) {
    const ch = noComments[i];
    if (ch === "\n") line++;
    if (ch === "{") {
      const sel = buf.trim();
      if (sel && !sel.startsWith("@")) rules.push({ selector: sel, line: selLine });
      buf = "";
      depth++;
      selLine = line;
    } else if (ch === "}") {
      buf = "";
      depth = Math.max(0, depth - 1);
      selLine = line;
    } else {
      if (buf === "") selLine = line;
      buf += ch;
    }
  }
  return rules;
}

const cssFiles = walk(FE, [".css"]);
const frameworkCss = cssFiles.filter((f) => f.includes(`${path.sep}framework${path.sep}`));
const appsCss = cssFiles.filter((f) => f.includes(`${path.sep}apps${path.sep}`));

/* knobs declared by framework components (R7 allowlist) */
const knobs = new Set();
for (const f of frameworkCss) {
  const head = fs.readFileSync(f, "utf8").slice(0, 600);
  const m = head.match(/knobs:\s*([^*]*)/);
  if (m) for (const k of m[1].match(/--rp-[\w-]+/g) ?? []) knobs.add(k);
}

/* R4 ownership map */
const classOwner = new Map();

for (const f of cssFiles) {
  const text = fs.readFileSync(f, "utf8");
  const isFramework = frameworkCss.includes(f);
  const isApps = appsCss.includes(f);
  const isBase = f.endsWith(`styles${path.sep}base.css`);

  // R3 — no !important
  text.split("\n").forEach((l, i) => {
    if (l.includes("!important")) flag(f, i + 1, "R3", "!important");
  });

  // R7 — --rp-* assignments in apps sheets must be documented knobs
  if (isApps) {
    text.split("\n").forEach((l, i) => {
      const m = l.match(/(--rp-[\w-]+)\s*:/);
      if (m && !knobs.has(m[1])) {
        flag(f, i + 1, "R7", `sets ${m[1]} (not a documented component knob)`);
      }
    });
  }

  for (const { selector, line } of cssRules(text)) {
    for (const sel of selector.split(",").map((s) => s.trim()).filter(Boolean)) {
      // R5 — #id selectors
      if (/#[a-zA-Z]/.test(sel) && !(isBase && sel === "#app")) {
        flag(f, line, "R5", `#id selector: ${sel}`);
      }
      // R2 — .rp- outside framework
      if (!isFramework && sel.includes(".rp-")) {
        flag(f, line, "R2", `.rp- selector outside framework/: ${sel}`);
      }
      // R1 — apps selectors start with the page root class
      if (isApps) {
        const rel = path.relative(path.join(FE, "apps"), f).split(path.sep);
        const rootClass = `.pg-${rel[0]}-${rel[1]}`;
        if (!sel.startsWith(rootClass)) {
          flag(f, line, "R1", `selector not rooted at ${rootClass}: ${sel}`);
        }
      }
      // R4 — collect framework class ownership
      if (isFramework) {
        for (const cls of sel.match(/\.rp-[\w-]+/g) ?? []) {
          if (!classOwner.has(cls)) classOwner.set(cls, f);
          else if (classOwner.get(cls) !== f) {
            flag(f, line, "R4", `${cls} also styled in ${path.relative(ROOT, classOwner.get(cls))}`);
          }
        }
      }
    }
  }
}

/* R6 — manifest integrity */
const manifest = path.join(FE, "styles", "main.css");
if (fs.existsSync(manifest)) {
  const text = fs.readFileSync(manifest, "utf8");
  const imports = [...text.matchAll(/@import\s+"([^"]+)"/g)].map((m) => m[1]);
  const resolved = imports.map((p) => path.resolve(path.dirname(manifest), p));
  // every css file (except main.css) imported exactly once
  for (const f of cssFiles) {
    if (f === manifest) continue;
    const n = resolved.filter((r) => r === f).length;
    if (n !== 1) flag(f, 0, "R6", `imported ${n}× by main.css (must be exactly 1)`);
  }
  // ordering: framework before apps
  const fwIdx = resolved.map((r, i) => (r.includes(`${path.sep}framework${path.sep}`) ? i : -1)).filter((i) => i >= 0);
  const appIdx = resolved.map((r, i) => (r.includes(`${path.sep}apps${path.sep}`) ? i : -1)).filter((i) => i >= 0);
  if (fwIdx.length && appIdx.length && Math.max(...fwIdx) > Math.min(...appIdx)) {
    flag(manifest, 0, "R6", "a framework import follows an apps import");
  }
  // @import nowhere else
  for (const f of cssFiles) {
    if (f === manifest) continue;
    fs.readFileSync(f, "utf8").split("\n").forEach((l, i) => {
      if (/@import/.test(l)) flag(f, i + 1, "R6", "@import outside styles/main.css");
    });
  }
}

/* R8 + R9 — apps js/html discipline */
const appsCode = walk(path.join(FE, "apps"), [".js", ".html"]);
for (const f of appsCode) {
  const text = fs.readFileSync(f, "utf8");
  text.split("\n").forEach((l, i) => {
    // R8: any rp- token not part of --rp- (var reads) is a framework-class leak
    const stripped = l.replaceAll("--rp-", "").replaceAll("data-rp-theme", "");
    if (/(^|[^\w-])rp-/.test(stripped)) {
      flag(f, i + 1, "R8", "rp- class literal in apps code");
    }
    // R9: inline styles
    if (f.endsWith(".html") && /style\s*=/.test(l)) flag(f, i + 1, "R9", "inline style attribute");
    if (f.endsWith(".js") && /\.style\./.test(l)) flag(f, i + 1, "R9", ".style. write");
  });
}

/* ── report ── */
if (violations.length) {
  console.error(`ui-fork-audit: ${violations.length} violation(s)\n`);
  for (const v of violations) {
    console.error(`  [${v.rule}] ${v.file}:${v.line} — ${v.msg}`);
  }
} else {
  console.log("ui-fork-audit: OK — no forks, no overrides, one owner per class");
}
process.exit(violations.length);
