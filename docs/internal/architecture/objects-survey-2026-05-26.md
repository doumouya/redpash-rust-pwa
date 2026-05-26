---
title: Objects survey — 2026-05-26 snapshot
section: Internal
order: 11
last modified date: 2026-05-26
owner: Woz
status: snapshot — not a locking doc; rerun + supersede
---

# Objects survey — 2026-05-26

> **Snapshot, not a contract.** [`object-model`](object-model.md) is
> the locked contract; this doc is a point-in-time read of the
> [`shared`](../../../backend/crates/shared/src/) crate against it.
> Tally the good, flag the drift, name the gap. Rerun + supersede when
> the next big object-layer move lands.

## Headline

**16 DTO modules surveyed. 12 clean, 4 carry drift, 0 broken.** The
drift is all *doc-string drift* — comments still describe the
pre-2026-05-22 world (Reports as an entity, prefs as a JSONB column on
users, `report_id+chart_index` widget refs). Wire shapes themselves
match the locked model.

Pattern that earned the win: every Summary in `admin.rs` /
`monitoring.rs` opens with a `NOT a duplicate of …` comment naming
the per-resource DTO it deliberately differs from. The friction of
having to write that line is what kept the projections honest.

## Tally

| Module | Lines | DTOs | State | Note |
|---|---:|---:|---|---|
| `project.rs`      |  34 | 2 | ✅ clean | `ProjectSummary` + `ProjectDetail` (flatten). Owner + company hydrated as joined fields. |
| `file.rs`         |  78 | 4 | ✅ clean | `FileSummary` + `ColumnMeta` + `PageQuery` + `Row`. `semantic_dtype` vs `dtype` doc is exemplary. |
| `step.rs`         |  29 | 2 | ✅ clean | Smallest module, sharpest header. `kind: String` is a deliberate evolvability choice. |
| `case.rs`         | 151 | 7 | ✅ clean | Best documentation in the crate. Per-field comments explain *why* the field exists, not what. `CaseDetail` composes `Case` + `Vec<Comment>` + `Vec<Event>` — no parallel History DTO. |
| `event.rs`        |  48 | 2 | ✅ clean | `Event` vs `EventReport` split is the textbook server-trust-boundary pattern. |
| `company.rs`      |  47 | 3 | ✅ clean | `Company` (record) + `CompanySummary` (flatten + `my_role`) + `CompanyMember` (member-of join). Cleanest Summary pattern in the crate. |
| `filter.rs`       | 105 | 4 | ✅ clean | The drift-reconciliation comment (lines 55–63) is the kind of "what we fixed and why" docstring [[no-mystery-css]] wishes every shared atom carried. |
| `search.rs`       |  45 | 2 | ✅ clean | `SearchResult.hash` — backend names the destination, FE just goes there. Routing rules don't bake into JS. |
| `optimization.rs` |  37 | 1 | ✅ clean | Static prose + live measurement on one row. Server evaluates `current_value` + `tipped` on every fetch. |
| `admin.rs`        | 196 | 6 | ✅ clean | The "NOT a duplicate of" disclaimer (lines 13–19) names what `UserSummary` adds over `UserProfile` — that's the pattern to lift everywhere. |
| `monitoring.rs`   | 211 | 8 | ✅ clean | Same "list-projection" framing as admin. `EventSummary` strips the heavy JSONB; detail lives behind `/api/events/:rid`. |
| `lib.rs`          |  68 | 3 | 🟡 minor | `Page<T>` doc-comment lists `"(files, reports, …)"` — the `reports` endpoint is retired per mig 018. One word fix. |
| `chart.rs`        |  34 | 2 | 🟡 drift | Header says "authored on the Reports page" — surface is **Designer** per [D4](object-model.md). `Chart` carries owner_*? No — no Summary projection (`admin.rs` carries `ChartSummary` instead, but split is unannotated). |
| `dashboard.rs`    |  74 | 3 | 🟡 drift | `Widget.kind` doc lists `'report'` as a valid kind (line 54). Plus `Dashboard` mixes owner_* hydration into the record (vs `Project` / `Company` keeping hydration on the Summary subtype). |
| `report.rs`       | 245 |10 | 🟡 drift | Header is honest ("There is no stored Report entity"), but `ReportSpec.charts` doc (lines 45–48) still references the retired `report_id + chart_index` widget-pairing pattern. Charts now have CHT_ ids; dashboards reference them via `chart_id` directly. |
| `user.rs`         |  49 | 3 | 🟡 drift | `prefs: serde_json::Value` is documented as a stored blob, but mig 024 dropped `users.prefs` — field is now a read-projection merged from `user_preferences` at `/api/me`. Plus `organisation` (free-text) is what `admin.rs:35` already calls "legacy in favor of memberships". |

