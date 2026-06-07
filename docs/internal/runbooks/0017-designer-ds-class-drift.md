---
title: 0017 — chart designer/builder render raw — JS emits retired ds-* classes after dedup renamed CSS to rp-dash-*
date: 2026-06-07
case: CAS_AACB45C0339F4DD68C0D140C4F392509
area: frontend/scripts (designer + chart builder) + tools/retired-class-audit (new guard)
---

# 0017 — designer ds-* class drift (CSS renamed, JS emitter not)

## Symptom

The Workspace **chart designer** rendered raw: the right-side config controls were
unstyled and the chart-preview area was empty/black ("the Dashboard page is also
fucked-up… I better check the whole app state"). The page was not erroring — it just
had no styling and no chart.

## Root cause

The design-language **dedup** (`c282646 "framework(dashboards): port the Workspace
designer → generic rp-dash-* component"`, plus the `rt-*→rp-*` series) renamed the
designer/dashboard CSS family from `ds-*` → `rp-dash-*` (105 `rp-dash-*` rules in
`frontend/styles/framework/dashboards.css`) **and deleted `frontend/styles/chart.css`**
(the old home of the `.ds-*` rules) — but the **JS emitters were missed**:

- `frontend/scripts/charts/builder-ui.js` — 49 `ds-*` emissions (the config panel)
- `frontend/scripts/designer.js` — 45 `ds-*` emissions (canvas + tiles + chart mount)
- `frontend/scripts/pages/workspace.js` — 2 (`.ds-config-hidden` toggle)
- `frontend/scripts/prefs/controls/chart-layouts.js` — 1 (`.ds-config` add-chart modal)
- `frontend/partials/workspace.html` — 1 (`class="ds-title"`, no `.ds-title` rule existed)

So the live DOM carried `ds-*` while the only rules defined were `rp-dash-*` — they
never matched. Critically, the ECharts mount `querySelector(".ds-chart")` sits in a
chain whose height is **CSS-only** (`.rp-dash-tile-body{flex:1;min-height:17.5rem}` +
`.rp-dash-chart{height:100%}`); with the element named `.ds-chart`, the height rule
never applied → **0-height container → empty chart**. This was a shipped regression on
the shared `prerelease` branch (the CSS side of the dedup was correct; the drift was the
un-migrated emitter).

## Fix (CAS_AACB45C0339F4DD68C0D140C4F392509)

Renamed the emitters to the canonical family the CSS already defines:

- `designer.js` / `builder-ui.js` / `workspace.js` / `chart-layouts.js`:
  `ds-*` → `rp-dash-*` (word-boundary rename; every `ds-` was a class — IDs are
  camelCase `dsGrid`/`dsConfig`; the lone `id="ds-acc-body"` hook renamed in lockstep
  with its `#…` selectors, so it stays internally consistent).
- Two non-mechanical targets, verified against the deleted `chart.css`:
  `ds-empty` → **`rp-empty`** (the shared atom; `.rp-dash-grid > .rp-empty` reproduces
  the old grid deltas byte-for-byte) — *not* `rp-dash-empty` (no such rule). `ds-tile-edit`
  → `rp-dash-tile-edit` (a JS hook on the styled `rp-dash-tile-act`; never had its own rule).
- `partials/workspace.html`: `class="ds-title"` → `class="rp-title"` (the title atom;
  `.rp-dash-toolbar .rp-title` styles it — there was no `.ds-title` rule, so it was
  unstyled too).

**Left alone (not this bug):** `rt-dd` / `rt-designer` / `rt-spinning` and the
`rt-toolbar--designer` shell — those `.rt-*` CSS rules are still present, so the JS
matches the CSS (consistent, un-migrated). That's the dashboards lane's remaining work.

## Prevention — the guard (so it fails the audit, not the user)

New `tools/retired-class-audit/audit.js` (auto-discovered + gated by `tools/audit.sh`):
scans frontend JS+HTML (comment-stripped) and **fails (exit 1)** if any emitter ships a
class/id on a **retired** family prefix. `ds-` is gated now (fully retired → `rp-dash-*`);
`rt-` is staged for when the dashboards lane finishes its port. Verified with a negative
test (re-injecting one `ds-config` fails the gate). Complementary edit: dropped `'ds'`
from `tools/uniformity-audit`'s `ALLOW_FAMILY`, so a `ds-*` in a partial/page also fails.

The guard immediately paid for itself — it found the `workspace.js` + `chart-layouts.js`
emitters that a manual prefix sweep had mis-attributed as `rt-*`.

## Verify

- `node tools/retired-class-audit/audit.js` → `OK` (exit 0); re-inject one `ds-config` →
  FAIL (exit 1); revert.
- `grep -rnE '\bds-[a-z]' frontend/scripts frontend/partials frontend/index.html`
  (comments excluded) → zero.
- `sh tools/audit.sh` clean (uniformity-audit 0 new foreign families; doc-coverage clean).
- Live browser (dev-login): Workspace → chart designer → `.rp-dash-chart` has non-zero
  height + a chart renders; config panel styled; theme switch re-renders.
