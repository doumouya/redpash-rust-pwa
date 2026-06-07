#!/usr/bin/env node
/* One-shot: generate redpash-newdark/newlight echarts themes from the catppuccin
 * mocha/latte JSONs — same per-element tuning, colours swapped to the new-theme
 * --rp-* token values so charts carry the RedPash identity in the new themes.
 * Run from repo root. Not a persistent tool. */
'use strict';
const fs = require('fs');
const path = require('path');
const DIR = path.join(__dirname, '..', '..', 'frontend', 'echarts-themes');

// catppuccin literal → new-theme token value. Longest/most-specific first so a
// substring never pre-empts (rgba forms handled before bare hex).
const MOCHA_TO_NEWDARK = [
  // structural (surface / border / text)
  ['#181825', '#101319'], ['#1e1e2e', '#15171b'], ['#313244', '#2a2e37'],
  ['#6c7086', '#6b7280'], ['#a6adc8', '#a0a6b0'], ['#cdd6f4', '#e6e8ec'],
  // categorical palette — lead with RedPash red, then theme info/ok/warn + fills
  ['#89b4fa', '#f04438'], ['#cba6f7', '#5b8def'], ['#94e2d5', '#2dd4a7'],
  ['#fab387', '#f5b14c'], ['#f38ba8', '#a78bfa'], ['#f9e2af', '#f472b6'],
  ['#a6e3a1', '#34d399'], ['#74c7ec', '#38bdf8'],
  // mocha info rgba (axisPointer/shadow) → new-dark info
  ['137, 180, 250', '91, 141, 239'],
];
const LATTE_TO_NEWLIGHT = [
  ['#ccd0da', '#e4e7ec'], ['#8c8fa1', '#98a2b3'], ['#5c5f77', '#667085'], ['#4c4f69', '#16191f'],
  // palette
  ['#1e66f5', '#f04438'], ['#8839ef', '#2563eb'], ['#179299', '#16a34a'],
  ['#fe640b', '#d97706'], ['#d20f39', '#7c3aed'], ['#df8e1d', '#db2777'],
  ['#40a02b', '#059669'], ['#04a5e5', '#0891b2'],
  // latte blue rgba → new-light info; latte text-alpha splitArea → new-light text
  ['30, 102, 245', '37, 99, 235'], ['76,79,105', '22,25,31'],
];

function transform(srcName, outName, themeName, map) {
  let s = fs.readFileSync(path.join(DIR, srcName), 'utf8');
  for (const [from, to] of map) s = s.split(from).join(to);
  const j = JSON.parse(s);
  j._meta = { name: themeName, version: 1, author: 'Torv',
    note: 'Generated from ' + srcName + ' by gen-chart-themes.js — colours swapped to the ' +
          themeName.replace('redpash-', '') + ' --rp-* token values so charts carry the RedPash identity.' };
  fs.writeFileSync(path.join(DIR, outName), JSON.stringify(j, null, 1) + '\n');
  console.log('  wrote ' + outName + ' (palette: ' + j.color.slice(0, 4).join(' ') + ' …)');
}

transform('redpash-mocha.json', 'redpash-newdark.json',  'redpash-newdark',  MOCHA_TO_NEWDARK);
transform('redpash-latte.json', 'redpash-newlight.json', 'redpash-newlight', LATTE_TO_NEWLIGHT);