12 ✅ · 4 🟡 · 0 ❌

## The four drift signals — fix shapes

Each is a comment-only fix (no code, no migration). Land as one
`docs+shared: comment refresh` commit per [[comments-truthful]] —
the wire shapes are correct, only the prose lags.

**1. `chart.rs:4` — "Reports page" → "Designer surface"**

```diff
-//! A saved chart is a self-contained visualisation authored on the
-//! Reports page. It is persisted as a chart-typed `project_files` row;
+//! A saved chart is a self-contained visualisation authored on the
+//! Designer surface ([D4](docs/objects/object-model.md#decision-record)).
+//! Persisted as a chart-typed `project_files` row;
```

**2. `dashboard.rs:54` — drop `'report'` from the Widget kind list**

```diff
-    /// `chart` | `kpi` | `table` | `text` | `report`.
+    /// `chart` | `kpi` | `table` | `text`. (The retired `'report'` widget
+    /// kind was folded into `chart` by [D4](docs/objects/object-model.md).)
     pub kind: String,
```

**3. `report.rs:45–48` — retire the `report_id+chart_index` widget pairing**

```diff
-    /// Charts authored alongside this report. Each plots two columns
-    /// of the subtotals output. Dashboards reference these by index
-    /// (`report_id` + `chart_index`) so the chart definition lives
-    /// next to the data shape it depends on.
+    /// Charts authored alongside this grouping spec. Each plots two
+    /// columns of the subtotals output. When saved, each becomes a
+    /// chart-typed `project_files` row with its own CHT_ id; dashboards
+    /// then reference them by `chart_id` directly (D1).
```

**4. `user.rs:3–5` — `prefs` is a read-projection, not a stored blob**

```diff
-//! Mirrors `core.UserProfile` from the Django side. The `prefs` JSON
-//! blob holds everything that doesn't deserve a column (theme, accent
-//! hue, default rows-per-page, …) — keep it small but free-form.
+//! Mirrors `core.UserProfile` from the Django side. The `prefs` field
+//! is a read-projection — at the schema level, prefs live in their own
+//! `user_preferences` table (mig 023; mig 024 dropped the `users.prefs`
+//! column). `/api/me` merges them into this DTO; writes go through
+//! `PATCH /api/me/prefs` (`PrefsPatch`). Sparse-keyed, free-form blob
+//! on the wire.
```

Tiny `lib.rs` cleanup goes in the same commit:

```diff
-/// One page of a paginated result. Returned by every `…/page` endpoint
-/// (files, reports, …). `rows` is generic so each resource can pick its
+/// One page of a paginated result. Returned by every `…/page` endpoint
+/// (files, monitoring lists, admin lists, …). `rows` is generic …
```

## Missing or thin

Things the DB / API models that don't have a first-class typed DTO:

- **Sentinel submissions** — `sentinel_submissions` table (mig 010)
  + `global_sentinels` view. No DTO. The route reads via raw sqlx
  + `serde_json`. If the feature stays — promote.
