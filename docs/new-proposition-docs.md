New proposition based on the capabilities of the new tool.
Plan:
- Establish the "fuller-version" possible of each group of components in the UI
- Describe the version available on each page

- REST API (already restructured)
- Auth
    - Google
    - Dev-User
- DB
    - Full Schemas
        - Each object details (object schema, fields detailed informations)
    - RBAC
        - Entity
        - Memberships
        - Teams
- Stack
    - Front-End
    - Back-End
    - Tools
    - DB

- TopBar (Same on All Pages)
    - Icon Logo
    - Welcome User message
    - OmniSearch
    - Nav Links (quick summary of each pages purpose)
        - Home
        - Workspace
        - Cases
        - Monitoring
        - Toggle Theme
        - Logout

- Rail Nav ("Fuller" version currently possible)
    - Rail View (tabs, ie: Data-DashBoards in Workspace, Monitoring-AdminConsole in Monitoring)
    - Search Input
    - Filters
    - Overview
    - Tabs [for Objects (ie: Projects, Cases, etc), or Sections (ie: Admin, Audits)]
        - Sub-Tabs [ie: Objects' Assets (Project's files) or Related Objects in the section (ie: Runs, Findings)]
    - Hide/Restore
    - Upload Files
    - Create Objects
    - Rail Footer (Same on all pages)
        - Docs
        - Settings
        - Profile

- Main
    - ObjectID (ie: rp-cases-detail-rid)
    - Title (ie: rp-shell-title)
    - Filters (rp-chip-row)
    - Charts and Stats (rp-hero-strip, rp-list-composite)
    - Kanban view
    - RedTable (Full-Version in Workspace)
        - Left Panel (dual tabs)
            - Filter
                - Predicates
                    -Describe all sub components in predicates
                - Clear
                - Apply Filter
            - Report
                - Undo-Redo
                - Describe all sub components in report panel
        - Toolbar
            - Search
            - Edit mode
            - Select mode
            - Delete mode
            - Undo
            - Redo
            - Refresh
            - Rows Per Page
            - Columns
            - Export
            - History
        - Right Panel
            - Clean
                - Describe all elements/tools (Snake-Case, Columns redtable, etc)
            - Joins
                - Describe all elements here also in details
        - Pagination
    - DashBoards
        - Full Details of the available components also (List of Charts, Tiles, Everything in the right Panel, etc)

---

# Confirmation — 2026-06-04 (representative slice)

> Method: captured the **live rendered DOM** of every page via the extended
> `?audit=1` walker (`frontend/scripts/audit/snapshot.js` now dumps the full
> `classList` inventory, not just the 12-atom catalog), driven with Playwright,
> ingested by `tools/ui-snapshot-audit/audit.js` → `component-map.md`. This sees
> what static CSS/partials can't — JS-built and `display:none`-present
> components. 7 routes, dark theme. Regenerate: run the app, Playwright-navigate
> `localhost:8080/?audit=1` through the pages, `node tools/ui-snapshot-audit/audit.js`.

## Q1 — Can these component groups rebuild every page? **Partly. Not yet.**

The vocabulary cleanly composes the **data-centric pages** but **misses ~5
pages' worth of groups**. Rendered class counts (live DOM):

| Page | Distinct classes | Composes from vocabulary? |
|---|---|---|
| workspace | 166 | ✅ **fullest** — TopBar + Rail + Main + full RedTable |
| cases | 149 | ⚠️ TopBar + Rail, but Kanban + Detail + Composer + Activity are **not in the vocabulary** |
| home | 130 | ✅ TopBar + Rail + Main (chip-row + composite + table + pager) |
| settings | 108 | ⚠️ TopBar + Rail; pref-driven **form rows** + search-shell not covered |
| monitoring | 103 | ✅ TopBar + Rail + Main (window chips + composite + table) |
| profile | 100 | ⚠️ TopBar + Rail; **identity/plan/connections cards** + form rows not covered |
| docs | 36 | ⚠️ TopBar + Rail; markdown **doc-viewer** body not covered |

**RedTable is the proof the vocabulary is real**: Workspace renders the full set
of foundation atoms the proposition's "Main → RedTable" describes —
`rt-table-wrap` · `rt-toolbar` (`--data`/`--designer`) · `rt-panel`
(`--filter`/`--history`/`--tools`) · `rt-panel-tabs` · `rt-report-builder` ·
`rt-designer` · `rt-mode` · `rt-pager` · `rt-search`. Home/Monitoring render the
**reduced** version (table + pager + chip-row, no left/right panels).

**Vocabulary gaps to add before a full rebuild** (rendered, JS-only — a static
pass would have missed these): **Detail panel** (`rp-cases-detail` +
`rp-cases-detail-side`) · **Kanban** (`rp-cases-col`/`rp-cases-card`) · **Rich
composer** (`rp-cases-composer`) · **Activity feed** (`rp-cases-activity-list`) ·
**Form/section + pref rows** (`rp-page__section` + `page-row.js`) · **Identity /
plan / connection cards** (`rp-profile__*`) · **Auth/demo surface**
(`rp-login__*`) · **Docs viewer** (`rt-group` rail + markdown body).

## Q2 — The CSS-name divergence (same component, different names, which page)

From the live DOM (`tools/ui-snapshot-audit/component-map.md`, regenerable):

**Foundation shadows — `rp-*` rendering as a foundation concept that should be `rt-*`:**

| Rendered class | Should be | Renders on |
|---|---|---|
| `rp-surface` | `rt-surface` | all 7 pages |
| `rp-main` | `rt-main` | all 7 pages |
| `rp-chip` | `rt-chip` | cases, home, monitoring, workspace |
| `rp-chip-row` | `rt-chip-row` | cases, home, monitoring |
| `rp-avatar` | `rt-avatar` | profile |
| `rp-btn` | `rt-btn` | profile |

**Title — one logical role, 11 rendered class names across pages:**

| Class | Pages |
|---|---|
| `rp-shell-head-title` | home, monitoring |
| `rp-page__title` | profile, settings |
| `rt-nav-title` | all 7 (rail) |
| `rt-panel-title` | workspace |
| `rp-chart-title` | home, monitoring, workspace |
| `rp-cases-detail-title` | cases |
| `rp-modal-title` | cases, home |
| `ds-title` / `ds-config-title` | workspace (designer) |
| `ws-landing-section-title` | workspace |
| `rp-settings__mon-chart-title` | settings |

→ Same "title" concept fragmented across `rt-*-title`, `rp-*-title` (hyphen),
`rp-*__title` (BEM), and bare `ds-*`/`ws-*` page prefixes. Consolidation target:
one `rt-title` (+ context modifiers). The source-side `css-tab-compare-audit`
corroborates the scale (**115 `rp-*` page classes ≥0.50 similar to `rt-*`
atoms**); the rendered capture above is the ground-truth subset.

**Healthy signal**: 39 `rt-*` foundation atoms already render shared across ≥2
pages — the consolidation has a real base to grow into; 407 distinct classes
total is the surface to converge.

## Follow-ups (not this slice)
- Capture **interactive states** (open modals/dropdowns created-on-click, edit/
  select/delete modes, kanban drag) + **light theme** + responsive — deeper than
  the default-mount inventory (which already catches `display:none`-present
  components).
- Extend `css-tab-compare-audit` to all-page-pairs aggregation for full
  source-name attribution alongside the rendered set.
- Add the ~8 missing component groups to the vocabulary above, then this doc
  becomes a complete rebuild blueprint.