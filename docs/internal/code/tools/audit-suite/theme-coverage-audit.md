---
title: tools/theme-coverage-audit/audit.js
source: ../../../../../tools/theme-coverage-audit/audit.js
owner: Torv
section: Internal · Code · tools · audit-suite
last modified date: 2026-06-07
---

# theme-coverage-audit

## Purpose

The design language is **4 themes on one `--rp-*` semantic-token API** (new-dark /
new-light / catppuccin-mocha / catppuccin-latte). An element only re-themes if its
colours come from `var(--rp-*)`. A **literal** colour (hex / rgb / rgba / hsl)
hardcodes ONE theme's value, so the element keeps that colour in the other 3 themes —
"not covered by the framework". This audit finds those leaks so theme-switching is
actually complete.

Auto-discovered by `tools/audit.sh` (the `tools/*-audit/audit.js` glob).

## Public surface

- `node tools/theme-coverage-audit/audit.js [stylesDir]` — scans every `.css` under the
  styles dir (default `frontend/styles`), skipping `tokens.css` (the legitimate definer,
  which maps the literals per theme).
- Output: a console summary + `audit.html` next to the script. **Exit 1** if any colour
  LEAK remains (the build gate); 0 otherwise.

## What it flags

- **leak** (gates): a semantic colour hardcoded to one theme — the known catppuccin-mocha
  literals (`accent` #f38ba8, `warn` #f9e2af, `info` #89b4fa, `ok` #a6e3a1, `text` #cdd6f4)
  and any other non-`var()` colour. These MUST recolour → replace with the matching
  `var(--rp-*)` token, or `color-mix(in srgb, var(--rp-*) <alpha>%, transparent)` to keep a
  custom alpha (zero-visual in the source palette, correct in all 4 themes).
- **warn** (tracked, not gated): black shadows (`rgba(0,0,0,…)`) + dark scrims — theme-neutral.

## Related tools (one-shot fixers, same folder)

- `tokenize-leaks.js` — replaced the hardcoded mocha colour literals in the surviving
  sheets with `color-mix(var(--rp-*) …)` (the bulk fix; legacy root atom sheets were left
  for deletion in the dedup).
- `gen-chart-themes.js` — generated `frontend/echarts-themes/redpash-{newdark,newlight}.json`
  from the catppuccin mocha/latte JSONs (same per-element tuning, colours swapped to the
  new-theme token values) so charts carry the RedPash identity. See
  [echarts-theme.js](../../frontend/scripts/echarts-theme.md).

## Drift-prone areas

- The `KNOWN` literal→token map is keyed on the catppuccin-mocha palette (what the atoms
  were first authored against). If a different palette's literal leaks, it lands in
  `(review)` — still gated, but without a suggested token. Add it to `KNOWN` if it recurs.
- A runtime DOM scan (Playwright `getComputedStyle` for the mocha literals while a non-mocha
  theme is active) catches leaks the static scan can't see (e.g. inline styles, JS-set
  colours). It found the live home-badge + chart leaks during the rollout; keep it in the
  verification loop.