- **User preferences** — `user_preferences` table is real; the wire
  shape is `PrefsPatch { prefs: serde_json::Value }`. No typed
  `UserPreferences { theme, density, rows_per_page, … }`. Free-form
  is the deliberate choice (see [`user-preferences.md`](../specs/user-preferences.md)),
  but means every consumer re-parses the keys. Worth a typed read
  view if the key-set stabilises.
- **`ChartSummary`** — admin.rs has it but chart.rs doesn't. The
  cross-module split is fine *if annotated* — drop the
  "NOT a duplicate of" disclaimer into `chart.rs` so future readers
  don't reach for `Chart` when they want the list shape.

## Promotable patterns

What the 12 clean modules already do that the 4 rough ones should lift:

- **Summary subtype with `#[serde(flatten)]` over the record.** Used
  in `project.rs` (`ProjectDetail`), `company.rs` (`CompanySummary`),
  cleanly separates "stored shape" from "list/detail projection".
  `dashboard.rs` should split — `Dashboard` (stored) +
  `DashboardSummary` (hydrated owner_* + member projection) instead
  of `Option<owner_*>` on the record.
- **"NOT a duplicate of" disclaimer.** `admin.rs` lines 13–19 names
  the sibling DTOs it deliberately diverges from. Friction of having
  to write the disclaimer is what stopped the parallel-class leak
  in DTO form. Adopt it in every module that ships a Summary.
- **Hydration source comment per joined field.** `case.rs`
  reporter_display_name + assignee_display_name + category_* fields
  each get a one-line "Hydrated server-side via LEFT JOIN users.
  Null when ON DELETE SET NULL." Future readers learn the lifecycle
  in passing.
- **`#[serde(default)]` on every projection-only field.** Already
  uniform; mentioned here so it stays uniform. Single-row fetchers
  that skip the join return `None`; list fetchers populate. Either
  way the DTO deserialises.
- **`kind: String` over a Rust enum for evolving vocabularies.**
  `step.rs`, `event.rs`, `case.rs` all do this — the data crate
  pattern-matches on known values, the DTO doesn't have to ship a
  schema migration for every new variant. Frontend reads `kind` as
  an opaque tag.

## Next moves

1. **Comment-refresh commit** — land the four diffs above (+ the
   `lib.rs` one). Single commit, area `docs+shared`, one coherent
   change per [[commit-convention]]. ~10 LOC. No wire change.
2. **`ChartSummary` annotation** — three-line "NOT a duplicate of"
   header on `chart.rs` pointing at `admin::ChartSummary`. Same commit.
3. **Audit-tool follow-up (proposed, not built yet)** —
   `tools/objects-audit/audit.js` that greps `shared::*.rs` doc
   comments against the locked object-model vocabulary (retired
   words: `RPT_`, `DSH_`, "reports table", "dashboards table",
   `report_id`, `users.prefs`, "Reports page" outside of historical
   context). Emit `audit.json` + `audit.html` per the tool suite
   convention; persist to `audit.run` / `audit.finding`. Per
   [[build-tools-proactively]] + [[audit-everything]]: encode the
   rule once so the next drift fails the tool, not the user.
4. **`Dashboard` summary split** — extract `DashboardSummary` with
   the owner_* hydration; keep `Dashboard` as the stored record.
   Frontend already treats them separately at the call sites;
   the DTO is the only place mixing concerns. Defer until the
   Publisher surface is touched next — bundle with that pass.

## Out of scope

- The `data` crate's internal types (Polars `DataFrame`, `FileEntry`,
  `StepKind` enum) — those don't cross the wire and aren't part of
  this survey.
- The frontend's mirror types (`ColumnMeta`, `FileSummary` consumed
  in JS) — they read from the same `shared` definitions; no separate
  surface to audit.
- The DB schema itself — covered by [`db/schema.md`](../../db/schema.md).
- Migration ordering — covered by [`REDMAP`](../../REDMAP.md#migrations).

## See also

- [object-model](object-model.md) — the locked contract this survey
  reads against.
- [data-shape-index](data-shape-index.md) — sister architecture doc;
  data-plane abstraction, complementary to this control-plane DTO
  view.
