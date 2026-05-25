---
title: CSS units — relative by default
section: Frontend
order: 1
last modified date: 2026-05-25
---

# CSS units — relative by default

**Rule.** In every CSS sheet under `frontend/styles/`, prefer relative
units — `rem`, `em`, `%`, `vw`, `vh`, `fr` — over `px`. Reach for
`px` only when a relative unit genuinely doesn't work.

## Why

It's a web application. Screens span phones, laptops, monitors,
tablets, kiosks, fridges. Form factors and ratios we can't predict
today land tomorrow. Relative units scale with the user's root
font-size, which means:

- a11y zoom keeps proportions intact instead of shifting only the
  text;
- a kiosk-class device with a non-default root scale renders without
  per-page tweaks;
- visual rhythm survives when the user changes the density / font-size
  preference, which already remap `:root` text scales.

Decade-old principle Em has held since first learning HTML/CSS:
*"give 100% width, 50% height"*. It survived because it travels.

## When `px` is still right

A narrow holdout list. Use `px` for:

- **Hairlines** — `1px solid …` borders, `1px` dashed dividers, the
  `height: 1px` flex-fill bar inside a centred-label separator. The
  smallest displayable unit; rounding to fractional rem can vanish
  on certain DPI ratios.
- **Hardware-pixel snapping** — `outline-offset: 1px`, `margin-top:
  1px` micro-nudges to fix sub-pixel alignment artefacts.
- **Box-shadow offsets** — visual cues read by the eye against the
  physical pixel grid; the typical `0 2px 8px rgba(…)` shape doesn't
  benefit from scaling with text.
- **Custom-property tokens in [`tokens.css`](design.md)** — text
  scales (`--rp-text-sm`, `--rp-text-md`, …) and density tokens
  cascade through every consumer, so changing units there is a
  separate (future) sweep. Anything that consumes those tokens via
  `var(--rp-text-md)` is already inheriting the right unit.

Every other length is a candidate for `rem` / `em` / `%` / `vw` /
`vh` / `fr`.

## Quick conversion table

Today's root font-size is the browser default of `16px` (the
redpash-app's [`base.css`](../../frontend/styles/base.css) doesn't
override `<html>`, and `--rp-text-md` sits at `15px` for body
copy):

| px  | rem        | typical use                                  |
|-----|------------|----------------------------------------------|
| `2px`  | `0.125rem`  | hairline gap, tight padding                 |
| `4px`  | `0.25rem`   | inline gaps                                 |
| `6px`  | `0.375rem`  | small padding, chip-row gap                 |
| `8px`  | `0.5rem`    | row gap, small radius                       |
| `10px` | `0.625rem`  | input padding                               |
| `12px` | `0.75rem`   | block padding, control height factor        |
| `14px` | `0.875rem`  | mid padding, label text                     |
| `16px` | `1rem`      | one root unit                               |
| `18px` | `1.125rem`  | body+1                                      |
| `24px` | `1.5rem`    | icon button, section gap                    |
| `28px` | `1.75rem`   | small control height                        |
| `30px` | `1.875rem`  | input height                                |
| `34px` | `2.125rem`  | tight button height                         |
| `260px`| `16.25rem`  | textarea min-height (long-form composer)    |

For widths and heights of layout regions (panels, columns, grids),
prefer `%`, `vw`, `vh`, `fr`, or composed `min(Nrem, Mvw)` over a
single fixed `px`. The slide-in detail panel on `/cases`, for
example, is `width: min(45rem, 70vw)` — capped large enough to read
comfortably on wide monitors, narrow enough to leave kanban visible
behind, and proportional everywhere in between.

## Worked example — cases.css sweep

The cases-page stylesheet ([`frontend/styles/cases.css`](../../frontend/styles/cases.css))
was converted in one pass (commit `ef83327`):

- **234** `px` occurrences swapped to `rem` (root-relative scale)
- **24** `px` holdouts kept — every one is a `1px` hairline border,
  outline-offset, dashed separator, or micro-alignment nudge

Conversion script (one-shot Python via Bash, runs over a single
file):

```python
import re, pathlib
src = pathlib.Path("frontend/styles/cases.css").read_text()
src2 = re.sub(
  r'\b(\d+(?:\.\d+)?)px\b',
  lambda m: m.group(0) if float(m.group(1)) <= 1
            else f"{float(m.group(1))/16:g}rem",
  src,
)
pathlib.Path("frontend/styles/cases.css").write_text(src2)
```

The unified integer+decimal regex matters — a separate-pass version
will eat `12.5px` as `12px` (= `0.75rem`) + leftover `.5px` (= `.` +
`0.3125rem`), producing nonsense like `12.0.3125rem`.

## Adopting on existing sheets

This rule lands going-forward. For sheets already in the tree
without a recent purpose-driven edit, follow the cleaning-cadence
convention: convert during the next edit that touches the file
(opportunistic), or open a focused single-purpose commit when a
sheet has a quiet moment. Don't open a sweeping multi-sheet
refactor — incrementally is fine.

## Audit (planned)

A `css-audit` pattern that flags `\b[2-9]\d*px\b` outside the
tokens layer would make this rule discoverable rather than tribal
knowledge. See the patterns catalog in [`tools/css-audit/`](../../tools/css-audit/);
add this pattern when the next css-audit edge case prompts the
batch.
