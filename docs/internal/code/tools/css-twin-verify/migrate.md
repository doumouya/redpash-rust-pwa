---
title: tools/css-twin-verify/migrate.js
source: ../../../../../tools/css-twin-verify/migrate.js
owner: Torv
section: Internal · Code · Tools · css-twin-verify
last modified date: 2026-06-05
---

# css-twin-verify/migrate.js

## Purpose

The **migration engine** for the design-language `rt-*`→`rp-*` rollout — the
write half of the tool whose read half is [verify.js](verify.md). Two modes:

- **rename** — token-safe `rt-*`→`rp-*` across one or more files (CSS / JS / HTML).
- **prune** — strip a page sheet's byte-equivalent framework-duplicate rules
  (after the sheet is renamed), so the framework atom becomes the sole owner.

Reused per slice and for Phase C's last-consumer cleanup. Built for the
workspace panel slice (CAS_B747F2B6, 2026-06-05).

## Modes

### rename `[--leave=a,b,c] <file…>`

Matches every class-token-leading `rt-…` (lookbehind stops mid-word hits like
`smart-`), token-by-token:

- an exact entry in the **SPECIAL** map → its non-straight target
  (`rt-btn`→`rp-btn-icon`, `rt-icon-btn`→`rp-btn-icon rp-btn-icon--sq`,
  `rt-field-lbl`→`rp-label`, `rt-dd`→`rp-menu`, `rt-panel--filter`→`rp-panel-filter`
  de-BEM, …). Whole-token matching means `rt-btn--accent` and bare `rt-btn` never
  collide — **no longest-first ordering needed**.
- otherwise a straight prefix swap `rt-`→`rp-`.

`--leave=` lists **family-prefixes left verbatim** — the slice boundary. For the
panel slice the consumers were renamed with `--leave=table,designer,toolbar,vrow,hidden,spinning`
so the table (slice 4), designer (slice 5), virtual-rows, hide-restore and
spinner classes stayed untouched. (The two columns-toolbar tokens in tools.js
that share the `toolbar` prefix were fixed by hand afterwards.)

### prune `<page.css> <framework-dir> [extraDeleteRegex]`

Removes rules whose `(normalised-selector, decl)` byte-matches a framework twin,
PLUS any rule whose selector matches `extraDeleteRegex` (used to drop the
`:not(.rp-report-measure)` cascade guards + the diverging `rp-btn-icon--ghost`
base that the page adopts from the framework canonical). It:

- builds the framework twin-map from **comment-stripped** framework text and
  collapses declaration whitespace — without this an inline-comment'd framework
  decl never matches the page's clean decl and the twin silently survives (the
  bug that made the first prune pass miss 31 rules);
- skips `@keyframes` step selectors (`to`/`from`/`NN%`) so it never guts a kept
  keyframe;
- **consumes each deleted rule's leading comment block** (+ blank line) so the
  prune leaves no orphan comment describing a rule that's gone.

## Usage

```
node tools/css-twin-verify/migrate.js rename --leave=table,designer <f…>
node tools/css-twin-verify/migrate.js prune frontend/styles/panel.css frontend/styles/framework ':not\(\.rp-report-measure\)|rp-btn-icon--ghost'
```

Always run `verify.js` after `prune` to confirm the DELETE set is empty (bar the
keyframe-`to` noise), then collapse blank-line runs (`perl -0pi -e 's/\n{3,}/\n\n/g'`).

## Drift-prone areas

- `rename`'s blanket swap assumes `rt-` only appears as a class-token prefix in
  the target files. Safe for CSS/JS class strings; do not run it over files where
  `rt-` could be a non-class substring at a token boundary.
- `prune` is text-range based (parses rule spans, deletes back-to-front). It does
  NOT understand nested `@media` blocks — these sheets are flat. Re-verify after.

## Related

- [verify.js](verify.md) — the classifier that decides what `prune` should remove.
- [Tools pillar landing](../../index.md)
