---
title: Runbooks
section: Internal
order: 60
last modified date: 2026-06-03
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
  this index is `order: 60` (its slot in the Internal-docs section
  listing, not an entry number). Add `case_id: CAS_<rid>` to the
  frontmatter too so it's discoverable via metadata queries.
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
- [0013 — Workspace rail view-switch leaves a wrong-kind file on the surface](CAS_3BCD6727-workspace-rail-view-surface-swap.md) —
  **Resolved 2026-06-01** (CAS_3BCD6727). The Workspace "Data ↔
  Dashboards" rail toggle CSS-filtered the rail rows but only
  *additively* restored the new view's last file in `rp-surface` — so
  toggling to Dashboards with a CSV open left the CSV redtable showing
  ("if a csv file is selected in Data, switching to the dashboard still
  show the csv file"). Fix: `onChange` now ignores the `loadFile`
  rail-sync echo (a `railSyncing` flag wrapping `setRailView`, since
  rail-controls `set()` always fires `onChange`), derives the showing
  view from the `#wsSurface` mode classes (`currentSurfaceView()`, not a
  drift-prone parallel variable), and — when the surface shows the other
  view's content with nothing to restore — clears `activeFileRid` +
  `showLanding()` so a wrong-kind file never lingers. Both chart
  branches now record the `dashboards` restore slot. Discipline rules: a
  view toggle must *reflect* the active view (evict wrong-kind content),
  not just additively restore; read "what's showing" from the DOM; a
  control that fires `onChange` on every `set()` needs a re-entrancy
  guard. Verified live via Playwright (`:8088`, dev-login) across all
  four toggle transitions.
- [0012 — Cell-editor extensions — data-prefix render rule + chip-enum select-overlay editor](CAS_E97414C482AB431FA28D43392501F47B-cell-editor-data-prefix-and-chip-enum.md) —
  **Resolved 2026-05-31** (CAS_E97414C482AB431FA28D43392501F47B).
  Two coordinated extensions to the cell-editor contract that landed
  in CAS_A5A4 (the `data-full` pattern). (1) `data-prefix` render rule
  layers alongside `data-trunc` — Users `username` ships as
  `data-full="sam-rivera" data-prefix="@"`, display shows
  `@sam-rivera`, edit-on strips the prefix so the user edits the bare
  username, edit-off re-applies it. (2) `editor: "chip-enum"` is the
  first non-contenteditable editor type — Users `plan` swaps its chip
  span for a `<select>` populated from `col.options`, change events
  fire save immediately so the PATCH lands without blur. Both
  contracts share the model-view split: `data-full` is the model,
  display is composed via render rules / chip renderer. Discipline
  rule: any derived display (truncation, prefix, formatting, chip
  styling) needs an explicit `data-full` on the TD before being
  flagged editable. Net Users editable surface 3 → 6 cols (gains
  handle, name, plan). Smoke-tested end-to-end on a live user with
  PATCH echo-back verification.
- [0011 — Scrub-retain user deletion (scrub_user_tx + sole-owner blocker + case-membership retention)](CAS_46BA67713EC84871991D3E7475598B47-scrub-retain-user-deletion.md) —
  **Resolved 2026-05-31** (CAS_46BA67713EC84871991D3E7475598B47).
  The pre-fix `db::delete_user` was a hard `DELETE FROM users` that
  CASCADEd every membership (including reporter / case-owner /
  project-owner rows) and broke the audit-retention contract on the
  most-rendered surface — cases. Em's 4-step transaction (sole-owner
  blocker → strip team memberships → destroy auth + prefs → scrub PII +
  `status='archived'`) shipped with one workflow-flagged refinement:
  step 2 skips CAS_% memberships (deleting them makes `CASE_USER_JOINS`
  return NULL and the case detail renders '—' instead of 'Deleted
  User'). Discipline rule: a user's identity rid is a long-lived audit
  handle — `DELETE FROM users` is not a valid path. `ON DELETE CASCADE`
  is correct for structural FKs (project → files) but WRONG for FKs
  that carry historical-reference semantics (case → reporter
  membership). Smoke-tested all 3 paths green: happy 200/204, blocker
  409 + state untouched, retention (`reporter_display_name` flips
  'Will Be Scrubbed' → 'Deleted User').
- [0010 — Cell-editor data-full pattern for truncated long-text columns](CAS_A5A432F1A82A4A4DB0B62C0085C4428C-cell-editor-data-full-pattern.md) —
  **Resolved 2026-05-31** (CAS_A5A432F1A82A4A4DB0B62C0085C4428C).
  Long-text columns on Home tabs (Cases `description` / `error_message`,
  Projects `description`) render via `(value || "").slice(0, N)` and
  put the truncated string directly into `td.textContent`. Flagging
  any of them `editable: true` naively would let the cell-editor's
  PATCH path write the *truncated* display string back to the backend —
  silently overwriting the original 2,000-char description with its
  own first 120 chars. Fix landed: row templates carry
  `data-full="<source-of-truth>"` + `data-trunc="<N>"` on the TD;
  `decorateEditMode` swaps `textContent` to `data-full` on edit-mode
  ON and re-truncates from `data-full.slice(0, data-trunc)` on
  edit-mode OFF; `saveCellEdit` keeps `data-full` in sync after a
  successful PATCH. Discipline rule: any TD whose display value is
  *derived* (truncated / formatted / computed) from the source-of-
  truth MUST carry `data-full` before being flagged `editable: true`.
  Net surface: Cases 1 → 3 editable cols, Projects 1 → 2, Home
  total 5 → 8 across 5 tabs. Smoke-tested end-to-end (the case
  documenting this very fix got live-edited via the new pattern).
- [0015 — Ungated tenant-list read leaks (scope `list_*` to caller reach)](CAS_AF2690C0CD7F4B238A8B462DD08BF4A8-tenant-list-scoping.md) —
  **In progress 2026-06-03** (epic CAS_AF2690C0CD7F4B238A8B462DD08BF4A8). Pattern runbook
  for the cross-tenant *list-read* leaks the "audit the auditor" review found: several
  `GET` list endpoints returned every tenant's rows to any authed caller while the
  singular `get_one` path was correctly gated. Fix pattern: list fn takes a
  `viewer: Option<&str>` scope, route passes `None` for platform-admins else `Some(caller)`,
  query gains a reach predicate mirroring the singular gate. `/events` done (verified by a
  DB partition check: 948 scoped + 949 hidden = 1897 total); `/companies`/`/search`/`/teams`
  append as they land. Discipline rule: a `$1` that feeds only a `my_role` display subquery
  is the "looks-scoped-but-isn't" trap — the row filter must be in the main query.
- [0014 — `/api/metrics` was anonymously readable (global request_log)](CAS_CBA057EE46F24BAD897089D2B9DDBDFC-metrics-anon-leak.md) —
  **Resolved 2026-06-03** (CAS_CBA057EE46F24BAD897089D2B9DDBDFC). `GET /api/metrics` had
  no auth in the handler AND no `.layer()` on its nest, so anyone could read the global,
  tenant-less `request_log` aggregation (error rates, p99, full route inventory). Found by
  the "audit the auditor" review (`wf_afacef54`) — one of 5 read-leaks the SQL-only audit
  missed because it never parsed `mod.rs` nest middleware. Fix: gated the `/metrics` nest
  platform-admin via the same `require_platform_admin_mw` proven on `/admin` + `/monitoring`;
  added `metrics` to the audit's `EXPECT_NEST_GATE` so the gate is now an asserted invariant
  (RED if removed). Discipline rule: an RBAC posture audit must read route-nest `.layer()`
  middleware, not just handler bodies + db SQL — else ungated tenant nests read as a
  YELLOW shrug and gated nests false-positive as leaks.
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
