---
title: Runbooks
section: Internal
order: 60
last modified date: 2026-05-24
---

# Runbooks

> **Internal — RedPash team only.** This section is not part of the
> public product documentation.

A log of real problems hit in RedPash — diagnosed, root-caused, and
fixed. Each entry is a short post-mortem in five parts so the
*reasoning* survives, not just the patch.

The Runbook is the human-written companion to the
[Events](../../api/events.md) system: Events captures *what* failed at
runtime; the Runbook captures *why* it failed and *how it was fixed*.

## Entry format

Every entry follows the same five headings:

| Section | Answers |
|---|---|
| **Problem Statement** | What was observed — the symptom, and who or what surfaced it. |
| **Troubleshooting steps** | What was checked, in what order, and what each step showed. |
| **RCA** | Root-cause analysis — the *underlying* cause, not the symptom. |
| **Solution** | What changed, what was deferred, and how to prevent a recurrence. |
| **Post Checking** | How the fix was verified once it landed — what was re-tested or monitored to confirm the problem is actually gone, plus any follow-up left watching. |

## Conventions

- One file per entry. From `0007` onwards entries are named
  `CAS_<rid>-<short-slug>.md` so the runbook is findable by case ID in
  the filesystem the same way it's findable in the cases system
  (per the [bug→case→runbook cadence](../processes/bug-case-runbook-cadence.md)).
  Legacy entries `0001-0006` keep their pre-Case-object `NNNN-<slug>.md`
  numbering for historical continuity; do not renumber them.
- `order` in the frontmatter is the entry number (sequential, padded);
  this index is `order: 0`. Add `case_id: CAS_<rid>` to the frontmatter
  too so it's discoverable via metadata queries.
- Write the entry when the fix lands, while the context is still fresh.
- Link the commit(s) and any related Events `kind` so a reader can pivot
  to the live data.
- Keep it honest: record what was *deferred*, not just what was fixed.

## Entries

- [0001 — Orphan preferences](0001-orphan-prefs.md) — Settings controls
  that persisted a choice no code ever consumed.
- [0002 — Stale join after a table drop](0002-stale-join-after-drop.md) —
  `/api/projects` 500'd after Phase 2 dropped `dashboards`;
  `PROJECT_SELECT`'s published-status subquery still joined the dropped
  table.
- [0003 — Dead reference after function deletion](0003-dead-reference-after-deletion.md) —
  WS#2 swept out `refresh()` but missed its tail-call inside
  `rebuildFilterCols`; every tab pick on the Workspace threw
  ReferenceError into "Couldn't load file." Discipline rule: grep for
  function NAMES AS CALLS across the codebase, not just at the
  semantic call sites you reasoned about.
- [0004 — Unescaped apostrophe blanks the page](0004-unescaped-apostrophe-blanks-page.md) —
  `it'll` inside a single-quoted JS string closed the literal early;
  the `/docs` page failed at parser time with "unexpected token:
  identifier" and rendered the generic mount-failure shell.
  Discipline rule: use the curly U+2019 (`'`) for contractions in
  single-quoted strings — the convention the rest of the file
  already uses.
- [0005 — ECharts `colorBy` default paints every bar the same colour](0005-echarts-colorby-series-default.md) —
  fresh `redpash-mocha` theme with 8 palette colours, but every bar
  on the Profile usage chart painted `palette[0]`. RCA: ECharts
  defaults `colorBy` to `"series"`, not `"data"` — a single bar
  series of N categorical points gets one colour for the whole
  series. Discipline rule: when registering a multi-colour theme,
  set `colorBy: "data"` on any series whose points are distinct
  categories (bar / line / scatter); the default works only for
  multi-series overlays.
