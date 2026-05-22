#!/usr/bin/env node
/* ──────────────────────────────────────────────────────────────────────────
   RedPash team board — who's where, what they touched, who's about to clash.

   Reads three files under Internal-Slack/:
     presence/<agent>.md  — that agent's current work claim (informal markdown;
                            any line beginning with `- ` is a claimed path).
     commits.log          — append-only commit history (one line per commit,
                            written by .git/hooks/post-commit).

   Prints three sections to stdout:
     1. presence       — every active agent's claim block, with age.
     2. overlapping    — two agents claiming the same path (or a parent /
        claims            child of the other) — the collision warning.
     3. recent commits — the last 15 entries from commits.log.

   No daemon, no locks — append-only markdown plus one shell hook. Same
   discipline the audit tools sit on.

   Usage:  node tools/team/board.js
   ────────────────────────────────────────────────────────────────────────── */
'use strict';

var fs   = require('fs');
var path = require('path');

var SLACK    = '/home/mansa/Internal-Slack';
var PRES_DIR = path.join(SLACK, 'presence');
var LOG      = path.join(SLACK, 'commits.log');

function fmtAge(secs) {
  if (secs < 60)    return secs + 's ago';
  if (secs < 3600)  return Math.floor(secs / 60)   + 'm ago';
  if (secs < 86400) return Math.floor(secs / 3600) + 'h ago';
  return Math.floor(secs / 86400) + 'd ago';
}

/* ── read presence ────────────────────────────────────────────────────────── */
var agents = [];
try {
  fs.readdirSync(PRES_DIR).forEach(function (file) {
    if (!file.endsWith('.md')) return;
    var full = path.join(PRES_DIR, file);
    var text = fs.readFileSync(full, 'utf8');
    var stat = fs.statSync(full);
    var claims = (text.match(/^\s*-\s+(.+)$/gm) || [])
      .map(function (l) { return l.replace(/^\s*-\s+/, '').trim(); })
      .filter(Boolean);
    agents.push({
      name:   path.basename(file, '.md'),
      age:    Math.floor((Date.now() - stat.mtimeMs) / 1000),
      text:   text.trim(),
      claims: claims,
    });
  });
} catch (e) {
  /* missing dir → empty list */
}

console.log('── presence ──');
if (!agents.length) {
  console.log('  (no presence files yet — agents drop one at Internal-Slack/presence/<name>.md)');
} else {
  agents.forEach(function (a) {
    var stale = a.age > 2 * 86400 ? '  [stale > 2d]' : '';
    console.log('  ' + a.name + '   (' + fmtAge(a.age) + ')' + stale);
    a.text.split('\n').forEach(function (line) {
      if (line.trim()) console.log('    ' + line);
    });
    console.log();
  });
}

/* ── overlaps ─────────────────────────────────────────────────────────────── */
function overlaps(p, q) {
  return p === q
    || p.indexOf(q + '/') === 0
    || q.indexOf(p + '/') === 0;
}

console.log('── overlapping claims ──');
var collisions = [];
for (var i = 0; i < agents.length; i++) {
  for (var j = i + 1; j < agents.length; j++) {
    var a = agents[i], b = agents[j];
    a.claims.forEach(function (p) {
      b.claims.forEach(function (q) {
        if (overlaps(p, q)) collisions.push({ a: a.name, b: b.name, p: p, q: q });
      });
    });
  }
}
if (!collisions.length) {
  console.log('  clean — no overlapping claims');
} else {
  collisions.forEach(function (o) {
    console.log('  ✗  ' + o.a + ' (' + o.p + ')  vs  ' + o.b + ' (' + o.q + ')');
  });
}

/* ── recent commits ───────────────────────────────────────────────────────── */
console.log('');
console.log('── recent commits (last 15) ──');
try {
  var lines = fs.readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean);
  var tail = lines.slice(-15);
  if (!tail.length) {
    console.log('  (commits.log is empty — first commit after the hook is installed will land here)');
  } else {
    tail.forEach(function (l) { console.log('  ' + l); });
  }
} catch (e) {
  console.log('  (commits.log not initialised yet — install the post-commit hook: sh tools/team/install.sh)');
}
