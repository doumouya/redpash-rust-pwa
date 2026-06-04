---
title: Coherence collapse plan — ≤1 class per atom (CAS_37B2E1BF)
owner: Torv
section: Internal · UI
last modified date: 2026-06-04
---

# Coherence collapse plan — one CSS rule per element

The execution contract for Em's coherence rule (a MAXIMUM of one framework class
`rp-/rt-/ds-/ws-` + one id per element; state → `aria-*`; container-variant →
ancestor-context; container-independent variant → `data-variant`; identity-stacks
collapse). Produced by the `coherence-collapse-map` workflow (12 read-only mappers +
synthesis + adversarial completeness critic, 2026-06-04). Measured by
[class-count-audit](../code/tools/audit-suite/class-count-audit.md) (multi-class +
state) + `ui-doc-audit` (divergences / parallelClusters / namespaceLegacy) +
`css-cross-page-audit` (leaks).

Already shipped: `rp-settings__tag → rp-chip` (782525a) · Workspace 3 create
buttons → 1 adaptive (bbd82cb) · framework-atom one-class conversion badge/seg/
select/field by another Torv (804467e) · the lint itself (91497a0).

## Why it is one serial campaign, not N independent fixes

The element families share sheets. **`cases.css` (1655 lines) is touched by 7
families** (chip-row, rail-tab, table, title, head, body, dot); `shell.css` by 3;
`rail.css`/`framework/rail.css` by 5; `framework/table.css` by table+dot;
`atoms.css` by title+head+dot. A file touched by multiple families MUST be edited
in one coherent pass or the edits clobber each other. So execution is **file-
contention-ordered**, and `cases.css` is finalized in ONE sweep at the end.

## Execution order (collision-safe, leverage-per-risk)

1. **title** (L8/R2) — `rp-title` is already canonical (`atoms.css:174`). Collapse 30
   `*-title` classes → `rp-title` + byte-identical ancestor-context overrides
   (`.rp-chart-card .rp-title`, `.rp-rail-head .rp-title`, `.rp-shell-head .rp-title`,
   `.rp-dash-tile-head .rp-title`, …). Look-preserving. First because it opens the big
   shared sinks (shell/surface/rail/chart/panel/dashboards) and establishes the atom
   head/body compose. Stage `cases.css` title edits to pass 6.
2. **chip-row** (L7/R4) — `framework/chip-row.css` is canonical; delete `shell.css`
   dup; rename the **mislabeled** `rp-cases-chip-row` (it is a column WRAPPER, not a
   row variant) → `rp-cases-rail-filter-chips`; the `done-window` variant → `data-`
   attr **in lockstep** (CSS selector + JS must change together). Stage cases.css to 6.
3. **head** (L6/R5) — 41 `*-head` → one + ~12 ancestor-context. Needs title landed
   (`.rp-head .rp-title` context). `head.js`: `is-copyable`→`data-copyable`,
   `is-editing`→`data-editing`.
4. **body** (L6/R7) — `*-body` → ancestor-context. **GUARDRAIL:** `rp-modal-body` /
   `rp-shell-body` / `rp-surface-body` are layout FRAMES, NOT scroll bodies — do NOT
   fold them into the body atom. Fix dead-token ids first.
5. **table** (L7/R6, highest blast radius) — `rt-table` → `rp-table`/`rp-redtable` (9
   JS files); delete legacy `frontend/styles/table.css`. **CASCADE TRAP (critic):** do
   NOT just strip `rp-table` off `rp-redtable` markup — the base rules (border-collapse,
   tabular-nums, thead/tbody padding/border/hover, is-selected) live in `rp-table.css`
   and are NOT duplicated in `rp-redtable.css`; either keep both classes as a justified
   semantic-hook pair or port the base verbatim first + verify. Must precede dot.
6. **rail-tab + dot, MERGED + the single `cases.css` sweep** (L7/R6+) — dot has no
   independent files (every dot edit is a line-subset of rail-tab/table/cases). Create
   `rp-dot` atom; `rp-rail-tab-dot`→`rp-dot[data-variant=stage]`,
   `rp-priority-dot`→`[data-variant=priority]`, `rp-cases-status-dot`→`[data-variant=status]`.
   Migrate `.active`→`[aria-selected]` across rail.js + 5 page JS **with dual-selector
   coexistence** (both selectors in CSS during the JS rewire, or pages break mid-flight).
   This pass closes out all 7 families' `cases.css` edits in one coherent sweep.

Then the long tail (empty/count/label/panel/predicate/divider/spinner/caret → one
rule each), the **button** sweep (`rt-btn`/`--glass`/`--accent`/`rt-mode`/`rt-pill`
→ `rp-btn`/`rp-btn-icon` + data-variant — biggest namespaceLegacy burndown), and the
27 css-cross-page leaks (settings/profile bespoke modals → framework `rp-modal`).

## Projected end-state (if the whole plan runs)

Divergences ~110 cataloged → ~30 genuinely context-forced overrides kept (rail-width,
compact-mode, detail-path-wrap, chart-tile-narrow). parallelClusters: title 34→1,
head 41→1+12, dot 5→1+variants. namespaceLegacy: full `rt-/ds-/ws-` burndown across
rail/chart/panel/table/card/workspace; legacy `table.css` deleted → ~0 in swept files.
multiFrameworkClass: redtable.js + cases.js:142 + cases.js:741 resolved.

## Critic guardrails (MUST honor — these are cascade-breakers if ignored)

- **table base styles**: `rp-redtable` does not duplicate `rp-table`'s base — see pass 5.
- **lockstep CSS↔JS**: any class→`data-*`/`aria-*` migration changes the CSS selector
  AND the JS markup in the SAME commit, or styles silently stop applying (chip-row
  done-window, rail-tab aria-selected). Pick ONE attribute name (`data-variant` vs
  `data-role`) and use it on both sides.
- **state-class migration is app-wide, not partial**: 131+ `is-*` (`is-dirty`/`is-clean`/
  `is-warn`/`is-selected`/`is-asc`/`is-sorted`/`is-backlog`/`is-todo`/`is-done`/…). A
  family's state→aria/data migration must convert ALL of that family's states or it
  orphans CSS rules. Do the multi-page JS rewires (workspace/cases/docs/profile/home) in
  one phase with dual-selector coexistence.
- **verify deletes are identity-preserving**: before deleting a `shell.css`/`table.css`
  duplicate, diff it against the canonical — if values differ, the divergence is real and
  must be ported as context, not dropped.
- **incomplete-spec families** the mappers under-specified — finalize their collapsePlan
  at execution time from the live audit: **rp-chip (the most divergent atom, 9 contexts)**,
  **rp-btn**, **rp-btn-icon**, rp-avatar, rp-comment-*, rp-dash-*, body, dot.

## Verification per pass

Look-preserving passes → `?audit=1` parity + byte-identical context overrides + the audit
deltas (divergence/parallel/legacy ↓) + 0 console errors. Convergence passes (look
intentionally changes) → Em's visual nod. ALWAYS verify the **live cascade** (the
ancestor-context rule actually out-specifies the atom) on a freshly-queried, attached
element — a re-rendered/detached node reads stale computed styles. Commit per pass with
`-o` named files; push on Em's confirm.

## Related

- [class-count-audit](../code/tools/audit-suite/class-count-audit.md) · [ui-doc-audit](../code/tools/audit-suite/ui-doc-audit.md) · [css-cross-page-audit](../code/tools/audit-suite/css-cross-page-audit.md)
- Plan file: `~/.claude/plans/hi-need-a-plan-golden-treasure.md` · raw workflow map: run `wf_782b371f-72f`.