- [0006 — Spec-only file types leak into data-file code paths](0006-spec-only-file-types-in-data-paths.md) —
  EISDIR 500s + `not_a_data_file` 400s when the workspace touched a
  dashboard rid via data endpoints. Root cause: `project_files` is a
  polymorphic carrier table (csv / chart / dashboard share the table;
  charts + dashboards carry empty `storage_path` because the payload
  lives in the `spec` JSONB column). Every consumer that implicitly
  assumed "every `project_files` row → CSV blob" was a latent bug.
  Fixed at four layers (hydrate guard / get_summary short-circuit /
  FE data-panel scope / joins sibling SQL filter). Discipline rule:
  prefer positive-form `file_type = 'csv'` queries over negative-form
  exclusions — future spec-only types (notebook, saved query) inherit
  the exclusion automatically.
- [0007 — Column drag-reorder cluster (4 layers)](CAS_2C692011AD2C41E88A7C2541EF30AE1E-column-drag-reorder-cluster.md) —
  **Resolved 2026-05-31** (CAS_2C692011AD2C41E88A7C2541EF30AE1E).
  Four interrelated bugs in the Home/Monitoring list-page column drag-
  reorder feature, peeled one layer at a time on 2026-05-31:
  applyColumnOrder early-returning on misaligned thead/tbody, the
  drop-indicator visually collapsing at the first/last column edge,
  appendChild shoving the trailing sentinel TH to position 0, and
  decorateEditMode tagging cells by spec position instead of live DOM
  position. Discipline rules: read positional state from the DOM not
  from the spec; never `appendChild` in a loop when the parent has
  framing children; drop indicators need overhang at row edges; for
  drag-and-drop column features, *always* verify live in a browser
  (Playwright MCP is the parallel option when chrome-devtools-mcp is
  locked). Filed the cadence this entry follows in
  [processes/bug-case-runbook-cadence.md](../processes/bug-case-runbook-cadence.md).
- [0008 — MCP cases bridge needs auto-refreshing session](CAS_097E36B6F6904E429401F4951A54BA9B-mcp-cases-session-auto-refresh.md) —
  **Resolved 2026-05-31** (CAS_097E36B6F6904E429401F4951A54BA9B). The `tools/mcp-server` cases bridge used
  to pin `REDPASH_API_SESSION` from `~/.claude.json` env at startup
  and use it as the `rp_session` cookie indefinitely; when the cookie
  expired or was invalidated, every Torv's `case_create` /
  `case_list` returned HTTP 401 silently until someone hand-edited
  the JSON and restarted Claude Code. Fix landed: `apiFetch` lazily
  mints via `POST /auth/dev-login` when env is unset, and on a 401
  re-mints + retries the same request exactly once. A `mintInFlight`
  promise coalesces concurrent retries so dev-login never stampedes.
  Smoke-tested all four code paths (no-env-cold / no-env-warm /
  stale-env-warm / stale-env-cold) against the live backend.
  Discipline rule: any MCP bridge that wraps an auth-gated HTTP API
  needs a refresh path — lazy init + retry-once-on-401 is the floor.
- [0009 — dev frontend edits don't show up (static assets ship no cache-control)](CAS_35090747FD78414D8CD060A73181A414-dev-static-assets-no-cache-control.md) —
  **Resolved 2026-05-31** (CAS_35090747FD78414D8CD060A73181A414). The `ServeDir` static fallback emitted
  `last-modified` but no `cache-control`, so browsers applied heuristic
  freshness (~10% of the file's age) and served stale CSS/JS after an
  edit without ever issuing the conditional GET — masquerading as "my
  edit didn't save" and blocking interactive verification more than
  once. Fix landed: a debug-gated `SetResponseHeaderLayer` puts
  `cache-control: no-cache` on the static fallback (wrapping the
  *service*, not the router, so `/api/*` stays uncached), re-arming
  ServeDir's existing `last-modified`/304 path. Verified live: header
  present, conditional GET → 304, `/api/*` unaffected. Discipline rule:
  `no-cache` ≠ `no-store` — `no-cache` keeps the 304 fast-path, only
  forcing revalidation; reach for it over `no-store` when an upstream
  already supports conditional requests.
