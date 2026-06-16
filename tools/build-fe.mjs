#!/usr/bin/env node
/* build-fe — the hashed release build of the frontend (S8).
   frontend/ → frontend-dist/, where:

   - every .js is renamed name.<sha1-12>.js and an IMPORT MAP in index.html
     remaps original→hashed (import maps match on RESOLVED URLs, so relative
     imports and dynamic import() both land on the hashed file);
   - the whole CSS manifest (styles/main.css @import tree) is FLATTENED into
     one styles/main.<hash>.css — manifest order IS cascade order, so the
     bundle is byte-faithful to the dev cascade (no url() rewriting needed:
     the audit'd house style has none);
   - index.html and the .html partials stay UNHASHED + no-cache (they are the
     entry points that name the hashes); service-worker.js stays unhashed
     (a SW must keep a stable URL) and still caches only the hashed wasm.

   The hash IS the cache version: hashed assets are served immutable, a
   rebuild yields new URLs, nothing can go stale, nobody hand-bumps anything.

   SELF-CHECK before writing index.html: every static/dynamic import literal
   in every shipped module must resolve to a mapped (or shipped) URL — a typo
   that would 404 at runtime fails the BUILD instead. */

import { createHash } from "node:crypto";
import {
  cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync,
  rmSync, statSync, unlinkSync, writeFileSync,
} from "node:fs";
import { dirname, join, posix, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(root, "frontend");
const OUT = join(root, "frontend-dist");

/* dev-only artifacts that must not ship */
const EXCLUDE = new Set(["framework-sandbox.html", "tests", "package.json"]);

const hash = (buf) => createHash("sha1").update(buf).digest("hex").slice(0, 12);
const toUrl = (abs) => "/" + posix.join(...relative(OUT, abs).split(/[\\/]/));

/* ── 1. copy the tree ─────────────────────────────────────────────────── */
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT);
for (const entry of readdirSync(SRC)) {
  if (EXCLUDE.has(entry)) continue;
  cpSync(join(SRC, entry), join(OUT, entry), { recursive: true });
}
/* TypeScript declaration files (wasm-bindgen emits them) are dev tooling */
const walk = (dir, out = []) => {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
};
for (const f of walk(OUT)) if (f.endsWith(".d.ts")) unlinkSync(f);

/* ── 2. flatten the CSS manifest into one hashed bundle ───────────────── */
const mainCss = join(OUT, "styles", "main.css");
let bundle = "";
for (const line of readFileSync(mainCss, "utf8").split("\n")) {
  const m = line.match(/^@import\s+"(.+)";/);
  if (!m) continue; // comments/blank — the manifest is @imports only
  const sheet = join(OUT, "styles", ...m[1].split("/"));
  bundle += `/* ── ${m[1]} ── */\n` + readFileSync(sheet, "utf8") + "\n";
  unlinkSync(sheet); // bundled sheets don't ship twice
}
unlinkSync(mainCss);
const cssName = `main.${hash(bundle)}.css`;
writeFileSync(join(OUT, "styles", cssName), bundle);
/* prune emptied component/page dirs (cosmetic; ServeDir ignores empties) */

/* ── 3. hash every module; build the import map ───────────────────────── */
const importMap = {}; // "/orig.js" → "/orig.<hash>.js"
/* STABLE-url modules are NOT hashed: their url isn't a module specifier, so the
   import map can't remap it. The service worker must keep a fixed url; the engine
   worker is launched by `new Worker(url)` (also outside the map, and workers don't
   inherit the page's map — they get the resolved wasm url handed in at init). */
const STABLE = new Set(["/service-worker.js", "/framework/engine/engine-worker.js"]);
const jsFiles = walk(OUT).filter((f) => f.endsWith(".js") && !STABLE.has(toUrl(f)));
for (const f of jsFiles) {
  const h = hash(readFileSync(f));
  const hashed = f.replace(/\.js$/, `.${h}.js`);
  renameSync(f, hashed);
  importMap[toUrl(f)] = toUrl(hashed);
}

/* ── 4. self-check the module graph ───────────────────────────────────── */
const IMPORT_RE = /(?:^|\s)import\s*(?:[^"'()]*?from\s*)?["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;
const problems = [];
for (const [orig, hashed] of Object.entries(importMap)) {
  const code = readFileSync(join(OUT, ...hashed.slice(1).split("/")), "utf8");
  for (const m of code.matchAll(IMPORT_RE)) {
    const spec = m[1] ?? m[2];
    if (!spec || (!spec.startsWith(".") && !spec.startsWith("/"))) continue;
    const resolved = posix.normalize(
      spec.startsWith("/") ? spec : posix.join(posix.dirname(orig), spec)
    );
    if (resolved.endsWith(".js") && !importMap[resolved]) {
      problems.push(`${orig} imports ${spec} → ${resolved}: not in the map`);
    }
  }
}
if (problems.length) {
  console.error("build-fe: BROKEN MODULE GRAPH");
  for (const p of problems) console.error("  " + p);
  process.exit(1);
}

/* ── 5. index.html: import map + hashed entry points ──────────────────── */
const indexPath = join(OUT, "index.html");
let html = readFileSync(indexPath, "utf8");
html = html.replace('href="/styles/main.css"', `href="/styles/${cssName}"`);
html = html.replace(
  'src="/framework/boot/main.js"',
  `src="${importMap["/framework/boot/main.js"]}"`
);
html = html.replace(
  "</head>",
  `  <script type="importmap">${JSON.stringify({ imports: importMap })}</script>\n</head>`
);
if (!html.includes("importmap") || html.includes('"/framework/boot/main.js"  src'))
  throw new Error("index.html rewrite failed");
writeFileSync(indexPath, html);

const total = walk(OUT).reduce((n, f) => n + statSync(f).size, 0);
console.log(
  `build-fe: OK — ${Object.keys(importMap).length} hashed modules, ` +
    `1 css bundle (${cssName}), ${walk(OUT).length} files, ` +
    `${(total / 1024 / 1024).toFixed(2)} MiB → frontend-dist/`
);
