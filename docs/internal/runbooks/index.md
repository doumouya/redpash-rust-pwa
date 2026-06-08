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
- [0018 — DB Console query masks the real SQL error as "transaction is aborted"](CAS_DF1FB40749374EDDA88F11081105DC7A-db-console-query-error-masking.md) —
  **Resolved 2026-06-07** (CAS_DF1FB40749374EDDA88F11081105DC7A). Found by
  dogfooding our own Postgres connector against our own DB (the Admin DB Console).
  A typo / unknown-relation query returned "current transaction is aborted" instead
  of `relation "…" does not exist`, because `postgres_loader::query` ran
  `describe(sql)` **inside** the read-only txn and swallowed its error — the failed
  describe aborted the txn, then the follow-up fetch reported the generic mask.
  Fix: run `describe` **before** `BEGIN` and surface its error (Parse+Describe is
  side-effect-free; the READ-ONLY txn still guards the fetch). Cross-schema query
  works; column order preserved; regression assertion in the dogfood test.
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
- [0016 — MySQL connector NUL byte from `CAST(geometry AS CHAR)` aborted `insert_file`](CAS_082A124FC4F7499CAD3805C267DE3437-mysql-connector-nul-geometry.md) —
  **Fixed 2026-06-05.** Pulling a geometry/binary MySQL table crashed the upload:
  `CAST(geometry AS CHAR)` emits WKB bytes full of NUL (U+0000), which Postgres
  `text`/`jsonb` cannot store, so `insert_file` aborted ("unsupported Unicode escape
  sequence"). Fix: type-aware projection (geometry→`ST_AsText`, binary→`HEX`) + a NUL-strip
  in `csv_field`; plus the `information_schema.DATA_TYPE`-as-BLOB CAST and a FE pull-error
  alert. `ec06e18` / `10ef2fa`.
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
- [CAS_A968E1D0 — MySQL connector silent data loss: FLOAT truncation + spatial SRID drop](CAS_A968E1D0F8E6421A8129F9DDF274DA63-mysql-typefidelity.md) —
  **Resolved 2026-06-07** (CAS_A968E1D0F8E6421A8129F9DDF274DA63). An empirical MySQL 8.4.9
  bench audit of `mysql_loader::project_expr` found two silent-data-loss gaps: FLOAT via
  `CAST AS CHAR` shows only ~6 sig digits (can't round-trip binary32) → now
  `CAST(CAST(.. AS DOUBLE) AS CHAR)`; spatial `ST_AsText` drops the SRID (4326 ≡ 0) → now
  EWKT `CONCAT('SRID=',ST_SRID,';',ST_AsText)`. Storage-layer losses no projection can
  recover were documented as a contract (JSON MySQL-normalized, CHAR trailing-space stripped,
  BIT width, SET definition-order, TIMESTAMP UTC). Verified live: `0.3333333432674408` vs
  `0.333333`; `SRID=4326;…` vs `SRID=0;…`. Discipline rule: every projection arm must end in
  a string type (CHAR/HEX/CONCAT) — `run()` decodes columns as `Option<String>`; a bench
  mysql-CLI audit hides this because the CLI prints every type as text.
- [0017 — Chart designer/builder render raw: JS emits retired `ds-*` classes after the dedup renamed CSS to `rp-dash-*`](0017-designer-ds-class-drift.md) —
  **Resolved 2026-06-07** (CAS_AACB45C0339F4DD68C0D140C4F392509). The dashboards dedup
  (`c282646`) renamed the designer/dashboard CSS `ds-*`→`rp-dash-*` and deleted `chart.css`,
  but five JS/HTML emitters still shipped `ds-*` — so `.ds-chart` never got `height:100%`
  (empty chart preview) and the config controls were unstyled. Renamed the emitters to
  `rp-dash-*` (`ds-empty`→`rp-empty` atom; `ds-title`→`rp-title`), and added the
  `tools/retired-class-audit` gate so a half-migration (CSS renamed, emitter not) fails the
  audit, not the user. The gate immediately surfaced two emitters a manual sweep mis-attributed.
  Discipline rule: a class-family rename isn't done until the **emitters** move too — gate it.
- [0019 — Workspace Dashboards path stripped (Slice D / D2): designer + view-toggle removed, CAS_3BCD6727 deleted structurally](0019-workspace-dashboards-strip.md) —
  **Done 2026-06-07** (Slice D / D2, CAS_3BCD6727). With the designer on its own `#/dashboard`
  page (D1), Workspace's in-page Data↔Dashboards toggle + designer mount + chart/dashboard
  flows were deleted (~515 lines): Workspace is now a pure data-redtable. The rail lists data
  files only; a per-row "Visualize" glyph deep-links a CSV to `#/dashboard?source=<rid>`; the
  rail-foot button is New Project. Removing the opposite-view surface **deletes the
  CAS_3BCD6727 re-entrancy bug structurally** (no swap, no echo) — supersedes runbook 0013.
- [0020 — Slice D / D0': Workspace + Dashboard adopt the framework mountRail (not a new project-rail.js); regressions caught by adversarial verify](0020-d0-mountrail-adoption.md) —
  **Done 2026-06-07** (Slice D / D0'). A pre-work map found `framework/rail.js` `mountRail` is
  already the canonical rail (admin/sheetwise/database), so a new `project-rail.js` would have been
  a 3rd parallel rail; instead Dashboard then Workspace adopted `mountRail`. A 15-agent adversarial
  verify + Em's live eye caught 10 regressions vs the hand-built rails (all fixed): the headline was
  per-tab affordances emitted as `rp-btn-icon` nested `<button>`s (oversized, invalid) — fixed by
  bare `<span>`s like Monitoring/cases. Lesson: an UNEXERCISED framework path is a latent trap;
  adopting a shared component on a richer page is a verification event.
- [0021 — Rail search returned nothing for an exact file name (project-only match); made file-aware](0021-rail-search-file-aware.md) —
  **Done 2026-06-07.** Post-D0' the rail's `buildGroups` matched the query against project names
  only, so typing an exact file/chart name emptied the rail (Em, both Workspace + Dashboard).
  Fix: file-aware `buildGroups` (group shows on project-name OR file-name match; file-only match
  shows the group expanded with just the hits) + a global `ensureAllFilesLoaded()` so files inside
  not-yet-expanded groups also match. Lesson: search over a lazily-hydrated list must hydrate the
  whole collection first — otherwise it silently covers only the loaded slice.
- [0022 — User surfaces read admin endpoints; object lists move to the registry, shaped by the data engine](0022-admin-scope-registry-list.md) —
  **Admin-scope lane DONE 2026-06-08 — `admin-scope-audit` → 0 user-surface leaks (exit 0).** Home + pickers
  read `/admin/*` (all-rows, admin-gated) for what should be the caller's RBAC reach. Built
  `tools/admin-scope-audit` (40-leak worklist + gate). Em's architecture: route user lists through the object
  registry (`ListProviderRegistry` reach providers → `GET /api/objects/:type`) + shape in the data-engine wasm
  client-side ("one engine"). S1 (backend, 6 reach providers + paginated handler, live-smoke-verified, `a34db97`)
  + S3 (frontend repoint: pickers + Home DATA & ORG tab reads → `/objects/:type`; admin writes kept + audit
  `ALLOW{}`-documented; `21f94d9`/`9894898`/`299ad3f`). DEFERRED (documented): memberships user-scoping (edge),
  client-derived gauges, the dashboard Overview (Lane 2). Lessons: reach-scope `all_count` not `count_total`;
  writes default to `spec.endpoint` so repointing a read needs an explicit admin write endpoint.

- [0023 — polars 0.54 would not compile for wasm32 (tokio→mio); fixed via the RedPash polars fork](0023-polars-0.54-wasm-fork.md) —
  **wasm "one engine" restored on polars 0.54.** 0.54's async/cloud/streaming machinery made `polars-async`
  (tokio multi-thread + `std::thread`) an unconditional dep of `polars-core` and wove `ASYNC`/async byte-sources
  through the eager scan path, dragging tokio `net`(→mio) + `rt-multi-thread` onto `wasm32-unknown-unknown` (48 mio
  errors). Fix = thin fork `doumouya/polars-rp` @ `0bb178d6` (~110 lines / 11 files): keep the async paths
  *compiling* (runtime-guarded, never reached on wasm) + remove the wasm-fatal leaves — drop `streaming` from csv,
  target-gate the unused/file/net tokio deps off wasm, and give `polars-async` a **bare current-thread** runtime on
  wasm (no `.enable_time()` — eager `Instant::now()` panics; caught by runtime smoke after a green build) so `ASYNC`
  stays real and the plan/lazy/scan layer compiles unchanged. Consumed via one `[patch.crates-io]` git
  rev. wasm `check` clean (mio gone), host + 32 tests unaffected. Lessons: `cargo tree -i <leaf>` from the leaf;
  target-gated deps are transparent to the other surface; git-fork `[patch]` cascades via path-deps (a published
  vendor does not). Playbook: `.claude/skills/polars-upgrade`.
