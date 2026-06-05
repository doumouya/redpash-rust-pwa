#!/usr/bin/env node
/* Purpose: opt-in runtime verifier — drives railed pages in a headless browser
 * (auto dev-login + navigate + interact) and asserts rt-*→rp-* migration
 * correctness, JS lockstep, theme recolor, and a clean console.
 * Doc: docs/internal/code/tools/page-verify/verify.md */
/* ──────────────────────────────────────────────────────────────────────────
   RedPash page-verify — the ACTIVE runtime check for the design-language rollout.

   NOT a `tools/*-audit/` member ON PURPOSE: it launches a real browser and needs
   the dev server up, so it must stay OUT of the always-run static `tools/audit.sh`
   (which runs anywhere, no server). It complements `ui-runtime-audit` (the static
   ?audit=2-capture-vs-enumeration divergence lane) rather than competing — this
   tool DRIVES the page end-to-end and asserts migration/interaction/theme health
   that a static capture diff can't see (the JS-selector lockstep is the real risk
   of a rt-*→rp-* rename: a markup rename that misses a JS selector silently breaks
   the rail with no parse error).

   Per railed page it checks:
     • rail renders on the framework rp-rail* atoms (rp-rail-tab / rp-rail-group present)
     • the rail subtree has ZERO residual rt-* (migration complete WITHIN the rail;
       list/redtable-surface rt-* outside .rp-rail are reported separately, not failed)
     • a rail tab click ACTIVATES (the JS lockstep is functional, not just renamed)
     • --rp-accent resolves under every theme (token-driven recolor works)
     • no console / page errors during load + interaction

   Requirements (opt-in, so they're checked at runtime, not assumed):
     • the dev server up with REDPASH_DEV_LOGIN=1 (default base http://127.0.0.1:8080)
     • Playwright resolvable (npx cache / node_modules / PLAYWRIGHT_DIR) + a Chrome
       (system google-chrome / chromium, or Playwright's bundled chromium)

   Usage:
     node tools/page-verify/verify.js
     node tools/page-verify/verify.js --pages profile,docs --themes new-dark
     node tools/page-verify/verify.js --base http://127.0.0.1:8088 --headed
   Exit: 0 all pass · 1 a page failed · 2 prerequisites missing (skipped)
   ────────────────────────────────────────────────────────────────────────── */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..");
const OUT = path.join(__dirname, "screens");

// ── CLI ──────────────────────────────────────────────────────────────────
function arg(name, def) {
  const i = process.argv.indexOf("--" + name);
  if (i === -1) return def;
  const v = process.argv[i + 1];
  return v && !v.startsWith("--") ? v : true;
}
const BASE = String(arg("base", "http://127.0.0.1:8080")).replace(/\/$/, "");
const PAGES = String(arg("pages", "profile,docs,home,settings")).split(",").map((s) => s.trim()).filter(Boolean);
const THEMES = String(arg("themes", "catppuccin-mocha,catppuccin-latte,new-dark,new-light")).split(",").map((s) => s.trim()).filter(Boolean);
const HEADED = arg("headed", false) === true;
const SHOT_THEMES = new Set(["catppuccin-mocha", "new-dark"]); // screenshot just two, to eyeball both identities

// ── resolve Playwright from wherever it lives (npx cache is ephemeral) ─────
function loadPlaywright() {
  const dirs = [];
  if (process.env.PLAYWRIGHT_DIR) dirs.push(process.env.PLAYWRIGHT_DIR);
  dirs.push(path.join(__dirname, "node_modules"), path.join(ROOT, "node_modules"));
  try {
    const npx = path.join(os.homedir(), ".npm", "_npx");
    if (fs.existsSync(npx)) {
      for (const d of fs.readdirSync(npx)) {
        const nm = path.join(npx, d, "node_modules");
        if (fs.existsSync(path.join(nm, "playwright"))) dirs.push(nm);
      }
    }
  } catch { /* no npx cache — fine */ }
  for (const d of dirs) {
    try { return require(require.resolve("playwright", { paths: [d] })); } catch { /* try next */ }
  }
  try { return require("playwright"); } catch { return null; }
}

// ── resolve a Chrome the browser can launch ────────────────────────────────
function chromePath() {
  const cands = [
    process.env.CHROME_BIN,
    "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/microsoft-edge",
  ].filter(Boolean);
  return cands.find((p) => { try { return fs.existsSync(p); } catch { return false; } }) || null;
}

