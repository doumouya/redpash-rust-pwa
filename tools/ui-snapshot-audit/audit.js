#!/usr/bin/env node
/* Purpose: ?audit=1 capture → audit.json bridge.
 * Doc: docs/internal/code/tools/audit-suite/ui-snapshot-audit.md */
/* ──────────────────────────────────────────────────────────────────────────
   RedPash UI-snapshot audit
   ---------------------------------------------------------------------------
   Reads UI snapshot JSONs captured by the frontend's `?audit=1` mode
   (frontend/scripts/audit/snapshot.js — Layer 2a), normalises them into a
   findings list, and emits `audit.json` in the canonical shape the audit
   suite ingests through `redpash-audit-ingest`.

   This tool is the COMPUTED-STYLE DRIFT half (?audit=1): one finding per
   (route, atom, prop, theme, state) whose severity is a hash of the rendered
   value, so audit.run_diff surfaces a value change as regressed/improved. The
   COMPONENT-INVENTORY half (?audit=2 → tools/lib/fe-inventory.js →
   tools/ui-doc-audit/audit.js) is a separate tool with a separate capture.

   ── Finding key + severity encoding ─────────────────────────────────────
   finding_key:  "<route>#<atom>#<prop>@<theme>"          (state = default)
                 "<route>:<state>#<atom>#<prop>@<theme>"  (state ≠ default)
                 — e.g. "#/home#.rt-toolbar#background-color@dark"
                 — stable across runs, no value embedded.
   severity:     djb2 hash of the property value, masked to 31 bits.

   kind values:
     "atom_style"    — atom present; one finding per (route, atom, prop, theme, state).
     "atom_missing"  — atom expected on a route but not found. Severity = 0.

   ── Input layout ────────────────────────────────────────────────────────
   Default snapshots dir: tools/ui-snapshot-audit/snapshots/
   Each file: ui-snapshot__<route>__<theme>[__<state>].json — path-tolerant;
   route/theme/state come from the JSON body. v1 captures without a `state`
   field read as state="default" (backward compatible).

   Usage:  node tools/ui-snapshot-audit/audit.js [snapshotsDir]
   Output: tools/ui-snapshot-audit/audit.json (canonical, ingest-ready)
   ────────────────────────────────────────────────────────────────────── */
'use strict';

var fs   = require('fs');
var path = require('path');

var SNAPSHOTS_DIR = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(__dirname, 'snapshots');
var OUT_JSON = path.join(__dirname, 'audit.json');

// ── djb2 — 31-bit positive hash ────────────────────────────────────────────
function djb2(s) {
  var h = 5381;
  for (var i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  }
  return h & 0x7fffffff;
}

// ── snapshot discovery ────────────────────────────────────────────────────
if (!fs.existsSync(SNAPSHOTS_DIR)) {
  console.error('ui-snapshot: snapshots dir not found: ' + SNAPSHOTS_DIR);
  console.error('Capture some first: open the SPA with `?audit=1`, navigate');
  console.error('through every page; download files into ' + SNAPSHOTS_DIR);
  process.exit(2);
}

var snapshotFiles = fs.readdirSync(SNAPSHOTS_DIR)
  .filter(function (n) { return /\.json$/i.test(n); })
  .sort();

if (snapshotFiles.length === 0) {
  console.log('ui-snapshot: no snapshots in ' + SNAPSHOTS_DIR);
  fs.writeFileSync(OUT_JSON, JSON.stringify({
    generatedAt: new Date().toISOString(),
    snapshotsDir: SNAPSHOTS_DIR,
    snapshots: [],
    stats: { snapshots: 0, atoms_tracked: 0, props_tracked: 0, atoms_found: 0, atoms_missing: 0, findings: 0 },
    findings: [],
  }, null, 2) + '\n');
  process.exit(0);
}

// ── per-snapshot parse + finding emission ─────────────────────────────────
var snapshots = [];
var findings  = [];
var atomsTracked = new Set();
var propsTracked = new Set();
var atomsFound   = 0;
var atomsMissing = 0;

snapshotFiles.forEach(function (file) {
  var raw;
  try {
    raw = JSON.parse(fs.readFileSync(path.join(SNAPSHOTS_DIR, file), 'utf8'));
  } catch (err) {
    console.error('ui-snapshot: parse error in ' + file + ': ' + err.message);
    return;
  }
  // Only the ?audit=1 atom snapshots carry an `atoms` dict; ?audit=2 inventory
  // captures (capture==="inventory") belong to ui-doc-audit — skip them here.
  if (raw.capture === 'inventory' || !raw.atoms) return;

  var route = raw.route || '#/';
  var theme = raw.theme || 'dark';
  var state = raw.state || 'default';
  var routePart = state === 'default' ? route : (route + ':' + state);

  snapshots.push({
    file: file, route: route, theme: theme, state: state,
    captured_at: raw.captured_at || null, viewport: raw.viewport || null,
  });

  var atoms = raw.atoms || {};
  Object.keys(atoms).forEach(function (selector) {
    atomsTracked.add(selector);
    var entry = atoms[selector];

    if (!entry.found) {
      atomsMissing++;
      findings.push({
        kind: 'atom_missing', finding_key: routePart + '#' + selector + '@' + theme,
        severity: 0, route: route, theme: theme, state: state, atom: selector, prop: null, value: null,
      });
      return;
    }

    atomsFound++;
    var styles = entry.styles || {};
    Object.keys(styles).forEach(function (prop) {
      propsTracked.add(prop);
      var value = styles[prop];
      findings.push({
        kind: 'atom_style', finding_key: routePart + '#' + selector + '#' + prop + '@' + theme,
        severity: djb2(value), route: route, theme: theme, state: state, atom: selector, prop: prop, value: value,
      });
    });
  });
});

// ── canonical audit.json ──────────────────────────────────────────────────
var payload = {
  generatedAt:  new Date().toISOString(),
  snapshotsDir: SNAPSHOTS_DIR,
  snapshots:    snapshots,
  stats: {
    snapshots:     snapshots.length,
    atoms_tracked: atomsTracked.size,
    props_tracked: propsTracked.size,
    atoms_found:   atomsFound,
    atoms_missing: atomsMissing,
    findings:      findings.length,
  },
  findings: findings,
};

fs.writeFileSync(OUT_JSON, JSON.stringify(payload, null, 2) + '\n');

// ── human-readable summary ────────────────────────────────────────────────
console.log('Scanning ' + SNAPSHOTS_DIR + ' …');
console.log('');
console.log('  snapshots parsed   ' + snapshots.length);
console.log('  atoms tracked      ' + atomsTracked.size);
console.log('  props tracked      ' + propsTracked.size);
console.log('  atom instances found    ' + atomsFound);
console.log('  atom instances missing  ' + atomsMissing);
console.log('  findings emitted   ' + findings.length);
console.log('');
console.log('  payload -> ' + path.relative(process.cwd(), OUT_JSON));
console.log('');
console.log('Next: ingest via `redpash-audit-ingest --tool ui-snapshot`');
