#!/usr/bin/env node
/* ──────────────────────────────────────────────────────────────────────────
   RedPash UI-snapshot audit
   ---------------------------------------------------------------------------
   Reads UI snapshot JSONs captured by the frontend's `?audit=1` mode
   (frontend/scripts/audit/snapshot.js — Layer 2a), normalises them into a
   findings list, and emits `audit.json` in the canonical shape the audit
   suite ingests through `redpash-audit-ingest`.

   Once that ingest binary's CHECK + explode logic broadens to recognise
   the `ui-snapshot` tool (Layer 1a — Gus's lane on Gus.md 21:22), the
   audit.run / audit.finding / audit.run_diff machinery automatically
   diffs each run vs the previous: a value change on any atom × prop
   surfaces as a `regressed`/`improved` finding (one int compared to
   another); a new atom appearing on a route surfaces as `new`; an atom
   no longer found on a route surfaces as `fixed`.

   The CI script (tools/ci-audit/check.sh) then catches all of the above
   as exit-code failures.

   ── Finding key + severity encoding ─────────────────────────────────────
   finding_key:  "<route>#<atom>#<prop>@<theme>"
                 — e.g. "#/home#.rt-toolbar#background-color@dark"
                 — stable across runs, no value embedded (per
                   audit.run_diff contract: same key, different severity
                   = regressed/improved)
   severity:     djb2 hash of the property value, masked to 31 bits
                 (positive INTEGER, fits Postgres int4)
                 — value change → severity change → diff surfaces it
                 — value unchanged → severity unchanged → no diff signal

   kind values:
     "atom_style"    — atom is present on the page; one finding per
                       (route, atom, prop, theme) tuple
     "atom_missing"  — atom expected on a route but not found (the page
                       walker reported `found: false`). Severity = 0;
                       finding_key = "<route>#<atom>@<theme>" (no prop).

   ── Input layout ────────────────────────────────────────────────────────
   Default snapshots dir: tools/ui-snapshot-audit/snapshots/
   Each file: ui-snapshot__<route>__<theme>.json (the canonical filename
   `downloadSnapshot()` emits). The script is path-tolerant — anything
   .json under the snapshots dir is parsed; the filename is a hint, the
   actual `route` / `theme` come from the JSON body.

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
// Standard string hash; deterministic across runs. Masking with 0x7fffffff
// guarantees a positive integer that fits Postgres int4 (the
// audit.finding.severity column type per mig 028).
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
  console.log('Capture some first: open the SPA with `?audit=1`, navigate');
  console.log('through every page; download files into the dir above.');
  // Emit an empty audit.json so the suite-runner doesn't trip on a
  // missing file. Stats reflect the empty input honestly.
  fs.writeFileSync(OUT_JSON, JSON.stringify({
    generatedAt: new Date().toISOString(),
    snapshotsDir: SNAPSHOTS_DIR,
    snapshots: [],
    stats: {
      snapshots: 0,
      atoms_tracked: 0, props_tracked: 0,
      atoms_found: 0, atoms_missing: 0,
      findings: 0,
    },
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
  var route = raw.route || '#/';
  var theme = raw.theme || 'dark';

  snapshots.push({
    file: file,
    route: route,
    theme: theme,
    captured_at: raw.captured_at || null,
    viewport: raw.viewport || null,
  });

  var atoms = raw.atoms || {};
  Object.keys(atoms).forEach(function (selector) {
    atomsTracked.add(selector);
    var entry = atoms[selector];

    if (!entry.found) {
      atomsMissing++;
      // One finding per (route × atom × theme) when the atom is expected
      // but missing. Severity 0 to read as "not present" at a glance in
      // the audit.finding table.
      findings.push({
        kind:        'atom_missing',
        finding_key: route + '#' + selector + '@' + theme,
        severity:    0,
        route:       route,
        theme:       theme,
        atom:        selector,
        prop:        null,
        value:       null,
      });
      return;
    }

    atomsFound++;
    var styles = entry.styles || {};
    Object.keys(styles).forEach(function (prop) {
      propsTracked.add(prop);
      var value = styles[prop];
      findings.push({
        kind:        'atom_style',
        finding_key: route + '#' + selector + '#' + prop + '@' + theme,
        severity:    djb2(value),
        route:       route,
        theme:       theme,
        atom:        selector,
        prop:        prop,
        value:       value,
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
console.log('      (gated on Gus.md 21:22 — Layer 1a CHECK + explode broadening)');
