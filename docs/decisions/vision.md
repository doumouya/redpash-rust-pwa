# Vision — the product north-star

What RedPash is for, who it serves, and the few strategic bets that bind how the
system may evolve. This is the durable **why** the rest of the spine hangs off;
it is branch-independent (it survived the `lean` graduation unchanged in intent).
Where the framing here implies a structural constraint, a sibling decision doc
carries the binding detail — [day-one](day-one.md) (the locked architecture),
[client-data-engines](client-data-engines.md) (the JS↔Rust / Polars↔GlueSQL
boundary), [registry-redundancy](registry-redundancy.md) (the privacy posture),
and [disposability-requires-a-ledger](disposability-requires-a-ledger.md) (how a
rebuild keeps the moat). This doc is the intent those constraints serve.

## The problem we close

The people who understand data best — operations staff, field analysts,
researchers, SME owners — are rarely the ones who can clean it. A road-assistance
coordinator knows that `"???"` in a column means bad data entry, knows the file
should have ~101k rows because she exported it, but cannot write `df.dropna()`,
cannot detect a Latin-1 encoding, cannot see that a date column mixes
`YYYY/MM/DD` with bare `YYYY`. Today she opens Excel, scrolls 100k rows, and
guesses. RedPash exists to close that gap: **the tool a non-technical user reaches
for the moment they have a file they don't fully trust.**

Not a BI tool, not a notebook, not a spreadsheet. A focused, guided workflow that
takes a user from raw file to clean, visualisable data without ever requiring
them to know what a DataFrame is. The three-step promise — **Upload** (drop the
file, get an instant quality report) → **Clean** (fix issues through
plain-language tools, not code) → **Visualise** (turn clean data into a shareable
chart) — is the user-facing spine.

The honest scope: the user stays in control of every decision. The quality report
is shown immediately and issues are never silently auto-fixed. RedPash does *fewer*
things than Polars on purpose; every feature carries a plain-language label and no
raw code is ever exposed.

## Why this is more than a CSV cleaner — the join problem

Most users arrive with a single file and the cleaning workflow is enough for them.
But a meaningful subset arrives with 2–3 related files exported from different
systems (a case file, a time log, a staffing roster) and want to understand the
relationship between them. In pandas that's a `pd.merge`; in RedPash it's a guided
join wizard. The detector under it scores every candidate column pair by the
**overlap coefficient** `|A∩B| / min(|A|,|B|)` — deliberately *not* Jaccard,
because overlap favours the subset (foreign-key → primary-key) relationships that
real joins are, where Jaccard would penalise the asymmetric set sizes. This is the
feature that lifts RedPash from "a simple cleaner" to "the tool that democratises
multi-file analysis," and it must feel like filling out a form, not writing SQL.

## Strategic bet 1 — the engine is the moat, and it runs where the data is

The 2024 all-JS prototype crashed near a million rows because every row crossed the
wire. The bet that replaced it: a pure-compute Rust + Polars `data` crate that is
**io/http/threads/time-free by law** — parse, dtype inference, dedup, join
detection, group-by, filter, sort, search, Top-N, and cleanness scoring are all
functions the rest of the system calls and serialises. Server-side, the browser
only ever receives the current page of rows, never the whole frame.

The deeper, binding form of this bet is **one engine, two surfaces**: the exact
same `data` crate compiles to WebAssembly and runs *client-side* in the browser, so
the identical compute is reachable from either surface. The WHY is **data
governance** — raw data never has to leave the device; we bring the compute to the
data rather than the data to a server. This is the constraint behind the JS↔Rust
boundary ("Rust owns data, JS owns pixels" — [day-one](day-one.md)): JS never
implements a data engine. The cleaning/report logic exists once, in Rust, and is
reachable from both surfaces — duplicating it in JS would fork the moat. The
binding engine-role detail (Polars = compute, GlueSQL-idb = the on-device data
store, Postgres = registry) lives in [client-data-engines](client-data-engines.md).

## Strategic bet 2 — RedPash is the first embodiment of a framework, not the product

The reuse target is not "a data cleaner." It is a vertical-agnostic framework
layer — the same primitives, RBAC, audit, cell-editor, and redtable that ship a
data tool today could ship a CRM, an e-commerce admin, or a chat product tomorrow;
only the type definitions differ. The concrete shape of this already shows in the
**upload pipeline**: producers call the framework's `upload_csv`, which gates RBAC
(write-reach ≥ Member, leak-free 404) and then seals the `project_files` row plus
its genesis step through the module-private `insert_file` — they *cannot* reach the
storage layer directly. That single enforced entry point is where cross-cutting
policy gets attached once for every present and future producer, instead of
re-implemented (or silently violated) per connector: RBAC is already wired there,
and the same seam is the one place to add the rest (audit, data-classification) so
no producer can skip it. The
[day-one](day-one.md) and [disposability-requires-a-ledger](disposability-requires-a-ledger.md)
decisions carry the binding detail; this vision doc is the intent they serve: build
the one-time framework cost so the per-vertical, per-feature cost collapses toward
zero.

