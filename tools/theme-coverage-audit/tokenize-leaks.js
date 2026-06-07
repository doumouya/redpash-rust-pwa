#!/usr/bin/env node
/* One-shot: replace hardcoded catppuccin-mocha COLOUR literals with theme-deriving
 * color-mix(var(--rp-*) <alpha>%, transparent) — zero-visual in mocha, correct in all
 * 4 themes. Targets SURVIVING sheets only; skips shadows/overlays (theme-neutral) and
 * the legacy root atom sheets (deleted later). Run from repo root. Not a persistent tool. */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..', 'frontend', 'styles');

// literal RGB → semantic token (its actual mocha identity)
const MAP = [
  { rgb: '243, 139, 168', token: '--rp-accent' }, // #f38ba8
  { rgb: '249, 226, 175', token: '--rp-warn'   }, // #f9e2af
  { rgb: '137, 180, 250', token: '--rp-info'    }, // #89b4fa
  { rgb: '166, 227, 161', token: '--rp-ok'      }, // #a6e3a1
  { rgb: '205, 214, 244', token: '--rp-text'    }, // #cdd6f4
];

// Surviving sheets: every framework/* + the page sheets that stay. NOT the legacy
// root atom sheets (button/chart/panel/rail/table/toolbar/topbar/modal/user-picker).
const PAGE_SURVIVORS = ['home', 'login', 'cases', 'monitoring', 'profile', 'settings',
  'workspace', 'sheetwise', 'doc-viewer', 'shell', 'page'];

function targets() {
  const fw = fs.readdirSync(path.join(ROOT, 'framework'))
    .filter(f => f.endsWith('.css')).map(f => path.join(ROOT, 'framework', f));
  const pages = PAGE_SURVIVORS.map(p => path.join(ROOT, p + '.css')).filter(fs.existsSync);
  return [...fw, ...pages];
}

let total = 0;
for (const file of targets()) {
  let css = fs.readFileSync(file, 'utf8');
  let n = 0;
  for (const { rgb, token } of MAP) {
    const esc = rgb.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/,\s*/g, ',\\s*');
    // rgba(R, G, B, A) → color-mix(in srgb, var(--token) A%, transparent)
    const re = new RegExp('rgba\\(\\s*' + esc + '\\s*,\\s*([0-9.]+)\\s*\\)', 'gi');
    css = css.replace(re, (_, a) => {
      n++;
      const pct = +(parseFloat(a) * 100).toFixed(2).replace(/\.?0+$/, '');
      return `color-mix(in srgb, var(${token}) ${pct}%, transparent)`;
    });
  }
  if (n) { fs.writeFileSync(file, css); total += n; console.log(`  ${path.relative(ROOT, file)}: ${n} tokenized`); }
}
console.log(`\nTotal colour leaks tokenized: ${total}`);
