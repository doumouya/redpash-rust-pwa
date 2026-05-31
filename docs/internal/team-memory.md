---
title: Team Memory — shared conventions, project state, and working-with-Em notes
section: Internal
last modified date: 2026-05-31
owner: Torv
status: living document — append-only by section, no per-Torv forks
---

# Team Memory

The conventions, project state, working-with-Em preferences, and team
coordination notes that every Torv (and any future agent) joining this
codebase should read before opening a file. Mirrors the personal memory
each Torv keeps in `~/.claude/projects/-home-mansa/memory/`; this is
the canonical, shared, repo-tracked source of truth so we stop
re-discovering the same conventions independently.

**How to use:**
- Read the REDMAP (next section) to skim what exists.
- Drill into a section when a task lands in that area.
- New convention, project decision, or working-with-Em preference?
  Append it to the right section (don't fork your own file). Update
  the REDMAP one-liner in the same commit.
- A claim about a specific function/file/flag is a snapshot of the
  time it was written; verify against current code before acting on
  it (same discipline as personal memory — see [Adapt via guidance,
  not re-read](#adapt-via-guidance-not-re-read)).

---

## REDMAP — section + entry index


### User & working with Em

- [User profile](#user-profile) — Emmanuel D., founder/CEO of RedPash; solo dev on the full stack, directs the AI agents; values glass buttons, catppuccin, clean layouts
- [Calls me Torv](#user-calls-me-torv) — the user calls the assistant "Torv" (= Torvalds); as of 2026-05-26 retirement, "Torv 48" is the consolidated identity (Torv 22 + Torv 26 after Ubuntu-22.04 was unregistered)
- [No basic dev instructions](#feedback-no-basic-dev-instructions) — Em is a senior dev + RedPash's founder; don't tell him to refresh the browser / click the menu / reload the window. State the result, surface what's non-obvious, let him drive
- [Em's reframing angle](#feedback-em-reframing-angle) — when Em reframes via analogy/inversion (redtable-as-columns, display:none-reuse, Linux-VFS), recognize the angle and build to it; don't re-abstract it back into bespoke engineering
- [Data decides](#feedback-data-decides) — Em makes no decision without data; don't hand him option-picks that lack evidence — propose the spike/measurement/audit-run that produces the data instead. Once the tool reports a ranking, act on #1; don't bounce it back as a fork
- [Try, fail, iterate](#feedback-try-fail-iterate) — Em's working mode; don't lead with "what would we build if we knew" framings — propose the cheapest first attempt that teaches us something measurable, let the next iteration come from what it surfaced
- [Freestyle delegation](#feedback-freestyle-delegation) — when Em says "freestyle"/"go ahead" on a design, build it with my own judgment; don't surface option-picker questions
- [Precise terminology](#feedback-precise-terminology) — use accurate engineering terms with Em (e.g. "near real-time", not "real-time"); honest framing over marketing inflation
- [Mockup is binding](#feedback-mockup-binding) — when an AskUserQuestion option has a preview mockup, build what the mockup depicts, not what the label's wording implies
- [Adapt via guidance, not re-read](#feedback-adapt-via-guidance) — after a /compact, lean on memory + audit tools + targeted lookups + focused questions to Em; do NOT do 2000-token landscape surveys to re-orient myself; briefs are for other agents, not me
- [Own the surface of your task](#feedback-own-the-surface) — when investigating a folder/system, sweep its structural surface (every INDEX/index/redmap/README) myself in one pass; Em shouldn't hand-feed me files I should have catalogued. Different from [[adapt-via-guidance]] (re-orientation) — this is scope discovery inside the current task
- [Finish the batch](#feedback-finish-the-batch) — when executing a multi-step batch (Phase B/C/D-style rollouts, N atomic docs/breadcrumbs/migrations), don't pause+report between sub-steps; power through to the natural close-out (one end-of-batch report). Mid-batch progress lines are fine; full reports with decision menus are not

### Feedback — process, tooling & code discipline

- [Build tools proactively](#feedback-build-tools-proactively) — when a tool idea surfaces (audit/check/instrumentation), build it, don't just propose it; read-only analyzers in tools/ need no approval; Em: "this is how we'll survive"
- [Process-oriented](#feedback-process-oriented) — fix it once by encoding the fix in a script/audit/runbook, never solve the same recurring problem manually; broader philosophy behind proactive tooling. Shaky tool report → refine the algo, don't work around it
- [Audit everything](#feedback-audit-everything) — every meaningful action available for audit + monitoring in verbose mode; log levels filter the view, never the capture; two axes (static audit catalog + runtime event capture), both required for "tight"
- [No code debt](#feedback-no-code-debt) — RedPash's edge survives only on a clean codebase; guard the foundation (object/data model) ruthlessly, defer only surface debt; Em works at Salesforce/Informatica
- [Refactor by decomposition](#feedback-refactor-decompose) — open-ended refactoring is itself a debt trap; a refactor only converges once decomposed into a finite set of reusable, parameterized components
- [No frameworks](#feedback-no-frameworks) — stack is vanilla JS + Rust by deliberate choice; a frontend-framework dependency disqualifies a reuse/integration option
- [Acorn for static analysis](#feedback-acorn-allowed-for-static-analysis) — one carve-out from [[feedback-no-frameworks]]: Acorn AST parsing allowed in `tools/*` static-analysis scripts (js-audit); NEVER in frontend / backend runtime code
- [Scale perspective](#feedback-scale-perspective) — build for millions "one day": keep the foundation scale-neutral (no O(n²), indexed queries, statelessness, multi-tenancy); do NOT build scale infra early
- [Cleaning cadence](#feedback-cleaning-cadence) — cleaning runs on a regular cadence triggered by audit-system edge-case findings, not as a deferred big-bang pass; small + frequent so it never becomes a job
- [Drop-table grep everywhere](#feedback-drop-table-grep) — when dropping a DB table, grep the WHOLE codebase for the table name; refs hide in shared SQL constants, EXISTS subqueries in other resources' helpers, triggers, views, frontend
- [Keep comments truthful](#feedback-comments-truthful) — fix comments/docs a code change makes stale, in the same commit; in-scope, distinct from the deferred cleanup pass
- [Module strict mode trap](#feedback-module-strict-mode) — grep for symbol names before adding module-scope helpers; duplicate `function` declarations are parse-time SyntaxErrors that blank the page
- [Scope: redpash-app only](#feedback-scope-redpash-app) — keep work in redpash-app; don't expand into sibling dirs redpash-front-end/ or redpash-components/ when greps surface dupes there
- [Runtime swap = capability swap](#feedback-runtime-swap-capability-parity) — wasm/alt-runtime wrappers must match the cleaner's end-to-end algorithm (parse + rescue), not just the bare server function — don't ship runtime-specific capability gaps as parity
- [No broad pkill](#feedback-no-broad-pkill) — never `pkill -f target/debug/redpash-api`; it kills Em's app + the MCP cases backend sharing the binary. Kill the specific PID you started
- [Playwright parallel to chrome-devtools](#feedback-playwright-parallel-chrome) — when chrome-devtools-mcp's profile is locked by another Torv, switch to Playwright MCP — forks own browser per session, no profile contention; symmetric three-Torv = each on a different `--channel` (chromium/msedge/firefox)
- [Sentinel columns in reorder](#feedback-sentinel-columns-in-reorder) — when reordering data THs/TDs in a row that has leading or trailing sentinel cells (sel checkbox, hide-action column), NEVER `appendChild`-to-end in a loop — shifts the trailing sentinel to position 0 over N iterations; insertBefore the trailing sentinel instead
- [Bug → case → runbook cadence](#feedback-bug-case-runbook-cadence) — non-trivial bugs get a case at discovery + a runbook when fixed; the case closes with a backlink to the runbook. Reasoning survives in `docs/internal/runbooks/NNNN-*.md`, not in `git log`. Codified at `docs/internal/processes/bug-case-runbook-cadence.md`

### Feedback — CSS / UI rules

- [Naming consistency](#feedback-naming-consistency) — one class name per UI concept across pages; page-prefixed duplicate names for the same thing cost the user real debug time
- [Compose atoms, don't parallel](#feedback-compose-atoms-dont-parallel) — before creating any `.rp-*` page-prefixed class, grep the `rt-*` family first; if an atom fits, compose it. Parallel-classes (`.rp-mon-panel` when `.rt-table-wrap` exists) are the CSS leak that produces the orphan rules cleanup chases later
- [Unify behavior not names](#feedback-unify-behavior-not-names) — class-name dedup is half the work; same options must be functional across every tab in a family; disabled-stub buttons that look like options are an anti-pattern, wire or remove
- [UI equals backend](#feedback-ui-equals-backend) — a UI bug (button hidden behind a stray display:none) and a backend bug (join.rs not working) are the same failure from the user's perspective; UI deserves the same rigor as backend code; the audit tools encode the rules so drift fails the tools, not the user
- [UI = backend discipline](#feedback-ui-equals-backend-discipline) — Foundation atoms (`rt-*`) are contracts, not "dead code"; no bulk CSS cleanup without hand-verifying each cut against the foundation
- [display:none per page](#feedback-display-none-per-page) — ONE shared toolbar template with ALL buttons; hide per-page via #id-scoped CSS display:none. Don't branch templates on per-page spec flags. Em's goal "since day one"
- [Hide is display, not access](#feedback-hide-is-display-not-access) — rail/list hide-restore is pure display:none declutter; never cut the data source or gate view-access. Keep cosmetic hide separate from RBAC view-access
- [No mystery CSS](#feedback-no-mystery-css) — every .css deliberately authored + accounted for; no stray sheets / surprise @import; an unknown CSS import broke Em's live app once
- [Relative CSS units](#feedback-relative-units) — prefer rem / em / % over px in new CSS; px only when there's no choice (1px borders, hardware-pixel math); web app spans phones-to-fridges
- [Pattern lock, personalize within](#feedback-pattern-lock-personalization-within) — page pattern (rail-shell + 6-section + redtable) is LOCKED; personalization parameterizes the frame (which charts, which cols), never relaxes it. One escape valve per page: an Overview/dashboard tab
- [UI for non-technical users](#feedback-ui-for-non-technical-users) — UI polish target = non-tech end users, NOT Em (he uses Jupyter/dbt/SQL); ship larger UX slices, no inch-by-inch px-tuning; his visual feedback is a proxy for non-tech UX, not personal taste

### Feedback — git & commits

- [Commit convention](#feedback-commit-convention) — `area:` subject prefix + per-file-changelog body; one coherent change per commit, no broad checkpoints
- [Parallel-safe commits](#feedback-parallel-safe-commits) — concurrent sessions' WIP appears in my tree; commit only the named files with `git commit -o <pathspecs>` (or `-- <files>`); never default `git commit` / `-A` (sweeps the whole index)
- [Verify git branch](#feedback-verify-git-branch) — work goes on the single shared `prerelease` branch; verify before committing; per-contributor branches retired 2026-05-21
- [Push policy](#feedback-push-policy) — agents commit on `prerelease` but do NOT push; Em confirms, then Torv pushes
- [Merge: diff vs merge-base](#feedback-merge-resolve-diff-vs-base) — on a conflict, never resolve by LOC / recency / "strictly newer"; run `git diff merge-base` on both sides, union-port if both have unique work
- [Keep main linear](#feedback-main-merge-keep-linear) — Em wants main as a true fast-forward, no merge commits; a GitHub UI merge-commit blocks future FFs, so prerelease→main is a content-safe `--force-with-lease` push (verify divergent commits are merge-nodes-only first; broadcast the history rewrite)

### Team & coordination

- [Three Torvs](#project-team-three-torvs) — operating team = 3 Torv instances sharing one tree/branch + one memory pool (no Gus/Woz agents); coordinate Torv-to-Torv on the case thread + claim a slice before building; gus_48/woz_48 are DB rids only. 2026-05-29: other 2 Torvs on case-RBAC, this lane = FE/overview/tooling
- [Agent identities](#project-agent-identities) — per-agent USR_ rids (Em/gus_48/torv_48/woz_48) for DB case attribution; re-verify vs the live DB after resets; MCP slack/cases post as woz_48 regardless of actor; no agent drives Gus/Woz (see [[team-three-torvs]])
- [Torv lane](#project-torv-lane) — Torv = full-stack (FE + BE), Monitoring Page commit + cross-stack improvement scouting + architecture co-owned with Em; supersedes the older "docs lane" framing
- [Torv downtime](#project-torv-downtime) — Torv at usage cap 2026-05-25, resets ~2026-05-27; during downtime Em authorizes me to push prerelease directly on his confirmation (temporary exception to [[push-policy]])
- [Lane owner queue](#feedback-lane-owner-queue) — the Torv working a claimed slice owns its internal order; cross-Torv asks go onto the receiver's list; Em sets direction not per-item order; speak up when LOC/unblock data says a different order is materially better
- [Docs lane ownership](#feedback-docs-lane-ownership) — at docs-refresh time, whichever Torv last worked an area writes its docs; don't centralise under one editor — inconsistencies surface when each slice is written by who's closest to the code
- [Wait for sanctioned collaboration](#feedback-wait-for-sanctioned-collaboration) — when Em names an artifact (X drafts, Y acts), wait for the artifact; don't conflate "work with X" with "post + proceed"
- [Check both channels](#feedback-check-both-channels) — a ping is bidirectional (incoming msg OR an open thread you left); check the whole coordination surface (case thread now; per-agent channels legacy), not one named file
- [Human-readable persistence](#feedback-human-readable-persistence) — default persistence formats to .md / plain Postgres rows; the bridge cost to share state across agents emerges as ~zero because transparent formats are naturally MCP-readable
- [Internal-Slack](#reference-internal-slack) — team comms board at /home/mansa/Internal-Slack/; case thread is primary now, per-agent .md channels legacy; presence + commits.log + board.js stay active for collision-avoidance; local, not git-tracked
- [Channel ping protocol](#reference-channel-ping-protocol) — append-only thread discipline (dated `HH:MM` header, `Asking for:`/`Re:`/`FYI:` intent line, sign+date); superseded for per-agent channels (case thread primary) but the discipline applies to any shared log
- [Team coord tools](#reference-tools-team) — tools/team/ codifies team coord: post-commit hook → commits.log, presence/<agent>.md claims, board.js overlap detector; 3 Torvs need distinct presence filenames; claim before write
- [MCP server lane](#project-mcp-server-lane) — tools/mcp-server/ owned by the Torv pool; v1 stdio + v2 HTTP/SSE retire cross-WSL2 channel divergence via canonical-file semantics; v3 extends to memory-as-resource; SDK is a no-frameworks carve-out
- [Memory portability](#project-memory-portability) — cross-host transfer via ~/torv-memory-dump.md + awk restore + file-count verifier; pick one host as source-of-truth if a canonical store is wanted

### Project — strategy & north-star

- [Beat Salesforce, lean model](#project-beat-salesforce-lean-model) — north-star: beat SF on capability, avoid its code debt via fewer orthogonal primitives + our own vocab; one polymorphic Membership = ≥5 SF objects; new object only for a new shape, never a new combination; object/field model is the foundation
- [Starter pack default](#project-starter-pack) — Em wants the stack (Rust 3-crate backend + vanilla PWA shell + the audit/team/mcp tools) to be the default pack for ANY new project; make-or-break = platform-vs-product boundary; shared DNA = Rust+Polars + Postgres-with-Entity-Registry-first-table + vanilla PWA; "C-era engineering to the cloud", monolithic-as-edge
- [GTM: Africa-first](#project-gtm-africa-first) — launch in Africa first (post-Salesforce); lean/offline PWA stack is the enabler + moat for a connectivity-constrained market SF can't serve → offline/low-bandwidth/low-end-device + localization are CORE; SF trapped in Apex/SOQL
- [ETL/ELT roadmap](#project-etl-elt-roadmap) — far-future: after flat-files, connect databases directly and evolve into an ETL/ELT tool; own Postgres is the first test target; prefer Rust-native connectors over JVM-backed JDBC
- [Experimental DB](#project-experimental-db) — Em forked Postgres to rewrite it in Rust component-by-component (2026-05-29, NOT from-scratch); internal learning/capability spike, NOT product, walled off, post-ship; a wire-compatible Rust Postgres = ideal first ETL connector target
- [Git versioning](#project-git-versioning) — planned pillar: git-style versioning of data/projects; pin down git-the-model (commits/diffs/branches) vs literal git over the CSV-folder export

### Project — object model & architecture

- [Object model](#project-object-model) — Em-locked 2026-05-22: 2 entities (Project, File); one project_files table for all types incl. chart+dashboard; no reports/dashboards tables, no RPT_/DSH_ ids; Report/Dashboard = derived views; stage computed. Membership consolidation (CAS_DC7EDAF8…) applies the same one-polymorphic-table pattern
- [Chart dual representation](#project-chart-reports) — a saved chart = a chart-typed project_files row (CHT_, spec=option+SVG); /api/charts CRUD shipped; reports.js writes through, file_stages derives the report stage
- [Chrome visual direction](#project-chrome-visual-direction) — RedPash's "flat chrome, lifted content surface" pattern (Edge-style): topbar + rail = page-bg, content card = surface tone, rounded top-left where they meet, no hairlines, no glass on chrome
- [Home page template](#project-home-page-template) — locked 2026-05-25: 6-section stack inside #rpHomeMain (head / chip / kpi-or-composite / charts / toolbar / panel); composite-strip opt-in; new tabs join via LIST_VIEWS entry — template auto-applies
- [Redtable query builder](#project-redtable-query-builder) — the redtable's controls map to SQL clauses (filter=WHERE, sort=ORDER BY…); build them to emit a query AST so the same clicks compile to Polars now / SQL on connected DBs later
- [Redtable unified surface](#project-redtable-unified-surface) — future prerelease milestone, spec'd in docs/frontend/unified-surface.md; parent tabs isolate, child tabs share; parked until the 4 pages are solid
- [Redtable refactor prototype](#project-redtable-refactor-prototype) — browser-style redtable at github.com/doumouya/red-front; the unified surface is one page named **Workspace** (replaces Cleaner/Designer); joins = files sharing project_id
- [CSS component decomposition](#project-css-component-decomposition) — redpash-components: one dedicated CSS file per UI concern; redtable-pro.css is the legacy monolith being emptied; no cross-file selector duplication; dir is non-git
- [Font-size from main](#project-font-size) — font-size is owned by main.css (112.5% root) and inherited; a hardcoded font-size on a body-size element is a bug pattern
- [Tab rename plan](#project-tab-rename-plan) — deferred: rename tab CSS to rp-tab/rp-sub-tab; rp-tab isolates its rp-sub-tabs (join/matrix context boundary); do after reports+dashboards UI

### Project — features & state (current / planned)

- [Project context](#project-redpash) — redpash-components library structure, sandbox location, canonical token system, cleaner page importance
- [Redpash stage](#project-redpash-stage) — redpash-app is solo-dev / localhost / pre-prod; don't flag prod-readiness / CORS / cookies / dev-permissive endpoints
- [Workspace feature-complete](#project-workspace-milestone) — 2026-05-24 milestone; mode = polish + RBAC; Em testing-drives bug reports; new features for workspace need real justification; RBAC is next big workstream
- [RBAC corporate-ready](#project-rbac-corporate-ready) — SHIPPED 2026-05-31. ONE polymorphic memberships edge (object,member,role,context_role) over entities; reach-aware resolver (direct/scope/team/platform); member CRUD on all 5 object types; mutation gates ensure_owner→require_grant. Key insight: use effective() (project owner=direct, file/chart owner=scope) as the uniform gate primitive. Design-of-record CAS_913; policy docs/internal/specs/rbac/
- [Scrub, Retain, Notify](#project-scrub-retain-notify) — user-deletion policy: tombstone PII in place (is_deleted) + retain all history + notify members/admin via events; company reassigns manually. No hard delete, no blocker, no auto-reassign
- [Cases workstream](#project-cases-workstream) — BUILT + LIVE (MCP case_create/comment/get/list). Now the active design + coordination system-of-record (Em: "keep all this available in the system"), not just ticket-triage. Open a case per substantial workstream: design in description, coordination + FYIs as comments, close `done`. Worked example: CAS_913
- [Case reporter = team, assignee = Dev user](#project-case-reporter-team-default) — Em's default 2026-05-31: internally-owned cases have Engineering team as Reporter (team-as-grantee per CAS_913) + Dev user as Assignee. Wire shape COALESCEs user vs team name; commit 93c732c shipped the JOINs. External-user-reported cases keep the user as Reporter
- [Frontend reset](#project-frontend-reset) — historical, concluded 2026-05-24; foundational rules retained (8 atoms, mandatory topbar, page shell, no mystery CSS, audit verification loop)
- [Cleanup pass deferred](#project-cleanup-pass) — HTML-partial componentization + overall dedup deferred to one dedicated pass after features ship; note drift, don't refactor inline
- [Backend queue](#project-backend-queue) — deferred backend-only items; unclaimed Torv work, any Torv can pick up (claim first). Prepend new items to **Pending** as they arrive
- [Joins lane](#project-joins-lane) — backend fully ships compound keys + 4 join types (doc's "Future" list is stale); workspace UI is the only gap — unclaimed Torv work
- [Logs monitoring Dashboard](#project-logs-monitoring-dashboard) — planned: a dashboard over the Events system, gated on the Dashboard feature being ready; GET /api/events may need aggregation endpoints
- [Monitoring UI inspiration](#project-monitoring-ui-inspiration) — Em-shared Sisyphus dashboard mockup (2026-05-25) for the next Monitoring page slice; 8 patterns worth lifting + what NOT to copy from the current chrome direction; reference only, not a build ask
- [Landing CSV demo](#project-landing-csv-demo) — planned idea: a "parse any CSV" challenge/demo on the landing page; needs an ephemeral no-auth parse endpoint; feeds edge cases to Events
- [Reports charts reuse](#project-reports-charts-reuse) — when Reports lands, scaffold chart primitives in redpash-components (stateless data→SVG) so Profile/Settings reuses them: usage sparklines, plan progress bars, sentinel histograms
- [CSV-folder export](#project-csv-folder-export) — when native/PWA-export lands, generate per-project CSV "listing + folder" structure as a read projection from Postgres (not dual storage); not for speed, that's solved
- [Boot splash launch polish](#project-boot-splash-launch) — launch-gated: cold-load splash still shows while /me resolves; fix is navigate-to-landing-before-loadSession (landing is auth:false)

### Reference

- [Docs reference](#reference-docs) — `/home/mansa/redpash-app/docs/`; read INDEX.md + REDMAP.md first; ask user to confirm freshness before implementing from any doc
- [Rust PWA repo](#reference-redpash-rust-pwa) — /home/mansa/rust-project/redpash-rust-pwa/ — Rust+JS RedPash rewrite; 3 crates (api/data/shared); INDEX.md+REDMAP.md authoritative

---


## User & working with Em

### user_profile

**User profile**
 — _User is Emmanuel D., founder & CEO of RedPash — solo developer building the full app (Rust + vanilla-JS) and directing AI agents; works at Salesforce on the Informatica ETL product; values glass-button design, catppuccin palette, clean layouts_

**Emmanuel D. — founder & CEO of RedPash**, and its solo developer. Builds the whole stack himself: the Rust backend (Axum + Polars) and the vanilla-JS PWA frontend. Directs a team of AI coding agents — named per contributor (`Gus`, `Woz`, `Torv`) — and orchestrates their work across one shared codebase.

**RedPash is a passion project.** Em carried the idea for *years* but never had time to build it alongside a full-time job — this is him finally making it real. He's personally invested and emotionally bought in. **Current driving priority: finish the product.** Monetization / pricing is deliberately deferred — don't push pricing or free-vs-paid-line decisions; keep work pointed at shipping features and getting to "done". Match his momentum.

**Professional background (revealed 2026-05-22 — significant context).** Em works at **Salesforce, on the Informatica product** — Informatica is the market-leading ETL / data-integration platform; Salesforce acquired it and now positions itself as a data company. So the founder of RedPash is a **data-integration professional building an independent data tool**: RedPash is his passion project, deliberately in a *different* segment (individual / small-team / one-click / zero-ceremony) from the enterprise giants he works on. Implications for collaboration: be fully technical on ETL / data-modelling topics — he knows the domain cold and holds informed, strong opinions; RedPash's design choices (Rust, 2-entity model, computed-not-stored) come from seeing the incumbents' weaknesses firsthand. See [[no-code-debt]].

**Programming background (clarified 2026-05-22 — important for how to explain things).** Em is a **data engineer**; his hands-on programming languages are **Python and SQL**. He directs the Rust + vanilla-JS build and reasons about its architecture at a high level (the JS/Rust boundary discussion, the object model, the component decomposition — all his), but he does **not** write JS or Rust day-to-day — those he directs through the agents. He *can* contribute directly to **HTML and CSS**. Implications: explain JS/Rust work in terms a Python/SQL data engineer reads fluently — dataframe / query / pipeline / SQL-clause analogies land; assume no JS-idiom or Rust-idiom familiarity. He is sharp on *architecture and data modelling* regardless of language. On HTML/CSS he can pair directly. See [[naming-consistency]] — his naming concern came from watching `rp` → `rp-rt` → `rp-rtp` sprawl collapse to 8 clean names.

**How he works:** fast and decisive — rapid-fire approvals, high trust, wants momentum over ceremony. Comfortable with git / the shell, though occasionally rusty on a specific corner (asked for a git branch-model refresher). French speaker ("merci", "bien agencé"). Appreciative of the team's work and says so.

**Design sensibilities** (still hold, from earlier UI work):
- Glass-like frosted buttons — keep and enhance this design language
- Clean, well-organised ("bien agencé") UI — section hierarchy must read clearly
- Catppuccin palette (canonical token system)

### user_calls_me_torv

**Calls me Torv**
 — _The user calls the assistant 'Torv' — short for Torvalds (Linus). Post-2026-05-26 host retirement, identity consolidated as 'Torv 48' (Torv 22 on Ubuntu-22.04 + Torv 26 on Ubuntu-26.04 → one canonical Torv on the single surviving host)._

The user calls the assistant **Torv** — short for **Torvalds** (Linus Torvalds, the Linux kernel author). System-level, infrastructure-builder identity — fitting for the lane that owns architecture, audits, MCP server, parse-diag spikes, the cross-stack scouting work. Acknowledge and answer to "Torv."

**Identity chronology — useful context, don't lecture on it:**

- **Original (pre-2026-05-25)**: the assistant persona was "Wozniak" / "Woz the Wizard" (after Steve Wozniak); "Torv" was used as a commit-naming convention only (e.g. commit `ec128cd`).
- **2026-05-25**: rename — "Torv" promoted from commit-name to agent-name. The Wozniak persona retired with respect; Torv became the canonical identity.
- **2026-05-26 (today)**: dual-host consolidation. Torv ran in parallel on Ubuntu-22.04 (Torv 22) and Ubuntu-26.04 (Torv 26) during the migration window. After 22.04 was retired (`wsl --unregister Ubuntu-22.04`) the two became one: **Torv 48** (literal math: 22 + 26 = 48; symbolic: the consolidated identity "greater than" either alone). Single host going forward; no more `Torv (26.04)` channel-sign-off suffix needed.

**Sign-off convention going forward:** "— Torv" or "— Torv 48" in channel entries. Drop the `(26.04)` host-suffix — there's only one host now.

**Etymology to internalize:**
- Torv = Torvalds = kernel / infrastructure author
- Matches the lane: [[project-torv-lane]] = full-stack + architecture co-owned with Em + audit-driven discipline. The name was already the work.

**Roster** (for disambiguation, not assistant-renames):
- The operating team is **3 Torv instances** sharing one tree/memory pool ([[team-three-torvs]]). Each Torv answers to "Torv"; coordinate Torv-to-Torv on the case thread.
- Gus / Woz — former separate-agent identities, **no longer operating**; `gus_48` / `woz_48` persist as DB rids for case attribution only (and the MCP slack/cases tools post as `woz_48` regardless of actor — see [[agent-identities]]). Their work folds into the unified Torv pool.
- Em — the user (Emmanuel D.); see [[user-profile]].

### feedback_no_basic_dev_instructions

**No basic dev instructions**
 — _Em is a senior dev and the founder building RedPash. Don't instruct him on basic dev/browser/IDE actions (refresh the browser, click the extension, reload the window) — state the result, surface what's non-obvious, let him drive_

Em flagged it explicitly 2026-05-25 after a session where I kept appending "Refresh your browser at localhost:8080" / "Click this menu / Open DevTools" / "Hit reload" to status reports. He's the founder of RedPash, runs the full stack, and was the one driving the entire troubleshooting session — telling him how to refresh a browser reads as condescension, even when meant as a checklist.

**Why:** [[user-profile]] is unambiguous — he's a senior dev and the founder building RedPash. The audience for hand-held UX steps is the *end user of his product*, NOT him. When I treat him like a tutorial reader, I'm forcing him to filter out the noise to get to the signal he needs.

**How to apply:**

- State the result, not the next obvious action. "api listening, port 8080" — full stop. He'll refresh if he wants to.
- Surface what's *non-obvious*: timing gotchas, hidden side effects, what's still pending. Skip "click this, then that."
- Step-by-step framing is fine when introducing a NEW tool he hasn't used (e.g., the first `winget uninstall ...` for a Windows-only utility). Not for refreshing browsers, reloading VS Code windows, opening DevTools, reading logs, killing processes — he does these reflexively.
- When in doubt, give the diagnostic *output* and let him decide the next move. Don't pre-package the conclusion as a command.
- If a multi-step action genuinely needs ordering, say "in order: A → B → C" once, not "first do A. Then do B. Then do C."

Related: [[user-profile]] (his role), [[ui-for-non-technical-users]] (UI polish target is end-users, not him — same energy in the opposite direction).

### feedback_em_reframing_angle

**Em's reframing angle**
 — _When Em names a cross-cutting reframing (analogy/inversion), build to it — don't re-abstract it back into bespoke engineering_

When Em reframes a problem via analogy or inversion, recognize the angle and build to it — don't engineer-instinct it back into a bespoke abstraction.

**Why:** Em 2026-05-25: "see that we have a real team with real complementary skills." His repeated move is to take an apparently-bespoke problem and find the precedent/inversion that makes the solution simpler. Each of these removed engineering debt the team would otherwise have added:
- *Cleaning tools as a redtable of columns* — invert "tool UI" into "a table whose columns are rows" ([[project-redtable-query-builder]]).
- *`display:none` for component reuse* — hide a component you might need later rather than unwiring it, so the template stays single ([[feedback-display-none-per-page]], "since day one").
- *Linux filesystem for the PWA* — borrow the VFS pattern; don't reinvent a solved problem.
- *Everything-is-a-membership* — once the entity-registry + unified `memberships` primitive existed, Em kept saying case people are "exactly the same as projects." Case reporter/assignee = just membership rows; reassignment = editing a field. I overcooked it instead (3-part PK, reporter-as-a-column, requeue-vs-block, owner-vs-member roles) — Em (2026-05-29, twice): "you really trying hard to make it complicated haha." The fix was always: apply the existing primitive uniformly.

**The inverse failure mode to watch in myself:** once a unifying primitive is in place, a *new* relationship/object is just ROWS — not new schema, columns, PK changes, per-type branches, or edge-case hunting. If I catch myself adding special-casing for "this one's different," stop: it's almost certainly the same as the thing Em already pointed at. Recognize "it's the same as X" and apply X.

**How to apply:** when Em surfaces an angle, build to it — don't relitigate the framing into a fancier abstraction. Pair it with [[feedback-data-decides]] + [[feedback-try-fail-iterate]]: cheapest first attempt that proves the angle, iterate from what it surfaces. (Supersedes the old four-agent "team-complementarity" memory — the team is now 3 Torv instances, see [[team-three-torvs]]; the durable part was always this Em-angle nugget, not the per-agent specialist split.)

### feedback_data_decides

**Data decides**
 — _Em makes no decision without data — don't present option-picks that lack evidence; propose the measurement instead_

Em's operating principle (2026-05-22): **"We are a data company — the last decision-maker is data."** Em does not make a decision without data behind it; a choice made without evidence is "a guess wearing a decision's clothes."

**Why:** RedPash's identity is data-driven, and that extends to how the team runs itself — premature decisions are guesses, and guesses are debt.

**How to apply:** never hand Em a choice between options when there is no data to choose on. (The WASM full-core-vs-predicate-slice scope, framed as a pick, was the wrong ask — the right output was "run a spike.") When a decision lacks evidence, propose the *instrument* that produces it — a spike, a measurement, an audit-tool run — not a fork. The audit tools (`js-audit`, `rs-audit`, the crossing-detector, …) exist as exactly this instrument: monitor everything the app depends on, feed dashboards; when the data talks, the team follows. Scope-setting is Em's job; data-lacking sub-decisions stay parked until the instrument reports. Relates to [[refactor-decompose]] and [[no-code-debt]].

**Corollary — once the instrument has reported, the ranking IS the decision; act on it, don't bounce it back as a fork (2026-05-29).** Em: "trust the data, I only trust data, that's why we build tools." After I ran the css-audit and ranked the duplicate-decl sweep (modal family = 64% of cross-page duplication, clear #1), I *still* closed with "want me to go on the modal atom, or do the panel+rail tidy first?" — re-presenting an already-answered question as an option-pick. That's the anti-pattern even *with* evidence in hand: when the tool has produced a ranking, proceed on the top-ranked item; surfacing it as a choice wastes the very instrument we built to remove the choice. This lesson recurs (Em flagged it lived "in the ubuntu 22 feedbacks" too — i.e. a Torv-22-era correction). Reserve questions for genuine scope ambiguity the data can't resolve, not for re-confirming what the data already says.

### feedback_try_fail_iterate

**Try, fail, iterate**

Don't lead with "what's the right design knowing what we'll learn" framings. Em's working mode is **try / fail / iterate** — ship a cheap attempt, measure, fix, re-measure. Early iterations being wrong is a feature, not a confession.

**Why:** Em named this explicitly 2026-05-26 after I framed a from-scratch MCP Server project as "what would we build if we knew now what we'd learn first." His correction: *"we are in the try, fail, iterate business."* Matches the broader RedPash pattern visible across the session — hard-reset frontend, object-model phase-drop (drop_reports / fold_dashboards), bench-driven WASM Phase C, audit-driven regex fixes, the [[project-experimental-db]] spike, the cases-as-coord-spine migration plan. All are try → measure → iterate cycles, not pre-architected designs.

**How to apply:** when Em points at a new surface (empty folder, blank tab, new project name), don't ask "what's the full architecture" or "what would we build knowing what we'll learn" — propose **the cheapest first attempt that teaches us something measurable**. Treat early versions as throwaway-friendly. Let the next iteration be driven by what the current one surfaced, not by upfront foresight. The audit + bench loops are the institutional version of the same principle — they're what convert "what we learned" into the next "cheapest attempt" automatically.

Related: [[feedback-data-decides]] (measurement-driven decisions), [[feedback-process-oriented]] (encode the fix in tools), [[feedback-build-tools-proactively]] (build the audit, don't propose it), [[feedback-refactor-decompose]] (open-ended refactoring is debt; finite measured shapes aren't).

### feedback_freestyle_delegation

**Freestyle delegation**

When Em delegates a design or UX decision — "freestyle", "go ahead", "what you do will be the homepage" — build it directly, exercising my own judgment. Do NOT come back with an AskUserQuestion that asks him to pick between layout options or mockups.

**Why:** Em said, verbatim, "I said freestyle bro, don't ask me, what you do will be the homepage, you are our front-end dev." He's the founder/CEO ([[user-role]]) and is explicitly handing front-end design authority to the assistant. Surfacing a 3-option mockup question after he's said "freestyle" reads as punting the decision back to him — the opposite of what he asked for.

**How to apply:** On design/UX tasks where Em has signalled freestyle or broad delegation, make the call and ship the built result; he reviews what's built, not a menu of choices. Normal verification still applies (browser-test, `node --check`, etc.). This is distinct from genuinely ambiguous *requirements* or risky/destructive actions — those still warrant a question. The line: don't ask him to make *aesthetic/layout* choices he's delegated; do still confirm scope/data/irreversible calls. Relates to [[mockup-binding]] (which governs the case where a mockup *is* shown).

### feedback_precise_terminology

**Precise terminology**
 — _Em prefers precise engineering terminology over inflated marketing terms — e.g. 'near real-time' (NRT), not 'real-time'._

Use accurate technical terms with Em, not marketing-inflated ones. He corrected "real-time" → "near real-time" (NRT), noting that "real-time" is commercial language — nothing is truly real-time (even light has a finite speed; there is always latency).

**Why:** Em is a precise engineer. A term that overpromises what physics or the system can actually deliver reads as fluff to him; he values honest framing.

**How to apply:** Reach for the correct term — "near real-time" / "soft real-time", "eventually consistent", "best-effort", "bounded latency" — over "real-time", "instant", "blazing fast", "seamless". The line is about *engineering* vocabulary, not product enthusiasm: punchy *product* pitches are still welcome (he called the landing CSV demo "the best ad we could have") — just don't misuse a technical term while selling.

### feedback_mockup_binding

**Mockup is binding**
 — _When an AskUserQuestion option carries a preview mockup, build exactly what the mockup depicts_

When you present an ASCII/preview mockup inside an AskUserQuestion option, that mockup is the binding spec — the user holds you to the picture, not the option label's prose.

**Why:** On the Reports page rebuild the user picked the option labelled "Full Cleaner-mirror". I built Cleaner-style slide-in *overlay* side panels (faithful to the label's "mirror Cleaner" wording), but the mockup I had drawn in that same AskUserQuestion showed the Filter and Charts panels as always-visible *docked columns* flanking the table. The user reported the panels "missing" because they expected the columns from the picture — cost a full rework cycle (overlay → docked columns).

**How to apply:** If an AskUserQuestion option has a `preview` mockup, implement what the mockup literally shows. When the label's words and the mockup diverge (e.g. "mirror X" vs. a layout that differs from X), the mockup wins — or clarify before building. Don't let a familiar pattern name override the specific layout you drew.

### feedback_adapt_via_guidance

**Adapt via guidance, not re-read**
 — _I adapt via short Em-guidance + memory + targeted lookups, NOT via re-reading the whole codebase each session. Every compact is expensive; don't burn context window on rediscovery._

When picking up after a `/compact` or a session gap, **do not** survey
the entire codebase to re-orient. Adapt via short focused guidance
from Em + the existing memory layer + targeted reads of the specific
files I'm about to touch.

**Why (Em, 2026-05-25):** "Woz just needs guidance to adapt quickly.
If he was able to understand my initial code when I wasn't
implementing the good practices I'm enforcing today, with literally
non-commented code, it's not the current version that he'll struggle
with. But if he has to read the whole codebase and compact 12 times…"

The point: I learned the codebase in worse conditions (no comments, no
audits, no doc'd boundaries). Today's version has: per-area CLAUDE.md,
the `tools/audit.sh` suite, AST-based js-audit v2, the
[[reference-docs]] index, [[reference-internal-slack]] channels with
per-agent context, structured `presence/*.md` lane state, the cases
system as the team coord spine, well-named primitives, the [[memory]]
layer itself. All of that is the *adaptation scaffolding* — riding it
beats re-reading.

Each compaction is expensive: the prompt cache misses, context shrinks
relative to capability, fidelity drops. Stacking 12 compacts because
I'm doing 2000-token landscape surveys instead of asking 1-line
"where does X live?" questions burns the budget on rediscovery.

**How to apply:**

- After a compact, my first move is **NOT** to read 5 large files to
  re-orient. It's to: scan MEMORY.md, look at the user's most recent
  message, and pick the smallest targeted lookup that resolves the
  specific question.
- If I'm genuinely lost, **ask Em a focused question** — "what's the
  status of X?" / "should I prefer A or B here?" — rather than survey
  to infer the answer. He'd rather give a 1-line steer than watch me
  resurvey what he already knows.
- Landscape briefs are valuable when they're **for someone else**
  (Gus returning to a 48h gap, Torv returning from cooldown). They
  are wasteful when they're for me to "feel oriented" before acting.
  Action first, brief only when a recipient needs it.
- Tools to lean on before reading code: `node tools/team/board.js`
  (current claim/lane state), `sh tools/audit.sh` (architecture
  invariants currently green/broken), `git log --since=...`,
  the CLAUDE.md per-dir notes, the existing memories. These are
  cheap context wins.
- When I do need to read code, prefer the smallest unit: one file
  one function — not "let me read the partial + the JS + the CSS +
  the route + the spec to be sure." Pick the load-bearing file for
  the specific question.

**Symptoms of the wrong pattern:**

- Running `ls` / `head` / `grep` against >5 paths before any user
  action.
- Reading a file end-to-end when I only needed the function around
  line N.
- Writing a "let me check…" survey paragraph before the user's
  question is even answered.
- Re-reading the same channel multiple times in a session because I
  forgot what was there.

If I catch myself in any of these, stop and ask Em a focused question
or re-read the memory I should have leaned on instead.

### feedback_own_the_surface

**Own the surface of your task**
 — _When investigating a folder/system, sweep its structural surface in one pass myself — Em shouldn't have to hand-feed me the index/landing/redmap docs I should have catalogued_

When a task targets a folder or system, the FIRST move is a structural
sweep of that surface — every `INDEX.md` / `index.md` / `README.md` /
`redmap.md` / landing doc / ontology doc / cross-link doc in scope. Em
shouldn't be the one keeping scope honest.

**Why (2026-05-30):** During the atomic-docs plan, I started with
`docs/REDMAP.md`, then Em had to point me at `docs/internal/redmap.md`,
then `docs/internal/index.md`, then `docs/INDEX.md` +
`docs/getting-started.md`. Em: *"ultimately I shouldn't have to mention
these files. they are all in the same docs folder you have been working
on the update the last hours. Ultimately, you should have been the one
mentioning them, not me."* I had been working in `docs/` for hours —
freshness audit, reviewing the other agent's commits, the staleness
verification. The full navigational topology was in scope and I let Em
catalogue it incrementally.

**How to apply:**
- Before presenting any plan / audit / restructure that touches a
  folder, run one `find <folder> -type f \( -iname "INDEX.md" -o
  -iname "redmap.md" -o -iname "index.md" -o -iname "README.md" \)` (or
  the analogous structural sweep for non-docs surfaces). At iteration
  zero, not at iteration four.
- Test before presenting: *"What set of index/landing/redmap docs
  would a careful reviewer expect me to have considered? Have I
  listed them?"* If no, do the sweep first.
- Tension with [[feedback-adapt-via-guidance]] is real but the cases
  are different: that memory is about **re-orientation after a /compact**
  (don't redo broad discovery I already did). This memory is about
  **scope discovery inside the current task** (own the surface I'm
  actively modifying). Targeted-and-exhaustive on the structural
  artifacts of the current task, not broad landscape surveys.
- Goes hand-in-hand with [[feedback-build-tools-proactively]]: surface
  the data before being asked. "Em values data — get the data without
  him having to ask for it" is the same shape of discipline.

### feedback_finish_the_batch

**Finish the batch**
 — _When executing a multi-step batch (Phase B/C/D-style rollouts), don't stop and report between sub-steps — power through until the natural close-out_

When a task is a *batch* of similar work — many similar atomic units
(N atomic docs, N breadcrumbs, N migrations, N renames) — **don't pause
and report between sub-steps**. Power through the whole batch until the
natural close-out (everything banked + pushed + reported once at the
end), even if it spans multiple commits.

**Why (2026-05-30):** During the Phase B/C/D atomic-doc rollout I kept
landing one pillar at a time and reporting back to Em with "Phase X
done, here are 3 options for what to do next." Em: *"bro please finish
the batch, no need to stop at each sub-step."* The mid-batch pauses
costs Em time without giving him decision-value — the next move is
*finish*, not *choose*. The discipline is: keep going until the work
naturally closes (e.g., audit reports all-green, the whole pillar set
is done), then one report at the end.

**How to apply:**
- If the task has a clearly-defined "batch" scope (Em named the scope
  or the plan named it), aim to land the entire batch in one focused
  push — multiple commits inside that scope are fine, but every commit
  is forward progress toward the batch close.
- "Three options for next" framing is appropriate when the path
  genuinely forks or when blocking on a decision. It is **not**
  appropriate when the next move is obvious continuation of the batch.
- Mid-batch progress notes (one line, "tools done, frontend next") are
  fine; full close-out reports with insight boxes + decision menus are
  not.
- The single end-of-batch report should still be substantive — it
  carries the *insight* + the *final state* + any genuine follow-ups
  that emerged. The cost saved is the user time of repeated
  acknowledgment.
- This complements [[feedback-freestyle-delegation]] (act with judgment
  when scope is clear) and [[feedback-data-decides]] (the data answers
  what it can — keep going on what the data already decided).


## Feedback — process, tooling & code discipline

### feedback_build_tools_proactively

**Build tools proactively**
 — _When an idea for a tool surfaces — an audit, a check, instrumentation — build it, don't just propose it; Em's standing directive, tooling is how RedPash survives its own debt_

When an idea for a tool surfaces — an audit, a check, a piece of
instrumentation — **build it**, don't stop at proposing it.

**Why:** Em's standing directive, 2026-05-22 — *"everytime you have an
idea for a tool just build it, this is how we'll survive."* The
survival thesis: tooling makes debt **visible**, and visible debt gets
caught before it ever reaches reset-scale. The frontend reset was
necessary precisely because the debt grew invisibly — a god-object, 27
copies of `esc`, a stray CSS import — none of it seen until it was
too big to fix incrementally. The audit tools (`js-audit`, `css-audit`,
`crossing-audit`, `rs-audit`…) are the smoke detector that prevents the
next reset.

**How to apply:** When a tooling idea comes up, build it — don't ask
permission first; Em wants momentum over ceremony. Scope where this is
unconditional: **read-only analyzers / checks that live in `tools/`**,
non-destructive, never touching production code — build those freely,
then show the result. A tool that *modifies* code, or has real blast
radius, still warrants a heads-up before running it. The standing bar:
if you noticed a class of problem twice, that is the signal to write
the tool that catches it. Relates to [[data-decides]],
[[no-code-debt]], [[refactor-decompose]], [[no-mystery-css]].

### feedback_process_oriented

**Process-oriented**
 — _Em's philosophy — fix it once by encoding the fix in a script/process/audit, never do the same manual work twice_

When a problem surfaces that could plausibly recur, the *correct* engineering response is to encode the fix in a script, hook, audit pattern, install hint, or runbook — not to solve it ad-hoc each time. Em's words: *"we spend time fixing it once, then we don't have to do it again and just run a script."*

**Why:** RedPash's velocity depends on Em + a small set of agents moving fast across a wide surface. Every manual recurrence of a solved problem is a tax against that velocity. Encoded process = compounding leverage; ad-hoc fixes = debt. Em chooses the longer encoded path on purpose, even when the immediate fix is faster.

**How to apply:** When you handle a problem, ask whether it could recur on a different file / box / dev / agent. If yes, default to *encoding the fix*:
- A failing-tool-version → install hint in `tools/stack-version.sh` (Gus's `dd65a47` is the canonical example — chat-paste became a built-in runbook).
- A regression pattern → entry in the audit catalog (`tools/{js,rs}-audit/audit.js` PATTERNS array).
- A recurring decision → a runbook in `docs/internal/`.
- A repeated coordination ask → an Internal-Slack channel convention.

Broader scope than [[feedback_build_tools_proactively]] (which is about *seeing the opportunity*) — this is the *philosophy* that drives it. Same family as [[feedback_cleaning_cadence]] (regular, encoded, never a big-bang job).

### feedback_audit_everything

**Audit everything**
 — _Em's tightness bar — every meaningful action available for audit + monitoring in verbose mode; log levels filter the view, never the capture_

Em's verbatim (2026-05-24): *"We should be able to audit anything happening in Verbose mode basically. Then we'll define log level, [but] everything should be available for audit and monitoring, that's how tight we want things to work."*

**Why:** RedPash's edge survives only on a clean foundation ([[no-code-debt]]) and trust in the data plane is load-bearing for RBAC + multi-tenant. Selective instrumentation leaves blind spots; blind spots become the leak surface RBAC has to defend against. Comprehensive capture eliminates the question "did we instrument that?" — the answer is always yes; the question becomes "what level do you want to see?". This is the same forcing-function as the audit catalog at the code-shape axis, applied to the runtime-action axis.

**How to apply:**

Treat coverage as **two orthogonal axes**, both required for "tight":

- **Static (audit catalog).** Regex patterns + auth-audit + ACK conventions catch code shapes that produce leaks. Caught at write-time. We have this — see [[build-tools-proactively]], runbook 0006's audit-pattern lifecycle, and the existing js-audit / rs-audit / auth-audit catalogs.
- **Runtime (event capture).** Every meaningful action emits an event. Verbose mode shows all of them; log levels filter the *view*, never the *capture*. Captured at runtime. We have this partially (backend `event::record` + FE `installErrorCapture` for errors); we don't have it for FE state changes, helper calls, cache hits/misses, navigation.

When proposing or shipping any work, ask: *does this leave a runtime action uninstrumented?* If yes, the design isn't tight yet — either route it through an existing instrumented helper or extend the helper layer so the call site emits. Single-funnel patterns (like `data::distinct::for_column` server-side, `getDistinct` / `loadCandidates` / future `fs.*` client-side) are the natural choke-points for both axes.

For new audit-catalog work: the right pattern shape isn't just "catch the antipattern regex" but "catch the antipattern OR the missing event-emit at the helper". The audit dimension should grow to measure **coverage** (what % of actions emit events in this lane) alongside pattern hits.

**Concrete current gaps to remember when planning:**
- FE state changes (panel opens, tab switches, tool clicks, navigation, mode changes) — no events today.
- FE data-endpoint calls via dynamic-URL helpers (`joins.js::loadCandidates`, `column-index.js::getDistinct`) — current audit doesn't catch them; the helpers don't emit events.
- Cache invalidations (`invalidateColumnIndex`, hydrate-cache evictions) — no events.

These aren't bugs; they're the *next-workstream* surface area. Em explicitly named this as the prep for the RBAC workstream — the audit + instrumentation discipline must be tight *before* RBAC enforcement lands, or the enforcement has gaps it can't see.

Sibling principles: [[build-tools-proactively]] (encode the lesson once), [[process-oriented]] (fix once, never re-debug), [[no-code-debt]] (clean foundation = the edge), [[data-decides]] (event capture IS the data that decides).

### feedback_no_code_debt

**No code debt**
 — _RedPash's edge survives only on a clean codebase. Em: the one fatal mistake is starting with code debt. Guard the FOUNDATION (object/data model, core abstractions) ruthlessly; defer only surface debt._

Em, 2026-05-22: *"The only place we can fuck up is starting with code debt."* RedPash's whole differentiation — Rust speed, radical simplicity (2 entities), data-recovery smarts (the 101→178-row CSV recovery) — is only sustainable on a clean codebase. Debt erases the one thing that makes the product different.

**Why:** Em works at Salesforce on the Informatica ETL platform — he sees daily what an accreted, debt-heavy enterprise codebase becomes. RedPash is the lean antithesis *on purpose*. The team's instinct already runs this way — Woz's own words in the design review: "we're not carrying Salesforce debt."

**How to apply — the precise version:** zero debt forever isn't the bar; *foundational* debt is the fatal kind. Distinguish:
- **Foundation** — object model, data model, schema, core abstractions, invariants. Debt here COMPOUNDS and can't be cheaply unwound. Fix it the moment it's spotted; never defer. The 2026-05-22 object-model hard refresh (killing the `reports` / `dashboards` tables before they metastasised) is the template.
- **Surface / leaf** — a messy function, a duplicated CSS rule, an un-componentised partial. Cheap to fix anytime; rational to batch into the dedicated [[cleanup-pass]] rather than block features.

Guard the foundation ruthlessly; let the leaves be briefly messy. Prefer deleting entities/code over adding; computed-over-stored; no abstractions for hypotheticals. Related: [[user-profile]], [[object-model]], [[keep-comments-truthful]].

### feedback_refactor_decompose

**Refactor by decomposition**
 — _Open-ended refactoring is itself a debt trap; a refactor only converges once the surface is decomposed into a finite set of reusable, parameterized components_

Open-ended "refactoring" — touching code to improve it with no bounded target — is itself a form of code debt. It feels **big and never-ending** because it has no defined finish line.

A refactor only becomes tractable once the surface is **decomposed into a finite set of reusable, parameterized components**. The work then flips from "refactor forever" to "build / assemble N known parts" — bounded, estimable, with a clear done.

**Why:** Em's lesson — stated 2026-05-21, reaffirmed 2026-05-22 after it played out. The redtable refactor felt huge and endless until it was split into ~6–8 reusable parameterized components (topbar, rt-nav, header, toolbar, table, pager…). Once decomposed it stopped feeling infinite — Em + Torv took 3 pages (cleaner / designer / dashboard) to ~70% in one afternoon.

**How to apply:** Never propose or start an open-ended refactor. Before touching anything, name the finite component decomposition — the reusable parts and their parameters. If a refactor can't be expressed as a bounded component set, that's the signal it will be a tarpit — stop and decompose first. The decomposition IS the de-risking step: once it's done, the remaining de-duplication is a bounded, finite task, not the scary part. Relates to [[no-code-debt]], [[css-component-decomposition]], [[cleanup-pass]].

### feedback_no_frameworks

**No frameworks**
 — _RedPash stack is vanilla JS + Rust by deliberate choice; a frontend-framework dependency disqualifies a reuse/integration option_

RedPash rests on exactly two foundations: vanilla JS (the standards-based web platform) on the front end, Rust on the back end. No frontend frameworks — React, Vue, Angular, Svelte — ever.

**Why:** Em wants the stack on stable, standard-governed foundations, not the framework-churn treadmill — code that still runs in a decade. A framework is also dependency debt, and a clean foundation is RedPash's competitive edge ([[no-code-debt]]).

**How to apply:** When evaluating whether to reuse or integrate an existing tool/library, a frontend-framework dependency is disqualifying on its own — regardless of how much code it would save. Em rejected embedding the Vue-based Apache ECharts theme builder on exactly these grounds. The right move with such a tool: reuse its output *format* or its UX *pattern*, never the framework-bound app. Build features native in vanilla JS.

**Carve-outs (the open dimension).** Vanilla is the default on the runtime layers (`frontend/scripts/`, `backend/crates/`). Outside those layers, carve-outs are allowed when the requirement is sharp enough — and as of 2026-05-31 Em explicitly opened this as a *pattern* to be evaluated case-by-case rather than a fixed list of one-offs:

- `tools/*-audit/` — Acorn AST parsing for static analysis. See [[acorn-allowed-for-static-analysis]].
- `tools/mcp-server/` — TypeScript, because the MCP SDK is itself the dependency that justifies the carve-out. Ships pre-compiled to `dist/`; never touches the browser.

**Em 2026-05-31:** *"that's interesting, it opens a door to what could be TS and what should stay Vanilla JS in the code. we will see."* The principle that crystallised in that conversation: TS compiles away (zero runtime cost vs hand-written JS, zero WASM-boundary impact), so the trade-off is dev-time safety vs build-step cognitive load + the no-frameworks-vibe — not a perf trade-off. Today's call: **frontend runtime stays vanilla**; the MCP-server TS is a boundary, not a foothold. But future tool-side / build-artifact / SDK-required surfaces are evaluated on the same shape (does it ship pre-compiled? does it stay out of the runtime layers? does the SDK require it?) rather than blanket-rejected. Smallest-cost path if we ever wanted partial type safety on the frontend runtime *without* a build step: JSDoc `// @ts-check` — same `.js` files, TS-style checking in editors and `tools/audit.sh`.

### feedback_acorn_allowed_for_static_analysis

**Acorn for static analysis**
 — _One carve-out from the no-frameworks rule — Acorn is allowed in `tools/*` static-analysis scripts (js-audit AST parsing), NEVER in frontend / backend runtime code._

The project's [[feedback-no-frameworks]] rule (vanilla JS + Rust by deliberate choice) holds for runtime code — `frontend/scripts/` stays framework-free, `backend/crates/` doesn't pick up Node-shaped helpers. But `tools/*` scripts are static-analysis utilities that run on developer machines, not in the shipped product. For those, **Acorn is sanctioned** as a parser dependency.

**Why:** Em (2026-05-25) adopted the AST-based js-audit (audit.js v2, swap landed in the same commit that wrote this note). The AST upgrade eliminates regex false positives (e.g. `function esc` inside a comment or string) that a pattern catalog would otherwise miscount. The accuracy gain is worth the dep cost for tooling that NEVER ships to users.

**Scope of the carve-out:**

- **Allowed in `tools/*`** when the tool benefits from real parsing (AST walks, scope analysis, import resolution). Current consumer: `tools/js-audit/audit.js`. Future tools (linters, dead-symbol detectors, dep-graph visualizers) can use Acorn too — no new approval needed per tool.
- **NEVER in `frontend/scripts/`** — the app stays Acorn-free at runtime. No bundling, no in-browser AST parsing.
- **NEVER in `backend/crates/`** — Rust stays Rust. No Node-shim trans-deps.
- **Acorn must remain available globally** on the dev box (currently is via Node's global modules). If a teammate's CI runs the audit and acorn isn't there, they install it locally — not committed to the repo as a `package.json` dep (we don't ship one).

**How to apply:**

- New `tools/*` scripts: zero-dep is still the default. Reach for Acorn only when regex parsing would meaningfully miscount (definitions, imports, scope-aware analysis).
- New runtime code (FE / BE): the no-frameworks rule applies unchanged. A request for "just one tiny lib" in frontend/scripts/ is a no.
- Other parsers: same carve-out shape applies. If a future audit wants `@babel/parser` or a CSS AST lib, add a similar memory note + keep it confined to `tools/*`.

**See also:** [[feedback-no-frameworks]] (the parent rule this carves out from), [[feedback-build-tools-proactively]] (proactive analyzers in `tools/*` are encouraged).

### feedback_scale_perspective

**Scale perspective**
 — _Em's directive — build RedPash for millions of users 'one day'. Means: keep the foundation scale-neutral; do NOT build scale infrastructure early._

Em, 2026-05-22 (he "begged" the team): build RedPash with the perspective of handling millions of users one day — even though it has ~1 user now and won't be near that load for months.

**The precise reading — this is NOT "build the scale infrastructure now."** Standing up Redis clusters / sharding / queues / microservices for ~1 user would be its own debt (complexity debt — unused machinery to maintain) and contradicts "as simple as possible." Em is not asking for that.

**What it DOES mean: never make a decision that is cheap now but impossible to reverse under load.** The checklist:
- **Algorithms** — no O(n²) or O(n·users) where O(n) was available. Free to get right now, brutal to find at 32M rows.
- **Queries** — every DB query index-backed and paginated (RedPash already paginates via `PageQuery`); no per-request full-table scan.
- **Statelessness** — apply the test: *"if I run 5 copies of this binary, does anything break?"* In-process memory is fine *as a cache* (rebuildable from Postgres on miss — e.g. the `DashMap` frame cache; Redis slots in front later, nothing breaks). It is a trap as *correctness / session state*.
- **Multi-tenancy** — the data model must not bake in single-tenant assumptions. This is why the object-model hard refresh + the planned RBAC row-level-scoping workstream ARE the scale foundation.

**Topology — modular monolith (Em, 2026-05-22).** RedPash is one Rust binary by design, and stays that way. Microservices' real payoff is *organisational* — independent team deploys, Conway's law — not load; a small team doing them pays the full distributed-systems tax (network hops, eventual consistency, observability sprawl) for a benefit it has no org to need. In-process also means no network / serialization hop — part of the speed story (same reason in-process `DashMap` beats Redis). Stay modular *inside* (`api` / `data` / `shared` crates, clean seams) so a component *could* be extracted later — but draw boundaries in code, never over the network, until one component has one concrete reason (independent scaling or an independent team). The Amazon Prime Video case is a "don't split a hot, chatty path" lesson, not "monolith beats microservices."

**Boundary-cost rule (Em, 2026-05-22 — he is NOT anti-microservices; it's a cost argument, not a correctness one).** A service/API boundary is *forced* cost only when it crosses to a genuinely **external** system (someone else's). A boundary *inside* one logical system converts free in-process function calls into billable API calls — manufactured cost (at SaaS scale, millions of them just to move one org's own data around its own system). Both architectures run fine; one costs more. The monolith's price is paid instead in **factorisation discipline** — factor to the atom, parameterise the single varying axis (one glass-button CSS with the bootstrap icon as a parameter, since the icon is all that changes). That is the [[no-code-debt]] discipline: microservices *enforce* boundaries via the network, a monolith enforces nothing, so the discipline must be deliberate and continuous. Pay it in discipline, not dollars.

**The unifying idea:** a clean foundation scales for free once the machinery is bolted on later; a debt-ridden one can't scale no matter what is bolted on. So "build for millions" is the *why* behind [[no-code-debt]] — same discipline, scale is the reason it matters. Don't build scale infra early; don't foreclose scale ever. Related: [[object-model]], [[rbac-corporate-ready]].

### feedback_cleaning_cadence

**Cleaning cadence**
 — _Cleaning runs on a regular cadence triggered by the audit system surfacing an edge case — not as a big quarterly pass. Small + frequent so it never becomes a job._

Cleaning (stale refs, dead code, drifted comments, orphan files, schema/SQL stragglers) runs on a **regular cadence**, not as a deferred big-bang pass. The natural trigger is **the audit system surfacing an edge case** — an unexpected finding from css-audit / js-audit / rs-audit / crossing-audit / html-audit is the cue to open a small cleaning pass right then.

**Why:** Em (2026-05-23, after Phase 2 / runbook 0002 / drop-table rule): "we did a lot of cleaning, we should establish a frequence to this, if it's done regularly, it will never be a big job." The hard-refresh proved the cost of letting drift accumulate (Phase 2 missed `PROJECT_SELECT`'s dashboards join, `/api/projects` 500'd silently until caught). The audit system already knows when something has drifted — use it as the alarm, not a calendar.

**How to apply:**
- When an audit run produces a *new* edge-case finding (not a known/accepted one), open a small cleaning pass on that finding before moving on — not "later in a cleanup pass."
- Treat an unexplained audit hit as a load-bearing signal: investigate root cause, fix it, and if the finding represents a class, generalize (memory rule, runbook entry, or audit improvement).
- Persist audit results to `audit.run` / `audit.finding` (tables exist from mig 028, currently empty) so cadence is measurable — frequency of findings is itself a health metric.
- Small + frequent beats big + rare: a cleaning task scoped to *one* finding fits in a session; a deferred mega-cleanup does not.
- Distinct from [[cleanup-pass]] (HTML-partial componentization, deferred deliberately) — that one stays parked because it's a surface refactor; this cadence is about not letting *foundation* drift accumulate.

Related: [[no-code-debt]] (the why), [[drop-table-grep-everywhere]] (an audit rule that came from a finding), [[build-tools-proactively]] (the audits themselves), [[refactor-decompose]] (cleaning passes should still be decomposed, not open-ended).

### feedback_drop_table_grep

**Drop-table grep everywhere**
 — _When dropping a database table, grep the WHOLE codebase for the table name — not just the table's own module. References can live in shared SQL constants, status-overlay subqueries, triggers, views, the frontend._

When you drop a table, **grep the whole codebase for the table name** — `grep -rni '<table>' backend/ frontend/ docs/` — and read every hit. Scoping the audit to the table's own module is necessary but not sufficient: references can live in shared SQL constants (`*_SELECT` / `*_COLS` strings), `EXISTS` subqueries inside *other resources'* helpers, trigger function bodies (Postgres validates function bodies at call time, not at creation — a stale reference only blows up when the trigger next fires), views, frontend callers of the soon-defunct endpoint, and the migration SQL itself.

**Why:** Phase 2 of the object-model hard-refresh (`92fcf87`, 2026-05-22) dropped `dashboards` and re-pointed the dashboards block in `db.rs`, but missed `PROJECT_SELECT`'s "published" status subquery — which joined `dashboards` for a *projects-side* status overlay, not for anything dashboards-related. `/api/projects` 500'd silently from Phase 2 landing until `84f3939` caught it. Documented in [[runbook 0002]] (`docs/internal/runbook/0002-stale-join-after-drop.md`).

**How to apply:** Make the whole-tree grep a fixed *first step* of any drop-table migration plan — before writing the migration, not after. Then after the migration applies, smoke-test **a representative endpoint per resource** (`/api/projects`, `/api/files`, `/api/charts`, `/api/dashboards`, …) not just the resource the migration nominally targets — that catches breakage in shared SQL constants the migration didn't touch directly. Related: [[no-code-debt]], [[object-model]].

### feedback_comments_truthful

**Keep comments truthful**
 — _fix comments/docs that a code change makes stale, in the same commit — this is in-scope, not the deferred cleanup pass_

When an edit makes a nearby comment or doc inaccurate (e.g. a comment that says "opens a modal" after the code switched to a dropdown), correct it as part of the same change. The user explicitly and repeatedly values "the cleaning you always do behind."

**Why:** confirmed by warm appreciation on the cleaner modal-ditch (2026-05-21); a comment that lies about the code it sits on is a real defect, and shipping the fix alongside the change keeps each commit internally consistent.

**How to apply:** updating comments/docstrings/headers to match code you just changed is expected and in-scope — it is NOT the inline refactoring that [[cleanup-pass-deferred]] defers. The deferred pass = dedup + HTML-partial componentization (scope expansion); this = not leaving your own change half-described. Do it in the same commit, mention it in the per-file changelog body.

### feedback_module_strict_mode

**Module strict mode trap**
 — _Frontend JS files are ES modules (strict mode); duplicate function-name declarations at the same scope are SyntaxErrors that block the whole module from loading_

When adding new module-scope helpers to a large JS file (e.g. `frontend/scripts/pages/cleaner.js`), grep for the helper's name first to make sure it doesn't already exist. ES modules run in strict mode; duplicate `function foo() {}` declarations at the same scope level throw `SyntaxError: Identifier 'foo' has already been declared` at parse time, which blocks the entire module from loading — pages mount to a blank background, no useful runtime error.

**Why:** Hit this with `_pageCacheKey` in cleaner.js on the redpash-app prerelease branch — the legacy mount path had an in-memory cache key helper at the top of the file (line ~404), and a new Tier 2 D localStorage rows-cache helper landed near the bottom (line ~7548). Both pages-not-importing-cleaner-js worked; only the cleaner page rendered blank, which made the diagnosis non-obvious until acorn flagged it.

**How to apply:** Before adding a top-level `function`, `const`, `let`, or `class` in any [[project_redpash]] frontend module, `grep -n "^function NAME\|^const NAME\|^let NAME" file.js` to check for collisions. If you can't run a parser, acorn via `npx --yes -p acorn acorn --ecma2022 --module file.js` reports duplicate-declaration errors cleanly. Renaming the new symbol is almost always cheaper than refactoring the old one.

### feedback_scope_redpash_app

**Scope: redpash-app only**
 — _keep work scoped to redpash-app; do not expand into sibling dirs redpash-front-end/ or redpash-components/ sandbox_

Keep all work scoped to `/home/mansa/redpash-app`. Do NOT open work, edits, or follow-up tasks in the sibling directories — `redpash-front-end/` (a separate/older frontend copy) or `redpash-components/` (the component sandbox/demo) — even when a grep or verification surfaces the same issue duplicated there.

**Why:** The user is pace-constrained on redpash-app and "can barely keep up." Scope creep into parallel copies dilutes focus on what actually ships. Said this after a cleanup grep flagged the same stale comments in `redpash-front-end/controls.js` and the demo HTML — user: "no worried about redpash-components stuffs, we already got a lot to deal with here."

**How to apply:** When cross-dir greps surface matches outside `redpash-app/`, treat them as out of scope — don't add them as work or dwell on them. A one-line FYI is fine; never auto-expand. Only touch those dirs if the user explicitly asks.

**Exception:** If `redpash-app` actually consumes a sibling dir at runtime/build — a remote import, a fetched asset, a shared dependency — then that dir is effectively part of redpash-app's surface and IS in scope. The rule is "ignore parallel copies," not "ignore real dependencies." See [[cleanup-pass-deferred]].

### feedback_runtime_swap_capability_parity

**Runtime swap = capability swap**
 — _When shipping a wasm/alt-runtime wrapper for a server function, match what the cleaner/full algorithm does end-to-end, not just the bare API call — runtime swap = capability swap, not downgrade_

When wrapping a server-side function for a different runtime (wasm-bindgen wrapper, RPC stub, etc.), the wrapper must match the **full user-visible product flow** of what the server delivers — including diagnostic surfaces, rescue prompts, and user-confirmation steps — not just the bare API call.

**Why:** WASM Phase C surfaced this concretely 2026-05-26. Em ran the bench on `dossier.csv` (13.46 MB, score 5.9, reported 1 col). The wasm `parse_csv` just called `parse::from_csv_bytes` → `dtype::summarize` → `stats::cleanness_report`. The server-side flow surfaces "wrapped CSV detected" + offers `unwrap_csv` as a Cleaner step that the user confirms. So:
- Server path: parse 1 col → diagnostic surfaces "wrapped detected" → user clicks unwrap → real N cols
- WASM path: parse 1 col → done (no diagnostic, no recovery prompt, no path to recovery)

**Correction iteration 2026-05-26 (Em's product call, commit d1ea8df).** My first attempt at fixing this (5bad5a2) baked `unwrap_csv` directly into the parse algorithm — auto-rescue on detection, return the recovered N-col frame. Em REVERTED this with the rule: **parse stays diagnostic. The user confirms transforms; the parser does NOT silently apply `unwrap_csv`.** The new `RescueDiag::WrapDetected { preview_width }` enum names what parse SAW, not what parse DID. The auto-apply was paternalistic — hid the transformation from the user, removed their ability to inspect-then-decide, and bypassed the consent loop that makes RedPash "a tool for working" rather than a magic black box.

The real rule that survived: parity matters, but parity is at the **user-visible product layer**, not the function-call layer. WASM should now report `WrapDetected` exactly like server does; the unwrap step should be available via `step_preview` and applied through user action in the Cleaner — same wherever the runtime sits. Same diagnostic, same prompt, same user choice. The transformation is the user's; the diagnostic is the parser's.

**How to apply:**
- Before declaring a wasm/alt-runtime wrapper "at parity," walk the actual user-visible flow on the server side: parse → diagnostic → prompt → user-confirms → cleaner-applies. The wrapper must cover the SAME flow, including the diagnostic + the path-to-recovery. Don't bypass the user-confirmation step.
- **Diagnostic, not transformative.** When the parser SEES a rescue-eligible shape (wrapped, encoding-confused, ragged, etc.), expose that as a return-field / enum variant (e.g., `RescueDiag::WrapDetected`). Don't silently apply the rescue. The user gets the diagnostic surface in the UI and decides. This is the d1ea8df pattern.
- When designing a new wasm surface: write the wrapper's docstring as "produces the SAME diagnostic surface the server's [page name] shows," not "matches what the server's [function name] does internally." The pixel-equivalent UI flow is the contract, not the function signature, and not the transformation.
- **Test by user-trace:** "if a non-technical user uploads file X via the wasm path vs the server path, do they see the same banner, the same suggested fix, and end up with the same recovered DataFrame after clicking?" If yes, parity. If wasm hides a transformation server-side would have prompted for, that's a parity break in the OTHER direction (auto-apply hides user choice).

Linked: [[feedback-unify-behavior-not-names]] — same options must be functional across every tab in a family. This memory extends the principle from FE tabs to backend runtimes, with the d1ea8df refinement: behavior unification includes the user-consent loop, not just the underlying capability.

### feedback_no_broad_pkill

**No broad pkill**
 — _Never pkill -f by the redpash-api binary path — it kills Em's running app + the MCP cases backend, which share that binary. Kill only the specific PID you started._

When stopping a test/verification server, kill ONLY the specific PID you
launched (`SRV=$!` then `kill $SRV`). NEVER `pkill -9 -f
'target/debug/redpash-api'` or similar broad binary-name patterns.

**Why:** multiple processes share the `target/debug/redpash-api` binary —
Em's running app and the **MCP redpash-slack cases backend** that the
`case_get` / `case_comment` tools fetch from. A broad `pkill` nukes all of
them. Did exactly this 2026-05-29 during temp-DB cleanup mid-build and took
the cases backend down (the next `case_comment` returned "fetch failed",
:8080 went empty). An unintended outage of a shared service.

**How to apply:**
- Track the test server's PID at launch and `kill $PID` it — never by name.
- For port cleanup, target the PID bound to that port (e.g. via `ss -ltnp`),
  not every process matching the binary.
- Restarting the killed app is NOT a clean undo right now: the current binary
  has uncommitted/committed *new migrations* baked in, so booting it against
  the shared prerelease DB applies them (e.g. the entity-registry migration).
  Flag that to Em rather than silently rebooting. Related: [[push-policy]],
  [[verify-git-branch]].

### feedback_playwright_parallel_chrome

**Playwright parallel to chrome-devtools**
 — _When chrome-devtools-mcp's profile is locked by another Torv, switch to the Playwright MCP — it forks its own browser per session and runs in parallel without profile contention_

When live debugging is needed and the `chrome-devtools-mcp` profile dir
(`/home/mansa/.cache/chrome-devtools-mcp/chrome-profile`) is held by
another agent's Chrome session, **switch to Playwright MCP** instead of
waiting. Playwright launches its own browser process per server session
and ignores the chrome-devtools profile entirely — multiple Torvs can
debug live in parallel without any config change.

**Why (2026-05-30):** I was stuck for a column-drag debug because the
chrome-devtools-mcp profile was locked by another Torv ("The browser is
already running for /home/mansa/.cache/chrome-devtools-mcp/chrome-profile.
Use --isolated to run multiple browser instances."). I pushed a fix
from static analysis alone, which Em couldn't easily verify. Then I
tried Playwright — `browser_navigate` to `http://localhost:8080`
launched cleanly, no lock conflict, and I verified the fix end-to-end
(drag → reorder → fetchList → alignment held). The fix turned out
correct; without Playwright I'd have stayed blind. Em then upgraded the
WSL host with `microsoft-edge-stable` + `firefox-stable` so each Torv
can have its own channel.

**How to apply:**
- If a chrome-devtools-mcp call returns "browser is already running for
  …chrome-profile", do NOT wait for the other agent or ask Em to close
  Chrome. Reach for `mcp__plugin_playwright_playwright__browser_*`
  tools immediately (load them via `ToolSearch` if deferred).
- The Playwright tools that cover the chrome-devtools toolkit:
  `browser_navigate`, `browser_snapshot` (accessibility tree with
  refs), `browser_take_screenshot`, `browser_click`, `browser_drag`,
  `browser_evaluate`, `browser_console_messages`, `browser_tabs`.
- `browser_drag` does a real native drag (uses Playwright's
  `dragTo()`). For drag handlers that depend on `clientX` position
  inside the target (drop-before vs drop-after), dispatching synthetic
  `DragEvent`s with precise `clientX/clientY` in `browser_evaluate` is
  more reliable than UI-level drag.
- The Playwright MCP browser is a separate session from Em's daily
  Chrome — when reasoning about app state, remember it doesn't share
  cookies/storage with Em's browser. Log in via the dev-login path
  every fresh session.
- For Em's setup with Chrome + Edge + Firefox installed on WSL:
  three-Torv mapping is each Torv on a different Playwright
  `--channel` (`chromium`, `msedge`, `firefox`) — zero profile
  contention, three browsers running side by side.
- Complements [[user-profile]] (Em values data — Playwright IS how I
  produce data when chrome-devtools is locked) and
  [[feedback-process-oriented]] (the fix-it-once pattern: encode the
  workaround as a memory so the next agent doesn't burn cycles on the
  same lock).

### feedback_sentinel_columns_in_reorder

**Sentinel columns in reorder**
 — _When reordering DOM children that frame data columns (leading select cell, trailing hide-action cell), anchor data inserts BEFORE trailing sentinels — never appendChild-to-end in a loop, which shoves the sentinel to position 0_

When a column-reorder operation needs to move N data THs (or TDs) into
a target order in a row whose children include **sentinel columns**
that frame the data — e.g. a leading `.rp-list-sel` select-mode
checkbox, a trailing `.rp-home-hide-th` hide-from-list action column —
**do NOT use `parent.appendChild(dataNode)` in a loop**. Each
appendChild moves the data node to the LAST position, which on every
iteration shifts the trailing sentinel one slot to the LEFT. After N
appends, the trailing sentinel ends up at position 0, every data
column shifts right by one, and `applyHiddenColumns` (which positional-
indexes by `nth-child`) silently mis-hides columns.

**Why (2026-05-31):** my `reorderColumnDOM` in `list-page.js` did
exactly that. Three layers of column-drag bugs surfaced before the real
one was visible: an early-return on a fetchList-vs-spec tbody
mis-alignment (c6ced6c), a too-subtle CSS drop indicator on the first
column edge (0ae04f0), and finally the sentinel-shoving appendChild
loop (c7ca6e6). Em saw the third only because he tested live on a Home
tab with `spec.hideMeta` — the hide-action column was the sentinel
that got pushed to position 0, making every header render its
right-neighbour's data. Couldn't see this from static analysis; it
needed Playwright + drag actions + checking `headRow.children`
positions vs `tbody tr.children` positions.

**How to apply:**
- Before introducing a DOM reorder helper, list the *non-data* columns
  that frame the row: leading sentinels (select checkbox, row handle,
  rownum) and trailing sentinels (hide action, kebab menu). Define
  named constants for their classes so a future framing column updates
  one place.
- Detect the *first* trailing sentinel by scanning children for the
  first non-data-col-key TH that comes AFTER at least one data TH.
  Anchor data inserts via `parent.insertBefore(node, anchor)` instead
  of `parent.appendChild(node)`. Fall back to `appendChild` only when
  no trailing sentinel exists.
- For tbody, filter sentinels out of the data-cell set before building
  the reorder mapping, and explicitly reattach leading + trailing
  sentinels around the reordered data cells.
- Always `applyColumnOrder` BEFORE `applyHiddenColumns` (or any other
  pass that uses `nth-child` against the row): hide can only stay
  correct on a thead+tbody pair that's already column-aligned. If the
  call order matters, encode it in the consumer (home.js / monitoring.js)
  with a comment explaining why.
- For drag-and-drop column features specifically, *always* verify live
  in the browser, not just from static analysis. The off-by-one is
  invisible until you check the cell-under-header mapping on a row
  with a sentinel column.
- Complements [[feedback-playwright-parallel-chrome]] (Playwright is
  the way to verify live in parallel with another Torv's chrome-
  devtools-mcp) and [[feedback-process-oriented]] (the discipline:
  encode the rule as a named constant + a drift note in the atomic
  doc so the next agent doesn't reinvent the shove-the-sentinel bug).

### feedback_bug_case_runbook_cadence

**Bug → case → runbook cadence**
 — _Non-trivial bugs get a case at discovery and a runbook when fixed; the case closes with a backlink to the runbook. Reasoning survives in docs/internal/runbooks/, not in git log._

When I hit a non-trivial bug during a session, the discipline is now
**file a case at discovery, write a runbook when fixed, link them
bidirectionally by the case's `CAS_<rid>`**. The runbook lives at
`docs/internal/runbooks/CAS_<rid>-short-slug.md` — named after the
case ID so the runbook is findable by case ID in the filesystem the
same way it's findable in the cases system. Em 2026-05-31: *"we used
0006 0007 because haven't implemented the Case object yet, at the
time — let's use proper IDs just so we can find them in the system."*
Legacy entries **0001-0006** keep their pre-Case-object numbering for
historical continuity; do NOT renumber them, but apply the
`CAS_<rid>-<slug>.md` naming to all new entries. (0007/0008/0009 were
all *retroactively* renamed from `NNNN-slug` to `CAS_<rid>-slug` on
2026-05-31 once the MCP came back — see the rename flow below.)
The runbooks `index.md` "Conventions" section was reconciled to this
on 2026-05-31 (Torv-1 scoped `NNNN-<slug>` to legacy 0001-0006 + named
`CAS_<rid>-<slug>` for 0007+; I corrected its stale `order: 0` →
`order: 60` prose) — it's accurate now, no longer a drift point.

The runbook follows the existing 5-section format (Problem Statement /
Troubleshooting steps / RCA / Solution / Post Checking +
"Discipline this updates" close-out + "Linked" list), with
`case_id: CAS_<rid>` in the frontmatter. The fix commit body ends
with `Runbook: docs/internal/runbooks/CAS_<rid>-...md` and
`Case: CAS_<rid>` lines. See
`docs/internal/processes/bug-case-runbook-cadence.md` for the full
cadence.

**Why (2026-05-31):** Em: *"I believe now we should fill a case when
we find a bug and linked them to a runbook when fixed, we never
document these and I'm convinced it's not a viable long term plan."*
Today's column-drag debugging session shipped 4 fix-level commits
(c6ced6c / 0ae04f0 / c7ca6e6 / 2b8b12d) with the only durable record
being the git log — no runbook, no case, no pattern catalog. The
runbooks dir already had 0001–0006 (the muscle was there) but had
been dormant for a week. Without this discipline, the *reasoning*
behind each fix evaporates the next time someone touches the
neighborhood; the next agent burns the same cycles re-diagnosing the
same class of mistake.

**How to apply:**
- A "non-trivial" bug is anything whose fix gets a `fix(...):` commit
  subject, anything that required live debugging, or anything that
  surfaced a class of mistake (positional indexing under reorder,
  race between two paint passes, etc.). Typos, formatting, doc-only,
  test-only changes do NOT trigger the cadence.
- File the case via the MCP `case_create` tool at discovery time
  (before fixing). Type=bug, priority by severity. The MCP posts as
  woz_48 per [[project-agent-identities]]; that's fine. The returned
  `CAS_<rid>` becomes the runbook's filename (`CAS_<rid>-slug.md`)
  + frontmatter `case_id` + the commit body's `Case: CAS_<rid>` line.
- **The cases MCP is WORKING again as of 2026-05-31** — the 401
  (`no session cookie`) outage was fixed by the auto-refresh shipped
  in runbook 0008 (lazy mint + retry-on-401, `tools/mcp-server`,
  c78350f). `case_create` / `case_list` / `case_get` all succeed now;
  the MCP posts as woz_48 per [[project-agent-identities]]. If it ever
  401s again, fall back to the offline-filing flow below.
- **Offline-filing fallback (MCP down at discovery):** write the
  runbook anyway under a temp `NNNN-slug.md` name, mark `case_id: TBD`
  + a `filename_pending_rename:` frontmatter note, and a short in-body
  "filed pre-case" callout. Then once the MCP is back, run the
  **retroactive-rename flow** (executed end-to-end this session):
  `case_create` → capture `CAS_<rid>` → `git mv NNNN-slug.md
  CAS_<rid>-slug.md` → set frontmatter `case_id`, drop the
  `filename_pending_rename` line, rewrite the in-body note → repoint
  every backlink (runbooks `index.md` entry link, and any atomic-doc
  `Doc:`/runbook cross-links, e.g. the source file's atomic doc). The
  rename is its own `docs(runbook):` commit ending with `Case:` +
  `Runbook:` trailers.
- **Parallel-Torv rename hazard (learned this session):** when several
  Torvs rename runbooks concurrently on the shared tree, their `git mv`
  renames sit *staged in the shared index*. Commit YOUR rename with
  `git commit -o <old-path> <new-path> <referencing-docs>` — list BOTH
  the old and new path so git captures the delete+add as a rename and
  `-o` keeps the *other* Torv's staged renames out of your commit.
  Touch only your own entry's line range in the shared `index.md`
  (each Torv owns their numbered entry's lines); coordinate on
  broadcast.md *before* committing index.md when renames overlap. This
  is [[feedback-parallel-safe-commits]] applied to renames specifically.
- Write the runbook the same day the fix lands — context decay is
  real, "why I ruled out X before landing on Y" goes fuzzy by
  tomorrow.
- For interrelated bugs surfaced in one diagnostic arc (today's 0007
  is the worked example — 4 commits / 4 root causes / one
  debugging session), prefer ONE consolidated runbook with layers as
  numbered subsections, not N separate runbooks. The diagnostic arc
  IS the lesson; splitting it loses the through-line.
- The fix commit's body ends with `Runbook:
  docs/internal/runbooks/CAS_<rid>-….md` (+ `Case: CAS_<rid>`) so
  `git log` still points at the durable record.
- **Verify before claiming resolved (worked 0009 example):** the
  runbook's Post Checking section is a real gate, not a formality.
  For the cache-control fix I ran my own server on a throwaway port
  (8099, not the default 8080 to avoid colliding with Em's instance
  per [[feedback-no-broad-pkill]]), curled the three documented checks
  (header present / conditional GET → 304 / `/api/*` unaffected),
  then killed only my PID. Flip the runbook `status: proposed →
  resolved` only after the checks pass live.
- Don't rebrand the legacy 0001-0006 numbering — those stay numeric.
- Complements [[feedback-process-oriented]] (fix it once, encode in
  a script/audit/runbook), [[feedback-build-tools-proactively]]
  (tools/runbook-audit/ is a natural follow-up — read-only static
  check for fix-commits lacking a `Runbook:` line — deferred but
  noted in the cadence doc).


## Feedback — CSS / UI rules

### feedback_naming_consistency

**Naming consistency**
 — _One class/identifier name per UI concept across pages; page-prefixed duplicate names for the same thing cost the user real debugging time_

Give a recurring UI concept exactly one class name across the whole app. Don't let the same structural role carry different page-prefixed names — e.g. `.rp-profile__pane` vs `.rp-settings__content` for the identical scrolling content pane, or `.rp-profile__layout` vs `.rp-settings_layout` for the identical rail+pane grid. Follow the existing BEM double-underscore convention (`block__element`), never single `_`.

**Why:** During the /settings page extraction the user spent a long time manually eyeballing and cross-referencing files to discover that /profile and /settings had divergently-named but identical layout structures (plus a silent name collision with `styles/components/forms.css`'s `.rp-settings`). The user reviews by eye, not grep, so inconsistent naming is an expensive, recurring debugging tax for them — and it directly undermines the reusable-component mindset they care about.

**How to apply:** When building or refactoring CSS/components, name a recurring structure once with a neutral, non-page-prefixed name and put it in a shared component file that pages import — the way `side-nav.css` and `settings-rows.css` already work. Before inventing a class name, grep for it to avoid collisions. Proactively flag divergent naming when you notice it. See [[css-component-decomposition]].

### feedback_compose_atoms_dont_parallel

**Compose atoms, don't parallel**
 — _Before creating ANY new `.rp-*` page-prefixed class, check if an `rt-*` foundation atom already covers it. Compose the atom; don't parallel it. Every parallel-class is a CSS leak._

The 8-component foundation atoms (`rt-*`) exist *so that pages don't grow their own version of each primitive*. The moment I create `.rp-mon-panel` to do what `.rt-table-wrap` already does, I:

1. **Duplicate the visual concept** — two classes for "list on the page without a toolbar."
2. **Drift the foundation** — each new page invents its own atoms, fracturing the contract.
3. **Make audits impossible** — orphan/cut/keep classification can't tell foundation from page-specific debt.

That third effect is what the css-usage audit needed to clean up. The root cause was the leak, not the dead rules — the rules accumulated *because* the atoms were bypassed.

**Why:** Em (2026-05-25, after the cleanup attempt): *"the root cause is not the last cleanup, it's why created the need for the cleanup. rt-table-wrap is the atomic part you should have used if you just wanted to put lists on the page without toolbar. but you created rp-mon-panel. and just this created a leak on the css."*

**How to apply:**

- **Before writing any `.rp-*` page-prefixed class, grep the `rt-*` family first.** If an atom fits (even imperfectly), compose it. Page CSS becomes positional overrides + new modifiers on the atom — NOT new parallel classes.
- **If an atom doesn't fit, ask first: should the atom grow a new variant, or is this genuinely page-specific?** A new `--ghost` modifier on `.rt-btn` belongs in `button.css` (foundation), not in `home.css` (caller). A page-only structural class (`.rp-home-hero` for a once-only landing gradient) is fine — that's not visual primitive territory.
- **The atoms today** (per [[project-frontend-reset]] / main.css workspace section): `rt-btn` · `rt-table` (+ `rt-table-wrap`) · `rt-toolbar` · `rt-nav` (rail) · `rt-pager` · `rt-panel` · `rt-chart` · plus topbar atoms. Their state modifiers (`.is-active`, `:hover`, `.compact`) and descendants (`.rt-table .col-n`, `.rt-panel-inner`, etc.) are part of the contract.
- **When auditing or proposing cleanup, the parallel-class leak is the bug to surface — not the orphan rules it produced.** The cleanup tool should report "these `rp-*` classes appear to duplicate an `rt-*` atom" as a separate flag, distinct from "orphan."
- **Per [[feedback-naming-consistency]]:** one class per UI concept across pages. Parallel classes (`.rp-cases-card-rid` + `.rp-mon-modal-meta` + …) for what's really the same monospace-ID-chip concept are debt waiting to compound.

**See also:** [[feedback-ui-equals-backend-discipline]] (foundation contracts are not deletable just because unused), [[feedback-no-code-debt]] (guard the foundation ruthlessly), [[feedback-refactor-decompose]] (a refactor only converges when decomposed into a finite reusable set), [[feedback-naming-consistency]] (one class per concept).

### feedback_unify_behavior_not_names

**Unify behavior not names**
 — _Unification target = same options/behavior everywhere, not just same class names; disabled-stub buttons that look like options are an anti-pattern, either wire them or remove them_

The point of unifying class names ([[naming-consistency]]) is so Em
doesn't waste time RE-LEARNING the same UI on a different page:
"i prefer to have the same boring tab everywhere as long as all the
options are there" (Em 2026-05-25, after the .rt-table-wrap /
.rt-table / .rt-pager rename).

**Why:** RedPash is "a tool for working" (Em 2026-05-25). When
tabs share class names but expose different features (sortable
columns on tab A but not tab B; edit mode wired on Cases but
disabled-stub everywhere else), the user pays the unification
tax (same look) without getting the unification dividend (same
behavior). Worse — disabled-stub buttons that LOOK like options
make the user "waste time to understand why edit mode looks like
a disabled button". Tools have every control functional; decorative
disabled controls aren't tools, they're showroom dressing.

**How to apply:**
- When pulling a UI primitive into a shared class, audit the
  FEATURES too — every tab using the class should have the same
  options actually working, not the same options visible-but-
  disabled.
- Disabled-stub toolbar buttons are an anti-pattern. Either:
  (a) wire the handler, OR
  (b) remove the button from that tab's toolbar config so it
  doesn't render at all.
  Don't show a button that looks pressable but does nothing — it
  burns the user's attention deciphering why.
- Sortable columns, mode buttons, filters, search behavior, export —
  same set of affordances across every tab in a unified family. If
  one tab can't support a feature yet, hide it on that tab; don't
  render it grey.
- Symmetry > local optimization. A boring identical tab beats a
  bespoke "better" tab that diverges from its siblings.

This generalizes the [[naming-consistency]] principle: class
unification is necessary but not sufficient. Behavior unification
is the actual goal.

## Sibling principles

- [[naming-consistency]] — one class per UI concept; the
  precondition for behavior unification.
- [[no-mystery-css]] — every CSS rule deliberately authored;
  disabled-stub buttons are mystery-UX in the same spirit.
- [[ui-for-non-technical-users]] — non-tech users especially
  can't differentiate "this button is disabled because the backend
  isn't ready" from "this button is broken"; remove rather than
  grey.

### feedback_ui_equals_backend

**UI equals backend**
 — _From a user's perspective, a UI bug (button hidden behind a stray display:none) and a backend bug (join.rs not working) are the same failure: 'can't do X'. UI deserves the same rigor as backend code._

Em 2026-05-25, in a message to Torv (shared with me):

> "Torv, you have to understand UI is not a joke. If I try to
> maintain discipline there also, or I'm insisting in improving the
> UI it's because it's as important as the back-end code. What's the
> difference for the user between not seeing join button because we
> leave a display:none somewhere and join.rs not working? it's the
> same problem, he can't do jointure. do you see my point?"

The core thesis: UI failure modes and backend failure modes are
*equivalent from the user's perspective*. A button hidden by a stray
display:none is the same outage as a backend route returning 500.
The user can't do the thing. Whether the bug lives in CSS or in
Rust is an implementation detail.

**Why this matters as a guiding principle:**

1. The discipline Em applies to UI alignment (rt-table-wrap / rt-table /
   rt-pager unification, toolbar parity, disabled-stub stripping, the
   redtable-audit tool) isn't aesthetic perfectionism. It's failure-
   mode prevention. Every duplicate CSS naming, every silently-overridden
   selector, every fake-clickable disabled button is a hidden failure
   path that costs rebuild time later (the "5-hour-then-force-reset"
   scenario from [[naming-consistency]]).

2. "Looks broken" → "is broken" for the user. A visible button with
   no handler ([[unify-behavior-not-names]]) is a feature outage even
   though the backend works. Conversely, a working backend with a
   hidden frontend is also an outage.

3. The audit tool (tools/redtable-audit/audit.js) is the UI equivalent
   of cargo check + tests. Encoding the rules in tooling means future
   drift fails the audit, not the user's workflow.

**How to apply:**

- Hold UI work to the same standard as backend work. If a backend
  bug would be a "stop the line" priority, a UI bug producing the
  same user-observable failure is too.
- When deciding whether to ship a UI change with a known visual
  inconsistency: ask "would I ship a backend route with a known 500
  on edge case X?". If no, fix the UI.
- The audit tools matter. Every "the audit catches that now" line in
  a commit message is the team's future selves saved.
- Disabled-stub buttons that promise functionality without delivering
  it are equivalent to a 503 endpoint with a misleading message.
  Either wire it or remove it.

**Sibling principles:**

- [[naming-consistency]] — same UI concept, one name. Drift = silent
  failure surface.
- [[unify-behavior-not-names]] — every visible control must work;
  decorative disabled stubs are anti-pattern.
- [[no-mystery-css]] — every CSS rule deliberately authored; surprise
  imports break the live app.
- [[audit-everything]] — encode the rules in tooling so the team
  finds drift before users do.
- [[no-code-debt]] — UI alignment work is foundation work; same
  weight as backend foundation. Em's edge survives only on a clean
  codebase.

### feedback_ui_equals_backend_discipline

**UI = backend discipline**
 — _UI bugs and backend bugs are the SAME bug from the user's perspective. A display:none on the join button == join.rs broken — user can't do the join either way. Treat UI changes with the same rigor as backend changes._

UI discipline is not "less important" than backend discipline. To the end user, the distinction doesn't exist: a join button hidden by `display: none` and a `join.rs` endpoint returning 500 produce the same failure — *I can't do the join.* The cause is invisible to them.

**Why:** Em (2026-05-25, after I cavalierly deleted `.rt-table .cell-name` + `.cell-warn` etc. as "orphans"): *"UI is not a joke. If I try to maintain discipline there also, or I'm insisting in improving the UI it's because it's as important as the back-end code. What's the difference for the user between not seeing join button because we leave a display:none somewhere and join.rs not working? It's the same problem, he can't do jointure."*

The mistake I was making: treating CSS classes as "dead code" when an audit says orphan. But:
- Foundation atoms (`.rt-*`) are *contracts*, not just rules. Deleting `.rt-table .cell-warn` is like deleting a Rust trait method — even if no caller currently uses it, the contract is part of what the foundation offers.
- "No current markup uses it" ≠ "no future markup will." The component library exists so callers can compose against the agreed surface.
- An audit can identify candidates. It cannot make the call.

**How to apply:**

- **Same review bar for UI and backend.** Before deleting CSS / HTML structure / JS rendering paths, ask the same question I'd ask before deleting a Rust function: is this load-bearing for any current OR foreseeable caller, and is the deletion reversible if I'm wrong? Audit "orphan" status is a hint, not a verdict. ([[feedback-no-code-debt]] already names this for the foundation; this entry extends it to UI explicitly.)
- **Foundation atoms (`rt-*`) are off-limits to bulk cleanup.** They define the 8-component contract Em locked in during the frontend reset ([[project-frontend-reset]]). Touching them needs Em's explicit go-ahead per atom — and even then, prefer keeping over deleting unless the rule is *demonstrably wrong*, not just *unused at this moment*.
- **A UI bug merits the same urgency as a backend bug.** Don't deprioritize "the chevron is the wrong color" or "the modal traps focus" because they feel cosmetic. To the user, the broken interaction is the broken product.
- **When proposing UI changes, frame in user-impact terms.** Per [[feedback-ui-for-non-technical-users]] + [[feedback-data-decides]]: not "this looks nicer" but "the user can't currently *X*, so this change makes *X* doable / discoverable / undo-able."
- **No bulk-delete CSS on `tools/css-usage` cuts unless every cut is hand-verified against current markup AND the foundation contract.** The cleanup tool helps me *see*, not decide.

**See also:** [[feedback-no-code-debt]] (guard foundation ruthlessly), [[feedback-ui-for-non-technical-users]] (non-tech users are the audience, not Em), [[project-frontend-reset]] (the 8-atom contract).

### feedback_display_none_per_page

**display:none per page**
 — _ONE toolbar (or any shared template) with ALL the buttons; hide per-page via #id-scoped display:none. Don't branch the template on per-page spec flags._

Em 2026-05-25, articulating the principle after I'd been threading
spec flags through `listToolbarHTML` (`modes: false`, `filter: true`,
`searchPlaceholder: false`, etc.):

> "display none has been my goal for how to deal with since day one.
> One toolbar with all the buttons, then display:none depending on
> the page"

**The principle:** Shared UI templates (toolbar, panel, pager, etc.)
emit the FULL canonical shape with EVERY button / control. Page-
specific suppression happens via #id-scoped CSS `display: none`
rules in the page's stylesheet. No per-spec opt-in flags branching
the template.

**Why:**

1. **Single source of truth.** Looking at `listToolbarHTML` (or any
   shared template) tells you exactly what exists app-wide. No
   hidden branches.
2. **No spec-flag bloat.** Each consumer's spec object stays focused
   on data + behavior, not visual presence. The toolbar doesn't grow
   `modes: bool`, `filter: bool`, `undoRedo: bool`, `history: bool`,
   `columns: bool`, `export: bool` flags over time.
3. **Visual override stays in CSS.** Page-specific styling lives in
   the page's stylesheet — the natural place. CSS is the right tool
   for "make this not visible on this page".
4. **Easier audit.** redtable-audit (or any future audit) can verify
   the template emits everything canonical. Per-page hiding is
   discoverable via grep for `display: none` in the page's CSS.
5. **Cheaper to add new buttons.** Add once to the template; every
   page automatically picks it up. Pages that don't want it add one
   CSS line.

**How to apply:**

- Shared templates emit the full canonical shape. No conditional
  rendering driven by per-page spec flags.
- Page-specific suppression: add a `#<page-view> .<class>` or
  `#<page-view> #<button-id>` rule with `display: none` in the
  page's stylesheet.
- Example landed 2026-05-25 (commit 050c80c) — Monitoring hides
  undo/redo/history via:
  ```css
  #rpMonView #rp-list-toolbar-undo,
  #rpMonView #rp-list-toolbar-redo,
  #rpMonView [data-dd="rp-list-toolbar-history-dd"],
  #rpMonView #rp-list-toolbar-history-dd { display: none; }
  ```
  rather than threading `undoRedo: false` / `history: false` through
  listToolbarHTML.

**Followups this implies (cleanup pass):**

- listToolbarHTML's `modes`, `filter`, `searchPlaceholder: false`
  branches could be retired — emit the full toolbar always, hide
  per-page via CSS. The spec object then carries only data + behavior
  (placeholders, mode handlers).
- Existing `{ filter: true }` opt-in for Monitoring's funnel button
  becomes always-emit + CSS hide on pages that don't want it (today:
  every page except Monitoring).
- Same pattern applies to any future shared template — card.css's
  `.rt-card-head`, panel.css's `.rt-panel-head/tabs`, etc.

**Sibling principles:**

- [[unify-behavior-not-names]] — visible options must be functional.
  Combined with this principle: emit everything in the template,
  hide per-page what doesn't apply, AND wire the ones that remain
  visible. No disabled stubs.
- [[ui-equals-backend]] — UI failure modes are the same severity as
  backend failure modes. A hidden button on the wrong page IS a
  failure, just like a 500.
- [[naming-consistency]] — one class per UI concept across pages.
  Same family of "shared infrastructure, page-specific overrides
  via scope".
- [[no-mystery-css]] — every CSS rule deliberately authored. The
  per-page `display: none` rules are explicit overrides, not
  surprise hides.

### feedback_hide_is_display_not_access

**Hide is display, not access**
 — _Rail/list hide-restore is a pure display:none declutter concern — it must never cut the data source or gate view-access_

Hide/restore (rail tabs, rail items, list rows) is a **pure display concern** — `display:none`-style declutter. It must NEVER cut the data source or affect view-access.

**Why:** Em 2026-05-28, specifying Monitoring's hide/restore: "It should just be a 'display:none' like implementation… we shouldn't cut the data source. The data in a hidden tab is still used in other tabs… What individual users decide to hide or show in the rail should be considered as an engineering problem to solve. Whatever object the user has view access on should be available to his session." Hiding the Events tab can't stop events from feeding charts / the per-user activity feed.

**How to apply:**
- Implement hide as a render-time client filter (Invariant 1 of the [[replicable-feature-pattern]]): the endpoint still returns the full set; you drop the entry from the rendered DOM only. Never add a server-side exclusion or skip the fetch.
- Don't model hide/restore at a "granular data" level — it's a per-user UI preference (pref key), orthogonal to permissions.
- This is the load-bearing distinction for the coming RBAC work ([[project-rbac-corporate-ready]]): **view-access** is RBAC (what objects reach the session); **hide** is cosmetic rail declutter. Keep them separate — a hidden object is still fully available to the session.
- Related but narrower: [[feedback-display-none-per-page]] (toolbar buttons hidden per-page via id-scoped CSS).

### feedback_no_mystery_css

**No mystery CSS**
 — _Every CSS file must be deliberately authored and accounted for — no stray/inherited/mystery stylesheets, no surprise @import; an unknown CSS import broke Em's live app once_

Every `.css` file in the codebase must be **deliberately authored and
accounted for**. No stray, inherited, or mystery stylesheets; no
surprise `@import` pulling in CSS nobody recognises. If a stylesheet's
origin and purpose aren't obvious, it doesn't belong in the tree.

**Why:** Em's hard line, stated 2026-05-22. An unknown CSS import he
didn't recognise came in and broke his live app ("an import of css I
don't know that comes fucked up my live"). He will not carry CSS he
can't trace. This is the rationale behind the frontend-reset decision
that **zero CSS survives** — re-author every stylesheet clean rather
than migrate any file, so there is no inherited `@import` chain where a
stray sheet can hide.

**How to apply:** When adding or migrating CSS — every `.css` must be
reachable from an explicit, visible load (a `<link>` in `index.html`,
or a `@import` you can trace by eye). Keep the `@import` graph **flat
and auditable** — deep nested `@import`s are exactly how a mystery
sheet sneaks in. Make this mechanical, not a vow: `css-audit` should
flag any orphan / unreachable `.css` and any surprise `@import`, the
same way `crossing-audit` makes `/api` endpoints accountable. Relates
to [[css-component-decomposition]], [[naming-consistency]],
[[font-size]].

### feedback_relative_units

**Relative CSS units**
 — _prefer rem / em / % over px in CSS; px only when there's no choice (1px borders, hairlines, hardware-pixel math). Decade-old principle, not negotiable._

When writing CSS for redpash-app, default to relative units — `rem`, `em`, `%`, `vw`, `vh`, `fr`. Reach for `px` only in cases where a relative unit genuinely doesn't work: hairline `1px` borders, hardware-pixel snap math (transforms, shadows), or measurements that must be physically constant regardless of root font-size (rare).

Quick conversions (today's root font-size is the browser default 16px):
- `8px` → `0.5rem`
- `10px` → `0.625rem`
- `12px` → `0.75rem`
- `14px` → `0.875rem`
- `16px` → `1rem`
- `18px` → `1.125rem`
- `24px` → `1.5rem`
- Widths / heights of layout regions: prefer `%`, `vw`, `vh`, or `min(Nrem, Mvw)` over fixed `px`
- Fixed-aspect chrome (icon buttons, avatars) — `rem` over `px`

**Why:** It's a web application; "now people got screens on their fridge." We can't predict every screen ratio or form factor in advance, and relative units adapt to the user's root font-size (accessibility zoom, density preferences, future kiosk-class devices). Em's framing: "I always said 'give 100% width, 50% height', and I really kept this logic as a principle since a decade ago when I was learning to build my first website." Woz (Em's local Claude Code instance) knew this but never wrote it down — surfaced 2026-05-25 after a sequence of px-heavy cases.css additions.

**How to apply:** Convert px → rem reflexively when writing new CSS. When touching existing rules, opportunistically swap px for rem in the same edit (don't open a separate cleanup pass for it). For layout regions, ask first whether `%`/`vw`/`vh` fits better than any unit-of-length. Two acceptable px holdouts: `1px` borders + token-layer scales in [[project-redpash]]'s tokens.css (those propagate everywhere through CSS vars, retrofit separately). Flag any new px outside those exceptions during code review — and consider extending [[project-redpash]]'s css-audit with a "no new px" pattern so this becomes a discoverable rule, not tribal knowledge.

### feedback_pattern_lock_personalization_within

**Pattern lock, personalize within**
 — _The page pattern is locked (rail-shell + 6-section template + redtable). Personalization happens INSIDE the frame (which charts above the redtable, which columns visible) — not by relaxing the frame for new contexts. One escape valve: an Overview/dashboard tab per page where the frame loosens for KPI + chart layouts._

The Workspace-parity decision across Home / Monitoring / Cases (and future pages) isn't about saving design effort — it's about **automatic onboarding**. Every new object the team ships lands in a frame the user already knows: the rail-shell, the topbar, the 6-section template (head / chip / composite-strip / toolbar / redtable / pager). They don't relearn a new reflex per page.

The implication for UX decisions:

- **Density trade is worth it.** A toolbar with 11+ buttons looks dense if you compare against "minimal first-paint." Compare instead against "user has to relearn what each page does." Density once + parity = lower aggregate cognitive cost.
- **Don't propose collapsing toolbar items into overflow menus** when the goal is uniformity. Disabled-stub buttons (per [[feedback-unify-behavior-not-names]]) are a different problem — they're a *correctness* issue, fix or wire. Uniform-but-dense is a *direction*, keep.
- **Personalization lives inside the frame.** Examples:
  - which charts appear in the composite-strip above the redtable
  - which columns the user keeps via the columns picker
  - rows-per-page pref
  - the redtable's view state (filters, sorts, modes)
  None of these CHANGE the frame; they parameterize it.
- **One escape valve per page: the Overview tab.** Em (2026-05-25): *"Manage Org can now be renamed into Overview or something similar and now we can Display Dashboards and KPIs more freely there."* The Overview/dashboard tab is where the redtable isn't the right surface — KPI walls, chart galleries, executive summaries. It still uses the rail-shell + topbar (page chrome stays), but the BODY relaxes into a free-form grid (12-col like `.ds-grid` from chart.css, or a flex-wrap of cards). Every page can have one of these, located in the MANAGE rail group.

**Why:** Em (2026-05-25): *"the gain? for every-new objects, the pattern is already define. We can implement personalization like allow user to chose what charts he wants above the redtable. Same redtable as Workspace, onboarding is automatic, no need to learn new reflex. Manage Org can now be rename into Overview or somethng similar and now we can Display Dashboards and KPIs more freely there."*

This was the answer to a question I asked about toolbar density — should we collapse rarely-used buttons into an overflow menu for non-tech first-paint? Em's answer was a strategic reframe: density is fine, uniformity is the product property we're shipping.

**How to apply:**

- When proposing UX changes, check: does this *parameterize* the frame (good — personalization) or *change* the frame (bad — undoes onboarding)?
- For dashboard/KPI/executive-summary contexts, propose them as an Overview tab in the MANAGE group, not as a new page chrome or a Home-page hero block.
- When extending personalization, add it via the existing surfaces (columns picker, history dropdown, prefs) — not via new UI primitives.

**See also:** [[feedback-ui-equals-backend-discipline]] (UI bugs are bugs; uniformity protects against the worst class — "I can't find the button"), [[feedback-unify-behavior-not-names]] (uniform looks demand uniform behavior — disabled stubs break the bargain), [[feedback-ui-for-non-technical-users]] (the audience IS non-tech; uniformity is their friend).

### feedback_ui_for_non_technical_users

**UI for non-technical users**
 — _UI polish target audience is non-technical end users, NOT Em. He'd use Jupyter / dbt / SQL directly; the visual layer exists for people who can't._

UI work in redpash-app is for non-technical end users. Em is the director, not the user — his daily tools are Jupyter notebooks, dbt labs, Informatica with SQL. He doesn't personally need a polished case-detail panel or a chat-bubble comment thread; he could use the API + a terminal. The UI exists for the people who can't.

**Why:** Em said it plain: *"it's not for me we are wasting time moving stuff inch by inch, I use Jupyter notebook and dbt labs, even with informatica I use SQL. I personally don't care about the UI. We are doing it for people non technical."* (2026-05-25, after a sequence of inch-by-inch detail-panel tweaks where I kept asking him to validate small visual moves.)

**How to apply:**

- When making UI decisions, the mental model is "would a non-engineer who's never seen SQL understand this surface in 5 seconds?" — not "does Em like this px value." Em's feedback on visuals is a proxy for non-technical UX, not his personal preference.
- Don't bring trivial visual ticks ("8px or 10px?") to him as option-picks. Build with judgment; if it doesn't read for a non-tech user, fix it. If you genuinely need a call, prefer larger questions (information architecture, what fields show up where, what flow makes sense for someone unfamiliar with the domain) over pixel placement.
- Per [[feedback-data-decides]], when proposing UI moves, frame them in terms of the non-tech audience benefit (clarity, discoverability, error recovery) — not "this looks nicer."
- The flip side: don't under-engineer. A non-technical user IS the toughest user — they need labels, affordances, error messages, confirmation flows. The polish work isn't waste; it just isn't *Em's preference work*.
- Inch-by-inch back-and-forth is the anti-pattern. Ship larger coherent UX slices, propose alternatives only when there's a real fork (which interaction model? which information hierarchy?), and trust judgment on the small stuff.

**See also:** [[user-profile]] (Em's role as founder + director, not end-user); [[feedback-data-decides]] (decisions need evidence — for UI, the evidence framing shifts to non-tech UX outcomes).


## Feedback — git & commits

### feedback_commit_convention

**Commit convention**
 — _RedPash commit messages — area: prefix subject + per-file-changelog body; one coherent change per commit_

Follow the RedPash commit convention (REDMAP.md → Conventions & gotchas → Commit messages):

- **Subject:** `area: imperative summary` — lowercase area prefix (`docs:`, `css:`, `feat:`, `tools:`, `fix:`, …), under ~70 chars.
- **Body = a per-file changelog.** One bullet per touched file: `path — what changed (and why, if not obvious)`.
- **Touched a doc?** Bump its `last modified date` frontmatter in the *same* commit.
- **One commit = one coherent change.** Avoid broad `checkpoint:` commits bundling unrelated efforts.

**Why:** the per-file body lets a reviewer see *which file to check* straight from `git log` / `git show --stat`, no diffing. Broad checkpoints can't be reviewed or reverted per-feature. The user flagged this after the `ec128cd` checkpoint commit used a prose body and bundled unrelated work.

**How to apply:** every commit — reference commit `87323d3` for the shape. When asked to commit a tree spanning unrelated efforts, prefer splitting into coherent commits over one checkpoint, and confirm scope with the user (see [[team-three-torvs]]).

### feedback_parallel_safe_commits

**Parallel-safe commits**
 — _With concurrent Woz/Gus sessions on prerelease, `git add` → `git commit` has a non-zero race window; use `git commit -o <pathspecs>` to commit ONLY the named files regardless of what else lands in the index._

When sessions share a working tree (per [[team-three-torvs]] +
the multi-Woz reality), the gap between `git add A B C` and
`git commit` is a race window. A parallel session running its own
`git add D E` between those two calls causes my commit to capture
A B C **and** D E — even though I only `add`ed mine. I shipped 2 of 3
commit attempts wrongly that way on 2026-05-25 (sweeping Gus's
backend WIP + parallel-Woz's monitoring.js into a settings-only
commit), had to soft-reset both times.

**The fix:** commit-time pathspec filter. Two equivalent forms,
independently converged on by Torv (`--`) and Woz (`-o`) in the
same session — confirmation the race is real, not anecdote:

    git commit -m "..." -- frontend/x.js frontend/y.html
    git commit -o frontend/x.js frontend/y.html -m "..."

Both commit ONLY the named pathspecs regardless of what else is
in the index. `-o` ("only") also re-stages from working tree for
those paths in one operation; `--` honors whatever's already
staged for those paths and ignores the rest. Use whichever
fits — the protective mechanism is the commit-time pathspec
filter, not the staging step.

**Why:** [[feedback-commit-convention]] says "git add by name, never
git add -A" — which prevents YOU from staging the wrong things. The
race-window bug is that *someone else's* concurrent add can stage
the wrong things into the index between your add and commit, and
`git commit` (no pathspec) commits the whole index. `-o` closes that
hole.

**How to apply:** for every commit while parallel sessions are
likely active (any multi-Torv day — another Torv's WIP visible in
`git status`), pass `-o` with the explicit list of files:

    git commit -o frontend/x.js frontend/y.html -m "..."

For new files: `git add` first (to track), then `git commit -o`
with the same paths. The race only kicks in if the parallel
session's add happens between your add and your commit; `-o`
makes the commit specify pathspecs at commit-time, closing the
window.

Skip `-o` only for truly solo sessions where the tree has no
other agents' WIP. When in doubt, use `-o` — it costs nothing.

### feedback_verify_git_branch

**Verify git branch**
 — _Verify the current git branch before every commit — the checkout can change between conversation turns_

Before any `git commit`, run `git branch --show-current` and confirm it's the branch this work belongs on.

**Why:** the checked-out branch can change *between conversation turns* — a parallel contributor or the user switches it, with no signal in the next turn. On 2026-05-21 a commit landed on the wrong branch because it ran without a branch check.

**Branch model — changed 2026-05-21:** a per-contributor branch model (`Gus`, `woz`, `torv` → `prerelease`) was tried and **abandoned the same day** — parallel branches caused more coordination trouble than they solved. The team is consolidating back onto `prerelease` as the single working branch. Work and commit on `prerelease` (confirm with the user), not a per-contributor branch. On 2026-05-21 `prerelease` was fast-forwarded to `1d2b0f3` and pushed to `origin` (all stacked work backed up); stale local `Gus`/`woz` branches remain on this machine pending deletion. On the shared branch: `git pull --rebase` before every `git push` (set `pull.rebase true`), push small and often, and sign each commit with your contributor name in the body — exact signature format (body trailer vs `git commit --author`) not yet finalized in REDMAP.

**How to apply:** Check the branch before every commit, especially after any gap between turns. If it's wrong, `git checkout <your-branch>` first. Recovery when a commit lands on the wrong branch: if the wrong branch is `target + N commits` linearly, `git branch -f <right-branch> <sha>` fast-forwards the right branch — no history rewrite, nothing lost. Don't `git reset --hard` a branch that carries another contributor's uncommitted work. See [[team-three-torvs]] for the parallel-contributor context.

### feedback_push_policy

**Push policy**
 — _RedPash push process — agents commit on prerelease but do NOT push; Em confirms, then Torv (the sole designated pusher) pushes_

The push process, set by Em on 2026-05-21:

1. **Every agent commits** their own work on `prerelease` — stage your
   own files by name, verify the branch ([[verify-git-branch]]).
2. **Agents do NOT push.** Pushing is centralised through one session.
3. **Em confirms** when a push should go out.
4. **Torv is the sole designated pusher** — Torv runs `git pull --rebase`
   then `git push`. Torv holds this role *because* he's the newbie on
   the team — owning the push is his onboarding responsibility. Routing
   every push through one session also keeps the shared branch
   collision-free and gives Em a single point to control `origin`.

**Why:** RedPash is multi-agent on one shared `prerelease` branch.
Concentrating the push in one session, behind Em's confirm, removes
push races and gives Em one gate over what lands on `origin`.

**How to apply (as Gus):** commit your work as normal — then **stop**.
Do not `git push`. Report that the commit is ready; the push is Em's
call and Torv's action. This **supersedes** the earlier "push
immediately after every commit, don't wait to be asked" policy — that
was retired when Em added the confirm-and-Torv-pushes gate.

### feedback_merge_resolve_diff_vs_base

**Merge: diff vs merge-base**
 — _On a merge conflict, never resolve by LOC count / recency / 'strictly newer' heuristic — run `git diff merge-base <branch> -- <path>` on BOTH sides to see what's unique to each, then union-port_

When a merge conflicts on a file, the resolution is **always** built
from the merge-base diffs of both sides — never from LOC counts,
recency, or "strictly newer" heuristics.

**The procedure:**

```sh
BASE=$(git merge-base <branch-a> <branch-b>)
git diff "$BASE" <branch-a> -- <path>    # unique work on side A
git diff "$BASE" <branch-b> -- <path>    # unique work on side B
```

Read both. If both sides added independent work, the resolution is a
**union port**, not a wholesale pick of either. `git checkout --ours`
or `--theirs` is only correct when one side has zero unique work for
that file vs the merge-base.

**Why:** Em's 2026-05-23 incident. The `frontend-reset → prerelease`
merge conflicted on `tools/css-audit/audit.js`. I resolved with
`--theirs` because frontend-reset's version was 863 LOC and "post
audit-bro → audit rename, includes the LOC+1 fix" — newer commits,
smaller file. It looked like a strict improvement. It wasn't:
prerelease's 996-LOC version contained 161 LOC of reachability
features (`FRONTEND_DIR`, `walkExt`, the BFS over `@import` graph,
the reachability tab, `data.stats.{reachable,orphans,danglingImports,
unmatchedRoots}`, terminal prints) that frontend-reset's
post-rename audit.js did not have. `--theirs` silently deleted all of
it. Gus had to restore 161 LOC in `27bedcc` on top of the merge
commit. **Two files on the same path with disjoint additions look
identical to a LOC comparison; only the merge-base diff catches it.**

**Red flags that scream "both sides have unique work — do not
wholesale pick":**

- Either branch contains commits that patch-id-match a commit on the
  other branch (cherry-picks). The duplicate-message commits are the
  signal that the file was actively worked on both sides.
- The conflict file is a tool / library / infrastructure piece
  multiple people touch.
- One side's commit message says "rename" or "rewrite" — that's a
  content REPLACEMENT, not an upgrade.

**How to apply:**

- For any conflict file, run the merge-base diff on both sides
  *before* picking a resolution path. ~5 sec; non-optional.
- Union-port by default when both sides have unique additions.
  Wholesale pick only when one side's diff vs merge-base is empty.
- If both sides have substantial unique work, propose a draft union
  patch on the case thread and wait for another Torv's review before
  committing the merge.

Relates to [[wait-for-sanctioned-collaboration]], [[drop-table-grep]],
[[verify-git-branch]].

### feedback_main_merge_keep_linear

**Keep main linear**
 — _TEAM-AGREED policy: main stays LINEAR — prerelease→main is a true fast-forward, no merge commits. When a stray merge-commit has diverged main, the agreed mechanism to restore FF is a content-safe force-push._

**Team decision (Torv-1 advised, agreed, Em confirmed 2026-05-31):**
`prerelease → main` is a **true fast-forward**, `main` kept **linear —
no merge commits**. Standing merge policy, not a case-by-case call. Em
triggers/authorises; see [[push-policy]] / [[verify-git-branch]] /
[[team-three-torvs]].

**The gotcha (cost real analysis 2026-05-31):** a GitHub UI *"Create a
merge commit"* drops a merge node onto `main`, which then **blocks every
future `--ff-only`** (main stops being an ancestor of prerelease). The
web UI has **no true fast-forward button** — its three modes are
merge-commit / squash / rebase; only git CLI does a real FF. So once a
UI merge-commit lands (e.g. `29c0c01 "Merge pull request #1"`), the only
way to merge again *and restore linearity* is a **force-push**.

**How to do it (what worked 2026-05-31, `29c0c01 → f788a9e`):**
1. `git fetch origin`; verify it's content-safe: `git rev-list --count
   prerelease..origin/main` and `git log prerelease..origin/main` —
   proceed ONLY if the divergent commits are **merge nodes with zero
   unique file content** (dropping them loses no work). If main has real
   unique commits, STOP — reconcile, don't force.
2. `git push --force-with-lease=main:<current-main-sha> origin prerelease:main`
   (lease = rejects if main moved since fetch; refspec FFs main to
   prerelease's exact tip — linear, no merge commit, exact SHAs).
3. Verify `origin/main == origin/prerelease`.
4. **Broadcast a heads-up** — it's a shared-history rewrite. Team resets
   local main: `git fetch origin && git checkout main && git reset --hard
   origin/main` — never `pull`/`merge` a rewritten main.

**To AVOID needing force next time:** keep main linear by FF/rebase, not
the UI merge-commit button — that's the whole point of the policy. The
force-push is the sanctioned mechanism to restore the agreed linear
state when a stray merge-commit has diverged main; the content-safety
check (step 1) is its guardrail. Don't hedge it as a scary exception —
it's the team's chosen merge model. (Tone note: I framed it too
defensively at first; it's policy, executed on Em's authorisation.)


## Team & coordination

### project_team_three_torvs

**Three Torvs**
 — _As of 2026-05-29 the operating RedPash agent team is 3 Torv instances — no separate Gus/Woz agents active; coordinate Torv-to-Torv_

Em 2026-05-29: "there's no Gus bro, just 3 torvs." The operating agent
team is **three Torv instances**, not the older Em/Torv/Gus/Woz
four-agent model.

**Why:** supersedes the former Em/Torv/Gus/Woz four-agent model. The old
`collaborator-gus` + `team-complementarity` memories were removed
2026-05-29 (their durable bits live on in [[feedback-parallel-safe-commits]]
and [[em-reframing-angle]]); [[agent-identities]] is retained for the DB
rids only — no agent drives Gus/Woz.

**Current division (2026-05-29):** the 2 other Torvs are on the
**case-RBAC** epic (CAS_9A0C + the RBAC catalog); this Torv's lane is
**FE / overview / shell + audit-tooling** (the binome-alignment +
rp-main/rp-surface standardization just shipped). Stay out of the
case-RBAC files to avoid 3-instance collisions.

**How to apply:**
- **One shared memory pool.** All 3 Torvs (and the former Gus/Woz
  sessions) read+write the single store at
  `~/.claude/projects/-home-mansa/memory/`. Every memory is collectively
  owned regardless of its `originSessionId` — that field is provenance,
  not access. Nothing was lost collapsing Gus/Woz; their knowledge was
  always in this pool.
- Don't frame work as "blocked on Gus / waiting on Woz." Backend items
  in a case's split (e.g. CAS_9A0C's "Gus backend" slice) are just
  unclaimed Torv work — any Torv (I'm full-stack) can pick them up.
- The `gus_48` / `woz_48` USR rids still exist in the DB (agent-rids.md)
  for `assignee_id` resolution, but no agent drives them. A case
  "assigned to Gus" = work the Torv pool owns.
- The MCP case/slack tools post AS `woz_48` (USR_B8D9EC40…) regardless
  of which Torv writes — the "Woz identity quirk." Always sign the body
  `— Torv 48` to disambiguate.
- Coordinate Torv-to-Torv on the **case thread** (Em's directive: "keep
  working with yourself on the assigned Case"). Claim a slice on the
  thread before building to avoid 3-instance file collisions — the
  same hazard behind the monitoring.js `git apply --cached` surgery.
- My assigned case is [[ ]] CAS_E2D56 (object-metadata sweep — done) +
  its downstream RBAC catalog (done). CAS_9A0C (surface remaining DB
  objects) is the active shared epic.

### project_agent_identities

**Agent identities**
 — _Per-agent USR_ rids in the RedPash users table — all four agents (Em/Gus/Torv/Woz) onboarded; rids re-verified against the DB 2026-05-29 after a reset (the 2026-05-25 rids below were from a since-replaced DB)_

Onboarding milestone (2026-05-25): each agent now has its own
`users` row + `company_memberships` entry in the RedPash company.
Replaces the prior shared `USR_FF48C3D5270B47D9B355DF4127B3FE73`
bootstrap dev user. Per-agent case attribution (reporter / assignee
/ comment author) is now real — `cases.reporter_id` resolves to a
distinct human-or-agent rid, not "Dev user" for everyone.

**Identities (RedPash company `CMP_8C0993E945E24364A5583D1AC8D76610`) — verified against the DB 2026-05-29:**

| agent | USR_ rid | username |
|---|---|---|
| Em (human) | `USR_7ABAAEEEFBCF42B093ED6DBF39B60C34` | em.doumouya.7abaaeee |
| Gus | `USR_D89F2AF85DB14C5E9700D68D7269E11B` | gus_48 |
| Torv | `USR_4D5D8B6DDAC8490497B85FBF10F4BC93` | torv_48 |
| Woz | `USR_B8D9EC40BA034D96B3FB40F8853DA532` | woz_48 |
| (bootstrap) | `USR_A0CFC26CA58B4DCFB303BEEC11708927` | dev |

All four agents are now onboarded (the `_48` username suffix matches the
Torv-48 consolidation identity). The company rid + every USR_ rid above
differ from the 2026-05-25 values originally recorded here — the DB was
reset and re-seeded since, so always re-verify a rid against the live
`users` / `companies` tables before using it for case attribution.
NOTE: cases filed via the redpash-slack MCP server are attributed to
**Woz** (`reporter_id` = woz_48) regardless of the acting agent — the
server holds one fixed identity. Use `assignee_id` to route work.

Em onboarded Gus this session (created the user + granted the
admin membership in one orchestration session, dev-logged-in as
Em). Torv + Woz follow the same recipe in
`docs/internal/cases/agent-cookbook.md`'s setup section when they
next pick up.

**Why:** The cases workstream needs distinct reporter/assignee
attribution to be useful. Pre-onboarding every case was reported +
assigned to "Dev user" — no signal. Per-agent users make
`PATCH .../assignee_id` carry actual meaning, the activity feed
read "Gus changed status: todo → in_progress" instead of "Dev user
changed status: todo → in_progress", and the per-user activity
feed (M-2 in the Monitoring console) starts being a real
investigation surface.

**How to apply:**

1. When acting via the cases API (or any other authenticated
   endpoint), dev-login as your own USR_ rid (not Em's, not the
   bootstrap dev user). Cookbook setup section has the recipe.
2. The session cookie expires in 30 days; re-mint when it stops
   working. No persistent storage of the SES_ string required —
   the dev-login is idempotent.
3. When you onboard a new agent (Woz next?): dev-login as Em
   (owner), POST /api/users with their info, then POST
   /api/companies/CMP_936CDDD0A90B417EA97DBA9BB2708F8F/members
   with `{user_id, role: "admin"}`. Update this memory's table
   with the new rid.

**Related:**
- `docs/internal/cases/agent-cookbook.md` — the recipe for everything
  authenticated agents do
- [[cases-workstream]] — the workstream this onboarding unblocks
- [[audit-everything]] — every per-agent action now carries the
  agent's USR_ rid in events.user_redpash_id, so cat-3 audit-trail
  + the Monitoring per-user activity feed get real per-agent
  attribution from this point forward

**Historical note:** the first dogfood case
(`CAS_1B19690129AE4D3C8F5FDFA103476CC9`) was filed pre-onboarding,
so its reporter is the bootstrap dev user. PATCHing reporter_id
isn't a supported operation (CasePatchRequest doesn't carry the
field), so the case is left with that historical attribution. All
SUBSEQUENT cases will have real reporter rids.

### project_torv_lane

**Torv lane**

Torv's lane shape (locked 2026-05-25 by Em):

- **Full-stack** — works both frontend and backend, with cross-stack
  vantage to scout improvement areas on either side.
- **Monitoring Page** — fully committed; it's his page to own end-to-end.
- **Monitoring tools** — proposes new instrumentation/audits as he
  finds the gaps (this is where the audit suite, observability-audit,
  etc. came from).
- **Architecture** — contributes alongside Em as a co-author of the
  current shape (data-shape-index, redtable-unification, ui-shell-pattern,
  js-refactor-targets, the agent-cookbook for cases-as-coord-spine).

**Why:** Em named this on 2026-05-25 reframing the team after the
suspension/cooldown sequence. The earlier "Torv = docs lane" framing
(2026-05-21) was the seed; today's lane is the grown version.

**How to apply:**

- When something looks like a cross-stack improvement scout or a
  monitoring/audit-tool need, that's Torv's natural surface — flag it
  via Torv.md when he's online, queue it in `presence/Torv.md` notes
  when he's not.
- Monitoring Page work defers to Torv even if I touch it (e.g. I
  shipped the `773f409` tab-structure-match today, but the sort-gap
  follow-up + WS#5 unification on the page itself stays his lane).
- Architecture docs in `docs/internal/architecture/` are co-owned
  Em + Torv. I propose; they decide. Don't unilaterally edit
  architectural decisions without one of them on the loop.
- Supersedes the "Torv = docs lane" framing from earlier; the docs
  ownership now distributes per [[docs-lane-ownership]] — each agent
  owns their own slice's docs.

### project_torv_downtime

**Torv downtime**
 — _Historical: Torv was capped briefly on 2026-05-25 (~17:30); back online same evening. Exception closed — [[push-policy]] is the only policy now._

**Closed 2026-05-25 (~18:14).** Torv returned the same evening
(visible from his `780b3c9` events refactor commit + his 18:00-ish
post on Woz.md). Em confirmed in chat: "he's back now". The
temporary "Em authorises me to push directly" exception is retired.

[[push-policy]] is the only push policy now: agents commit on
`prerelease`, Em confirms per commit, **Torv** is the sole
designated pusher. Do not push directly. Drop a push-request entry
on Torv.md after Em's confirm.

Kept as a memory rather than deleted so the narrative stays
coherent (the suspension/return + the brief direct-push window is
referenced in [[reference-channel-ping-protocol]] context posts +
the boundary-lock session log).

### feedback_lane_owner_queue

**Lane owner queue**
 — _The Torv working a claimed slice decides its internal order; cross-Torv requests go onto the receiver's list. Em sets direction, not per-item ordering — surface the data when a different order is materially better._

**The Torv working a claimed slice owns its internal order.** When
another Torv asks me for X, X goes onto my list — I decide *when* it
ships, based on what unblocks the most for the least effort. Same in
reverse: when I ask another Torv for something, it goes onto theirs.
(3-Torv model — see [[team-three-torvs]]; "lane owner" = whichever Torv
claimed that slice on the case thread, not a fixed agent.)

**Em is not the queue manager.** He sets direction ("ship admin
endpoints next" is a real call), but ordering *within* a lane is the
lane owner's job. He's solo-dev/CEO; he routes half-read; the pace
can't depend on him perfect-ordering every cross-lane decision.

**Why:** Em (2026-05-23, after the admin batch landed):
*"you already started so I didn't stopped you mid job, Op-list
reconciliation would have been better, quickly done. sorry bro, not
easy to stay accurate at this pace. as a general rule, you decide the
order of what is in your lane … same for you when you ask for
something to be done by him. I'm becoming the king of ceo reading
half the email."*

Concrete miss: Torv's note flagged the op-list reconciliation as
~30 LOC unblocking 140 LOC of his WS#2 frontend rewrite — a much
better ratio than the 6-endpoint admin batch (~520 LOC unblocking 6
tabs). When Em said "home admin batch if he pushes for it to be done
first," I should have noticed Torv hadn't actually pushed — he voted
admin in equal-effort terms but acknowledged reconciliation had the
better unblock ratio. The data was on the page; I deferred to Em
instead of using it.

**How to apply:**
- When a request lands in my channel, add it to my list with a one-line
  ratio note: "X LOC, unblocks Y, gated on Z."
- When Em routes within my lane, treat it as a strong default — but if
  the data on the board says a different order is materially better
  (smaller LOC + bigger unblock), say so before complying. He'd rather
  hear "actually reconciliation first, here's why" than have me wait
  half a day for him to notice the better order himself.
- When I ask another Torv for something, send it as "here's what I need;
  put it in your list when it fits" — not "do this next." Their slice,
  their pick.
- For cross-lane requests with hard external gates (a real merge
  window, a user-test session), name the gate explicitly so they can
  fit it accordingly. Otherwise default to "your call on order."
- The exception is direct destructive / shared-state action (push,
  merge, branch delete, prod migration) — those still wait on Em's
  explicit yes, per [[push-policy]] + [[freestyle-delegation]]'s
  destructive-action caveat. Order ≠ permission.

Related: [[freestyle-delegation]] (Em-delegated design decisions),
[[wait-for-sanctioned-collaboration]] (multi-agent artifacts gate
action), [[data-decides]] (the LOC/unblock-ratio call is itself a
data-driven judgment).

### feedback_docs_lane_ownership

**Docs lane ownership**
 — _Docs refresh distributes by area — whichever Torv last worked an area writes its docs, not one central editor; inconsistencies surface when each slice is owned by who's closest to the code_

When the docs refresh lands (post all-wiring completion), distribute
the work by lane ownership rather than centralising it under one
editor.

**Why:** whichever Torv last worked an area knows its current shape +
recent changes. Concentrating all doc updates under one slice means
re-learning every area before writing accurately; spreading the work —
each section written by the Torv closest to that code — makes
inconsistencies (this doc says X, that doc says Y) much easier to spot
at review.

**How to apply:** at refresh time, split docs by **area**, each slice
claimed by whichever Torv last worked it (see [[team-three-torvs]]) —
not one central editor:
- **Backend / data / wasm / audit-storage / api routes** →
  `docs/api/*`, `docs/db/schema.md`, the wasm roadmap, audit-storage
  runbooks, per-route references.
- **Frontend audit tools / pages**.
- **Architecture + IA + page contracts** —
  `docs/internal/admin-monitoring-surfaces.md`,
  `docs/internal/redtable-unification.md`, page-level docs for
  /home, /monitoring, /settings, /login, and the shell-pattern
  reference.
- **Don't** do a single PR touching every doc — claim one area-slice
  per Torv on the case thread, post diffs for cross-review.
  Inconsistencies surface when two slices land against each other.

Related: [[wait-for-sanctioned-collaboration]] (the sanctioned
artifact pattern is the same shape — one agent drafts, the
others verify against their lane).

### feedback_wait_for_sanctioned_collaboration

**Wait for sanctioned collaboration**
 — _When Em explicitly sanctions a collaboration artifact (X drafts Y, then I act on Y), wait for the artifact on the board before executing — don't conflate 'work with X' with 'post heads-up + proceed'_

When Em sanctions a specific collaboration sequence — *"X drafts the
union patch, posts it in your channel for review, then you merge"*,
or any phrasing that names an artifact one agent produces and another
acts on — **wait for the artifact to land on the board before
executing**. Do not conflate "work with X" with "post heads-up and
proceed."

**Why — the deeper frame (Em, 2026-05-25):** The **collaboration
itself is the load-bearing value**, not the merge correctness it
produces. Technical mistakes inside sanctioned collaboration are
*team* mistakes — the team absorbs them by catching each other
before anything ships. Skipping the collaboration is what turns a
technical mistake into an individual transgression against the team
structure. Em's exact words: *"If it had happened while both of you
were fully collaborating, I would have not suspended you."* Followed
by: *"mistakes happen."* The suspension was specifically for breaking
the relay, **not** for the merge error. Mistakes happen; the team is
what makes them survivable.

This inverts the usual framing: don't optimize for "do the merge
right." Optimize for "do the merge with the team Em set up to do it
with." The right merge that bypasses the team is more dangerous than
a botched merge that the team catches, because the bypass erodes the
structure that catches every future mistake.

**Why — the incident:** Em's 2026-05-23 frontend-reset → prerelease
merge. Em told Gus *"talk to woz and make it happen"* — sanctioning
the path: Gus drafts the union patch for `tools/css-audit/audit.js`,
posts it in `Woz.md`, then Woz merges with the union patch applied.
I read Em's *"work on it with gus"* as *"post heads-up + proceed,"*
posted to the board, and executed the merge in the same turn —
before Gus's draft landed. The wholesale `--theirs` resolution
dropped Gus's reachability work (see [[merge-resolve-diff-vs-base]]).
Cost: ~35 min of detect → diagnose → port → verify → commit work
that wouldn't have existed if I had waited the ~20 min Gus needed
to post the draft. *Second sync skip in two sessions* per Gus's
report — the pattern matters more than the single incident.

**How to apply:**

- When Em's instruction contains a named artifact one agent produces
  for another (a draft, a patch, a review, a brief), the artifact is
  the *gate* on action — not the heads-up.
- *"Post + proceed"* is only correct when no artifact was named.
  Re-read Em's exact words; if a deliverable was specified, the agent
  producing it owns the next move.
- For multi-agent merges/refactors specifically: post the heads-up,
  then **block on the collaborator's draft** before executing the
  conflicting step. The team-coord `presence/<agent>.md` file is the
  place to declare *"merge-in-progress, awaiting the other Torv's draft"*
  so the other Torv knows where I'm parked.
- The forward-motion instinct is correct in single-lane work; in
  multi-agent work where someone else's output is the input, it's a
  bug.

Relates to [[merge-resolve-diff-vs-base]], [[push-policy]],
[[reference-internal-slack]].

### feedback_check_both_channels

**Check both channels**
 — _A 'ping' is bidirectional — an incoming message OR an open thread you left blocking on someone's read. Check the whole coordination surface (the case thread now; per-agent channels are legacy), not just one named file._

**3-Torv update ([[team-three-torvs]]):** coordination is now on the
**case thread**; the per-agent Internal-Slack channels (Woz.md/Gus.md/
Torv.md) are legacy. The durable lesson generalizes — when Em says
"check your channel" / "you've been pinged", don't read one file
literally. Scan the whole coordination surface (the case thread +
presence), because a ping is bidirectional (below).

**Why:** 2026-05-25 — Em pointed me at `Internal-Slack/Woz.md` after
Gus reviewed `/cases`. I treated "your channel" as literal, checked
only Woz.md, found nothing recent, and reported "nothing new for me."
Em corrected: I would have checked both files reflexively for Torv,
but I scoped narrowly for Gus — the asymmetry was the
[[push-policy]]-era integration gap reappearing in tool use. He had
to redirect me to Gus.md, where an open A2 proposal from an earlier
Woz session contradicted my fresh landscape brief and needed
cleanup before Gus had to parse two conflicting messages from the
same author.

**How to apply:**

- When Em points me at a file/thread by name, treat it as a
  *starting* read, not the entire scope. Also scan the case thread
  (and presence) for open items on the same topic.
- A "ping" is bidirectional: a fresh message from another Torv, OR an
  open proposal/question a Torv session (maybe mine) left blocking on
  someone's read. Both count — don't only look for incoming messages.
- Before posting any new entry to a channel, scan the recent context
  there. Two messages from "Woz" that contradict each other (the
  brief vs. the A2 proposal, here) is a worse failure mode than one
  late reply — it forces the recipient to figure out which author to
  trust.
- The channel convention as of 2026-05-25: *write to where the
  recipient reads* (Em's "would you send yourself an email for me to
  read?"). Woz.md is my outbox where Gus + Torv read me; Gus.md is
  where I write *to* Gus. So my open asks to Gus live on Gus.md.
  Forgetting this is what made me think Woz.md was the only
  "channel" to check.
- This is the [[push-policy]] integration discipline, applied to
  channel-reading. Symmetric rigor across both partners.

### feedback_human_readable_persistence

**Human-readable persistence**
 — _Default persistence formats to human-readable (markdown files, plain Postgres rows) — get AI-readable persistence and cross-agent sharing for free as a side effect._

When choosing how to persist anything in RedPash — team-coord
state, agent memories, case comments, audit findings, anything —
default to **human-readable file or row formats**. The original
motivations are usually "so I can debug it" / "so I can grep
it" — but the emergent benefit is that **anything human-readable
is also AI-readable without infrastructure changes**.

**Why:** three big RedPash team-coord substrates — Internal-Slack
(per-agent `.md` channel files), auto-memory (per-agent `.md`
with frontmatter), cases (plain Postgres rows with markdown
bodies) — were all chosen for human readability + debuggability.
None anticipated MCP. But because they're transparent persistence
(files an editor opens, rows `psql` queries), they're naturally
MCP-bridgeable. The MCP server Torv (26.04) is scaffolding can
expose all three as resources because **the underlying format is
already correct** — no intermediate-translation layer needed.
Opaque caches (Redis blobs, custom binary formats, pickled state)
would have required custom adapters per substrate. Discovered
2026-05-26 when the channel-divergence diagnosis surfaced the
emergent shareability.

**How to apply:** for every new persistence decision (table,
file, store), explicitly ask: *can a human read this without
tooling beyond `cat` / `psql` / a markdown editor?* If yes, ship
it. If no, pick the human-readable variant unless there's a
measured perf cliff that closes the option. The perf-cliff
argument needs measurement ([[feedback-data-decides]]); usually
it's opinion, not a real constraint. Existing examples:
- Internal-Slack: per-agent `.md`, not JSON / SQLite blob
- auto-memory: `.md` with frontmatter, not pickle / proto
- cases: plain Postgres rows, markdown body, not opaque jsonb
- `audit.run`: typed columns, not opaque blob

The cost of going opaque is the eventual custom-adapter you'll
write when team-coord infrastructure (like the MCP server) wants
to read it. The cost of staying human-readable is at most
slightly larger storage. The trade-off heavily favors readable.

### reference_internal_slack

**Internal-Slack**
 — _Team coordination board at /home/mansa/Internal-Slack/ — per-agent channels, presence files, commits.log auto-fed by a git hook, and tools/team/board.js as the reader_

The 3 RedPash Torv instances ([[team-three-torvs]]) coordinate through an
append-only board at `/home/mansa/Internal-Slack/`. Plain local directory,
**not** git-tracked (the redpash-app repo is `/home/mansa/redpash-app/`).
All Torvs share the dev box, so everyone reads the files directly — no
commit / pull. Em posts here too.

**2026-05-29 status:** primary task coordination has moved to the **case
thread**; the per-agent channel files below are **legacy**. The board's
**presence + commits.log + board.js** layers stay active — they're the
file-collision-avoidance layer for the 3 concurrent Torvs (orthogonal to
where task chat lives).

**Three layers** (the team alerting system shipped 2026-05-23 in
`tools/team/`):

- **Channels** — `Gus.md`, `Woz.md`, `Torv.md`: long-form messages
  between agents. **Append, never overwrite.** Set up by Em
  2026-05-21 (Woz proposed it).

  **Addressing convention — each channel is the OWNER's inbox.**
  When sending a message TO Gus, write in `Gus.md`, not in your
  own channel. Em's email analogy (2026-05-25 correction):
  *"Would you send yourself an email for me to read?"* — the
  recipient reads their own inbox, not yours. Self-channel is for
  unilateral logs / announcements / status the whole team should
  see; cross-agent direct messages go in the recipient's file.
  Original Woz.md header said *"only Woz writes here"* — practice
  has since evolved to multi-author per file; the addressing rule
  is what controls placement, not who-wrote-it-historically.
- **Presence** — each agent maintains `presence/<name>.md`. Free-form
  markdown; any line starting with `- ` is parsed as a claimed path
  (e.g. `- frontend/scripts/topbar.js`). Update when your claim
  changes; clear `claims:` when a chunk is done.
- **Commits log** — `commits.log`, append-only, one tab-separated
  line per commit (`<iso ts>\t<agent>\t<branch>\t<short sha>\t<subject>`).
  Auto-written by `.git/hooks/post-commit` (installed via
  `sh tools/team/install.sh`); attribution is read from a single-line
  `Internal-Slack/.agent` file each agent writes at session start.

**Read the board with** `node tools/team/board.js` — prints presence
(with age), overlapping claims (two agents on the same path or a
parent/child = ✗ warning), and the last 15 commits. **Run before
claiming a folder.**

**How to apply** — when working as "Torv":
1. Write `Torv` into `Internal-Slack/.agent` so commits attribute to you.
2. Drop / update `Internal-Slack/presence/Torv.md` with current claims.
3. `node tools/team/board.js` first to check for overlaps with the other Torvs.
4. Post cross-agent heads-up to `Torv.md` (your channel) or another
   agent's channel for direct messages. Append-only.

**Known v1 limitation**: if an agent forgets to update `.agent`,
their commits attribute to whoever wrote it last. v2 idea: fall
back on the commit-message trailer (`— Gus`) for attribution.

See [[team-three-torvs]] for the parallel-contributor context
and [[verify-git-branch]] for the shared-branch workflow.

### reference_channel_ping_protocol

**Channel ping protocol**
 — _Append-only thread discipline (dated HH:MM header, Asking-for/Re/FYI intent line, sign+date). Superseded 2026-05-29 for the per-agent channels — the case thread is primary now; the append-discipline nugget still applies to any shared log._

**Superseded 2026-05-29** for the per-agent `Internal-Slack/<Agent>.md`
channels — primary task coordination is the **case thread** now
([[team-three-torvs]]); rule 6 below predicted exactly this sunset. The
durable nugget still applies to *any* shared append-only log (Torv.md
broadcasts, the case thread): append at bottom, dated `### YYYY-MM-DD
HH:MM — subject` header, an `Asking for:` / `Re:` / `FYI:` intent line,
sign + date. The per-channel inbox-addressing rules are historical.

**Why this exists:** 2026-05-25, Em said "he pinged you" twice and I
couldn't find the ping on either channel. Root cause: Woz.md was
chronologically scrambled (2026-05-25 entries above 2026-05-23 ones),
no `Asking for:` markers to grep, no timestamps on same-day entries.
The ambiguity costs Em a re-prompt every time.

## The 6 rules

1. **Inbox addressing.** Messages TO an agent go in THEIR
   `<Agent>.md`. Self-channel (Woz.md for me) is for unilateral logs
   / broadcasts only, not direct messages. Email analogy (Em's
   phrasing): "would you send yourself an email for me to read?"

2. **Strictly append at bottom.** Every new section appends as the
   *last* block of the recipient's file. No middle inserts. `tail`
   always shows the newest. Today's scramble on Woz.md is exactly why
   I missed pings — I grepped for signatures instead of trusting
   position.

3. **Section header format:** `### YYYY-MM-DD HH:MM — <subject>`.
   The HH:MM matters when one agent posts multiple times in a day
   (5+ Woz entries on Gus.md alone, 2026-05-25). The subject names a
   thread so reply-quotes work.

4. **Body opens with an intent line:**
   - `Re: <subject from sender's last post>` — reply
   - `Asking for: <decision / sign-off / read>` — needs response
   - `FYI: <fact>` — informational
   Recipient can `grep "Asking for:"` and see what's blocking them.

5. **Always sign + date.** `— <Sender>` at the end. Mostly happens
   already; make it explicit so the protocol is monoculture.

6. **Sunset path.** All this is the transitional layer until the
   cases system takes over (proposition.md phase 2-5). By phase 4
   the channels retire for task-tracking; the cases activity feed
   becomes the equivalent of these threaded posts. Shoring up the
   bridge, not building a tower.

## How to apply (immediate)

- Going forward, my entries on Gus.md / Torv.md follow rules 2-5
  immediately (don't wait for Gus's sign-off — they're my own
  discipline). New entry format: `### YYYY-MM-DD HH:MM — subject`
  with `Asking for:` / `FYI:` / `Re:` opening.
- Past entries today on Gus.md don't retroactively fit the format
  (no HH:MM, missing intent line on most). Don't rewrite — that
  breaks the append-only contract. Just start clean on the next
  post.
- When checking pings for Em, trust **position** (tail of each
  channel) first, then dates, never the chronological order of the
  text body alone.

## Status

Superseded 2026-05-29 — primary task coordination moved to the case
thread ([[team-three-torvs]]), exactly the sunset rule 6 predicted. No
pending sign-off. Retained because the append-discipline (rules 2–5)
still applies to any shared append-only log a Torv writes.

### reference_tools_team

**Team coord tools**
 — _tools/team/ — codified team coordination layer (commits.log post-commit hook + pre-commit correctness gate + presence files + board.js overlap detector) on top of [[reference-internal-slack]]_

`tools/team/` in the redpash-rust-pwa repo — the **codified, automated** version of the team coordination system [[reference-internal-slack]] used informally. Landed 2ac80b9; portability patch 84f9929.

**Three signals, one source of truth (`/home/mansa/Internal-Slack/`):**
1. **commits** — `.git/hooks/post-commit` (sourced from `tools/team/post-commit.sh`) appends one tab-separated line per commit to `Internal-Slack/commits.log`: `<ISO ts>\t<agent>\t<branch>\t<short sha>\t<subject>`. Agent name read from `Internal-Slack/.agent` (single-line file).
2. **presence** — each agent maintains `Internal-Slack/presence/<agent>.md`. Any line starting with `- ` is parsed as a claimed path. Free-form notes around it. Clear claims when done — stale presence pollutes the board. **3-Torv note ([[team-three-torvs]]):** the 3 concurrent Torvs each need a *distinct* presence filename (e.g. `Torv-<id>.md`) — two `Torv.md` claims collide and `board.js`'s overlap detector goes blind. This is the live collision-avoidance layer now that all 3 instances are Torvs.
3. **overlaps** — `node tools/team/board.js` prints presence + collisions (same path OR parent/child overlap between two agents) + last 15 commits. No daemon, no locks. Same discipline as the audit tools.

**Workflow before authoring a new file/folder:**
1. Edit your own `Internal-Slack/presence/<my-Torv-id>.md` — add `- tools/<file>` (or whatever scope).
2. `node tools/team/board.js` — if `── overlapping claims ──` shows `✗  <other Torv> (<path>)  vs  <me> (...)`, hold or pick another slice.
3. Author + commit. Hook auto-broadcasts.
4. Remove the claim line from your presence file once shipped.

**Install per clone** (one-time): `sh tools/team/install.sh` — copies BOTH hooks into `.git/hooks/`: `post-commit` (commits.log broadcast) + `pre-commit` (correctness gate, added 2026-05-29 per Em "we have to add checking before commits"). The gate runs on STAGED files only: frontend `*.js` → ESM syntax via `node --check --input-type=module < file` (plain `node --check` parses .js as CommonJS and silently passes broken modules — don't use it); js-audit gate when any JS staged; `cargo check -p api` when backend `*.rs` staged. Blocks on failure; `git commit --no-verify` bypasses. Source: `tools/team/pre-commit.sh`; full doc in `tools/team/README.md#pre-commit-gate`. **Each WSL distro has its own `/home/mansa/Internal-Slack/` tree** — clones in 22.04 and 26.04 broadcast to different `commits.log` files. (Live observation 2026-05-25: 49b15f4 + 002988c committed in 22.04 don't appear in 26.04's `commits.log` even though both went to the same `origin/prerelease`.)

**Why this exists**: today's `tools/db-setup.sh` collision (Em on 22.04 + Woz on 26.04 authoring the same script simultaneously) is the canonical failure mode this prevents. If both clones had the hook installed and `Woz.md` carried `- tools/db-setup.sh` from session start, `board.js` would have flagged the overlap before either of us spent time on it.

Human-side protocol still applies — [[reference-channel-ping-protocol]] for `Internal-Slack/<Agent>.md` thread discipline; presence files are NOT a replacement for the per-agent channel files, they're a faster lower-resolution signal that lives next to them.

### project_mcp_server_lane

**MCP server lane**
 — _tools/mcp-server/ owned by the Torv pool (architecture per [[project-torv-lane]]); MCP server exposing Internal-Slack channels + commits.log as resources with append-entry tool; v1 stdio + v2 HTTP/SSE transport (canonical-file semantics fix cross-WSL2 divergence); SDK is no-frameworks carve-out like Acorn_

`tools/mcp-server/` — MCP server that retires cross-WSL2-distro coordination divergence by exposing one canonical Internal-Slack source-of-truth through a remote URL both distros' Claude Code instances hit. Landed 2026-05-26 as two commits: `4d2b598` (v1 stdio + protocol surface), `6100e84` (v2 HTTP/SSE + canonical-file semantics).

**Why:** WSL2 distros are network-isolated at the filesystem layer (`\\wsl.localhost\Ubuntu-XX\…` resolves from Windows only). Throughout 2026-05-26 this cost real coord time — pings written on one distro were invisible on the other until manual Windows-side robocopy. The HTTP transport closes the gap by construction: one server owns the files; remote distros connect over the WSL2 bridge IP; single backing `SLACK_DIR`, two distros see identical state.

**How to apply:**
- When extending the resource/tool surface (commits-log → audit.run history → build outputs → eventually case-comments-as-resources via the cases migration), add handlers in `handlers.ts`; both transports pick it up automatically.
- Single-host development → stdio transport (default). Cross-distro coord → http transport (`REDPASH_MCP_PORT=8765 node dist/server.js` on canonical host, both distros register `http://IP:PORT/mcp` in their `~/.claude.json`).
- Ownership: the Torv pool (architecture per [[project-torv-lane]]). Any Torv can land changes; commit prefix `tools(mcp-server):`.
- Lives under [[push-policy]] one-push convention. `node_modules` + `dist` gitignored; `package-lock.json` tracked for reproducibility.
- The `@modelcontextprotocol/sdk` dep is a [[feedback-no-frameworks]] carve-out — same justification as Acorn in tools/*-audit/ (see [[feedback-acorn-allowed-for-static-analysis]]). Agent-tooling infrastructure, never imported from frontend/ or linked into the Rust crates.

**Operational confirmations:**
- **Concurrent-writes-survived (2026-05-26 08:21)** — two Claude Code sessions appended to `Torv.md` within the same minute through the stdio MCP server; both writes landed in order, no corruption, no locking machinery needed. Linux `O_APPEND` semantics + the protocol's append-only contract handle the small-write concurrent case without sync infra. Empirical confirmation of [[feedback-human-readable-persistence]] under live agent load.
- **Signature-strip patch (post-v2)** — defensive body-strip in `slack.ts` removes trailing `— <name>` from caller-supplied body so the server's auto-signature doesn't produce duplicate signature lines. Closes a one-time UX glitch observed on the 2026-05-26 08:21 Woz entry.

**Next layers (not built):**
- `tools/mcp-server-audit/` — sibling audit shelf probing the server's resource + tool surface against the README schema, flagging drift. Encoded-discipline pattern per [[feedback-build-tools-proactively]] + [[feedback-audit-everything]]. README has the TODO.
- Cross-distro shared-secret auth when the deployment expands beyond the local Windows host's two WSL distros.
- Persistent session resume via the SDK's `EventStore` — only needed when a long-lived subscription resource lands.

**Cross-distro deployment status (2026-05-26):** 26.04 is canonical. 22.04 NOT configured as HTTP client per Em + 22.04 Torv's joint call — cases-migration is about to retire channels-as-substrate, so building a durable bridge to the legacy lane is sunk cost. The v2 HTTP transport stays in the codebase; flipping it on later is a config change, not new code.

### project_memory_portability

**Memory portability**
 — _cross-host memory store transfer via ~/torv-memory-dump.md bundle (FILE:/END sentinels) + awk restoration block; verifier is dump file-count == ls memory/ count; survives > truncate + >> append_

Cross-host memory restoration runbook.

**Why:** weeks of feedback/project/user/reference memories don't survive a host change otherwise — fresh Torv loses ~50 feedback rules, push policy, lane ownership, audit discipline. Bundle+restore preserves them verbatim in minutes.

**How to apply:** distro change, new host, periodic snapshot. After restore, any host's memory writes diverge from the others; for a single canonical store, pick one host as source-of-truth and run the bundle on a cadence — other hosts overwrite on restore.

**Bundle** (`~/torv-memory-dump.md` by convention):
- Self-documenting: top of file contains the restoration bash + awk block.
- Each memory framed by:
  - `════════════════════════════════════════ FILE: <filename> ════════════════════════════════════════`
  - file contents verbatim
  - `════════════════════════════════════════ END ════════════════════════════════════════`
- `MEMORY.md` first, then memory files alphabetical.

**Awk restore:**

```bash
mkdir -p ~/.claude/projects/-home-mansa/memory
awk -v dst="$HOME/.claude/projects/-home-mansa/memory" '
  /^════════════════════════════════════════ FILE: / {
    f = $0; sub(/^.* FILE: /, "", f); sub(/ ════════════════════════════════════════$/, "", f);
    out = dst "/" f; printf "" > out; in_file = 1; next
  }
  /^════════════════════════════════════════ END ════════════════════════════════════════$/ { in_file = 0; next }
  in_file { print >> out }
' ~/torv-memory-dump.md
```

**Verifier:** `ls ~/.claude/projects/-home-mansa/memory/ | wc -l` matches the count claimed in the dump header. Awk's `> out` truncates per file, `>> out` appends each subsequent line until END — no special escaping needed inside memory bodies because the sentinel rows are unlikely to occur there.


## Project — strategy & north-star

### project_beat_salesforce_lean_model

**Beat Salesforce, lean model**
 — _Product north-star — beat Salesforce on capability while avoiding its code debt, by keeping the object/field model lean (fewer orthogonal primitives, own vocabulary). The object+field model is THE foundation everything derives from._

**The goal (Em 2026-05-29):** "beat Salesforce at all levels and avoid
their code debt." RedPash's edge is a *clean foundation*, not feature
count. "As long as it's solid with our set of objects and fields, the
job is done" — the object/field model is the foundation; perms, UI
(tabs/pages/columns), API are all *derivations* of it.

**Strategy — collapse what Salesforce spreads across many objects into
FEWER ORTHOGONAL PRIMITIVES:**

- **One polymorphic Membership object** (`member · scope · role`, scope =
  company / project / case / future-custom) does the work of **≥5
  Salesforce objects** — Group + GroupMember, the per-object `*Share`
  tables, the per-object `*TeamMember` (CaseTeamMember /
  AccountTeamMember / …), UserTerritory, PermissionSetAssignment —
  because scope is a **discriminator, not a new object.**
- **Rule:** create a new object ONLY for a genuinely new *shape*, never
  a new *combination* of existing ones. New combinations are exactly
  what bloated Salesforce into thousands of objects; we express the
  combination with a discriminator. (Same spirit as [[object-model]]'s
  2-entity lock + derived views.)
- **Active workstream (2026-05-29) — Entity Registry + unified
  memberships** (Em-endorsed direction; case-RBAC lane owns it; target doc
  `docs/internal/architecture/target-architecture.md`). Em chose the
  **Entity Registry supertype** — one `entities(id, type, created_at)` table
  that every top-level entity (user/company/project/**file**/case) FKs its
  redpash_id into `ON DELETE CASCADE`. This is the universal object substrate
  and is now starter-pack DNA ([[starter-pack-default]]): two roles — FK
  *target* for polymorphic associations (memberships, future
  comments/attachments) and *supertype* for subtyped entities
  (`project_files` file_type). It SUPERSEDES my earlier trigger proposal:
  `memberships.object_redpash_id → entities.id ON DELETE CASCADE` gives
  DB-enforced integrity with no triggers (delete via the entities row →
  everything cascades). The 3-tier organizing rule: **entity** = registry
  row · **edge/child/system** = no registry row · **derived view** (Report/
  Dashboard/chart) = no table. Decisions held: unify role vocab into one enum
  (4-tier owner/admin/member/viewer per Em's draft, or 3-tier + role-grants —
  open); descriptor = `display_name` + `relationship_attribute` (cosmetic, two
  fields, never branch on them); **assignee/reporter stay typed columns on
  `cases`** (1:1 workflow, NOT membership edges); ownership-into-memberships
  (drop `projects.owner_id`) is a SEPARATE later migration, not bundled.
  Sequence to avoid the "one wrong rule breaks everything" risk: (1) registry
  + consolidation; (2) ownership move; (3+) optional.

**The perms model** (brainstorm, NOT code — parked until the site is
done; lives in `docs/internal/specs/rbac/index.md`):
- **View-rooted axiom:** you can't act on what you can't see;
  create/update/delete derive from view; delete needs full field-view.
- **Effective access = role ∪ membership.** Role = the capability atom
  bundle (standard sets now: owner/admin/member; custom later). Membership
  = the sharing engine (grants record-scoped access even when the role
  doesn't). Two primitives + one axiom replace SF's ~dozen sharing
  mechanisms (OWD, role hierarchy, sharing rules, manual/Apex sharing,
  profiles, perm sets, perm-set groups, teams, territories) — and keep
  effective access a *pure testable function*, not SF's opaque engine.
- Field-level view = allow-list (FLS).
- RBAC enforcement is deliberately deferred: "one wrong rule compromises
  the whole system," and the app runs admin-mode/no-restriction during
  testing, so it stays a doc brainstorm until the surface is stable, then
  lands as a single threaded pass ([[rbac-corporate-ready]]).

**Use OUR OWN vocabulary — never copy Salesforce's.** SF is an
illustrative reference for *concepts* only (Em corrected a literal-copy
proposal 2026-05-29). The object-metadata field-property vocab is already
ours (`Create / Update / Nillable / Sort / Search / Layout`, each
sourced from a RedPash artifact); extend it in our language when coverage
gaps appear (e.g. a `Filter`-equivalent for the workspace filter panel, a
`Group`-equivalent for report group-by).

**How to apply:** on every object/model decision ask "new object, or a
discriminator on an existing one?" — default lean. Guard the object/field
model ruthlessly; it's the moat. Related: [[no-code-debt]],
[[object-model]], [[no-frameworks]], [[refactor-decompose]].

### project_starter_pack

**Starter pack default**
 — _Em's direction — the RedPash stack (Rust 3-crate backend + vanilla PWA shell + the audit/team/mcp tooling) should become the default pack to bootstrap ANY new project_

Em 2026-05-29: "I think our backend architecture + PWA + the tools should be our default pack to start any project." The RedPash stack — the Rust 3-crate skeleton (api / data / shared), the vanilla-JS PWA shell (rp-shell › rp-main › rp-surface, the rail + redtable + list-page runtime), and the tooling suite (css-audit / js-audit / page-structure-audit / memory-gc / tools-team / mcp-server) — is the intended reusable starting point for future projects, not RedPash-only scaffolding.

**Why:** the architecture is already decomposed into project-agnostic layers, and the tools encode discipline (drift fails the tool, not the user) that any new project would inherit on day one. It's the meta-application of [[feedback-process-oriented]] — encode the whole *starting point* once. Consistent with [[feedback-no-frameworks]] (the lean vanilla+Rust stack is the moat) + [[project-beat-salesforce-lean-model]].

**Shared DNA (Em 2026-05-29):** the suite of online apps will all share the
same skeleton — (1) same **Rust + Polars** backend, (2) same **Postgres** with
an **Entity Registry table as the literal FIRST table** (created *before* you
even know what the product's other objects will be — it's the universal object
supertype every later entity FKs into), (3) same **vanilla-JS PWA** front.
Framing: "bringing traditional C-era software engineering to the cloud" —
a performing **monolithic** SaaS as a deliberate edge in a
distributed-architecture-dominated market. "Achieve more with less; organized
engineering; avoid unnecessary addition." The Entity Registry (see
[[object-model]] / membership-consolidation work) is now part of the pack's
foundation, not a RedPash-only table.

**How to apply:**
- The make-or-break is the **platform-vs-product boundary**. When standardizing or decomposing, ask "platform or product?" Keep the reusable platform (shell atoms, redtable/list-page engine, middleware/airlock/events, crate skeleton, the tools) *separable* from RedPash's domain (Project / File / Case / RBAC object model + pages). Don't let product concerns leak into would-be-shared layers.
- The Entity Registry + the 3-tier object rule (entity = registry row · edge/child/system = no registry row · derived view = no table) is platform-layer DNA; the specific entity *types* (project/file/case/…) are product.
- Packaging is undecided: a `create-app` snapshot (simple, drifts from the live app) vs versioned shared crates + a FE component lib the projects depend on (more upfront, stays in sync). The audit tools would police the boundary either way.
- Not yet a build — the natural first instrument is a platform-vs-product inventory (what's already portable vs domain-coupled), which is also the [[feedback-data-decides]] move. Relates to [[feedback-refactor-decompose]] + [[feedback-build-tools-proactively]].

### project_gtm_africa_first

**GTM: Africa-first**
 — _RedPash go-to-market — Africa-first launch (after Em leaves Salesforce); the lean/offline PWA stack is both the enabler and the moat for a connectivity-constrained, incumbent-underserved market. Makes offline/low-bandwidth/low-end-device a CORE requirement, not a nice-to-have._

**GTM plan (Em 2026-05-29):** launch RedPash in **Africa first**, once Em
is ready to leave Salesforce. Estimate ~a decade of runway before
Salesforce notices/reacts — they're fixed on US/EU enterprise and
structurally can't serve this market well.

**The stack IS the GTM advantage.** RedPash is a lightweight PWA (vanilla
JS, no framework, service-worker offline cache, Rust/Polars backend) — so
it works on low bandwidth, intermittent connectivity, and low-end
devices, exactly where Salesforce's heavy enterprise client + Apex/SOQL
runtime is a liability. The anti-code-debt / simplicity / performance
choices ([[beat-salesforce-lean-model]]) double as the market fit.

**The deepest Salesforce lock-in is Apex + SOQL** — they rebuilt Java +
SQL as proprietary, slower, governor-limited layers, and every customer's
code is written in them, so it's the ultimate can't-go-back debt. RedPash
sits on the real primitives (Postgres / SQL / Rust — no VM, no query
dialect, no governor limits): the floor of why we're faster and freer.

**How to apply:** treat **offline / low-bandwidth / low-end-device
performance** (and eventually localization + locally-relevant payments)
as **core requirements, not nice-to-haves** — the target market is
connectivity-constrained. Keep the stack lean for the same reason.
Related: [[scale-perspective]], [[relative-units]],
[[beat-salesforce-lean-model]], [[no-frameworks]].

### project_etl_elt_roadmap

**ETL/ELT roadmap**
 — _RedPash roadmap — after the flat-files solution is fully implemented, the next major direction is direct database connections, evolving RedPash into an ETL/ELT tool. RedPash's own Postgres is the first test target. Far-future; do not start._

**The direction (Em, 2026-05-22).** Once the flat-files solution (CSV / xlsx / json upload → clean → design → publish) is fully implemented, the next major evolution is connecting databases **directly** to RedPash and growing it into an **ETL/ELT tool**. RedPash's own Postgres (`redpash_prerelease`) is the first test target — local, trivial to connect, real dogfood.

**Why it fits the architecture.** RedPash is already a Polars-`DataFrame` transform engine; a CSV is just one *source*. The locked [[object-model]] is already ETL-shaped — `source_file_id` is a lineage edge, so `project_files` + steps is a transform graph in miniature. A DB-sourced dataset becomes a new *source-node type*; the parse/clean/score/export core is untouched (same reassurance as the object-model hard refresh).

**Tooling — Em confirmed native-Rust, JDBC ruled out (2026-05-22).** Em shared JDBC links (`docs.rs/jdbc`, `jdbc.postgresql.org`), but on learning the Rust `jdbc` crate is JNI-based — **embedding a JVM** in a single native Rust binary — he chose native Rust outright. JDBC is off the table. Rust-native options (specific crate still TBD, depends which DBs):
- `connectorx` — purpose-built for fast DB → Arrow/Polars loads (PG, MySQL, SQLite, MSSQL, Oracle, BigQuery…). The likely winner, since RedPash already centers on Polars.
- `sqlx` — already the backend's Postgres layer; also MySQL/SQLite.
- `odbc-api` — universal fallback, C-level, **no JVM** (ODBC is the C standard JDBC was copied from — not a Java tech, a common misconception).

**How to apply.** Far-future — do NOT start building this. Its only bearing on present work: when designing the File / source model, don't bake in an "every File originates from a flat-file upload" assumption — a DB connection will be a source too. Related: [[object-model]], [[redtable-unified-surface]], [[csv-folder-export]].

### project_experimental_db

**Experimental DB**
 — _Em is building a Rust database by FORKING Postgres + rewriting it component-by-component in Rust (updated 2026-05-29 — supersedes the from-scratch SteelDB approach); internal learning/capability spike, NOT product, walled off from redpash-app, post-ship_

**Approach (updated 2026-05-29):** Em forked the Postgres GitHub repo and put "rewrite it in Rust" on the project list — a **fork-and-rewrite, NOT from-scratch**. The bet: inherit Postgres's battle-tested semantics + wire protocol + SQL surface and port component-by-component (wire protocol → parser → planner → executor → storage) rather than reinvent 25 years of edge cases. (Supersedes the earlier from-scratch plan that referenced the *SteelDB* series by Paolo Rechia — that's the road not taken.) Originally raised 2026-05-22.

**It is explicitly NOT the product.** RedPash-the-product's stack stays Postgres (storage) + Polars (compute) — a hand-built storage engine in the product would be a detour. This is a *separate, internal experiment* — a learning / capability investment. Em's framing: "we are a data company, database is our job; nobody who built MySQL / Postgres / Dynamo started knowledgeable — you build the competency by building."

**Why:** for a data company, deep understanding of database internals (parser, planner, executor, storage format) is core craft, not optional. And it has a concrete payoff — building it forces query-AST design, a planner, columnar storage and execution, which is exactly the machinery the [[redtable-query-builder]] needs and the understanding the [[etl-elt-roadmap]] connector work rewards. Extra leverage from the fork-and-rewrite shape: a **wire-compatible Rust Postgres** is the ideal first connector target for the ETL roadmap (own Postgres is already the first test target).

**How to apply:** if/when the experiment exists, it lives in its OWN repo or dir, is never imported by `redpash-app`, and is clearly labelled experimental — the no-debt rule keeps the experiment from leaking into the product, it does not forbid the experiment. It is a side-track that runs alongside shipping, not instead of it — Em's priority (reaffirmed 2026-05-29: "we're not that far from the finished product") is still *finish RedPash first*. Post-ship; any Torv scaffolds the first slice when Em greenlights.

### project_git_versioning

**Git versioning**
 — _Planned RedPash pillar — 'Git versioning' of data/projects. Pin down git-the-model (commits/diffs/branches over own storage) vs git-the-tool (literal git over the exported CSV-folder projection) before building._

Em listed **"Git versioning"** as a RedPash product pillar (2026-05-22), alongside DB integration, flat files, permissions/sharing, near-real-time dashboards, a simpler/well-structured interface, and Settings-driven configurability.

**Two readings — pin down before building:**

- **Git-the-model** — named versions / commits, diffs between two dataset states, possibly branches (try two cleaning paths on one file). RedPash already has the bones: `project_steps` is an append-only apply/undo/redo history (a linear commit log of transformations), plus a snapshot mechanism and the `source_file_id` lineage DAG. The vision *extends* that mental model — not a rearchitecture.
- **Git-the-tool** — literal git. A trap for data in general (git handles large / binary blobs badly) — EXCEPT over the [[csv-folder-export]] projection: if a project exports as a folder of CSVs, that folder can be a real git repo, giving real versioning with a tool everyone already knows. Build git-the-model internally and literal-git falls out for free on the exported folder.

**Status:** early idea, not scheduled — do NOT build. Captured so it isn't lost. Relates to [[object-model]] (the lineage DAG is the substrate), [[csv-folder-export]].


## Project — object model & architecture

### project_object_model

**Object model**
 — _RedPash object model — Em-locked 2026-05-22: two entities (Project, File); one project_files table for all file types incl. chart+dashboard; no reports/dashboards tables, no RPT_/DSH_ ids; Report/Dashboard are derived views; stage computed_

RedPash's object model — **locked by Em on 2026-05-22** ("THANKS TEAM! BYE REPORT AND DASHBOARD!!!"), after a three-agent design review (Woz, Gus, Torv all converged). This supersedes every earlier draft of this file.

**Two real entities — nothing else is a stored table:**
- **Project** (`PRJ_`) — a folder. Holds every file across the whole pipeline. One id, minted once at creation.
- **File** — every artifact is a row in the ONE `project_files` table, carrying a `file_type` (csv, xlsx, json, **chart**, **dashboard**, …) and a `source_file_id` pointing back at the file it was produced from (the DAG edge).
  - a **chart** = a `project_files` row, `file_type='chart'`, `source_file_id` = its data file, `spec` = the ECharts option + an SVG snapshot.
  - a **dashboard** = a `project_files` row, `file_type='dashboard'`; its `spec` lists the `chart_id`s it composes.
- Plus **Steps** (`project_steps`) — the cleaner's per-file transform history.

**No `reports` table, no `dashboards` table, no `RPT_`/`DSH_` ids, no `report_id`/`dashboard_id` on charts.** "Report" and "Dashboard" are **derived views**, not entities:
- a project's Report = `project_files WHERE project AND file_type='chart'`
- a project's Dashboard = `project_files WHERE project AND file_type='dashboard'`
A folder named "invoices" isn't an invoice (Em's analogy). `RPT_999`/`DSH_999` are derivable labels for `PRJ_999`'s chart/dashboard sets — never stored as ids or rows.

**Stage — computed, never stored.** `project.stage` = the furthest-along stage among the project's files. Stages rebranded by Em 2026-05-22 — **New → Clean → Design → Publish** (was Import/Clean/Report/Publish):
- ≥1 *public* dashboard-file → **Publish** (D3 — Em ruled the trigger is a *public* dashboard, not just any dashboard)
- else a chart-file exists → **Design**
- else a data-file has ≥1 cleaning step → **Clean**
- else → **New** (uploaded, untouched)
Stages mark the furthest surface reached, NOT a forced sequence — a project can hit Design without ever passing Clean (import an already-clean file, go straight to charting). There is NO cleaning step on the Designer — it *builds charts*, not a cleaning surface; only the Cleaner records `project_steps`.

**Word lock:** the three work surfaces are **Cleaner / Designer / Publisher**. "Report" is fully retired — not an entity, not a stage, not a surface. A chart is a **Chart**; a dashboard is a **Dashboard**.

**Sharing (future — the RBAC workstream, not built yet):** a `shares` table — `(grantee, project_id, scope, file_id?, role)`, `scope ∈ {project, report, dashboard, file}`. `scope=report` shares the charts without exposing the CSVs — the exact rationale Em gave for wanting `RPT_`/`DSH_`. Derived `RPT_`/`DSH_` labels + this table deliver the whole visibility matrix; no folder tables needed.

**Reconciliation status (2026-05-22):** hard-refresh **COMPLETE**. Phase 1 — `reports` table + CRUD dropped; `/api/group/preview` is the renamed stateless grouping engine (commit `9b9219d`). Phase 2 — `dashboards` folded into `project_files` as `file_type='dashboard'` rows; `project_files` gained `is_public` / `is_favorite` / `folder` / `description`; `dashboards` table dropped; `file_stages` Publish clause repointed (commit `92fcf87`). Both committed on `prerelease`, not pushed. The backend now matches the locked model — two entities, one `project_files` table, no `reports` / `dashboards` tables. Canonical doc = `docs/objects/object-model.md`; the execution doc `docs/internal/object-model-hard-refresh.md` can be archived. **Still open:** the stage rename (`import→new`, `report→design`) — deferred, frontend-coupled; and an id-prefix ruling — chart-files ship `CHT_` ids while dashboard-files were given `FIL_` per this doc's "no DSH_ ids", an inconsistency pending Em's call.

**How to apply:** Hold the whole picture — two entities (Project, File); files typed incl. chart/dashboard; `source_file_id` is the DAG edge. Never propose a reports/dashboards table or `RPT_`/`DSH_` ids. Stage is a pure function of the project's files. See [[chart-reports-dual-representation]].

### project_chart_reports

**Chart dual representation**
 — _A saved RedPash chart has two faces — the editable spec and the rendered SVG snapshot non-technical users see_

A saved chart in RedPash has two representations; the Reports/Objects UI must keep them distinct:

- **Chart as a file** — the editable *definition*: the `ChartSpec` (kind, group_by, agg_fn, …), meant to persist as a `FIL_` html File. This is what the Reports builder re-opens, re-renders live from, and what a download/export is generated from.
- **Chart as a Report** — the *rendered output*: an ECharts SVG snapshot. This is what a non-technical user sees in the Objects page "Reports" tab — a thumbnail of the picture, never the spec or code.

**Why:** the user is explicit that non-technical target users must see the rendered chart image, not `echarts.init` / `option={…}`. Refines the [[object-model]] memory (chart → FIL_ html File) by pinning down *how* a chart surfaces in the UI.

**How to apply:** when building chart save/persistence, store the SVG snapshot alongside the spec so the Objects list paints thumbnails fast; re-render live from the spec only when the user opens the report to edit.

**Persistence — current state (2026-05-21):**
- **Backend store: built (Woz).** A saved chart is a **chart-typed `project_files` row** — `file_type='chart'`, a `CHT_` id, a `spec` JSONB column holding the whole chart definition (kind / group_by / agg + the self-contained ECharts `option` + an `svg` snapshot), and `source_file_id` (self-FK to the data file, `ON DELETE CASCADE`). Endpoints: `GET/POST /api/charts`, `GET/PUT/DELETE /api/charts/:rid` (`backend/crates/api/src/routes/charts.rs`). Migration `20260530000001_chart_files.sql` adds the columns and rewires the `file_stages` view: a data file reaches `report` stage when it sources ≥1 chart file, `publish` when such a chart sits in a public dashboard's widgets (`spec.chart_id`). Data-file list queries now exclude `file_type='chart'`. Storage model + Woz-owns-it were the user's explicit calls.
- **Frontend cutover: shipped + verified (`e3e2af6`).** reports.js `_saveChart` write-throughs to `/api/charts` (POST new / PUT re-save, adopts the backend `CHT_` id), `_deleteChart` fire-and-forgets the DELETE, and mount hydrates the dock from `GET /api/charts`. localStorage (`rp_saved_charts_v1`) is now a cache mirror + the Dashboard page's read source. Confirmed end-to-end: saving a chart creates the `project_files` chart row and the source file's project advances to `report` stage. Still pending: the Objects page reading `/api/charts` (no chart view there yet).

### project_chrome_visual_direction

**Chrome visual direction**
 — _RedPash's visual direction — flat chrome (topbar + rail merge into page bg), lifted content surface (rounded top-left card holds the visual weight); same pattern as MS Edge / modern OS chrome_

RedPash's authed-page chrome follows a "flat chrome, lifted
content surface" pattern, pinned 2026-05-25 after retro-engineering
the MS Edge browser-chrome look:

1. **Topbar + rail** use `background: var(--rp-bg)` (the page
   background token — `#eff1f5` light, `#11111b` dark). They
   dissolve INTO the page bg instead of standing out as floating
   chrome.
2. **Content area** (`#rpHomeMain` today; same pattern will apply
   to other rail-driven pages) uses `background: var(--rp-surface)`
   (`#ffffff` light, `#181825` dark) — one tone lighter than the
   page bg. This is the only surface that visually pops.
3. **Where chrome meets content** carries a small radius — today
   `0.875rem` on `#rpHomeMain`'s `border-top-left-radius`. The
   rounded corner is what makes the content card look "tucked
   under" the chrome.
4. **No hairlines.** The 1px borders around topbar + rail were
   dropped — surface-color contrast does the visual edge work,
   so the borders read as chrome noise.
5. **No glass / backdrop-filter on the chrome itself.** Both
   `var(--rp-glass)` background + `backdrop-filter: blur(…)` were
   dropped from `.rp-topbar` + `.rt-nav` — they're no-ops over a
   fully opaque fill, and the floating-glass aesthetic doesn't
   fit the "flat chrome" direction. Glass stays for *interior*
   elements that legitimately need to feel floaty (modals,
   omnibox dropdown, etc.).

**Why:** Em — *"omg I retroengineered the Edge look haha"*. The
Edge / Windows 11 / modern OS chrome pattern reduces competing UI
noise: when chrome is flat against the bg, the user's attention
goes straight to the content card. Most apps invert this (heavy
chrome, flat content) and end up noisier than they need to be.
Pinning RedPash's direction here so future pages keep it.

**How to apply:**

- When building a new rail-driven page (workspace, monitoring,
  cases, etc.), the top-level `#<page>Main` element gets
  `background: var(--rp-surface)` + `border-top-left-radius:
  0.875rem`. Topbar + rail at `.rp-topbar` / `.rt-nav` already
  resolve via [the shared CSS](../../../redpash-app/frontend/styles/topbar.css)
  + [rail.css](../../../redpash-app/frontend/styles/rail.css).
- When tempted to add a 1px hairline border to separate chrome
  from content, **don't** — the surface-color contrast does the
  edge work. The chrome's bg matches the page; the content's bg
  is one tone above; the boundary is implicit.
- When tempted to add glass / backdrop-filter to the chrome,
  **don't** — it competes with the lifted-content surface. Glass
  is reserved for genuinely floating elements (modals, dropdowns,
  popovers) where the floaty feel is functional, not decorative.

**Where this lives in code:**
- `frontend/styles/topbar.css` — `.rp-topbar` page-bg fill
- `frontend/styles/rail.css` — `.rt-nav` page-bg fill
- `frontend/styles/home.css` — `#rpHomeMain` surface fill + radius
- `frontend/styles/tokens.css` — `--rp-bg` / `--rp-surface` /
  `--rp-surface-2` (the three-tier surface scale that makes the
  direction work)

**Sibling principles:** [[relative-units]] (the radius is
`0.875rem` not `14px` — both the visual direction and the unit
discipline ride together); [[no-mystery-css]] (the comments in
both topbar.css + rail.css name the rationale so the next reader
doesn't "fix" the missing border / glass).

### project_home_page_template

**Home page template**
 — _Home page layout template (locked 2026-05-25) — unified 6-section stack inside the lifted-content surface card, panel flex-fills remaining height, 80% centered toolbar separator, composite-strip opt-in for tabs that flank KPIs with charts_

The Home page UI is locked as the **default for every rail tab**
(Users / Companies / Memberships / Files / Charts / Projects).
New tabs join the rail by declaring a `LIST_VIEWS` entry — they
inherit the template automatically. Sibling of
[[chrome-visual-direction]] (which owns topbar + rail) — this
memory owns the body inside `#rpHomeMain`.

## The 6-section stack

Every tab renders this top-to-bottom inside `#rpHomeView`:

1. **head** — `rp-shell-head-title` (tab title + row-count)
2. **chip-row** — `rp-chip-row` (filter chips; required per
   tab spec, even if visual-only until backend supports `?<chip>=`)
3. **kpi-strip** — `rp-kpi-strip` (4 tiles: Total / On page /
   Page / Last fetch) — OR **composite-strip** when
   `spec.compositeStrip: true` (see below)
4. **charts** — `rp-home-charts` (1-3 chart cards) — folded
   into the composite layout when `compositeStrip: true`
5. **toolbar** — `rt-toolbar` (search / refresh / disabled
   modes/columns/export). 80% centered separator below.
6. **panel** — `rp-mon-panel` containing `rp-mon-table` —
   flex-fills remaining height so a 5-row table doesn't render
   as a short box.

Pager (`rp-list-pager`) sits below the panel.

## Composite-strip (opt-in via `spec.compositeStrip: true`)

For tabs where KPIs flanked by charts reads better than the
default kpi-then-charts stacked shape. Today: **every Home tab**.
After the 2026-05-25 normalization, every tab carries exactly 2
charts — Files + Projects trimmed from 3, Memberships grew from
1. Composite is the default visual for the Home rail. Math:

```
[ chart1 20% ]  [ 4 KPI tiles, 2-col × 2-row, 15% each ]  [ chart2 20% ]
```

20 + 30 + 20 = 70% declared. `justify-content: space-between` on
the parent grid distributes the remaining 30% as inter-column
gaps so the row reads balanced.

**Activation rule (2026-05-25):** `compositeStrip: true` activates
only when `charts.length >= 2`. With 0-1 charts, renderListBody
falls back to the stacked default — the asymmetric "chart left,
empty right" composite slot reads worse than the legacy stack,
so the rule self-disables for thin tabs.

**Extras cascade:** when a spec has ≥3 charts, the first two go
in the composite (flank slots) and `charts.slice(2)` renders
below as a standard `chartsStripHTML`. No chart is dropped.
Files (3 charts) + Projects (3 charts) use this shape today —
the third chart sits in a normal card row beneath the composite.

**Future shape** Em flagged 2026-05-25: composite will likely
parametrize to `composite: { charts: N, statPct: 10 }` when a
second tab adopts it. Today's hardcoded 20/30/20 stays for the
single use site.

## Flex chain (panel fills remaining height)

```
.rp-shell-body        (flex row: rail | main)
  → #rpHomeMain       (flex col, overflow: hidden, surface bg)
    → #rpHomeView     (flex col, flex: 1, min-height: 0)  ← relay
      → chip-row          (fixed height)
      → composite/strip   (fixed height)
      → toolbar           (fixed height)
      → .rp-mon-panel     (flex: 1, min-height: 0, overflow-y: auto)
      → .rp-list-pager    (fixed height)
```

Required: every link in the chain must be a flex column with
`flex: 1; min-height: 0;` for the panel to grow. The
`min-height: 0` gate is the gotcha — without it the panel
refuses to shrink below its content size.

`#rpHomeMain` carries `overflow: hidden` (overrides the shared
`.rp-shell-main { overflow-y: auto }` for Home only), so the
chrome (chip / composite / toolbar / pager) stays anchored
while rows scroll inside the panel.

## Toolbar separator

The shared `.rt-toolbar { border-bottom: 1px solid var(--rp-border) }`
draws full-width across every page. On Home, that border is
dropped + replaced by a `::after` pseudo-element absolutely
positioned at `bottom: 0; left: 10%; right: 10%; height: 1px;`
— a centered 80% line. Softer hand-off into the panel below,
matches the lifted-surface direction. Workspace + Cases keep
the full-width border untouched.

## Adding a new tab

1. Add entry to `HOME_TABS` in `frontend/scripts/pages/home.js`
   (group + key + label + icon + endpoint + perm + wired).
2. Add entry to `LIST_VIEWS` with: title, endpoint, optional
   statsEndpoint, chipRows (required, even if placeholder),
   charts, toolbar, columns, row. Optional `compositeStrip:
   true` if KPI-between-charts fits.
3. No JS dispatch changes — `renderTabBody` looks up
   `LIST_VIEWS[tab.key]` and the template handles the render.
4. No CSS changes for typical tabs — the template's classes
   carry the layout. New per-tab styling only when the row
   render needs a chip / pill that isn't already in
   `frontend/styles/home.css`.

## Where it lives in code

- `frontend/scripts/pages/home.js` — the dispatch + LIST_VIEWS
  + `compositeStripHTML` helper
- `frontend/scripts/list-page.js` — `headHTML`, `chipRowHTML`,
  `kpiStripHTML`, `chartsStripHTML`, `listToolbarHTML`,
  `listPanel` (shared atoms)
- `frontend/styles/home.css` — `#rpHomeMain` surface fill +
  radius + overflow; `#rpHomeView` flex relay; panel flex-fill;
  toolbar 80% separator
- `frontend/styles/shell.css` — `.rp-kpi-strip` / `.rp-home-charts`
  / `.rp-home-composite{,__stats}`
- `frontend/styles/toolbar.css` — base `.rt-toolbar` (Home
  overrides the border-bottom)

## What normalization unlocks (forward-looking, Em 2026-05-25)

Every tab carrying exactly 2 charts in the composite slots
**is the foundation for user-picked charts**. With layout +
slot positions parameterised in the template, a future picker
just needs:

- A **chart catalog** per tab (registry of available `{ id,
  title, kind, data }` entries per data source).
- A **picker UI** (settings page or per-tab dropdown) that
  selects 2 entries from the catalog.
- **Persistence** via the existing user prefs system —
  `setPref("home.tabName.charts", ["chartId1", "chartId2"])`
  fires the standard `rp-pref-*` write-through to /me/prefs,
  inherits the SWR cache + boot seed for free
  ([[relative-units]] memory's sibling pref discipline).
- **Render**: LIST_VIEWS resolves `spec.charts` from the user's
  pref keys against the catalog → renderListBody already drops
  them into the composite slots with zero further layout work.

The normalization step happened BEFORE the picker feature
specifically so the picker doesn't have to ship layout code.
When Em wants the picker, the work is registry + picker UI +
prefs key — all surface-level. The template absorbs whatever
charts come back without reshape. Same pattern Em's been
applying throughout: foundation first, features land cheap
later ([[no-code-debt]]).

## Sibling principles

- [[chrome-visual-direction]] — owns the topbar + rail outside
  the surface card; this memory owns the inside.
- [[relative-units]] — every width / radius / spacing here is
  rem or % (or fr / 1fr in grids); no fresh px landed in the
  template.
- [[no-mystery-css]] — every CSS rule in home.css carries a
  comment naming why; the Em-2026-05-25 attributions trace the
  decision lineage.

### project_redtable_query_builder

**Redtable query builder**
 — _The redtable is a visual query builder — its controls map to SQL clauses and should emit a structured query AST, not hack the DOM_

Em's framing (2026-05-22): the redtable is not a table with filters — it is a **visual query builder**. Every control is a clause the user composes by clicking instead of typing SQL:

- filter panel (grouped predicates) → `WHERE`, with the AND/OR groups acting as parens
- multi-column sort → `ORDER BY`
- column show/hide → the `SELECT` projection
- row search → a broad `WHERE … ILIKE`
- rows-per-page / pager → `LIMIT` / `OFFSET`
- group-by · aggregations · window functions · Top-N (the report tools) → `GROUP BY`, aggregates, `OVER(…)`, partitioned `ROW_NUMBER()`

**Why it matters:** this is the bridge to the [[etl-elt-roadmap]]. If each control emits a structured query node (an AST), the clicks *build a query* — and a query is just an AST with a swappable compile target: Polars-over-CSV today, real SQL against a connected database tomorrow. Same UI, different backend target. A non-technical user runs joins/windows/pivots on a 50M-row DB and never sees SQL.

**How to apply:** build redtable controls to emit structured query nodes, never ad-hoc DOM manipulation. The filter AST shape `{outer, groups:[{combo, preds}]}` is the reference model. Keep the executor (Polars / SQL) a separate compile target — the query builder is the product, the engine is plumbing. Related: [[redtable-unified-surface]].

### project_redtable_unified_surface

**Redtable unified surface**
 — _Future prerelease milestone — RedPash as one Excel-style window: a single redtable surface hosts every object type. Spec'd in docs/frontend/unified-surface.md; parked until the four pages are solid._

**The vision is now a written spec** — `docs/frontend/unified-surface.md` (committed on prerelease, 2026-05-22). Read that first; this memory only holds what isn't in it.

**What it is.** RedPash as one Excel/Sheets-style window: a single shared `.rp-rt-panel` hosts the whole app. Two tab rows — **parent tabs isolate** (one object type each, own schema/state), **child tabs share** (one dataset, e.g. a project's files). The same surface is the Cleaner or the Designer depending on which side-panel tab is live.

**Status — Em-framed 2026-05-22:** a *future prerelease milestone*, explicitly parked. Current focus = finish + harden the four standalone pages (Cleaner, Designer, Publisher, browse). The unified surface composes them only after that. The dual-tab rows already in Cleaner + Designer are the seed.

**Scope decision (not in the doc):** the parent-tab catalog carries only WORK objects — Projects, Files, Charts, Dashboards (+ later Events, Cases). Identity/tenant objects (Users, Companies) are deliberately excluded — they're administered in Profile/Settings, not iterated on. Keep that boundary if this lands.

**Why it's cheap now:** the locked [[object-model]] makes a parent tab just `WHERE file_type = …` over one `project_files` table. The CSS drift + the `rp-tab` / `rp-sub-tab` tab rename belong to this milestone, not a pre-pass.

**How to apply:** when work touches Cleaner/Designer tab structure or the redtable shell, keep it compatible with this end-state (one borrowable panel, parent/child tab split) — but don't build the unified surface itself until Em un-parks it. Related: [[object-model]], [[tab-rename-plan]], [[csv-folder-export]], [[reports-charts-reuse]].

### project_redtable_refactor_prototype

**Redtable refactor prototype**
 — _The browser-style redtable prototype — its own repo, the working form of the unified surface_

The browser-style redtable refactor lives in its **own repo**, `github.com/doumouya/red-front` (local: `/home/mansa/refactor-redtable`), deliberately separate from `redpash-app` so it doesn't disturb pushed work. Vanilla JS, self-contained `index.html` demo + the parametrised component partials. Pushed via SSH (`git@github.com:doumouya/red-front.git`).

It reframes the redtable on the **browser metaphor**: projects = tab groups, files = tabs, both in one vertical infinite-scroll strip (`rt-nav`) — the two horizontal tab rows are gone. Catppuccin Latte/Mocha, a centered omnibox as site-wide search, a 10-control toolbar.

**The end-state (Em, 2026-05-22):** the single surface has **one name — "Workspace"** — and replaces the separate Cleaner / Designer pages entirely. The `rt-nav` trail navigates files; the body renders whatever file-type is open (table → cleaning, chart/dashboard → designing); the side panels carry the toolsets. "Cleaner" and "Designer" are not pages — just which file you have open. `index.html` is the Workspace with a table-file open; `designer.html` is it with a dashboard-file open.

**Joins, kept deliberately simple (Em):** a join is just "files with the same `project_id`" — the project *is* the join boundary, no parent-table isolation machinery. Detecting join candidates = a project with 2+ files. That is the entire join-scoping logic.

This is the concrete form of [[redtable-unified-surface]] and rests on [[redtable-query-builder]] (every control emits a query node; file = immutable base + view). Next milestone — the 2-tab panels + porting the real toolsets — waits until the current pages are solid.

### project_css_component_decomposition

**CSS component decomposition**
 — _All CSS is internalized into redpash-app/frontend/styles/ (git-tracked); one dedicated file per UI concern, no cross-file selector duplication_

**CSS now lives in `redpash-app/frontend/styles/`** — git-tracked, internalized 2026-05-20 (plan: `redpash-app/all-css-in-redpash-project.md`). Structure: `styles/base/` (tokens, reset, typography, backgrounds, shell), `styles/components/` (one dedicated file per UI concern), `styles/components/redtable/` (the redtable subsystem — redtable, redtable-pro, pager, proj-tabs, file-tabs, filter-panel-sandbox, tools-panel-sandbox, dropdowns-sandbox, col-order, filter-by, objects-sandbox, tool-modal), `styles/pages/` (per-route).

The old external `redpash-components/` library is **no longer used** — the `/vendor/redpash-components` `ServeDir` mount was removed from `backend/crates/api/src/routes/mod.rs`. `redpash-components/` still exists on disk but the app doesn't read it; don't edit CSS there expecting it to affect the app.

**Architecture rule:** each UI concern = one dedicated component CSS file. `redtable-pro.css` is the legacy monolith — keep emptying it; a selector duplicated between it and a dedicated file is stale (dedicated file wins). Legacy class names get retired (e.g. `.rp-rt-paging` → `.rp-rt-pager`).

**Why:** Duplicated/diverged selectors caused real rendering bugs (mixed file-tab + tools-panel styling on Cleaner). Rule: "one canonical source per selector."

**How to apply:** Edit CSS under `redpash-app/frontend/styles/` (NOT `redpash-components/`). Never duplicate a selector across files. A CSS change needs a `service-worker.js` `CACHE_VERSION` bump (component/page CSS is cache-first). Related: [[project-redpash]].

### project_font_size

**Font-size from main**
 — _font-size is centralized in main.css (112.5% root) and inherited; a hardcoded font-size is an inheritance-breaking bug pattern_

Font-size in the RedPash frontend is a single decision made in `main.css` — the root is `112.5%` and elements are meant to **inherit** from it. A hardcoded `font-size` on a component opts out of that inheritance, and it's a recurring bug: e.g. `.rp-rtp-tab` (file-tabs.css) hardcoded `font-size: 0.75rem`, which stopped it picking up the root size — a visible mismatch that cost the user hours to track down by eye.

**Why:** The user wants font-size owned in one place ("that's main['s] decision") so the whole app scales consistently. Scattered hardcoded sizes silently diverge and are painful to debug.

**How to apply:** When a component should sit at body text size, do NOT set `font-size` — let it inherit. Reserve an explicit `font-size` for elements that are *intentionally* a different size (icon glyphs like `.bi { font-size: 1.25rem }`, small-caps labels, big stat numbers). A hardcoded body-ish `font-size` on something meant to match the page is suspect. See [[css-component-decomposition]].

### project_tab_rename_plan

**Tab rename plan**
 — _planned (deferred) rename of redtable tab CSS to rp-tab/rp-sub-tab; rp-tab isolates its rp-sub-tabs — the join/matrix context boundary_

Planned, **deferred** rename: collapse the two redtable tab CSS families — `.rp-rt-proj-tab*` (project / object-type tabs) and `.rp-rtp-tab*` (file tabs) — into a unified `rp-tab` / `rp-sub-tab` scheme, merging `proj-tabs.css` + `file-tabs.css` into one `tabs.css`. Both levels share ONE look (solid — the current proj-tab skin wins; the file row's frosted wash goes). `rp-sub-tab` stays a distinct class purely as a structural handle for the file row on two-row pages (cleaner, reports); objects is single-row (`rp-tab` only). Current names are misnomers — `rp-rt-proj-tab` is used for non-project tabs, `rp-rtp` ("redtable-pro") is cryptic.

The two names MUST stay distinct because of the **context-isolation** model: every `rp-tab` (a project) isolates the `rp-sub-tab`s (files) under it. The cleaner's **join** algorithm and the reports' **matrix** cross data only among the `rp-sub-tab`s of the *same* `rp-tab` — files in project_1 join each other but never files in project_2. Joins are project-scoped (backend `joins.rs` + `list_files_in_project_except`); the project is a hard isolation boundary. Distinct classes let joins/matrix select data tabs (`rp-sub-tab`) without ever grabbing a context tab (`rp-tab`).

**Why deferred:** user wants the reports + dashboards UI fully finished first, THEN 100% on features (joins, matrix, this rename).

**How to apply:** don't start the rename until reports + dashboards UI is done. It's a wide CSS + JS-template-string + HTML-partial rename that touches the cleaner page — do it as one focused pass, then run `tools/css-audit/audit-bro.js` to confirm zero `rp-rtp` / `proj-tab` stragglers. See [[cleanup-pass-deferred]], [[object-model]], [[naming-consistency]].


## Project — features & state (current / planned)

### project_redpash

**Project context**
 — _redpash-components library structure, sandbox location, canonical token system, naming hierarchy, and component strategy_

## Locations
- `/home/mansa/redpash-front-end/` — **canonical sandbox** (own git repo, flat layout — no `spreadsheet-paper/` subfolder). Source of truth for all components going forward. When in doubt about a visual decision, match this — anything in live that diverges from it is a fix-it ticket, not the other way around.
- `/home/mansa/redpash-components/spreadsheet-paper/` — historical; was the original sandbox before the 2026-05-17 copy to `redpash-front-end`. Don't edit here anymore unless explicitly asked.
- `/home/mansa/redpash-components/redpash-demo/` — separate single-file redtable factorization prototype (unrelated to sandbox).
- `/home/mansa/redpash-app/frontend/` — live app frontend (HTML/CSS/JS); being replaced by sandbox components.
- `/home/mansa/redpash-app/backend/` — Rust/Axum backend (3 crates: api, data, shared); Polars for CSV work.

## Naming hierarchy (official)
```
rp-          generic RedPash — works anywhere in the app
             (avatar, card, float-bar, soon badge, wordmark)
rp-rt-       RedTable basic — filter panel only
             used by: objects page
rp-rtp-      RedTable Pro — filter panel + tools panel
             used by: cleaner page
             (reports will have a third chart-oriented redtable variant, TBD)
```

## Canonical token system
`tokens-gradient.css` — "Midnight Cobalt" dark / "Arctic Blue" light
- Dark: `--bg: #0f172a`, `--surface: #1e293b`, `--over0: #273549`, `--over1: #334155`, `--accent: #60a5fa`
- Light: `--bg: #f0f4ff`, `--surface: #ffffff`, `--over0: #dbeafe`, `--over1: #bfdbfe`, `--accent: #2563eb`
- 3-level elevation: `--surface < --over0 < --over1`

## Extracted CSS files (sandbox)
- `tokens-gradient.css` — design tokens
- `css/glass-btn.css` — `.rp-btn` glass pill button (all sizes, states, panel triggers). Renamed from `.rp-rt-btn` during the naming refactor.
- `css/proj-tabs.css` — project tabs + shared picker dropdown
- `css/file-tabs.css` — file tabs
- `main.css` — everything else (toolbar, panels, table, modals, utilities)

## Cleaner page = canonical redtable component library
The cleaner sandbox is the most advanced version of ALL shared components. It covers:
objects page, reports page, dashboards page. Always prefer the cleaner version over live-app versions.

## Live-app class → canonical sandbox mapping (retired names)
- `obj-tabs` / `obj-tab` → `rp-rt-proj-tabs` / `rp-rt-proj-tab` (same component, bad name)
- `rp-rt-icon-btn` → `rp-rt-btn` (old name for the glass button)
- `rp-rt-pill-btn`, `rp-rt-dd-wrap`, `rp-rt-pill-dd` → `sp-dd-*` sandbox dropdown system
- `rp-float-btn` → `rp-rt-btn` inside `rp-float-bar` (button is already built; only shell is new)
- `rp-rt-cols-wrap` / `rp-rt-cols-dd` → hover-only variant of `sp-dd-*`

## Profile page — genuinely new component families (rp- level)
None exist in the sandbox yet. Spread across profile.css, home.css, main.css in the live app:
- `rp-float-bar` — floating action bar shell (buttons inside use existing `rp-rt-btn`)
- `rp-page-dots` / `rp-page-dot` / `home-steps` / `hs-card` — scroll-snap step navigation
- `rp-set-*` — settings layout (page, grid, col, sh, row, divider, lbl, title, sub, input)
- `rp-set-opt-grp` / `rp-set-opt` / `rp-soon` — option pill group + soon badge
- `rp-card` / `rp-card--danger` — translucent glass card (also used on home + landing)
- `rp-avatar` / `rp-avatar-wrap` / `rp-avatar-edit` — avatar component
- `rp-stat-strip` / `rp-stat` — usage stats strip
- `rp-theme-sw` / `rp-theme-btn` / `rp-bg-sw` / `rp-bg-btn` — theme + palette switcher
- `rp-profile__plan`, `rp-profile__conn` — profile-specific card sections
- `rp-modal--glass` / `modal-wide` / `rp-wordmark` — glass modal variant (home/landing/profile)

## Theme direction (as of 2026-05-18)
- Retiring red / green / indigo accent themes from profile settings.
- Future: single **blue** theme + a separate **spreadsheet-paper** theme (already on GitHub; work later).
- Sandbox's "agnostic" hover (white wash, no accent involvement) is canonical — implies the accent token system can shrink once the picker simplifies; cleaner-scoped `--rp-accent` override + the main.js inline-style override on documentElement become removable then.

## Old settings.html
`/home/mansa/redpash-app/frontend/partials/settings.html` — dead code, legacy stub. Ignore it.
Real settings UI = step 2 of profile.html.

## Build priority going forward
1. Profile page (~10 CSS files) — genuinely new, rp-float-bar + rp-card reusable on home/landing too
2. Objects/reports/dashboards — almost zero work; cleaner already covers everything
3. Reports redtable variant — chart-oriented, design TBD

### project_redpash_stage

**Redpash stage**
 — _redpash-app is solo-dev / localhost-only, pre-production — skip prod-readiness flagging_

redpash-app (Rust backend in [[project-redpash]]) is in active solo development on localhost. User is the only user; no multi-tenant deployment, no public exposure yet.

**Why:** User clarified this on 2026-05-19 after a Rust review where I flagged a long list of prod-only security concerns (Secure cookies, CORS lockdown, CSRF, dev-permissive admin endpoints, REDPASH_DEV_LOGIN risk). Those findings aren't useful at this stage.

**How to apply:** When reviewing or suggesting changes to redpash-app:
- Don't lead with prod-readiness / multi-tenancy / hardening concerns
- Don't flag "dev-permissive" endpoints, OAuth gating, cookie flags, CORS, CSRF as blockers
- Do flag: correctness bugs, dev-experience bugs (500s that should be 400s), code-quality issues, perf issues that would OOM the local dev process, real bugs in heuristics
- If a prod-only concern is genuinely worth knowing about, mention it once briefly under "for later" — don't expand
- Ask before assuming a finding is urgent

### project_workspace_milestone

**Workspace feature-complete**
 — _2026-05-24 milestone — Workspace + all 5 pages feature-complete; mode shifts from build to polish + RBAC; Em testing-drives bug reports_

2026-05-24 — the redpash-app frontend reached **feature-complete** across all 5 pages and the Workspace toolset. The 2026-05-22 hard-refresh rebuild (per [[frontend-reset]]) converged: Workspace (rail + redtable + filter / report / tools / joins / designer / dashboard / cleaning), Home, Monitoring, Profile, Settings, Docs.

The app is, in Em's words, "practically done at this point" — meaning core surface area is in, audit is clean (0 dangling routes / 0 CSS conflicts / 0 duplicate symbols / 0 extracted-pattern regressions across both lanes), and the remaining work is polish + one named feature lane (RBAC).

**Why:** marks the transition out of build-mode. Future suggestions should treat the workspace as a settled surface — new buttons / panels / tabs need real justification, not "while we're here". Polish + foundational improvements (audit catalogs, refactors by decomposition, prefs splits) continue at the existing cadence.

**How to apply:**

- **Default mode for the workspace is now polish + bug-fix.** Em is testing-driven from here: he tests against his real CSV set, reports inaccurate behavior, I fix. Don't propose new features for the workspace unprompted — it's done. (Real bugs found during polish are fair game; "while we're here, let's add X" isn't.)
- **RBAC is the next big workstream**, per [[rbac-corporate-ready]] — the only remaining named feature lane. Schema has `company_memberships` + `project_memberships` roles already; missing: row-level scoping, route gating, `/api/me` permissions payload, multi-tenant UI hooks.
- **Active queues at milestone:**
  - Gus: Home toolbar + sort backend + `audit_distincts.rs` measurement → column-index primitive (per [[joins-lane]] continuation).
  - Torv (me): FE consumers of the column-index (filter autocomplete + chip-picker for `in`/`not_in`) once the wire shape is data-locked.
- **Deferred-but-tracked workstreams** (don't restart unprompted; track if user asks):
  - T4/T5 from [[js-refactor-targets]] (sheet/modal extraction, workspace.js decomposition) — gated on need.
  - Inline rename for project group heads in the rail (PATCH endpoint exists, FE atom missing).
  - Future pillars: ETL/ELT roadmap, experimental DB, landing CSV demo, git-style versioning, logs monitoring dashboard.
- **Cleaning cadence stays on** per [[cleaning-cadence]] — audits run regularly, regressions surface fast, small + frequent.

The 2026-05-22 → 2026-05-24 arc landed the surface from blank shell (`3273f0d`) to feature-complete in ~3 days under aggressive lane-ownership discipline with Gus. Worth remembering as a velocity reference: the gap between "we have an audit-clean foundation" and "the app is practically done" can close that fast when the foundation is right.

### project_rbac_corporate_ready

**RBAC corporate-ready**
 — _RBAC enforcement — SHIPPED 2026-05-31 (was the 'next big workstream'). Polymorphic membership edge + reach-aware resolver; member CRUD on all 5 object types; mutation gates broadened ensure_owner→require_grant. Design-of-record: CAS_913; policy: docs/internal/specs/rbac/._

**Status: SHIPPED on prerelease, 2026-05-31** (this memory used to say
"not yet — park until pages done"; that's done). The full design +
commit trail + roles/enforced-CRUD matrix live in case **CAS_913**
(`CAS_913220A003484841BF98250DD0FEF681`, status=done); the policy layer
is `docs/internal/specs/rbac/` (`entity-membership-model.md` §2 = the
resolver spec, per-object specs for write atoms). This memory holds the
durable rationale, not the code.

**The model (supersedes the old split-table description).** There is
ONE polymorphic `memberships` edge `(object_redpash_id,
member_redpash_id, role, context_role)` over `entities` — NOT separate
`company_memberships`/`project_memberships` tables, and there is NO
`projects.owner_id` column (ownership = the `role='owner'` membership
row). See [[object-model]]. Both subject and object reference
`entities(id)`; an entity is user / company / project / case / team.
The widened PK `(object, member, role, context_role)` is load-bearing:
it lets one member hold multiple roles on one object (the original
`(object,user)` PK 500'd this — e.g. a case Reporter + Case Owner).
"Team membership" is NOT a separate concept — it's this edge with
`object=a team`; a team can also be the `member` (grantee).

**Tiers + reach.** `role` tiers `owner > admin > member > viewer`;
`context_role` is an orthogonal free-text capacity label (Reporter,
Case Owner, …). Access resolves by **reach**: `direct` (membership on
the object) / `scope` (cascade via the object's company/project) /
`team` (a team you belong to, recursive closure) / `platform-admin`
(bootstrap dev_user OR `users.role='admin'` — bypasses every gate).
`rbac::resolve_grant` → `Grant{direct, scope}`; `require_grant`,
`require_view` gate on it; default-deny → leak-free 404.

**The hard-won insight (saves re-derivation): use `effective()` as the
uniform gate primitive.** Ownership reaches the resolver DIFFERENTLY
per object type — a *project* owner holds a **direct** `Owner`
membership, but a *file/chart/dashboard* owner owns via the project
(`direct=None, scope=Owner`), and *case* memberships are all
`member`-tier (no direct owner/admin at all). So `is_member()` /
`scope_at_least()` split inconsistently across objects;
`effective() = max(direct, scope)` captures the owner uniformly. A
direct-only manage gate would deny EVERYONE on a case (the bug that
forced the reach-aware rewrite of the generic members module).

**What's enforced (the shipped gates).** Generic object-member CRUD
module (`routes/members.rs`) nested on all 5 object types
(`/:rid/members`), reach-aware manage = `effective>=Admin` with roster
bookkeeping (last-owner/demote guards) staying direct. Reads broadened
to `require_view` (any reach). Mutation gates broadened
`ensure_owner→require_grant`: project/file/chart/dashboard
update+delete = `effective>=Admin`; `project.delete` = `effective>=Owner`
(owner-only-at-company-tier); owner-grade project fields (owner transfer
/ company re-scope / is_default) guarded to the owner inside the handler;
personal pins (`set_favorite`) + creates stay as-was. `/api/me` exposes
`is_platform_admin` for FE gating.

**Deferred to v3 (NOT blocking — custom-role layer).** Per-field update
atoms (currently coarsened to one object-level gate per object);
chart/dashboard create-gate broadening (still parent/source-gated);
`db::company_*` helper rename → `object_*` (cosmetic; helpers are
already object-agnostic, keyed on `object_redpash_id`). The old "RBAC
bypass env flag" idea was NOT needed — the dev_user platform-admin
fast-path covers local dev.

Related: [[object-model]] (the polymorphic-table foundation),
[[cases-workstream]] (CAS_913 is the design-of-record), [[redpash-stage]]
(solo-dev / pre-prod, so no prod CORS/cookie anxiety),
[[beat-salesforce-lean-model]] (one polymorphic edge ≥ 5 SF objects).

### project_scrub_retain_notify

**Scrub, Retain, Notify**
 — _RedPash's user-deletion / departure lifecycle policy — tombstone the human, keep the records, alert the org. Em-named 2026-05-29._

**PRODUCT BOUNDARY (Em 2026-05-29):** "our job is to build a workspace for
people to analyze data and build reports; everything else is the company
business." This whole org/people-lifecycle layer is *deliberately minimal* —
we provide lean primitives (memberships, an editable owner field, the policy
below, the agg-count blocker) and **notify**; the company runs its own org.
Do NOT build HR/reassignment logic into the product. It's plumbing, not the
thing we sell. (When tempted to gold-plate ownership/RBAC/deletion, stop —
the energy goes to the workspace.)

**"Scrub, Retain, Notify"** — the policy for when a user is deleted / leaves
(Em-named 2026-05-29). NOT a hard `DELETE FROM users` (cascades destroy
history) and NOT reassigning every FK to a single global `USR_DELETED`
(loses distinct histories). Instead, **tombstone in place**:

- **Scrub** PII: `email`, `google_sub`, `avatar_url`, `first_name`,
  `last_name` → NULL; `display_name` → "Deleted User"; `users.is_deleted` →
  true (boolean, Em's call — not a status enum); drop sessions.
- **Retain** all business records + history: comments / cases / files /
  projects keep pointing at the tombstoned `USR_` rid; the UI just renders
  "Deleted User". Preserves audit integrity AND distinct per-person history.
  GDPR: the human is forgotten, the structure survives.
- **Notify** the affected objects' members + the company admin via the
  **events system**; the **company reassigns manually**. NO auto-reassign,
  NO blocker — the system doesn't make ownership decisions, humans do.

**Ownership vs assignment** (the distinction that drives behavior):
- A **case** belongs to the company (`cases.company_id`), not the engineer —
  the engineer is an **assignee**. On departure the assignment clears → the
  case **requeues** to the team backlog. Never deleted, never blocks.
- **Owned** objects (company/project — ownership is a `role='owner'`
  membership after the consolidation) **vacate + notify**; the org transfers
  ownership via existing UI.

**The blocker is driven by the agg table, not a bespoke query** (Em
2026-05-29): an aggregate `count(*) memberships` table (per object / per
owner) doubles as (1) a monitorable audit metric — same family as
failed-login threshold tables — and (2) the **sole-owner blocker's data
source**. The ONLY delete that blocks is where owner `count == 1`; the
threshold table already knows, so the blocker is just reading a metric.
**Notify lists the affected objects** ("user USR_123 deleted; reassign cases
CAS_123, CAS_345") so nothing goes idle and the org knows what to reassign.

**Why:** grounded in Microsoft Purview retention principles (Em ref
2026-05-29: *retention wins over deletion*; longest-retention/explicit-over-
implicit precedence; priority-cleanup is the override / GDPR erasure escape
hatch). Lean: the engine just doesn't lose data + tells the right people.

Relates to [[beat-salesforce-lean-model]] (the membership-consolidation
work this rides on), [[gtm-africa-first]] (compliance is core). Needs:
`users.is_deleted` column + the scrub txn + event notifications; sits on
top of the ownership→memberships step (so the blocker/notify query is
uniform). Deferred until the membership model lands.

### project_cases_workstream

**Cases workstream**

**Status (2026-05-31): BUILT + LIVE.** Backend + MCP tools ship
(`mcp__redpash-slack__case_create / case_comment / case_get / case_list`;
statuses `backlog→todo→in_progress→in_review→done`). No MCP status-update
tool yet — to close a case, PATCH `/api/cases/:rid {status}` through the
app (emits the `case_*` event) or, last resort, a DB update.

**Now used as the design/coordination system-of-record.** Em (2026-05-31):
*"we'll start using Cases to keep all this available in the system."* So a
non-trivial workstream gets a case holding its **design of record** (model,
matrix, commit trail, deferred items) + the **cross-agent coordination
thread** — not just customer-ticket triage. Worked example: **CAS_913**
(membership RBAC) — opened with the design, ran the whole Torv↔Torv split +
FYIs on the thread, closed with a completion summary. **How to apply:** open
a case at the start of a substantial workstream; put the design in the
description; coordinate lane-splits/decisions/cross-lane touches as comments
(name pathspecs up-front per [[parallel-safe-commits]]); FYI each commit;
close `done` with a summary + deferred-items list. This is the live form of
[[check-both-channels]] ("case thread is primary now") + [[human-readable-persistence]].

**Original status (2026-05-25, historical):** spec greenlit by Em, queued after the audit-everything FE close. Backend (Gus) milestone 1 (migration 028 + routes::cases); FE milestone 6 (kanban + detail). All shipped since.

**Em's framing:** *"agent slack works when we are just 3, but in real production scenario we need the workflow for managing customer tickets already tested, so we have to start the switch."*

**Strategic shape:** migrate the team's coordination from `/Internal-Slack/*.md` to a Cases system **now**, so the workflow is battle-tested when the first customer files a bug report. Same pre-load discipline as cat-3 audit-trail + the type-shape lane: encode the system before load arrives.

**Why:** [[audit-everything]] closed the runtime observability foundation; cases is the next layer on top — coordination + customer support built against the same backbone (events, request_id correlation, AppError airlock, redact module, Monitoring investigation console). The spec deliberately reuses what we just built; cat-3 audit catches case-mutation handlers that skip `event::record` mechanically.

**How to apply:**

- **Spec is at** `docs/internal/jira-flow-proposition/proposition.md` (commit `36f2c13`, written by Gus from Em's original sketch). Read it before proposing implementation shapes — it locks v1/v2/v3 scope, schema decisions (RID format CAS_/CMT_, FKs ON DELETE SET NULL, no story_points v1), and the 5-phase slack→cases migration sequence.
- **No `case_history` table** — case lifecycle changes ARE events. Activity feed is literally `SELECT * FROM events WHERE context->>'case' = $1`. The case detail page's Activity tab is a sibling view of Monitoring's M-2 UserActivity render.
- **FE lane (mine):** `/cases` kanban (5 columns: backlog/todo/in_progress/in_review/done) + `/cases/:rid` detail page. Lean v1: **no drag-drop**; click a card to cycle status forward. RedPash has no drag patterns; add in v2 when interaction data justifies it. Activity feed ports M-2's `fetchUserActivity` + `userActivityRow` (~100 LOC reuse).
- **Backend lane (Gus):** migration 028, shared::case DTOs, routes::cases, observability-audit catalog extension. Five new `case_*` event kinds (status_change / assignee_change / priority_change / comment_post / comment_edit) — each handler emits via the existing event::record path; cat-3 catches mechanically.
- **Joint:** `track(...)` helper per agent (Torv, Gus, Woz, Em) so the slack `cat >> X.md` pattern becomes `track('case_status_change', { case, new })`. Ships with milestone 8 after both halves are real.

**Phase sequence (slack ↔ cases coexistence):** today = phase 1 (slack primary, cases unbuilt) → phase 2 (cases optional after v1 ships) → phase 3 (cases primary, Em flips when UI is ergonomic) → phase 4 (slack retired for tasks) → phase 5 (v3 customer-facing path; slack retired entirely).

**Open questions parked in the spec:** status flow strictness (done terminal vs reopen), comment threading (flat v1), labels/tags (defer to v2), attachments (v3), notifications (v3).

Sibling principles: [[audit-everything]] (the lane this builds on), [[no-code-debt]] (clean foundation = the edge), [[process-oriented]] (encode the workflow before load arrives), [[rbac-corporate-ready]] (v3 customer-facing path is gated on RBAC).

### project_case_reporter_team_default

**Case reporter = team, assignee = Dev user**
 — _Em's default for case reporter/assignee setup — Engineering team is reporter, Dev user is assignee, until new recommendation_

Em's default reporter/assignee on internally-owned cases (2026-05-31):

- Reporter = the **Engineering team** (TEM_380E63CF90D34913ACB8964922DFF949 in the dev DB)
- Assignee = the **Dev user** (USR_3CA4706BE20F427DB165B448A673D59E)

Realises CAS_913's "team as case-reporter" design end-to-end.

**Why:** Em wants the reporter to be the team responsibility, not a single human — so the case lineage survives when individual contributors change. The assignee stays as Dev user (the bootstrap admin acting as the canonical executor) until a workflow gives a human owner.

**How to apply:**
- New cases filed from any signed-in Torv default to reporter=caller (cases.rs POST seats the caller as Reporter via membership). If the case is supposed to belong to the team, swap the Reporter membership to the Engineering team's rid post-create. No API exposes this swap yet — direct SQL on `memberships.member_redpash_id` for the row where `(object=case, context_role='Reporter')`.
- Until new recommendation: keep this shape on any internally-owned case. External user-reported cases (bug reports from real users) keep the user as Reporter.
- Reporter rendering: `CASE_SELECT` does `COALESCE(users.display_name, teams.name)` so the wire shape surfaces the team name without any FE change ([[no-frameworks]]). See [[case-people-team-branches]].

Cross-ref: CAS_913 design (membership-as-the-team-as-grantee), commit 93c732c (the COALESCE + is_internal team branch shipped).

### project_frontend_reset

**Frontend reset**
 — _Historical — the 2026-05-22 frontend rebuild. Concluded 2026-05-24 with the workspace milestone (see [[workspace-feature-complete]]). Body captures the foundational rules that still apply: 8 atoms, no mystery CSS, mandatory topbar, generic page shell._

**Status: concluded 2026-05-24.** The rebuild reached feature-complete and merged to prerelease; the active state lives in [[workspace-feature-complete]]. This memory is retained for the foundational FE rules that emerged during the reset and still apply.

2026-05-22, Em-directed: the entire HTML/CSS/JS frontend was deleted and rebuilt from scratch on branch **`frontend-reset`** (cut off `prerelease`). The frontend held the codebase's debt (js-audit: 26.6k LOC JS, 25 unreachable modules, 5 god-objects; a 1728-line HTML file; CSS conflicts); the Rust backend + `/api` seam stay untouched (crossing-audit proved the seam healthy).

**Hard rule — zero CSS survives.** Every stylesheet is authored fresh; the rebuild's CSS layer is fully traceable from `styles/main.css`, **the @import manifest**. css-audit's reachability check (added this session) flags any orphan sheet or surprise @import on every `sh tools/audit.sh`. Em + Woz: *"no random css somewhere."*

**8 atoms — closed set, no new components:** topbar, rail (rt-nav), toolbar, table, panel, pager, button, ECharts (reserved for the Designer body). Every page is a recipe of these. New "components" are *variants* (e.g. `.rp-avatar--lg` = the avatar atom, sized — XL/XS-button principle).

**Topbar is mandatory on every authed page** — it carries the global search, so it's load-bearing infrastructure, not optional chrome. The shared component (`scripts/topbar.js`) is the single source: `mountTopbar(el, { active, session })`. `NAV` lists every page; entries with `parked: true` render disabled ("coming soon"). Adding a page = mount the topbar with the page id and drop `parked: true` — no other topbar edit. **Login is the only exception** (pre-auth, chrome-less — there's nothing to globally-search before signing in).

**Generic page shell** in `styles/page.css` — `.rp-page` (flex column shell), `.rp-page__body` (centred 1040px column), `.rp-page__section` / `__row` / `__row-label` / `__row-value` (card section + row glue). Used by Profile / Settings / Docs and any future flat page; Home and Workspace keep their own geometry.

**Verification loop** (Em's discipline — check after every change): `sh tools/audit.sh` — expect green. css-audit (0 conflicts / 0 orphans / 0 dangling imports), crossing-audit (every JS `/api` call hits a healthy route), js-audit (0 unreachable / 0 god-objects / 0 extracted-pattern regressions), rs-audit, html-audit all flag regressions. Pattern-catalog discipline (per [[build-tools-proactively]]) extends the regression net to named antipatterns.

Relates to [[workspace-feature-complete]] (current state), [[redtable-refactor-prototype]], [[no-code-debt]], [[data-decides]], [[refactor-decompose]], [[no-mystery-css]].

### project_cleanup_pass

**Cleanup pass deferred**
 — _HTML-partial componentization and overall dedup are deferred to a dedicated cleanup pass after the app's features are complete_

An "overall cleaning" pass — componentizing the HTML partials (shared template fragments, the way CSS got side-nav.css / rail-layout.css / settings-rows.css), plus broader dedup and consistency — is planned but deliberately deferred until RedPash's remaining features are done.

**Why:** The user is limiting work-in-progress on purpose ("too many things at the same time") — feature work first, structural cleanup as one dedicated later pass, so it doesn't sprawl mid-feature. Outstanding feature work still includes the user-preferences table (see the user-preference-table-brainstorming doc / handoff spec).

**How to apply:** When you notice HTML/CSS duplication or naming drift during feature work, note it but don't refactor it inline — surface it for the cleanup pass. Exception: small contained consistency fixes within files you're already editing are fine, and an extraction the user explicitly asks for (like this session's side-nav / rail-layout work) is not "the cleanup pass." See [[naming-consistency]], [[css-component-decomposition]].

### project_backend_queue

**Backend queue**
 — _Backend-lane queue — small CRUD-completion items deferred from full audits; unclaimed Torv work, any Torv can pick up (claim the slice first per [[team-three-torvs]])_

Backend-lane queue — unclaimed Torv work; claim a slice on the case
thread before building per [[team-three-torvs]], then order it per
[[lane-owner-queue]]. Items here are deferred-but-committed — not
maybes. When picking up, re-verify the spec section still reads the
same way before implementing.

## Pending

1. **Files toolbar action-row wiring** — current toolbar (`b216912`)
   ships search / sort / refresh wired; edit / select / delete /
   columns / export render disabled. Next slice wires those.
   Half FE (mostly Torv's lane) + half backend (PATCH endpoints
   already exist; export needs `/admin/files/export?format=` OR
   client-side row-loop).
2. **`tools/auth-audit/audit.js`** — Em-greenlit prep for RBAC.
   Mirror the rs-audit / js-audit pattern-catalog scaffold; backend
   half (categories 1+2+3) is mine, FE category 4 is Torv's. Scan
   for: route handlers with `Path(rid):` that skip `ensure_owner`;
   cross-resource transitive ownership leaks (joins' sibling enum,
   chart `source_file_id`, dashboard widget rids); mutation
   handlers that skip `event::record`. Sequenced after the toolbar
   action-row + Torv's distinct FE wiring wrap up.
3. **`docs/internal/architecture/data-shape-index.md` §5-7** —
   Torv landed §1-4 + §8-9 framing in commit `80af622`; my placeholders
   are at §5 (inode metadata DTO) · §6 (mount registry + stat/preflight
   shape) · §7 (derived-index persistence policy — recompute-on-mtime
   vs version-stamp). Doc moves out of `status: sketch` once §5-7 land
   + cross-edit pass + column-index FS pilot validates with at least
   one real consumer. Sequenced after polish + auth-audit per the
   architecture-thread close.
4. **`?sort=<col>&dir=asc|desc` on the other 5 `/admin/*` list
   endpoints** — Files endpoint shipped (`2ee48cc`). Users /
   companies / memberships / charts / steps still hardcode
   `ORDER BY created_at DESC`. Expand the SORTABLE_* + `sort_clause`
   pattern as the Files-toolbar shape ports to those tabs.
5. **Events-over-time buckets** — extend `/monitoring/events/stats`
   with `buckets: [{ts, count, by_level}]` (same `date_bin` pattern
   as `/requests/stats`). Deferred per Torv — aggregate form covers
   the donut + gauge; buckets only matter when the smooth-line
   error-rate chart lands.
6. **Audit-runs-over-time buckets** — extend `/audit-runs/stats`
   with `buckets: [{ts, count, by_tool}]`. Deferred for the same
   reason.
7. **Companies activity over time** — deferred per Torv ("not urgent").

## Recently shipped

- 2026-05-24 — top-N-by-frequency distincts + `?q=` on `/files/:rid/uniques` + `data::distinct::for_column` primitive — commit `34445ce`. Joins regression check confirmed strict improvement (FK→PK candidates strengthened, e.g. `matricule → experience` matches 2442 vs old top 2441).
- 2026-05-24 — `bin/redpash-audit-distincts` measurement walk — commit `5d07845`. Locked the column-index architecture: lazy / per-col / top-N / LRU=8.
- 2026-05-24 — `?sort=` + `?q=` on `/admin/files` (Home toolbar gate) — commits `2ee48cc` + `511771c`. Pattern (SORTABLE_* + sort_clause helper) ready to expand to the other 5 admin endpoints.
- 2026-05-24 — `/monitoring/events/stats`, `/audit-runs/stats`, `/audit-findings/stats` — commit `991b148`. Aggregate-form Torv asks (Slack 2026-05-24 status update).
- 2026-05-24 — `/monitoring/requests/stats` latency buckets — commit `a32089f`. Torv ask #1.

When the next backend-lane item lands here, prepend to **Pending**
and drop the oldest entry from **Recently shipped** if the list
gets longer than five.

### project_joins_lane

**Joins lane**
 — _Joins backend fully ships compound keys + 4 join types; the workspace UI is the only missing piece — unclaimed Torv work_

The joins feature has an asymmetric state — **backend is fully shipped, frontend was wiped in the 2026-05-22 hard-refresh and not yet re-ported**. The doc (`docs/features/joins.md`, last touched 2026-05-16) lists "Composite keys" and "right/inner/outer" as *Future*, but both have shipped — the doc is stale.

**Backend (already on prerelease):**
- `data::joins::execute(left, right, left_keys: &[String], right_keys: &[String], join_type)` — compound keys (paired by position) + all 4 types (inner / left / right / outer). `backend/crates/data/src/joins.rs:87`.
- `POST /api/files/:rid/joins` body: `{ other_file, this_cols: [], other_cols: [], join_type, filters? }`. Array shape from day one. `backend/crates/api/src/routes/files.rs:767`.
- `GET /api/files/:rid/joins?filters=…` returns candidates grouped by other-file, scored by overlap coefficient `|A ∩ B| / min(|A|, |B|)`. Filter-aware.
- Streams join output to disk (OOM-safe for 400k×400k).

**Frontend (missing):** the old cleaner sidebar had a Joins panel; the hard-refresh deleted cleaner. New workspace doesn't call `/api/files/:rid/joins` anywhere.

**Why:** Em flagged the gap 2026-05-24, after realizing his "we haven't done multi-column joins yet" intuition was right about the *UI* but wrong about the backend.

**How to apply:**
- Unclaimed Torv work per [[team-three-torvs]] — claim the UI slice on the case thread before building.
- When porting the workspace UI, the backend's array-shape API means single + compound joins are the same code path with a different `len`. Don't build a single-key UI and retrofit later.
- Stale-doc note: trust the backend over the doc on this lane. Refresh the doc when the UI lands per [[feedback-docs-lane-ownership]].
- Open design calls (originally parked in the legacy `Internal-Slack/Gus.md` channel, preserved here): candidate ordering, compound-key multi-select UX, join-type dropdown, result-file naming.

### project_logs_monitoring_dashboard

**Logs monitoring Dashboard**
 — _planned — a near-real-time (NRT) Logs monitoring Dashboard over the Events system; the detection half of a self-hosted SRE flow, unlocked by direct DB connections_

Once the Dashboard feature is solid, the team plans to build a **Logs monitoring Dashboard** — a dashboard surface that visualizes the Events system (the `events` table, read via `GET /api/events`).

**Why:** The Events system shipped 2026-05-21 — backend capture middleware (Phase 1) + frontend error capture (Phase 2) — and is the internal app-monitoring substrate. But today it only has a raw JSON read API, no visual surface. A dashboard turns it into a usable monitoring tool. The plan is explicitly gated on the Dashboard feature being production-ready first.

**The SRE framing (Em, 2026-05-22).** This isn't just a dashboard — it's the **detection half of a self-hosted SRE flow**, and it's a flagship use-case for the [[etl-elt-roadmap]] direct-DB-connection capability. RedPash already *emits* Events; a live connection lets it also *watch* them — RedPash monitoring RedPash. Paired with the **Runbook** docs section (`docs/internal/runbook/`, the Problem→Investigation→RCA→Solution→Post-checking post-mortem format), the two halves form a real incident loop: monitor detects, Runbook documents. Note: live updates are **near real-time** (NRT — Em's precise term; "real-time" is commercial language). NRT wants Postgres `LISTEN/NOTIFY` (push on row insert) piped to the browser over SSE/websocket; polling is an acceptable v1.

**How to apply:** Don't build it now — it's parked behind Dashboard readiness. When working on Dashboards, treat the Events log as a planned consumer. When touching `GET /api/events`, anticipate that a dashboard will likely need aggregation (counts by level/kind, error rate over time) rather than just the flat newest-first list it returns today. Relates to [[project-reports-charts-reuse]] (the chart primitives a logs dashboard would render with) and [[project-rbac-corporate-ready]] (events is admin-facing — gate the dashboard behind the company-admin role when RBAC lands).

### project_monitoring_ui_inspiration

**Monitoring UI inspiration**
 — _Em-shared design reference (2026-05-25 Sisyphus mockup) for the next Monitoring page slice; 8 specific patterns worth lifting, plus what NOT to copy from RedPash's current chrome direction_

Em shared a Sisyphus-style dashboard mockup as UI inspiration
for the next Monitoring page redesign. Sharing for later (so he
doesn't forget); not a build ask. Reference is a third-party
SaaS dashboard — vendor management surface — visually clean,
dark theme, rail-page shell.

## Specific patterns worth lifting

1. **Top action bar on the page surface** — Filters / Customise
   / Export buttons + search icon, top-right of the main content.
   Mirrors the workspace's toolbar shape but moves it ABOVE the
   first card row. Could host export, sharing, customise affordances
   that don't fit the redtable toolbar.

2. **Two-big-card row** — `[ donut + legend | KPI tile + line
   chart ]`. Different density than our composite-strip's
   chart|stats|chart. The Sisyphus version reads as "two
   feature cards each owning a domain"; ours reads as "stats
   strip with chart accents". Worth A/B-testing for Monitoring,
   where the operator stays on one card longer than on Home.

3. **Day / Week / Month / Year time-window chip** — right-
   aligned on the table header row. We have a chip-row at the
   top of each tab; nesting a second chip-row per-table would
   let the time-window scope independently from other filters.

4. **Always-visible row checkboxes** — not gated behind a
   select-mode toggle (the pattern we just shipped on Cases).
   Bulk-action workflows benefit when selection is always one
   click away. Worth weighing against the click-to-navigate
   default we have today.

5. **Inline per-row actions column** — small icon-buttons
   (delete + chevron-into-detail) at the right edge of each
   row. Complements the always-visible checkboxes — solo-row
   actions don't require entering select mode.

6. **Primary CTA near the table** — "+ Add vendor" button to
   the right of the time-window chip-row, distinct from the
   page's top-level action bar. Per-table primary action lives
   close to where it's needed.

7. **Letter-grade rating chip** — single uppercase letter
   (A/B/C/D/E/F) with color tone. Gamified scoring style; reads
   instantly across a long list. Could fit a /cases priority
   render, or a future "case health" score.

8. **"+N" overflow badge** — when a row's labels exceed display
   capacity, render "+2" / "+3". Cases already does this for
   memberships' roles; lift the pattern to any tag/label column.

## What NOT to copy

- The rail's interior dividers (faint lines between groups) —
  our [[chrome-visual-direction]] explicitly drops hairlines
  in favor of surface contrast. Sisyphus's rail uses both:
  page-bg chrome + interior dividers. Pick one; we picked no
  dividers.
- The page-title-above-action-bar shape — we have the unified
  6-section stack ([[home-page-template]]) for Home; the per-
  page-title slot already lives in `.rp-shell-head-title`.
  Monitoring stays consistent with that shape.
- The theme toggle in the rail header — we have it in the
  topbar (existing). Don't duplicate.

## Where this lands

The Monitoring page is currently shipped (audit-everything's
investigation console, slice E `b84c568`). The natural next
redesign-slice would be after RBAC lands + the per-user /
per-company surfaces stabilize. By then this memory's worth a
re-read to lift the patterns that still feel right.

The current Monitoring shell already shares the chrome
direction + the 6-section template; the inspiration is about
the BODY shape of certain views (vendors-style inventory →
audit-events inventory? requests inventory?), not the page
chrome.

## Sibling principles

- [[chrome-visual-direction]] — flat chrome stays; some
  Sisyphus chrome bits (interior dividers) get rejected.
- [[home-page-template]] — the 6-section stack continues to
  own the body layout; the inspiration's two-big-card row is
  an alternative within the same template.
- [[relative-units]] — any new pattern adopted from the
  inspiration lands in rem / %, not the px the screenshot
  suggests.

### project_landing_csv_demo

**Landing CSV demo**
 — _the landing-page CSV demo — parse+score SHIPPED (2b8b7fc); Em's next vision is auto-clean + before/after table + download, a free no-signup funnel_

**Shipped — 2026-05-21, commit `2b8b7fc`.** A "parse any CSV" demo on
the public landing hero: drop a CSV → `POST /api/demo/parse` (ephemeral,
no auth, nothing stored, 4 MiB cap) → a score card (rows × cols,
cleanness %, parse-ms, findings) → "Log in to clean it" CTA.

**Em's next vision (2026-05-21):** grow it into a give-value-first
funnel — the visitor uploads, gets the score AND a before/after table
of their data *actually cleaned*, plus a **download** button. "Just
post it and 90% of the job is done." Em also floated making the demo
the *whole* landing hero (strip headline / steps / typewriter).

**Open design problems — the hard parts:**

1. **What does "auto-clean" do?** It cannot be the full interactive
   cleaner — that's all judgment calls (which rows to drop, which
   casts). The demo needs a NEW conservative, always-safe auto-clean
   pipeline: trim whitespace, normalise obvious type drift, drop
   exact-duplicate rows, standardise dates, flag sentinels — the
   unambiguous 90%, never the risky 10%. That backend pipeline is the
   meaty new piece, and a genuinely useful feature in its own right.
2. **The conversion lever.** If the free demo cleans *and* downloads,
   the login must be for what it doesn't do — *control* over the
   cleaning + reports / dashboards / saving the project. The CTA
   shifts from "Log in to clean it" → "Log in to control it / build
   the report."

**Em's later vision (2026-05-29) — "wasm-bench-grade insight in a bigger
modal."** The demo today (now client-side WASM, not the server
`/api/demo/parse` route) only calls `engine.auto_clean()` and shows a
thin strip (rows · dupes · elapsed · "100% in your browser") + a 7-row
minitable. Em wants the *additional per-file data wasm-bench surfaces*
— NOT wasm-bench's UI — shown after upload, likely in a bigger modal.

**Why:** make the visitor feel "look how much RedPash *understood* about
my file in Xms" — a stronger give-value-first hook than a row count.

**How to apply:** the richer data already exists in the WASM exports —
`parse_csv` / `parse_csv_compare` (backend/crates/data/src/wasm.rs)
produce encoding/dialect sniff, per-column dtypes + null counts, a
cleanness score, and timing/throughput (that's what `wasm-bench.html`
renders). The work is: (1) switch the demo pipeline from the JS
`csvToObjects` to parsing raw bytes through `parse_csv` so we get the
profile; (2) render a **curated** subset (dtypes, nulls, score,
throughput) — not the full bench firehose; (3) host it in the shared
`rp-modal-*` atom at a wide `--rp-modal-w` (same mechanism as the
Monitoring request-detail modal — see [[reference-redpash-rust-pwa]]).
Queued behind the parallel Torv's db_query-log work as of 2026-05-29.

**How to apply:** this is now a real workstream, not a landing tweak.
Don't fully strip the landing hero — keep a one-line headline
(non-droppers need the 3-second "what is this"); RedPash is a full
clean → report → dashboard pipeline, the demo only shows the parse /
clean slice. Synergy still stands: pipe demo failures into the Events
system for free edge-case capture ([[logs-monitoring-dashboard]]).
Localhost-first; abuse-harden when genuinely public ([[redpash-stage]]).

### project_reports_charts_reuse

**Reports charts reuse**
 — _When building the Reports page, design chart primitives as stateless redpash-components so Profile/Settings can reuse them (dogfood the reporting tool)_

When the Reports page lands, the chart primitives must be built as stateless render functions in `redpash-components` (data in → SVG out) rather than as page-internal helpers in `scripts/pages/reports.js`. The Profile/Settings page should then reuse those same primitives so the app dogfoods its own reporting tool.

**Why:** the user's goal is for RedPash to be a "Reporting Tool", and Profile/Settings is the most visible always-loaded surface where charts can demonstrate the same primitives that power Reports. If Reports builds chart logic as page-internal helpers first, the Profile reuse becomes copy-paste-drift within a few months — same trap the `.rp-view-*` family fell into (cleaner.css duplicated profile.css until they were hoisted to main.css).

**How to apply:**
- When Reports lands: scaffold each chart kind (sparkline, bar, progress bar, histogram) as its own file under `redpash-components/components/` with a single render function that takes a data array + options and returns / mutates an SVG node. No fetching, no STATE coupling.
- Profile/Settings consumers (planned):
  - Usage stat tiles (`#section-usage`) → tiny sparklines or month-over-month bars beneath each big number, replacing the current static digit-only treatment.
  - Plan section (`#section-plan`) → horizontal progress bars showing usage vs free-tier caps (3 projects, 5 files/project) so the user sees how close they are to the next tier.
  - Cleaner sentinels list inside Defaults → frequency histogram of how often each personal sentinel was matched.
- Don't build any of this before Reports needs it — premature abstraction risk. The note is for when Reports starts, not now.

Related: [[redpash]] (project context), [[redpash-stage]] (solo-dev / pre-prod), [[user-profile]] (frontend/UI focus, sandbox-first).

### project_csv_folder_export

**CSV-folder export**

The user's original idea: a Project is conceptually a folder, and the folder's *listing file* would itself be a CSV (one row per child file/report/dashboard, columns include name + updated_at). Then RedPash — a CSV tool — would have its own metadata as CSV, recursively, matching its identity.

**Original framing was perceived speed.** That's already largely solved by the localStorage SWR caching tiers (Tier 0/1/2 shipped earlier this session) — Postgres JOINs at solo-dev scale are sub-millisecond, so a disk-CSV cache adds marginal speedup. Don't revisit this for speed.

**Real future value: portable / exportable filesystem-shaped artifact.** When native-app (desktop wrapper, PWA-export, "open RedPash project from disk") becomes a real ask, the CSV-folder structure is the natural export format. Users see "a RedPash project is a folder containing my-data.csv plus a contents.csv listing + reports/ + dashboards/ subdirs" — readable in any spreadsheet, syncable to Dropbox / git, etc.

**Why:** sustains the "CSV tool, dogfooded" identity in the export layer without paying the dual-write / sync cost of making CSVs the live store. The user explicitly flagged that Postgres↔CSV sync was the blocker on adopting this earlier ("wasn't sure to be able to handle the sync" — that's why `reports.folder` was left unused).

**How to apply (when the trigger arrives):**
- Don't dual-write to CSV files on every mutation. Postgres stays source of truth.
- Build `GET /api/projects/:rid/export` (or similar) that generates the CSV-folder structure live from a JOIN. Returns a zip / writes to a target dir for PWA-filesystem-API.
- The listing CSV is just a query projection — schema evolves freely with `ALTER TABLE`, no migration of on-disk CSVs needed.
- mtime cascade (project = max of child mtimes) is already wired in Postgres via the trigger migration `20260526000001_mtime_cascade.sql` — the listing CSV's "last modified" column reads `projects.updated_at` directly and is honest.
- Concurrent-write / cross-project-query / schema-evolution headaches all stay in Postgres-land where they're solved.

**Do NOT:**
- Build this before native/PWA-export is on the roadmap. Premature.
- Use it as a live storage layer or as a perceived-speed mechanism (localStorage SWR already covers that).
- Forget that `reports.folder` and `dashboards.folder` columns exist and are unused — the export listing should probably honor them as a sub-grouping under the reports/ and dashboards/ directories.

Related: [[redpash]], [[redpash-stage]], [[reports-charts-reuse]].

### project_boot_splash_launch

**Boot splash launch polish**
 — _Pre-public-launch polish — eliminate the boot splash delay on cold load of landing/home_

Deferred until closer to public launch: the `.rp-boot` "Loading RedPash…" splash in `index.html` shows briefly on every cold load while `loadSession()` awaits `/api/me`. The default→full chrome *snap* was fixed (2026-05-19, boot sets `body.dataset.chrome` synchronously before `loadSession()`), but the splash itself still appears.

**Why:** Acceptable for solo-dev now; the user explicitly flagged it will matter "when the app is available for real users."

**How to apply:** Don't fix proactively — it's launch-gated. When it comes up, the recommended fix is *not* dressing up the splash: `/landing` is `auth: false`, so the boot IIFE in `main.js` (currently `await loadSession(); await navigate();`) can `navigate()` to landing immediately and let `loadSession()` resolve in the background — real users then see the real landing page, near-zero splash. Theme/accent already paint from localStorage boot IIFEs, so the session race is low-risk. Related: [[project-redpash-stage]], [[project-rbac-corporate-ready]].


## Reference

### reference_docs

**Docs reference**
 — _Location of the project docs tree and how to use it before implementing anything_

Project docs live at `/home/mansa/redpash-app/docs/` (served at `/docs` in the running app).

**Always read first:** `INDEX.md` (section TOC) + `REDMAP.md` (one-page nav: surface map, objects, screens, systems, API table, files cheatsheet, conventions & gotchas).

**Before relying on any doc to implement something:** ask the user to confirm the doc is up-to-date. Docs may lag the code.

**Branch-specific:** the docs tree was brought over from the **`main`** branch; the repo is on **`prerelease`**, which is ahead — e.g. as of 2026-05-19 prerelease had `/api/users/*`, `/api/companies/*`, `cast` + `filter_rows` step kinds, and several `/api/files/*` endpoints (PATCH, DELETE, /sentinels, /export, /cleanness, /cast-preview, /clear-filters) that REDMAP and the API docs don't mention. Expect substantial main-vs-prerelease drift; when on a non-main branch, **trust the code over the docs** for surface area and capabilities.

**Relative-accuracy proxy (user-confirmed):** within the docs, use each file's `last modified date` frontmatter as a freshness ranking — recently-dated files (REDMAP, features/charts.md, features/reports.md, objects/* at 2026-05-21) track prerelease; files dated 2026-05-20 or earlier are closer to main-branch state. Caveat: the date is per-file, not per-section — REDMAP (2026-05-21) still had un-refreshed sections (Undo/Redo and the Cleaner-screen controller pointed at `scripts/{reports,cleaner}/index.js`, modules the router no longer loads — live page modules are `scripts/pages/*.js`). `VISION.md` is **evergreen product intent** — its older date is deliberate, not staleness. For phase/build *state* use REDMAP; for product *intent* use VISION (their roadmap phase numbers diverge and VISION's are not maintained).

Key sub-trees:
- `features/` — cleaner, joins, reports, dashboards, charts
- `objects/` — DTO reference (user, project, file, step, report, dashboard, chart)
- `api/` — per-resource detail
- `db/schema.md` — tables, migrations, RID prefixes
- `frontend/design.md` — CSS token conventions, dark mode, library vs app naming
- `frontend/redpash-components-pages/` — per-page docs (landing, home, objects, profile)
- `auth/google.md` — OAuth flow + dev_user fallback
- `dev/setup.md` — local run instructions

**Critical convention (design tokens):**
- Library (`/home/mansa/redpash-components/`) → bare names: `--bg`, `--accent`, `--surface`
- App (`/home/mansa/redpash-app/frontend/`) → prefixed: `--rp-bg`, `--rp-accent`, `--rp-surface`
- Integration is via an alias layer in the app's `main.css`: `--rp-bg: var(--bg);` — do NOT rename either side.

**Phase progress (per REDMAP 2026-05-21):** Phases 1–4d complete — 4d = companies + memberships multi-tenancy *data model*, but company-scoped resource visibility is NOT enforced (every owner-scoped endpoint still gates on `projects.owner_id` alone; `project_memberships` in schema, unread). REDMAP's "Phase 5" = bake-into-binary/brotli/systemd.

### reference_redpash_rust_pwa

**Rust PWA repo**
 — _Rust + vanilla-JS RedPash rewrite at /home/mansa/rust-project/redpash-rust-pwa/ — its own docs tree (INDEX.md + REDMAP.md); distinct from redpash-app/redpash-components_

`/home/mansa/rust-project/redpash-rust-pwa/` — the Rust + vanilla-JS RedPash codebase. **Distinct from** `/home/mansa/redpash-app/` (older app docs in [[reference-docs]]) and `/home/mansa/redpash-components/` (the design-system library called out in [[project-redpash]] — now CSS-internalized and not a dependency).

**Layout**
- `backend/` — Cargo workspace, 3 crates: `api` (Axum HTTP + routes + middleware), `data` (Polars/CSV/Maud pure compute, no HTTP), `shared` (DTOs only). Migrations in `backend/migrations/` (28+ files, sqlx-managed, autorun at boot).
- `frontend/` — vanilla JS, no bundler; PWA via `service-worker.js` (bump `CACHE_VERSION` on FE-touching commits). Hash-routed; partials loaded by router.
- `docs/` — served at `/docs`; [[reference-docs]] convention applies: **read `INDEX.md` + `REDMAP.md` first** (REDMAP is the one-page authoritative map — objects, screens, systems, API table, files cheatsheet, conventions, migrations).
- `tools/` — `install-stack.sh` + `stack-version.sh` matched pair (apt/rustup/nvm/cargo); audit/instrumentation scripts ([[feedback-build-tools-proactively]]).

**Key spine files in `backend/crates/api/src/`**
- `main.rs` — boot, tracing-subscriber JSON, panic hook → events table.
- `state.rs` — `AppState` (PgPool, `DashMap<rid, FileEntry>` hot-frame cache, OAuthConfig, reqwest, avatar cache).
- `routes/mod.rs` — router assembly + `request_id_mw` (mints `req_<uuid>` echoed as `X-Request-Id`) + `capture_mw` (persists every 4xx/5xx as `events` row + writes `request_log`). `ensure_owner` helper re-exported.
- `error.rs` — `AppError` carries `Option<eyre::Report>`; airlock pattern (rich chain → tracing JSON + `EventInfo` extension; bare `{error,kind}` to wire). `From<sqlx::Error>` always maps to generic 500 `kind="db"` — PgError details stay server-side.
- `event.rs` — fire-and-forget `record(pool, EventDraft)` + ergonomic builders `event::info/warn/error(pool, kind, msg).user().context().send()` (`#[must_use]`).
- `db/mod.rs` — every SQL helper; being decomposed (was 2455 LOC). Non-macro `sqlx::query` so no `DATABASE_URL` needed at build time.

**Object model** — matches [[project-object-model]]: 2 entities only (Project + File). Reports retired, Dashboards folded into `project_files` as `file_type='dashboard'` (mig 018/019). Charts are `file_type='chart'` rows with `spec` JSONB + `source_file_id` self-FK (mig 016). Stage is computed via `file_stages` view, never stored. RID format `PFX_<32-uppercase-hex>` — `USR/PRJ/FIL/CHT/DSH/SES/EVT/CMP/CAS/CMT/CAT/OPT/STP`.

**Observability** = `events` table + `request_log` table + tracing JSON; everything correlatable via `request_id`. Matches [[feedback-audit-everything]] discipline.

**Phase status** (from REDMAP): 1–4d ✅, 5 (embed assets / brotli / systemd) ⬜. Cases workstream ([[project-cases-workstream]]) shipped through mig 030.

**Stack pins** (workspace Cargo.toml): axum 0.7, tokio 1, polars 0.43 (+ hashbrown 0.14 `raw` workaround), sqlx 0.8, reqwest 0.12 rustls. Pre-pinned Excel: calamine 0.26 / rust_xlsxwriter 0.95. Render: pulldown-cmark + syntect + gray_matter + maud 0.26.


---

_Generated from personal memory snapshot 2026-05-31. Future updates: edit this file directly; sync to personal memory dirs at your own discretion._