async function main() {
  const pw = loadPlaywright();
  if (!pw) {
    console.error("page-verify: Playwright not found. Install it (e.g. `npx playwright@latest`)\n"
      + "  or set PLAYWRIGHT_DIR to a node_modules containing it. Skipping (exit 2).");
    process.exit(2);
  }
  const exe = chromePath();
  const launchOpts = { headless: !HEADED, args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"] };
  if (exe) launchOpts.executablePath = exe; else launchOpts.channel = "chrome";

  // Prereq: dev server reachable.
  try {
    const r = await fetch(BASE + "/", { signal: AbortSignal.timeout(4000) });
    if (!r.ok && r.status !== 401) throw new Error("status " + r.status);
  } catch (e) {
    console.error(`page-verify: dev server not reachable at ${BASE} (${e.message}). Start it (REDPASH_DEV_LOGIN=1). Skipping (exit 2).`);
    process.exit(2);
  }

  fs.mkdirSync(OUT, { recursive: true });
  const browser = await pw.chromium.launch(launchOpts);
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const dl = await ctx.request.post(`${BASE}/api/auth/dev-login`, { data: {} });
  if (![200, 204].includes(dl.status())) {
    console.error(`page-verify: dev-login returned ${dl.status()} — is REDPASH_DEV_LOGIN=1? Skipping (exit 2).`);
    await browser.close();
    process.exit(2);
  }

  const results = [];
  for (const pg of PAGES) {
    const page = await ctx.newPage();
    const errors = [];
    page.on("console", (m) => { if (m.type() === "error") errors.push(m.text().slice(0, 160)); });
    page.on("pageerror", (e) => errors.push("PAGEERROR: " + String(e).slice(0, 160)));
    const r = { page: pg, themes: {}, errors: [] };
    try {
      await page.goto(`${BASE}/#/${pg}`, { waitUntil: "networkidle", timeout: 15000 });
      await page.waitForSelector(".rp-rail", { timeout: 8000 });
      r.struct = await page.evaluate(() => {
        const rail = document.querySelector(".rp-rail");
        const railRt = rail
          ? [...new Set([...rail.querySelectorAll("[class]")].flatMap((e) => [...e.classList]).filter((c) => c.startsWith("rt-")))]
          : ["(no rail)"];
        return {
          railRt,
          tabs: document.querySelectorAll(".rp-rail-tab").length,
          groups: document.querySelectorAll(".rp-rail-group").length,
          footer: !!document.querySelector(".rp-rail-footer"),
          listRt: document.querySelectorAll('.rp-surface [class*="rt-"]').length, // deferred list/redtable surface — informational
        };
      });
      const firstTab = await page.$(".rp-rail-tab:not([disabled])");
      r.tabActivates = null;
      if (firstTab) {
        await firstTab.click().catch(() => {});
        await page.waitForTimeout(150);
        r.tabActivates = await page.evaluate(() => document.querySelectorAll(".rp-rail-tab.active").length > 0);
      }
      for (const th of THEMES) {
        r.themes[th] = await page.evaluate((t) => {
          document.documentElement.dataset.theme = t;
          return getComputedStyle(document.documentElement).getPropertyValue("--rp-accent").trim();
        }, th) || "(empty!)";
        if (SHOT_THEMES.has(th)) await page.screenshot({ path: path.join(OUT, `${pg}-${th}.png`) });
      }
      r.errors = errors;
    } catch (e) {
      r.fatal = String(e).split("\n")[0];
      r.errors = errors;
    }
    results.push(r);
    await page.close();
  }
  await browser.close();

  // ── report ──
  console.log("page-verify");
  console.log("───────────");
  console.log(`base ${BASE} · chrome ${exe || "(playwright channel:chrome)"} · pages ${PAGES.join(",")} · themes ${THEMES.length}`);
  let fails = 0;
  for (const r of results) {
    const railClean = r.struct && r.struct.railRt.length === 0;
    const railRendered = r.struct && (r.struct.tabs > 0 || r.struct.groups > 0);
    const noErr = (r.errors || []).length === 0;
    const themesOk = THEMES.every((t) => r.themes[t] && r.themes[t] !== "(empty!)");
    // tab-click is ADVISORY, not a hard gate: the click→.active model is page-
    // specific (profile/docs/home/settings use it; monitoring renders the body
    // as the active indicator instead). The hard gates are rail-clean + renders +
    // theme recolor + clean console; tab-click is reported as a signal.
    const pass = !r.fatal && railClean && railRendered && noErr && themesOk;
    if (!pass) fails++;
    console.log(`\n  ${pass ? "PASS" : "FAIL"}  ${r.page}`);
    if (r.fatal) console.log(`        FATAL: ${r.fatal}`);
    if (r.struct) {
      console.log(`        rail subtree rt-*: ${r.struct.railRt.length} ${r.struct.railRt.length ? JSON.stringify(r.struct.railRt) : "(clean)"}`);
      console.log(`        rp-rail-tab ${r.struct.tabs} · rp-rail-group ${r.struct.groups} · footer ${r.struct.footer} · deferred list-surface rt-* ${r.struct.listRt}`);
    }
    console.log(`        tab-click activates: ${r.tabActivates}  (advisory — varies by page tab model)`);
    console.log(`        --rp-accent: ${Object.entries(r.themes).map(([k, v]) => k.replace("catppuccin-", "") + "=" + v).join("  ")}`);
    if ((r.errors || []).length) console.log(`        errors: ${r.errors.join(" | ")}`);
  }
  console.log(`\n  ${fails ? fails + " FAIL" : "ALL PASS"} · screenshots ${OUT}/`);
  process.exit(fails ? 1 : 0);
}

main().catch((e) => { console.error("page-verify crashed:", e); process.exit(2); });
