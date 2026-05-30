---
title: Vision
section: Start here
order: 2
last modified date: 2026-05-16
---

# RedPash — Product Vision & Intent

> Originally drafted under the ClarNa name; product renamed to
> RedPash. The substance of the vision is unchanged.

## The problem

Data is everywhere. The people who understand it best — operations
staff, field analysts, researchers, small business owners — are
rarely the ones who can clean it.

A road-assistance coordinator knows that `"???"` in the
`Assistance.ou.Administratif` column means bad data entry. She knows
the file should have 101 234 rows because she exported it herself.
But she cannot write `df.dropna()` or `df[df['col'] != '???']`. She
cannot detect that the file is Latin-1 encoded, or that
`date.de.survenance` mixes `YYYY/MM/DD` with bare `YYYY`.

She opens the file in Excel, manually scrolls through 100k rows, and
guesses.

RedPash exists to close that gap.

---

## The vision

**RedPash is the tool non-technical users reach for the moment they
have a CSV they don't fully trust.**

Not a BI tool. Not a notebook. Not a spreadsheet.

A focused, guided workflow that takes a user from raw file to clean,
visualisable data — without requiring them to know what a DataFrame
is.

The three-step promise:

1. **Upload** — drop your file(s), get an instant quality report.
2. **Clean** — fix issues through plain-language tools, not code.
3. **Visualise** — turn clean data into a shareable chart in one step.

---

## Core insight: the join problem

Most RedPash users will arrive with a single CSV. The cleaning
workflow is straightforward for them.

But a meaningful subset arrives with 2–3 related files they've
exported from different systems — a case file, a time log, a staffing
roster — and they want to understand the relationship between them.
In the real world this is a `pd.merge`. In RedPash it's a guided
join wizard powered by the **overlap-coefficient detector** in
`data::joins`.

The join workflow is the feature that elevates RedPash from "a simple
data cleaner" to "the tool that democratises multi-file analysis." It
should feel like filling out a form, not writing SQL.

---

## Who it's for

**Primary persona — The Operational Analyst**

- Works in operations, logistics, HR, or administration.
- Exports data from internal systems (CRM, ERP, ticketing tools).
- Has Excel skills but no Python/SQL.
- Needs to produce reports or dashboards — but the data is messy.
- Example: a road-assistance coordinator working with
  dossier/temps/ressources exports.

**Secondary persona — The Student Researcher**

- Has a dataset from a public source or academic survey.
- Needs to clean before running analysis in R or SPSS.
- Wants a quick quality check before handing off to a statistician.

**Out of scope (for now)**

- Data engineers who can just use Polars / pandas.
- Real-time or streaming data.
- Databases — RedPash works with file exports, not live connections.

---

## Why Rust + Polars

The 2024 all-JS prototype (`redpash-demo`) crashed at ~921k rows
because every row crossed the wire. RedPash 2026+ keeps the
DataFrame on the server — the browser only ever receives the current
page (25 rows by default). Group-by, sort, filter, search,
aggregation, and Top-N filtering all happen against a Polars
LazyFrame cached in the api crate.

Polars 0.43 is the right size for this: fast enough to feel
instantaneous, small enough to compile into the binary, and the lazy
API maps naturally onto the report-builder's spec model.

---

## Language & market strategy

RedPash launches in English and French. This is intentional:

- French is the language of the founding context (French
  road-assistance operations data).
- English covers the global default.
- Both markets have a large base of non-technical data workers in
  regulated industries (healthcare, insurance, transport, public
  sector).

Next wave: Mandarin, Russian, Swahili. Swahili specifically targets
the fast-growing East African tech and SME market — an underserved
population with high mobile usage and growing data-literacy needs.

The frontend `locale` field on `users` is already typed for this;
multilingual strings ship with Phase 4c.

---

## Design philosophy

**Guided over powerful.** RedPash does fewer things than Polars.
Every feature in the UI has a plain-language label. No raw code is
ever exposed to the user.

**Honest about state.** The quality report is shown immediately on
upload. Issues are never hidden or auto-fixed silently. The user
always knows the state of their data.

**Mobile-first where it counts.** The upload, review, and cleaning
flows are designed to work on a tablet. Phones get a "use a bigger
screen" prompt — RedPash is not a phone app and is honest about it.

