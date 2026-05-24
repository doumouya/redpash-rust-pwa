---
title: 0005 — ECharts colorBy default paints every bar the same colour
section: Internal
order: 5
last modified date: 2026-05-24
---

# 0005 — ECharts `colorBy` default paints every bar the same colour

**Date:** 2026-05-24 · **Area:** frontend / Profile (ECharts theming) · **Status:** resolved (commit `a1137ca`)

## Problem Statement

The Profile page usage chart had just landed with a freshly-registered
`redpash-mocha` theme — palette of 8 catppuccin colours
(`#89b4fa, #cba6f7, #94e2d5, #fab387, …`). On first hard-refresh,
every one of the four bars (Projects · Files · Charts · Dashboards)
painted the **same** colour — `#89b4fa` (palette[0]).

Em: *"it's still all blue on my profile, i hard refresh but still the same."*

The theme was clearly loaded — the `<rect>` fills in DevTools were
`#89b4fa`, matching `palette[0]` exactly — but the rest of the palette
was inert.

## Troubleshooting steps

1. **Ruled out a stale theme.** The browser was hitting `redpash-mocha`;
   confirmed by inspecting an `<rect>` and seeing `#89b4fa` (not
   `--rp-accent-2`, not the prior token reads).

2. **Ruled out a per-bar `itemStyle` override.** The previous
   implementation hardcoded `itemStyle.color: getCSSVar(i.token)` per
   bar; the new code dropped all per-bar styling. So the bars were
   supposed to fall through to the theme palette. They did — they all
   fell through to `palette[0]`.

3. **Realised the bug class.** A single bar series with N data points
   isn't N series. ECharts treats colour cycling as **per-series by
   default**, not per data point. So all points inherit the same
   series colour (the first in the palette).

4. **Confirmed via the ECharts docs**: `series.colorBy` defaults to
   `"series"`. Setting it to `"data"` cycles the palette per data
   point. Exactly the knob that's missing.

Diagnosis time: ~30 seconds once the bug class was named.

## RCA

ECharts' colour cycling defaults to **series-level**, not data-level.
This is the right default for typical multi-series charts (line +
bar overlay, multi-stack bar, etc.) — each series gets one
consistent colour across all its points, which is what you want for
a legend that names a series.

But a *single-series-of-N-points* chart — common for "show me the
counts of these 4 things side by side" — is the exact case where the
default is wrong. The first palette entry monopolises every point;
the rest of the palette is dead weight.

There's no warning, no console message, no visual hint that the
theme registered with 8 colours but only 1 is in use. The chart
*looks plausible*; it's only on a second glance ("wait, all bars
are blue?") that you notice the theme isn't doing its job.

## Solution

One line added to the series config:

```js
series: [{
  type: "bar",
  // Cycle the theme palette per data point (not per series) so each
  // bar gets its own colour — without this, ECharts hands the whole
  // series palette[0] and every bar paints the same blue.
  colorBy: "data",
  // ...rest unchanged
}],
```

Commit: `a1137ca`.

## Post Checking

1. Hard refresh `/profile` — four bars in four colours
   (accent-2 / mauve / teal / peach). ✓
2. Toggle theme dark↔light via topbar, navigate back to `/profile` —
   bars paint with `redpash-latte` palette (blue / mauve / teal /
   peach in Latte hexes). ✓
3. Tooltip + hover emphasis still work; click-to-navigate per bar
   intact. ✓

## The discipline this updates

When using `echarts.registerTheme()` with a multi-colour palette,
**always set `colorBy: "data"` on series whose data points represent
distinct categories** rather than samples of one category.

Quick decision rule:

| Chart shape | `colorBy` |
|---|---|
| Single series, N points = N distinct categories (Profile usage bar, "items by type", etc.) | **`"data"`** |
| Multi-series overlay (line + bar, stacked bars by group, etc.) | `"series"` (default) |
| Pie chart (each slice is a distinct category) | `"data"` is the default for pie — no override needed |

For pie, ECharts already does the right thing. For bar / line /
scatter / etc. with the "single series of categorical points"
shape, the explicit `colorBy: "data"` is required.

### Follow-ups worth a pass

- **Monitoring's status-code donut** — currently uses per-slice
  `itemStyle.color` overrides (palette mapped by status band). Not
  bitten today, but if it ever migrates to the registered theme,
  the per-slice override would mask this issue cleanly. Note in
  the back of your head.
- **Designer canvas charts** — Torv's `buildOption()` paints from
  the in-module `THEMES.<name>.series` array directly into each
  series' `itemStyle`. Also masks the default. If/when designer
  consolidates onto the registered theme (per the Internal-Slack
  ECharts-theme thread), revisit colorBy on each chart kind.

## Linked

- The fix — commit `a1137ca`.
- The theme module — `frontend/scripts/echarts-theme.js` (commit
  `9533d0e`).
- ECharts docs — `series.colorBy` field in the bar / line / scatter
  options.
- Related discipline — [[no-frameworks]] (we stay vanilla, so when a
  framework default bites us, the diagnosis lives in our docs, not
  in someone else's StackOverflow answer).
