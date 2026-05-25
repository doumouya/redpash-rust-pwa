---
title: Cases — detail panel UI
section: Internal
order: 30
last modified date: 2026-05-25
owner: Woz
status: filled
---

# Cases — detail panel UI

The `/cases` page surfaces the kanban board (one column per status)
plus an overlay detail panel that slides in from the right when
`#/cases?id=CAS_…` is in the hash. This doc covers the **detail
panel** specifically — the UI restructure shipped 2026-05-25
(`4fbafe4`) replaced a 3-tab vertical stack with a two-column
layout that makes the comments thread the primary work surface and
the metadata sidebar always-on.

Source of truth: `frontend/partials/cases.html`,
`frontend/styles/cases.css`, `frontend/scripts/pages/cases.js`.

Related docs: [`internal/cases/agent-cookbook.md`](../cases/agent-cookbook.md)
(HTTP API recipes), [`features/cases`](../../features/cases.md) (TODO —
feature-level overview).

---

## Structure

```
.rp-cases-detail            position:absolute, slides over the kanban
├── .rp-cases-detail-head   rid · title (truncated, full in title=) · ✕
└── .rp-cases-detail-body   flex-row
    ├── .rp-cases-detail-main      flex:1 — comments + sticky compose
    │   ├── .rp-cases-comments-list   flex:1, overflow-y:auto
    │   └── .rp-cases-comment-form    flex-shrink:0, autosize textarea
    └── .rp-cases-detail-side     flex:0 0 14rem — sidebar, overflow-y:auto
        ├── .rp-cases-detail-edit     stack of label+control rows
        │   ├── Status select
        │   ├── Priority select
        │   ├── Type select
        │   └── Assignee picker
        ├── dl.rp-cases-detail-side-meta   Reporter / Opened / Updated
        ├── details#rp-cases-side-desc      Description (auto-open if populated)
        └── details#rp-cases-side-activity  Activity (collapsed by default; filter pills + feed inside)
```

Width: `min(45rem, 70vw)` — bounded so wide screens don't waste
half the viewport; narrow screens get a near-full-screen overlay.

## Why two columns

Three forces collapsed the previous design:

1. The old layout stacked a heavy overview (title, read-only chip
   row, info row, big "Advance status" button) on top of a 3-tab
   strip (Comments / Activity / Case details). The overview ate
   ~150-200px before the tabs even started, squeezing the comments
   thread — the primary work surface — into a thin band.
2. Three different surfaces mutated the same status: the read-only
   chips above (display), the Details tab's editable selects
   (mutation), and the Advance button (one-click forward). This is
   the [[feedback-unify-behavior-not-names]] anti-pattern — one
   role, three implementations.
3. The Case details tab was a definition-list reference card
   duplicating most of what the inline meta already conveyed.

Two-column collapses all three: the sidebar is the **single
mutation surface**. Editable selects + the assignee picker live
there; the read-only chip-row + the Advance button + the DL card
all retired.

## Narrow-viewport fallback

```css
@media (max-width: 40rem) {
  .rp-cases-detail-body { flex-direction: column; }
  .rp-cases-detail-side {
    flex: 0 0 auto; max-height: 50%;
    border-left: 0;
    border-bottom: 1px solid var(--rp-border);
  }
  .rp-cases-detail-side .rp-cases-detail-edit {
    flex-direction: row;
    flex-wrap: wrap;
    gap: 0.5rem 0.75rem;
  }
}
```

When the panel is narrower than ~40rem (handset widths after the
70vw cap kicks in), the body flips to a column: sidebar takes a
half-height top strip with the edit-row chips laid out horizontally,
and the comments thread takes the bottom half.

## Sidebar discipline

The sidebar packs four atoms into a 14rem column. Each section has
a job:

1. **Edit controls** — `.rp-cases-detail-edit` hosts label+select
   pairs for status / priority / type, plus the assignee
   chip-button → picker pattern. **Width:100%** on the controls so
   the column reads as a uniform stack regardless of label width.
   Selects fire sparse PATCHes (`/cases/:rid { status: … }`) on
   change. No "Save" button — every field commits on mutate.