**Progressive.** A user with one CSV gets a simple, clean
experience. A user with three related CSVs gets the join workflow.
The complexity surfaces only when the data requires it.

**Server-rendered where it matters.** The frontend is vanilla JS, no
bundler in dev. Pages load on first paint. The chart kinds are the only piece
that pulls in a heavy library (ECharts) — self-hosted at
`/vendor/echarts/`, not a CDN.

---

## What RedPash is NOT

- Not a BI platform — Tableau, Power BI, and Metabase exist for that.
- Not a data warehouse or database — it works with file snapshots.
- Not an AI that cleans automatically — the user stays in control of
  every decision.

---

## Business model & pricing (planned)

Freemium + one-time pass + subscription, designed to remove friction
at every entry point.

| Tier | Price | Limits | Target |
|---|---|---|---|
| Free | €0 | 3 projects, 5 files/project, CSV export only | Acquisition; all new users start here |
| 2-Week Pass | €10 once | 10 projects, unlimited files, all exports | One-off projects; team evaluation |
| Pro (annual) | €8.99/month (€107.88/yr) | Unlimited everything | Regular users; best unit economics |
| Pro (monthly) | €12.99/month | Unlimited everything | Flexibility seekers; no lock-in |
| Enterprise | Contact us | Bulk licences | Organisations buying for a team |

**New-subscriber offer:** Free accounts receive a full-featured
30-day trial (no limits) so users experience the complete product
before hitting the free-tier ceiling.

**Pricing rationale:**

- The free tier must be **genuinely useful** (not crippled). Users
  who export one CSV per month may never convert, and that's
  acceptable. Word-of-mouth from satisfied free users is valuable.
- The 2-Week Pass exists specifically for the consultant, student,
  or operations manager who has *one* project to do right now and no
  intention of subscribing. Forcing them into a subscription creates
  churn and support cost.
- Annual pricing at €8.99/month is aggressive for the European
  SME/operations market. It undercuts per-seat pricing in competing
  BI tools by 10–20×.

Billing integration (Stripe) lands with **Phase 6**. Today's `plan`
column on `users` is set server-side only.

---

## Success metrics

- A non-technical user can go from raw CSV upload to a visualised
  chart in **under 5 minutes**.
- The quality report correctly identifies all issue types in the
  reference dataset (the road-assistance dossier export).
- A user with 2+ files can successfully configure a join and preview
  the merged result without typing SQL.
- The app is installable as a PWA and works offline after first
  load.

---

## Roadmap

| Phase | Status | Scope |
|---|---|---|
| 1 — Foundation | ✅ Shipped | Cargo workspace, /api/health, router, page stubs, design tokens, service worker |
| 2 — Cleaner | ✅ Shipped | parse / dtype / dedup / joins / steps, redtable, cleaning tools sidebar, undo/redo, encoding detection |
| 3 — Reports & Dashboards | ✅ Shipped | Reports (group-by + matrix + filter + sort + Top-N + windows + chart authoring), Dashboards (chart-ref widgets) |
| 4a — Auth (OAuth flow) | ✅ Shipped | Google OAuth code flow, `rp_session` cookie |
| 4b — Auth (data scoping) | ✅ Shipped | Per-user data via `resolve_user_rid` |
| 4c — Auth (polish) | ✅ Mostly shipped | Per-resource ownership checks (`routes::ensure_owner` + `db::*_owner`), `PATCH /api/me`, Profile + Settings pages, logout button. Share-link UI for `is_public` toggles still pending. |
| 5 — Visualisation (advanced) | ⬜ Planned | Hierarchical (tree/sunburst), flow (Sankey), geo/map, candlestick — see [`features/charts.md`](features/charts.md) "Remaining kinds" |
| 6 — Payments | ⬜ Planned | Stripe integration for 2-Week Pass + Pro |
| 7 — Collaboration | ⬜ Planned | Shared projects, export to Google Sheets |
| 8 — Formats | ⬜ Planned | Excel + JSON + XML upload support |
| 9 — Deploy polish | ⬜ Planned | Bake frontend into the binary (`include_dir!`), brotli pre-compress, systemd unit |
