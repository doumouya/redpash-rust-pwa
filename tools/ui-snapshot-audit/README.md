# `tools/ui-snapshot-audit/` — computed-style audit for the atom catalog

Pairs with the SPA's `?audit=1` self-report mode
([`frontend/scripts/audit/snapshot.js`](../../frontend/scripts/audit/snapshot.js)).
The frontend walks the rendered DOM, captures `getComputedStyle()` for every
foundation atom in the catalog, downloads a JSON file per route. This
tool reads those captures and emits a standard `audit.json` for the
existing audit pipeline.

## The capture → audit → diff → CI chain

```
  browser at ?audit=1
        │
        ▼  page mount triggers captureSnapshot()
  ui-snapshot__<route>__<theme>.json (downloaded to ~/Downloads)
        │
        ▼  user moves files into tools/ui-snapshot-audit/snapshots/
  tools/ui-snapshot-audit/audit.js
        │
        ▼  builds findings list, emits audit.json
  tools/ui-snapshot-audit/audit.json
        │
        ▼  redpash-audit-ingest --tool ui-snapshot   (gated on Gus's slice 1a)
  audit.run + audit.finding rows (Postgres)
        │
        ▼  audit.run_diff(latest, prev)
  diff classified new / fixed / regressed / improved / unchanged
        │
        ▼  tools/ci-audit/check.sh
  exit 0 if no regressions, exit 1 with markdown table otherwise
```

Every link is already in place except the **ingest broadening** (Layer
1a — Gus's queue, asked on `Internal-Slack/Gus.md` 21:22). Until that
lands, this audit emits an `audit.json` that the ingest binary rejects
on CHECK; the JSON is still inspectable / diffable by hand.

## Usage

```sh
# 1. Open the SPA with ?audit=1 in the URL bar (e.g. http://localhost:8080/?audit=1)
# 2. Navigate through each page you want covered
# 3. Each page-mount downloads ui-snapshot__<route>__<theme>.json
# 4. Move all the downloaded files into tools/ui-snapshot-audit/snapshots/
# 5. Run the audit
node tools/ui-snapshot-audit/audit.js

# Or against a custom snapshots dir
node tools/ui-snapshot-audit/audit.js /path/to/snapshots
```

Output: `tools/ui-snapshot-audit/audit.json` — the canonical payload
ready for ingest.

## Why computed styles, not pixel-diff

Pixel-diff (BackstopJS / Playwright `toHaveScreenshot()` / reg-suit)
carries font-rendering + anti-alias noise that has nothing to do with
our actual UI changes. The same page rendered on two different machines
produces two different PNGs by sub-pixel rounding alone.

Computed-style snapshots track the **design-system contract** —
`token → atom → rendered value`. A drift on `.rt-toolbar`'s
`background-color` from `rgb(30, 30, 46)` to `rgb(248, 248, 250)` is a
real, actionable signal regardless of how the browser anti-aliases the
text inside it. Em's "tailor-made for our app" brief.

## Atom catalog

Source of truth: `ATOM_CATALOG` at the top of
[`frontend/scripts/audit/snapshot.js`](../../frontend/scripts/audit/snapshot.js).
v1 list:

```
.rt-surface         .rt-toolbar         .rt-table-wrap
.rt-pager           .rt-card            .rt-btn
.rp-page__section   .rp-page__head      .rp-page__title
.rp-chip-row        .rp-chip            .rp-avatar
```

Co-owned with Torv's atom-catalog work in `redtable-unification.md`.
v1 is conservative — the catalog expands in response to findings, not
in anticipation (per [[feedback-process-oriented]]).

## Tracked properties

```
background-color   color              border-top-color   border-bottom-color
border-radius      box-shadow         padding            margin
font-size          font-weight        line-height        display
flex-direction     gap
```

The 14 load-bearing properties for the inspo-deck direction Em locked
("lifted card on calm bg" + "pill chip vocabulary"). Not every
`getComputedStyle()` property — that would produce 300-key dicts per
atom and bury real drift in noise.

## Finding-key + severity encoding

`finding_key` is stable across runs (no value embedded), so a value
change registers as a **severity change** through `audit.run_diff`.

```
finding_key:   <route>#<atom>#<prop>@<theme>
               — e.g. "#/home#.rt-toolbar#background-color@dark"
severity:      djb2 hash of the value, masked to 31 bits (positive int4)
kind:          "atom_style"   — atom present, one finding per (route × atom × prop × theme)
               "atom_missing" — atom expected but absent on the route (severity = 0)
```

Per `audit.run_diff` semantics:
- `unchanged` — finding present in both runs, same severity → value stable
- `regressed` / `improved` — finding present in both, severity changed → value drifted
- `new` — finding only in current run → new atom/prop combination
- `fixed` — finding only in previous run → atom removed from route OR prop dropped

`tools/ci-audit/check.sh` fails on `new` + `regressed` (the two
actionable statuses). Value drift surfaces as `regressed` /`improved`
regardless of which numeric direction the hash went — both mean
"value changed."

## What's NOT in scope

- The capture itself — `frontend/scripts/audit/snapshot.js` owns that.
- The ingest binary — `backend/crates/api/src/bin/redpash-audit-ingest.rs`.
  Once Layer 1a (Gus's lane) teaches it the `ui-snapshot` tool's
  explode shape, this audit auto-flows through the standard pipeline.
- Multi-instance divergence on a single page (same atom with different
  computed values in different DOM positions) — v1 captures the FIRST
  instance only. v2 concern when a real finding surfaces.