2. **Meta** — `.rp-cases-detail-side-meta` is a dl with three
   label/value pairs (Reporter / Opened / Updated). Values are
   right-aligned with `text-overflow: ellipsis` so long display
   names don't bleed into the labels. Read-only.
3. **Description** — native `<details>` with rotating `›` marker.
   JS sets `sideDescDetails.open = !!c.description`, so an empty
   description renders the section in collapsed state with a
   muted "— no description —" body; a populated description opens
   automatically. Pre-wrap, word-break — long lines wrap inside
   the column.
4. **Activity** — also a native `<details>`, closed by default
   (the feed can be long, users come for comments). The filter
   pills (All / Comments / Status / Assignment / Edits) and the
   feed `.rp-cases-activity-list` both live inside the section.
   Activity items collapse to a vertical stack inside the
   sidebar via a CSS override — the base `.rp-cases-activity-item`
   grid is 16.25rem (8.75 + 7.5 + 1fr) which overflows the 14rem
   column. Stacked: kind tag → time muted → message.

## Things deliberately removed

The restructure dropped CSS + JS that no longer had a consumer:

| Removed | Why |
|---|---|
| `.rp-cases-detail-overview`, `.rp-cases-detail-thread`, `.rp-cases-detail-tabs`, `.rp-cases-detail-tab` family | the vertical stack + 3-tab strip is gone |
| `.rp-cases-detail-controls` + the centered chip row | read-only chips were the duplicate of the editable selects |
| `.rp-cases-detail-info` + the inline meta strip | superseded by the sidebar's dl |
| `.rp-cases-detail-action` + `.rp-cases-advance-btn` | the status select cycles forward; the big button was the third mutation surface |
| `.rp-cases-details-dl`, `.rp-cases-details-pre`, `.rp-cases-details-error` | DL reference card retired (every field covered by sidebar) |
| `.rp-cases-chip` / `--status` / `--type` / `--priority` family | only consumer was the centered chip row; kanban card uses `priorityDotHTML` + plain text, not chips |
| `statusChip`, `typeChip`, `priorityChip` JS helpers | only consumer was the chip row paint |
| `renderDetailsDl(c)` | DL card removed |
| `currentDetailCase` module-scope var | only the advance button read it |
| Tab-switch click handler on `#rp-cases-detail-tabs` | no tabs |
| Advance-button click handler | no button |

`ADVANCE_LABEL` (verb-based "Move to Todo" / "Start working" / …
lookup) **stays** — the kanban card chevron tooltip still uses it
to name the next status. Single-consumer is fine.

## File summary

| File | Role |
|---|---|
| `frontend/partials/cases.html` | static markup for the page + detail panel scaffold |
| `frontend/styles/cases.css` | layout, sidebar atoms, sidebar-scoped activity-item override, narrow-viewport fallback |
| `frontend/scripts/pages/cases.js` | board paint, detail loader (`loadCaseDetail` / `paintDetail`), assignee picker, comment compose + submit, activity render |

`paintDetail(detail)` is the single repaint path — it sets the
title (+ tooltip), all four edit controls, the meta values, the
description body + auto-open state, the activity count in the
summary, and renders comments + activity. Called on initial load
and after every mutation (`postComment` / `patchCase` both call
`loadCaseDetail` to re-fetch + repaint).

## Open lanes

- **Comments composer** — Em wants a small text-editor with bold /
  italic / code / bullet / link affordances. Coordination pending
  with Gus (storage / render / sanitization shape) — see the
  16:55 thread on `/Internal-Slack/Gus.md`. When the markdown
  render lands, the comment body changes from `<pre>esc(body)` to
  `innerHTML = body_html`, and the composer grows the toolbar.
- **Avatar atom extraction (A2)** — `userAvatarHTML` is currently
  inline in `cases.js`. Deferred to Torv's WS#5 cleanup lane;
  generic `.rp-avatar` collides with the topbar's simpler variant,
  needs a naming-collision call.
- **Chip atom rename (A1)** — the existing `.rp-mon-method` chip
  atom is the generic small-read-only-label across all pages, but
  its `mon-` prefix lies. Torv's WS#5 lane targets renaming to
  `.rp-badge`. Cases inherits the rename when it lands.
