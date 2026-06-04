---
title: frontend/scripts/framework/page-assembly.js
source: ../../../../../../frontend/scripts/framework/page-assembly.js
owner: Torv
section: Internal · Code · Frontend · scripts · framework
last modified date: 2026-06-04
---

# framework/page-assembly.js — page completeness assembler

## Purpose

The **page-assembly completeness proof** for the framework epic (CAS_37B2E1BF):
the sandbox-done gate is *"rebuild the 7 real pages from ONLY framework
components,"* and this is the generic assembler that does it. `assemblePage(host,
spec)` builds the live rail-shell outer chain and mounts the registered units into
it from a plain page spec — the **seed of the declarative page-spec + runner** the
Figma page-automation plan is built on.

## Public surface

- `assemblePage(host, spec)` — self-registers as `"page"`. Builds
  `section.rp-shell > header(topbar) + div.rp-shell-body > [ rail + main.rp-main >
  div.rp-surface (+ comments) ]` and mounts each registered component from the spec.
  Spec keys (each optional → slot skipped): `topbar` · `rail` · `surface` (→
  mountSurface: head/chipRow/statStrip/table) · `redtable` (the interactive B3
  RedTable, mounted INTO the surface after the stat strip) · `comments` ·
  `shellHead` ({title, count}) · `wide`. Returns `{topbar, rail, surface, redtable,
  comments}` handles.

ESM. Imports `register` + `get` (registry) + `esc`. Composes only — owns no component markup.

## How it works

- Emits the static outer chain (the part authored in page partials today), then
  `get(name)(slotEl, cfg)` for each present spec section. Components are
  host-becomes-root (rail→`.rp-rail`, surface→`.rp-surface`), so the slot divs
  become the real elements.
- `shellHead` (the Home/Monitoring `.rp-shell-head` title+count band) is emitted by
  the assembler and prepended into the surface — a **proof-layer fill** for a real
  gap: mountSurface has no shellHead section yet (it owns the Cases-style rp-head
  object header instead). The proper fix is a `shellHead` section in mountSurface.
- **SECURITY**: only the `shellHead` title/count are interpolated, via `esc()`; the
  outer chain is static; every component escapes its own content.

## Drift-prone areas / completeness status

Two pages now rebuild from components with **zero legacy class leak** (worked proofs
in `framework-sandbox.html`):
- **Cases detail** — topbar + rail + surface[object head + status chip-row] + comments.
- **Monitoring** (the first LIST page) — topbar + rail + surface[shellHead + window
  chips + composite stat strip] + the interactive **RedTable** (now that B3 landed).

Remaining gate gaps (do NOT fake them — flag + wait for the owner):

- **B3 RedTable + list-toolbar** (interactive table) — Monitoring/Home/Cases list tabs. *(B3 lane)*
- **S4 create-action** — Home/Cases create buttons + create-modal.
- **shellHead section in mountSurface** — Home/Monitoring section header. *(B2 surface lane)*
- **Cases board** (kanban columns) + **detail properties panel** + the board⇄detail mode machine.
- **Profile / Settings / Docs** bespoke UIs (not yet componentized).

When those land, add their specs here + assemble the remaining sandbox page sections.

## Related

- [surface](surface.md) (the head→chip→stat→table assembler this composes) · [rail](rail.md) · [topbar](topbar.md) · [comments](comments.md).
- `frontend/framework-sandbox.html` — assembles the Cases-detail page in the `sbx-cases` section.
- [component-registry](component-registry.md) · [framework index](index.md).
- Gate + gaps tracked on `CAS_37B2E1BF`; downstream consumer: the Figma page-spec/runner plan (`~/.claude/plans/hi-need-a-plan-golden-treasure.md`).