## Who it's for

- **Primary — the Operational Analyst.** Works in operations, logistics, HR, or
  administration; exports from internal systems (CRM, ERP, ticketing); has Excel
  skills but no Python/SQL; needs reports/dashboards from messy data. The founding
  example: a road-assistance coordinator working dossier/temps/ressources exports.
- **Secondary — the Student Researcher.** Has a public or academic dataset; needs
  a quick quality check before analysis in R or SPSS.
- **Out of scope (for now):** data engineers who can just use Polars/pandas;
  real-time/streaming data; live database connections (direct-DB connectors are a
  far-future roadmap item — today RedPash works on file snapshots).

## Market & language strategy

RedPash launches English + French — French because of the founding context
(French road-assistance data), English as the global default. Both markets have a
large base of non-technical data workers in regulated industries (healthcare,
insurance, transport, public sector). The next wave targets Mandarin, Russian, and
Swahili, with Swahili aimed deliberately at the fast-growing, underserved East
African SME market. The `locale` column on `users` is already pre-staged for this
(`text NOT NULL DEFAULT 'en'`); multilingual strings are a later phase. The wider
GTM bet is **Africa-first** — an enterprise *desktop* ETL/ELT tool
(Informatica/dbt/Fivetran class) for connectivity-constrained, data-sovereign
enterprises, which is exactly what the offline-capable, compute-on-device engine is
built to serve. (That frugality — everything from a fresh clone, no daemon/job
queue/CI service — is itself a feature; see
[disposability-requires-a-ledger](disposability-requires-a-ledger.md).)

## Design philosophy (the rules these bets imply)

- **Guided over powerful** — fewer features, every one labelled in plain language.
- **Honest about state** — the quality report is immediate; nothing is hidden or
  silently fixed; the user always knows their data's state.
- **Progressive** — one CSV gets a simple experience; multiple related files
  surface the join workflow. Complexity appears only when the data demands it.
- **Server-rendered where it matters** — vanilla JS, no bundler in dev, pages load
  on first paint. ECharts (self-hosted, not a CDN) is the one heavy dependency, and
  only for chart kinds.
- **Mobile-first where it counts** — upload/review/clean flows target a tablet;
  phones get an honest "use a bigger screen" prompt rather than a degraded app.

## What RedPash is NOT

Not a BI platform (Tableau/Power BI/Metabase exist for that); not a data warehouse
or database (it works on file snapshots, not live data); not an AI that cleans
automatically (the user owns every decision). Pricing — freemium + one-time pass +
subscription — is a planned business-model intent, not a shipped system: today the
`plan` column on `users` is set server-side only (`text NOT NULL DEFAULT 'free'`,
billing wires later) and there is no billing integration. Treat any tier table as
direction, not a contract the code honours.

## Source files

- [`backend/crates/data/src/lib.rs`](../../backend/crates/data/src/lib.rs) — the
  pure-compute `data` crate: the io/http/threads/time-free engine that is bet 1
  (one engine, two surfaces; `tools/purity-check.sh` gates the wasm32 build).
- [`backend/crates/data/src/joins.rs`](../../backend/crates/data/src/joins.rs) — the
  overlap-coefficient join detector behind the join wizard.
- [`backend/crates/data/src/wasm.rs`](../../backend/crates/data/src/wasm.rs) — the
  wasm-bindgen boundary: the same engine functions the server calls, in the browser
  (the data-governance bet).
- [`frontend/framework/engine/wasm-engine.js`](../../frontend/framework/engine/wasm-engine.js)
  and
  [`frontend/framework/engine/engine-worker.js`](../../frontend/framework/engine/engine-worker.js)
  — the JS surface that drives the wasm engine off the main thread.
- [`backend/crates/api/src/pipeline.rs`](../../backend/crates/api/src/pipeline.rs)
  (`upload_csv`) — the RBAC-enforced framework upload path; the concrete proof of
  bet 2.
- [`backend/migrations/20260612000000_init.sql`](../../backend/migrations/20260612000000_init.sql)
  (`users`) — the pre-staged `locale` and `plan` columns the market/pricing
  strategy is typed against.

For the deeper code narrative: the engine doc
[`../internal/code/backend/data-engine.md`](../internal/code/backend/data-engine.md),
the route doc [`../internal/code/backend/api-routes.md`](../internal/code/backend/api-routes.md),
and the cleaner-flow doc [`../internal/code/frontend/data-cleaner.md`](../internal/code/frontend/data-cleaner.md).
