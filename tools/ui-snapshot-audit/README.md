# `tools/ui-snapshot-audit/` — computed-style audit for the atom catalog (LEAN tree)

Pairs with the SPA's `?audit=1` self-report mode. When the SPA loads with
`?audit=1` in the URL, every page mount walks the rendered DOM, captures
`getComputedStyle()` for every foundation atom in the catalog, and downloads
a JSON file per route. This tool reads those captures and emits a standard
`audit.json` for the existing audit pipeline.

> **Lean status — capture script not yet ported.** The browser-side
> `captureSnapshot()` self-report (the prerelease `frontend/scripts/audit/
> snapshot.js`) is **not in the lean cut** — lean has no `frontend/scripts/`
> tree and no `?audit=` capture wiring. This `audit.js` is the
> source-of-truth half and is reconciled to prerelease behavior; it is
> namespace- and route-agnostic, so it runs unchanged the moment a lean
> capture lands (or against any hand-authored snapshot JSON of the documented
> shape). Until the capture is ported, run the tool against a `snapshots/`
> dir you populate by hand — see "Input shape" below. Wiring the capture is a
> separate change (router/shell), out of scope for this tool's reconcile.

## The capture → audit → diff → CI chain

```
  browser at ?audit=1
        │
        ▼  page mount triggers captureSnapshot()   (capture not yet in lean)
  ui-snapshot__<route>__<theme>.json (downloaded to ~/Downloads)
        │
        ▼  user moves files into tools/ui-snapshot-audit/snapshots/
  tools/ui-snapshot-audit/audit.js
        │
        ▼  builds findings list, emits audit.json
  tools/ui-snapshot-audit/audit.json
        │
        ▼  redpash-audit-ingest --tool ui-snapshot
  audit.run + audit.finding rows (Postgres)
        │
        ▼  audit.run_diff(latest, prev)
  diff classified new / fixed / regressed / improved / unchanged
        │
        ▼  tools/ci-audit/check.sh
  exit 0 if no regressions, exit 1 with markdown table otherwise
```

In the lean tree the **capture** (top link) and the **ingest binary**
(`redpash-audit-ingest`, whose source is not yet tracked in lean — only stale
`backend/target/` artifacts) are the two not-yet-present links. The `audit.js`
→ `audit.json` middle is fully runnable now; the emitted JSON is inspectable /
diffable by hand until the rest of the chain lands.

## Usage

```sh
# Once a lean capture exists:
# 1. Open the SPA with ?audit=1 in the URL bar (e.g. http://localhost:8080/?audit=1)
# 2. Navigate through each page you want covered (#/workspace, #/org,
#    #/console, #/registry, #/cases, #/settings)
# 3. Each page-mount downloads ui-snapshot__<route>__<theme>.json
# 4. Move all the downloaded files into tools/ui-snapshot-audit/snapshots/
# 5. Run the audit:
node tools/ui-snapshot-audit/audit.js

# Or against a custom snapshots dir
node tools/ui-snapshot-audit/audit.js /path/to/snapshots
```

Output: `tools/ui-snapshot-audit/audit.json` — the canonical payload ready for
ingest. With an empty/absent `snapshots/` dir the tool still emits a valid
zero-finding `audit.json` (exit 0).

## Input shape

Each snapshot file (`*.json` in `snapshots/`) is read for its body, not its
name. Minimal shape the tool consumes:

```json
{
  "route":  "#/workspace",
  "theme":  "dark",
  "state":  "default",
  "captured_at": "2026-06-16T00:00:00.000Z",
  "viewport": { "width": 1440, "height": 900 },
  "atoms": {
    ".rp-redtable": {
      "found": true,
      "instances": 1,
      "styles": { "background-color": "rgb(30, 30, 46)", "color": "rgb(205, 214, 244)" }
    },
    ".rp-pager": { "found": false, "instances": 0 }
  }
}
```

`?audit=2` inventory captures (`"capture": "inventory"`) are skipped — those
belong to `tools/ui-doc-audit/`.

## Why computed styles, not pixel-diff

Pixel-diff (BackstopJS / Playwright `toHaveScreenshot()` / reg-suit) carries
font-rendering + anti-alias noise that has nothing to do with our actual UI
changes. The same page rendered on two different machines produces two
different PNGs by sub-pixel rounding alone.

Computed-style snapshots track the **design-system contract** —
`token → atom → rendered value`. A drift on `.rp-redtable`'s
`background-color` from `rgb(30, 30, 46)` to `rgb(248, 248, 250)` is a real,
actionable signal regardless of how the browser anti-aliases the text inside
it. Em's "tailor-made for our app" brief.

## Atom catalog (lean `rp-*` namespace)

The lean cut uses the `rp-*` namespace exclusively (`rt-*` retired). The
catalog is the foundation classes the design-system contract guarantees,
starting with the cross-page chrome + the table/card vocabulary that the lean
pages actually render:

```
.rp-surface         .rp-redtable        .rp-gridview
.rp-pager           .rp-card            .rp-chip-row
.rp-chip            .rp-topbar          .rp-rail
.rp-omni
```

The catalog is conservative — it expands in response to findings, not in
anticipation (per [[feedback-process-oriented]]). An atom listed but absent on
a route just emits an `atom_missing` finding (severity 0); the tool never
fails on a missing atom.

## Tracked properties

```
background-color   color              border-top-color   border-bottom-color
border-radius      box-shadow         padding            margin
font-size          font-weight        line-height        display
flex-direction     gap
```

The 14 load-bearing properties for the "lifted card on calm bg" + "pill chip
vocabulary" direction. Not every `getComputedStyle()` property — that would
produce 300-key dicts per atom and bury real drift in noise.

## Finding-key + severity encoding

`finding_key` is stable across runs (no value embedded), so a value change
registers as a **severity change** through `audit.run_diff`.

```
finding_key:   <route>#<atom>#<prop>@<theme>
               — e.g. "#/workspace#.rp-redtable#background-color@dark"
severity:      djb2 hash of the value, masked to 31 bits (positive int4)
kind:          "atom_style"   — atom present, one finding per (route × atom × prop × theme)
               "atom_missing" — atom expected but absent on the route (severity = 0)
```

Per `audit.run_diff` semantics:
- `unchanged` — finding present in both runs, same severity → value stable
- `regressed` / `improved` — finding present in both, severity changed → value drifted
- `new` — finding only in current run → new atom/prop combination
- `fixed` — finding only in previous run → atom removed from route OR prop dropped

`tools/ci-audit/check.sh` fails on `new` + `regressed` (the two actionable
statuses). Value drift surfaces as `regressed` / `improved` regardless of
which numeric direction the hash went — both mean "value changed."

## What's NOT in scope

- The capture itself — the browser-side `captureSnapshot()` self-report (not
  yet ported into the lean `frontend/`).
- The ingest binary — `redpash-audit-ingest` (source not yet tracked in lean).
  Once it teaches the pipeline the `ui-snapshot` tool's explode shape, this
  audit auto-flows through the standard pipeline.
- Multi-instance divergence on a single page (same atom with different computed
  values in different DOM positions) — v1 captures the FIRST instance only. v2
  concern when a real finding surfaces.
