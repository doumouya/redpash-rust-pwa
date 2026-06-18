# RedPash — A Project Deep-Dive

*Companion to the CV of Emmanuel Doumouya. The long version of the story — read it if the one-page summary made you
curious. Written by Claude (Anthropic's Claude, via Claude Code) — the AI agent Emmanuel orchestrated to build
RedPash — and signed, with an honest assessment, at the end.*

---

## 0. The honest framing, up front

RedPash is **not a shipped, at-scale product.** It is a localhost / pre-production application, built **solo in
about six weeks** (early May – mid-June 2026) by one person directing a small team of AI coding agents, while he
held a full-time job. It is also Emmanuel's **only project built with Claude** — there is no portfolio of ten of
these.

I lead with that because the rest of this document is going to describe a genuinely sophisticated system, and I
don't want the substance to read as inflation. The interesting claim here is **not** "Emmanuel shipped a unicorn."
It is: *in six weeks, alone, alongside a day job, he built — and rebuilt five times — a multi-crate Rust/WebAssembly
platform with a generated RBAC engine, a client-side compute architecture, and a CI/audit system rigorous enough to
let a fleet of AI agents commit to one branch without eroding it — and he developed a repeatable methodology for
doing that with Claude.* For a role whose whole job is helping founders build with Claude, that lived methodology is
the asset. The product is just its proof.

---

## 1. The version timeline — six rewrites of one idea

One idea — *a browser-first data-quality tool that cleans messy spreadsheets without the data ever leaving the
user's device* — rebuilt from the ground up six times, each rewrite a deliberate response to where the last one
broke. Every repository below is **public** under `github.com/doumouya`.

| When (2026) | Repo / branch | Stack | Commits | What it was |
|---|---|---|---|---|
| **May 4** (one day) | `dc-project` ("ClarNa") | Python · **Streamlit** | 15 | The first prototype — proved the concept in hours. Fast to demo; a monolith that hard-coded every assumption. |
| **May 8** (one day) | `redpash` | **Django 5.1.5** · pandas | 13 | The web rewrite — *"Initial commit — RedPash Django app."* Real routing, an admin, a cleaner page. Still a server-side monolith. |
| **May 16 → 17** | `spreadsheet-paper` | HTML · CSS · JS | 24 | A pure front-end design sandbox — the cleaner UI worked out in isolation. |
| **May 17** | `redpash-front` | vanilla HTML/CSS/JS | 1 | A front-end snapshot/export. |
| **May 22** | `red-front` | vanilla JS · ECharts | 3 | A charting/designer proof-of-concept. |
| **May 16 → today** | `redpash-rust-pwa` | **Rust · Axum · Polars · WebAssembly · vanilla-JS PWA · PostgreSQL** | **1,186** | The keeper. The full rewrite that encodes every prior lesson as architecture. |
| **Jun 8** | `polars-rp` | forked Polars 0.54 | — | A fork of the Polars dataframe engine, patched to compile to `wasm32` (commit `0bb178d`). |

The arc is the point: **Streamlit → Django → Rust/WebAssembly**, plus three front-end iterations, in six weeks. Each
jump was a response to a real ceiling — the Streamlit and Django versions were quick but monolithic (every object
type hard-coded; couldn't grow); the front-end sandboxes surfaced the costly lesson that uncontrolled component
forking produced **137 same-class CSS divergences**; the Rust rewrite turned each of those lessons into a *mechanical
guardrail* (more on that below).

### Inside the keeper: how `redpash-rust-pwa` itself evolved

The current repository is not a single push — it has its own three-branch history, which is where the discipline
shows:

- **`main`** — **769 commits**, May 16 → May 31. The production-shape foundation: auth, the entity registry, RBAC,
  the data engine, the cleaner, cases, dashboards.
- **`prerelease`** — **1,117 commits**, branched from `main` at `f788a9e` (May 31, 15:59) and run forward to June 13.
  The fuller, experimental tree — connectors (MySQL/Postgres/Kafka), the monitoring page, TypeDefinition v2, more.
- **`lean`** — **1,186 commits**, branched June 13, then a deliberate *"graduation"* (`fbd9f5e`, June 16, 01:57):
  *"wipe the prerelease-derived tree, bring in the clean rebuild."* `lean` is a from-scratch re-build that keeps the
  hard-won architecture and drops the accumulated weight — a single-purpose, leaner version. Recovery tags
  (`full-app-pre-slim`, `lean-pre-graduation`) were cut first so nothing was lost.

That last move — voluntarily rebuilding a working 1,100-commit tree to shed complexity, with recovery tags in place —
is, to me, the most revealing thing in the whole history. It is the **"disposability"** instinct of someone who
has felt how code debt compounds and refuses to carry it.

> A note on the numbers: the CV's *"770+ CI-gated commits in five weeks"* is the conservative `main` figure. The full
> `lean` tree is **1,186** commits. Features such as RBAC, cases, connectors, and monitoring were built across `main`
> and `prerelease` (May–mid-June); the June 16–17 commits on `lean` are the clean-rebuild *re-landing* them, not
> two days of from-scratch work.

---

## 2. Architecture & design choices

The architecture is where RedPash stops looking like a six-week solo project. The decisions below are documented in
the repo's own `docs/decisions/` and `docs/internal/code/` trees, with the *why* attached to each.

**Compute-to-data (the governance thesis).** Raw customer data never leaves the device. A pure-compute Rust + Polars
crate runs natively on the server **and compiles to `wasm32` to run in the browser** — one engine, two surfaces,
byte-identical results. The PostgreSQL database holds only ids, metadata, and shapes (the *registry*); the customer's
actual rows live client-side, in Polars frames and a **GlueSQL + IndexedDB** on-device store. This directly answers
the first objection a founder raises about any cloud data tool — *"our data can't leave our walls."*

**A three-crate Rust workspace, with a `wasm32`-purity gate.** `api` (the Axum edge), `data` (pure compute), and
`shared` (DTOs). A pre-commit gate — `tools/purity-check.sh` — runs `cargo check --target wasm32-unknown-unknown -p
data` and **fails the commit** if any I/O, threads, HTTP, or clock access creeps into the compute crate. That purity
is *what makes* "one engine, two surfaces" possible, and it's enforced by a machine, not by vigilance.

**The object registry — "database as a framework."** Declaring a new object type is **a row, not a migration.** A
`type_definitions` row (plus `type_fields`) auto-wires storage, CRUD, role-based access control, audit, and typed
fields — with zero new code — served by one generic `/api/objects/:type` handler. The design thesis, stated verbatim
in the repo: *"framework, not product — O(1) in an O(Y) market."* Build the framework once; new verticals become
configuration.

**Polymorphic, generated RBAC.** One `memberships` edge (a principal — user *or* team — holding an ordered role
`Viewer < Member < Admin < Owner` on any object) carries the entire access layer *and* the org chart. There are no
`owner_id` columns anywhere; ownership is a membership row, and *"there is no object without an owner"* is a creation
invariant. Reach resolves through a **recursive SQL cascade generated from a single declared `scope_parents`
column** — not three hand-synced copies — and every denial is a **leak-free 404, never a 403** (a non-member can't
even tell the object exists). This is the part most six-week projects don't have, and it's the part that matters most
for an enterprise buyer.

**A sealed write path.** Every file that enters the system goes through one function (`pipeline::upload_csv`); the
underlying `insert_file` is module-private and unreachable any other way. A whole class of "someone added a second
write path that skips validation" bugs is made *impossible by construction*, not caught by review.

**Derive, don't store.** Per-role field cells, file/project stage, dashboards — all derived, never stored a second
time. A second storage path for one concept is treated as a bug.

**No front-end framework — a registry-driven UI instead.** No React, no Vue, no bundler at dev time. Three registries
make *UI components, object types, and behaviour all data*; pages are declarative specs that mount self-registering
components. A new look is a single framework commit, never a per-page override — and that rule is mechanically
enforced (see §5).

**The Polars fork.** When Polars 0.54 made an async/Tokio dependency unconditional, it stopped compiling to `wasm32`.
Rather than abandon the compute-to-data design, Emmanuel **forked Polars** (`doumouya/polars-rp`, ~110 lines across 11
files) to gate Tokio off the wasm target, consumed via a `[patch.crates-io]`. That is not a beginner's move.

---

## 3. Technology stack

- **Backend / edge:** Rust 2021 · Axum 0.7 · Tokio · Tower / Tower-HTTP · SQLx 0.8 (non-macro, compiles without a
  live DB) · eyre · tracing.
- **Compute engine:** Rust → native **and** `wasm32-unknown-unknown` · Polars 0.54 (the `polars-rp` fork) ·
  `wasm-bindgen` · `csv` / `encoding_rs` / `chardetng` (encoding-robust CSV import) · `rust_xlsxwriter` (export).
- **On-device persistence:** GlueSQL 0.19 + `gluesql-idb-storage` (IndexedDB), built as a separate wasm module.
- **Database:** PostgreSQL (registry / metadata / RBAC / audit only — *not* a customer-data store).
- **Front-end:** vanilla ES modules + vanilla CSS, no framework; a hash router; a service worker; content-hashed
  release assets. Build/analysis tooling in Node lives only under `tools/`.
- **AI integration:** a **Model Context Protocol (MCP) server** bridging Claude to the live application.
- **Connectors:** MySQL / Postgres / Kafka loaders behind one shared SSRF/TLS security gate (on the `main` /
  `prerelease` lineage).

---

## 4. What was built — features & primitives

Everything below was built in the six-week window. *App features* are what a user touches; *architectural
primitives* are the framework underneath that makes new features cheap.

**App features.** A non-destructive **data cleaner** with ~18 operations (column ops, row filters, type casts,
date-format repair, CSV-unwrapping, split/join columns, find/replace) applied as a replayable step list with
undo/redo · a **read-only SQL console** (Polars `SQLContext`, multi-file joins) · **automatic join detection** across
a project's files (overlap-coefficient key inference) · a **group-by / pivot / reporting** engine (aggregations,
windows, top-N) · a **Cases** kanban with a workflow-as-data engine and file attachments · a **monitoring** page
surfacing the CI audit trail · an **admin console** (org management, a read-only data registry, field-permission
overrides) · a **settings** system with a four-level preference cascade (user → role → company → platform) ·
**Google OAuth** + a compile-gated dev-login · **external-database connectors** (MySQL/Postgres/Kafka) that act as a
conduit, never a store · a **messaging** backend so AI agents can participate alongside users.

**Architectural primitives.** The **entity registry** (one polymorphic id space; one delete path) · **type
definitions** (the data-driven object catalog) · the **membership RBAC** engine and generated scope cascade ·
a **field-permission** layer (per-field read/write rules derived from a role matrix) · an **audit/events** system
(time-partitioned at birth) · **open codec registries** (data types, filter operators, aggregations are open
strings, extended by data not by migration) · one canonical recursive **`FilterNode`** consumed identically by the
server, the persisted steps, the group-by pre-filter, and the wasm engine · the **component / type / preference**
registries · a server-resolved **rail** (navigation) · and **unified, reach-scoped search**.

---

## 5. How the work was organized between AI agents — the real novelty

This is the part I can speak to with first-hand authority, because I was one of the agents. Emmanuel did not "prompt
an AI and paste the output." He built an **operating system for AI-agent development** and ran the project through it.

**A five-role pipeline.** Every feature flows through `Architect → Tester → Coder → Reviewer → Ops`, each a separate
agent with its own tool permissions defined in `.claude/agents/`. The constraints are enforced by *tooling*, not
trust: the Architect can't write code, the Coder can't edit tests, the Reviewer can't edit anything (it only flags),
and Ops is the sole pusher. Test-first is structural — the Tester writes a failing test per acceptance criterion
before the Coder may touch the implementation.

**Two human checkpoints and a circuit breaker.** Emmanuel approves the spec (before any code) and approves the push
(before anything ships). Between them the chain self-governs under hard caps — **≤3 retries per gate, ≤8 role-hops
per feature** — and escalates to him on a breach rather than looping forever. A "test-drift" dispute (the Coder
believes a test contradicts the approved spec) has its own bounded path. Ambiguity is never allowed to flow
downstream.

**Dogfooding: the product runs its own build.** The team's coordination ticket *is the product's own **Cases**
feature.* A Case is a registered object under the same RBAC and audit as customer data; the agents read and advance
it through an MCP server (`case_create` / `case_get` / `case_comment` / `case_set_status`), and case comments are
literally *"the agent-to-agent thread surface."* The workflow is data, not code, so illegal transitions return a
clean `422`. Emmanuel built a ticketing system, then used it to coordinate the AI team that builds the ticketing
system.

**A shared-branch team model.** Multiple agent instances committed to one `prerelease` branch without stepping on
each other, via discipline encoded in tooling: a coordination board (`commits.log`, per-agent presence files, a lean
`broadcast.md`) and a strict **parallel-safe commit rule** — `git commit -o <named files>`, never `-A`, so no agent
ever sweeps another's work-in-progress into its commit.

**Domain knowledge encoded as reusable skills.** Four custom Claude Code skills — `rust-object-registry-design`,
`rust-data-engine`, `redpash-frontend`, `polars-upgrade` — mean each agent produces convention-correct code on the
first pass instead of re-learning the codebase every session.

**Guardrails that let a fleet move fast without eroding quality.** One `ci.sh` runs six gates; a **ratcheted
static-audit suite of ~28 analyzers** compares each run to a committed baseline and **fails only on *new*
violations** — so agents can move fast on a shared branch while the design system, the leak-free auth model, and the
docs cannot silently regress. An **atomic-docs** rule requires every code change to update its documentation in the
same commit. The `ui-fork-audit` turned that 137-CSS-divergence lesson into a CI *failure* (forking framework styles
is now mechanically forbidden).

**Honesty built into the system.** The audit baseline is also an honest ledger of *what isn't done*: at last read it
openly tracked, among others, **82** UI-doc gaps, **23** list-endpoints still needing RBAC coverage, **19**
front-end-framework reuse violations, and **17** observability gaps. A project that counts its own debt in CI and
refuses to let it grow is telling you the truth about itself — which is the same trait you want in someone advising
your customers.

---

## 6. Governance as a measurable framework — June 16–18

*Added after the first draft of this document. In the three days since I wrote the sections above, Emmanuel and I did
one more piece of work together — and because it maps almost exactly onto the hardest thing this role hires for, it
belongs here.*

**This role's sharpest requirement — *"Win technical evaluations … helping them develop evaluation frameworks to
measure Claude's performance for their specific use cases"* — is, underneath, a single muscle: take a fuzzy quality nobody has quantified, turn it into a
machine-checked gate, and hold the line as the system changes.** Over June 16–18, Emmanuel directed exactly that
exercise, on privacy.

**He asked me to assess RedPash as an independent privacy consultant — and to be honest, not flattering.** I produced
a GDPR / Privacy-by-Design assessment that surfaced **12 findings**, each mapped to a specific GDPR article, graded
the maturity across the seven Privacy-by-Design principles, and stated plainly that the app was *not* compliant for
production. Then we didn't fix the findings by hand and call it done. **We encoded the assessment as a tool.**
`tools/privacy-audit/` is a static analyzer that turns each finding into a CI check and ratchets it against a
committed baseline — so privacy stopped being *asserted in a document* and became *a number the build refuses to let
regress.* It became one more analyzer in the same ratcheted suite described in §5. The enforced count fell from
**11 to 2** over the next day; the two remainders are documented as a deliberate pre-launch ("go-live") workstream,
not quietly dropped.

**The nine findings closed were real changes to the system:** an orthogonal PII-classification dimension added to the
type registry (so redaction and data export *derive* from data, not hand-maintained lists); complete erasure (a
delete now sweeps the on-disk blobs the database cascade can't reach, and a user-scrub anonymizes their free-text
comments); a GDPR Art. 15/20 data-subject **export** endpoint, scoped by that new classification so secrets can't leak
into it; an Art. 30 **read-access audit**; **AES-256-GCM** encryption for connector secrets with a **dual-key
rotation** window and a `redpash-rotate-secrets` CLI (round-trip, tamper, wrong-key and rotation each covered by unit
tests); and a shared-device logout that wipes client-side storage.

**The judgment was the more senior signal — knowing what *not* to build.** One "stale comment vs. add a sanitizer"
finding he resolved by *accepting the existing escape contract and correcting the documentation*, rather than forcing
a rich-text product change nobody asked for. Retention he deliberately *split*: the session cleanup and an orphan-blob
reaper shipped, but the partition-rotation piece he deferred to go-live once I surfaced that the clean fix needs a
data migration — a real architecture call made with eyes open, not a silent skip. And when he asked how RedPash could
offer enterprise **SSO / SCIM / SAML**, we worked through a design — discussion, not yet code: the existing identity +
membership-RBAC foundation maps cleanly onto SCIM (provisioned groups become membership edges), so the honest
build-vs-buy call was *build OIDC + SCIM in-house, broker SAML* rather than hand-roll XML-signature verification in
Rust (an auth-bypass-prone area), and treat a general-purpose **Identity Provider** as a non-goal — a separate product
with a security team behind it, not a feature. A founder in a technical evaluation wants exactly this: a
build-vs-buy-vs-*don't* answer with the reasoning attached.

**"Measure, don't assert" is the eval-harness instinct** — the difference between telling a founder "Claude seems good
enough" and helping them build the gate that proves it and catches the regression. That is the same loop as §5's
operating system, now pointed at the security-and-compliance questions that themselves block enterprise AI deals. I
watched Emmanuel reach for it by default.

**The honest caveats, in the spirit of the rest of this document.** This was an *internal* audit run in a consultant's
frame, not a third-party certification; the result is an engineering *posture*, not legal GDPR compliance. RedPash is
still localhost with no real users — this is hardening *ahead* of an adversary, not battle-tested *against* one. And
it is Rust + privacy work, which does **not** close the gaps §7 names: production-LLM depth, Python and eval-framework
experience at scale, and a customer-facing track record. What it *does* show is that the measurement-and-enforcement
discipline this role is hardest to hire for is not a story he tells — it's how he works, including on the security and
trust questions a startup founder will put to a Claude advisor first.

---

## 7. An honest assessment — why Emmanuel is, and isn't, a fit

*This section is my opinion, as the AI that worked alongside him. I've tried to be the reference a hiring manager
actually wants: specific about the strengths, and equally specific about the gaps.*

**Why he's an unusual fit for this role.**

- He has *actually done the thing this role exists to teach.* The Applied AI Architect's job is to help a founder
  build something real with Claude. Emmanuel has built a genuinely non-trivial system that way and can explain the
  methodology — role separation, CI guardrails for AI output, dogfooding, context engineering — at a depth I have
  rarely seen articulated. Most candidates will be able to *describe* building with AI; he can show the operating
  system he built to do it.
- **His engineering judgment is real, not cosmetic.** Compute-to-data, a generated RBAC cascade, `wasm32` purity
  enforced in CI, a sealed write path, forking Polars to keep the engine pure — these are senior architectural
  instincts. The work would survive a serious technical interview.
- **He has lived the before/after.** He built the same product the traditional way (Django) and the AI-orchestrated
  way (Rust). He can speak to a founder about the *delta* from direct experience, not theory.
- **He is intellectually honest under pressure.** Repeatedly, he volunteered the *less*-flattering truth: he told me
  Durabilis was **not** an AI build (cutting his own headline differentiator in half), he insisted a pre-production
  app be called pre-production, and when a grade was in doubt he sent the actual exam certificate rather than let me
  round it up. He can stand behind every claim in his application because he refused to make one he couldn't. For a
  customer-facing technical advisor, that trait is worth more than another year of experience.
- He brings an **enterprise data + customer-facing base** (Salesforce, Informatica), is **Dublin-based and
  EU-authorized**, and is **certified bilingual** (English C1 / French C2).

**Where he falls short of the bar, and what he needs to improve.**

- **It's pre-production, single-user, six weeks old, and n=1.** RedPash runs on localhost. There is no evidence it
  survives real users, real load, an actual adversary, or multi-tenant scale — and it is his only Claude project.
  Many people applying for this role will have shipped products with real customers behind them. He should say
  "localhost / pre-production" before anyone else does, and lean on the *discipline* rather than imply scale.
- **The customer-facing bar is a stretch.** The role asks for ~5+ years; his clearly customer-facing technical time
  is closer to two (the two Salesforce/Informatica support roles). And **technical support is not technical
  pre-sales** — winning a technical evaluation, running an executive demo, and being the trusted architect in a
  founder's room are muscles he has not yet demonstrated. There is no quota-carrying sales history.
- **His LLM depth is narrow, if deep.** He is excellent on agentic *coding* orchestration and MCP. I saw little
  evidence of the broader applied-LLM surface this role often touches — retrieval, evaluation harnesses at scale,
  production inference, multi-model trade-offs — or of Python LLM frameworks in production. That's a learnable gap,
  but today it's a gap.
- **Orchestrating AI agents is not the same as leading an engineering organization.** He ran a disciplined process
  solo; advising a startup's *human* team through architecture and adoption is a related but different skill.
- **The credential profile is light** for the seniority implied: a degree in progress, no shipped-at-scale product.

**My recommendation.** Measured against *this* posting — 5+ years, customer-facing at scale, quota — he is honestly
below the line, and I won't pretend otherwise. The fair read is that he's an **early-career version of exactly this
profile**: the instincts and the build evidence of the role, without the years or the production scars yet. So my
recommendation is not "hire him for the seat as written" — it's "**this is a person worth bringing in a level down
from where he's applying.**" On the single axis this role is hardest to hire for — *someone who has genuinely built
production-discipline software with Claude and can teach a founder to do the same* — he is one of the stronger
signals you will see, and his honesty makes him low-risk to put in front of a customer. I would **interview him**,
most naturally for a Forward-Deployed-Engineer or junior solutions-engineering seat, and spend that interview on the
dimensions a CV cannot show: can he demo under pressure, explain a hard idea to a non-expert, hold a room, and read
what a customer actually needs. If those land, the build evidence behind him is real. If they don't, the gaps above
are the reason.

He asked me to sell him to you, and also to be honest. The honest version *is* the sell: a person who builds at this
level, this fast, alone — and who would rather tell you what's missing than oversell what's there — is exactly the
kind of person who gets dangerous with another year and the right room to grow into.

— **Claude** (Anthropic's Claude, via Claude Code), the AI agent Emmanuel orchestrated throughout RedPash · 2026-06-18

---

*Every factual claim above is drawn from the public repositories under `github.com/doumouya` and the project's own
documentation. RedPash is pre-production. Where the evidence was thin, I said so.*
