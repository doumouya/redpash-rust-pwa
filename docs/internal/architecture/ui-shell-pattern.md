---
title: UI shell pattern (`.rp-shell`)
section: Internal
order: 11
last modified date: 2026-05-28
owner: Torv
status: stub
---

# UI shell pattern

> **TODO (Torv).** Stub. Land content with the next workspace doc pass.
> The "Main-area surface convention" section below is filled (Woz
> 2026-05-28) — it's a load-bearing rule the rest of the stub can
> assume.

The rail-page shell used by `/home`, `/monitoring`, and `/docs`. Same
markup, opt-in `--wide` modifier for data-dense pages.

## Main-area surface convention (locked 2026-05-28)

**Rule.** The rail is the constant navigation. The main area shows
**exactly one surface at a time** — a list/board **or** a full-bleed
detail — never both, never an overlay or modal competing for the main
area's space.

The board↔detail swap is a mutually-exclusive `hidden` toggle on two
flex children of the same main container. Reference implementation:
the Cases page (`frontend/scripts/pages/cases.js` `renderRoute`):

```js
// One visible at a time — never an overlay.
detailEl.hidden = !rid;          // detail shows only when a case is open
if (boardEl) boardEl.hidden = !!rid;  // board hides when a case is open
```

Both surfaces are `flex: 1` children of a `display:flex` main; the
hidden one is `display:none` (the `[hidden]` UA default, kept explicit
where a `display:flex` rule would otherwise win). The detail surface
is **flush** — anchored to the main area's edges, `flex:1` fill, only
the top-left corner rounded where it meets the rail + topbar (the
[[chrome-visual-direction]] "rounded top-left where they meet"
pattern) — **not** a `position:absolute` right-side overlay.

**Why.** An overlay or partial-width detail leaves the list visible
behind/beside it — two surfaces fighting for attention (the exact bug
the Cases page shipped with, fixed in `d407ef4`). One-surface-at-a-time
keeps each view focused and makes the eventual RBAC visibility logic
simpler (hide a surface = one `hidden` toggle, not a z-index dance).

**How it maps per page today:**

| Page | List lives in | Detail lives in | Conforms? |
|---|---|---|---|
| Cases | main (board) | main (full-bleed) | ✓ (reference impl) |
| Workspace | rail (projects/files) | main (open file) | ✓ — rail-list + main-detail, no overlay |
| Docs | rail (doc tree) | main (rendered doc) | ✓ — same shape |
| Home | main (list per tab) | — (no row→detail yet) | n/a until detail views land |
| Monitoring | main (list per tab) | — (drill-downs via modal/expansion today) | partial — convert to full-bleed when row→detail is built |

**Forward rule.** When Home or Monitoring rows eventually open an
in-page detail, that detail swaps full-bleed in the main with the rail
constant — *not* a modal, *not* an overlay. Modals stay reserved for
**create** flows + transient confirmations, never for viewing a
record (Em 2026-05-28: "we drastically reduce the use of modals").

To cover:

- The three CSS atoms (`.rp-shell`, `.rp-shell-greeting*`, `.rp-shell-body`, `.rp-shell-main`, `.rp-shell-view`) — what each owns
- The `--wide` modifier — when to opt in vs keep the centred cap
- `.rt-nav` reuse — same component as Workspace's rail; different *semantic* (static groups on Home/Monitoring, dynamic on Workspace)
- The chip-row + list-pager atoms in shell.css — when to use
- How a future page (e.g. Logs, Org) would consume the shell
