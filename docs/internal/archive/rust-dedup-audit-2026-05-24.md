---
title: Rust dedup audit — 2026-05-24
section: Internal
order: 91
last modified date: 2026-05-24
superseded-by: tools/rs-audit/ — recurring audit replaces the one-shot review
---

# Rust dedup audit — 2026-05-24

One-shot survey of the api crate looking for repeating patterns that
could be decomposed into reusable, parameterized helpers. Goal: a
finite list of abstractions with measured ROI, not an open-ended
refactor (see [[refactor-decompose]] memory).

**Method.** Scanned `crates/api/src/` (~13.5k LOC) for 11 specific
patterns I had hypotheses about, then folded in counter-evidence
("what NOT to extract"). All numbers + file:line citations from
the survey.

---

## Quick wins — ship these

Three patterns are clearly worth extracting. Combined ~330 LOC
saved, all low-risk, all already-tested locally as one-off
inline equivalents.

### A. `.map_err(|e| AppError::internal("db", e.to_string()))?` — **134 occurrences**

Every fallible sqlx call has this boilerplate. Concentrated:
- `routes/admin.rs` — 32
- `routes/monitoring.rs` — 27
- `routes/files.rs` — 28
- everywhere else — 47

**Proposed helper** (in `routes/mod.rs` or `error.rs`):

```rust
pub fn db_err(e: sqlx::Error) -> AppError {
    AppError::internal("db", e.to_string())
}
```

Then `.map_err(db_err)?` everywhere. ~5–8 LOC per site × 134 ≈
**200 LOC saved**.

Even cleaner: a `From<sqlx::Error> for AppError` impl, then the
`?` works directly. Costs us the `"db"` kind label (we'd need a
distinct kind per source — `sqlx::Error::RowNotFound` could map
to `not_found`, others to `internal_db`). Worth doing; matches
the discipline pattern in [[no-code-debt]].

### B. Count(\*) scalar queries — **43 occurrences**

`SELECT COUNT(*)::BIGINT FROM <table> [WHERE …]` chained with
`.fetch_one().await.map_err(db_err)?`.

**Proposed helper** (in `db.rs`):

```rust
pub async fn count_total(pool: &PgPool, table: &str) -> sqlx::Result<i64> {
    sqlx::query_scalar(&format!("SELECT COUNT(*)::BIGINT FROM {}", table))
        .fetch_one(pool).await
}
```

Plus a sibling `count_where` with a `WHERE` fragment. ~3 LOC per
site × 43 ≈ **100 LOC saved**.

**Risk note**: `format!()` on table names looks like SQL injection
territory. Safe here because every caller passes a string literal;
we'd add a `#[doc] // table must be a literal, never user input`
comment. Reviewable in PR.

### C. `paginate()` + `build_page()` duplicated across two files — **2 definitions**

Identical 12-line `paginate()` in `admin.rs:100` and `monitoring.rs:124`.
Same for `build_page<T>`. ~12 LOC saved + one source of truth.

**Proposed**: move both to `routes/pagination.rs`, `pub use` from
`routes/mod.rs`. Trivial. Low risk because the code is already
identical; deletion is the entire diff.

---

## Already optimal — leave them

Three patterns I expected to be problems are actually well-factored.
Don't touch.

- **`group_count(pool, query)`** — extracted at `admin.rs:607`, 6
  call sites including one cross-module (monitoring uses it). Sharing
  works.
- **`ensure_owner(...)`** — single helper at `routes/mod.rs:57`,
  32 call sites across files/projects/charts/dashboards. The
  per-resource error label is the only variation and is passed in.
- **`window_cutoff(label)`** + `bucket_interval(label)` — single
  helpers in `monitoring.rs`, 5 call sites. The vocabulary
  (`1h|24h|7d|30d`) is stable; nothing else uses it; cross-crate
  lifting isn't justified.

---

## Considered + declined

Five patterns LOOK like duplication but the variation is load-bearing.
Extracting these would add abstraction tax for marginal gain — and in
two cases would actively obscure intent.

### Optional-filter WHERE clauses — 42 occurrences

`WHERE ($1::text IS NULL OR col = $1) AND ($2::ts IS NULL OR …)`.
The clauses look identical at a glance, but the *types* and *JOINs*
vary per handler (`text`, `timestamptz`, sometimes nested JOIN on
`memberships` for scope-based queries — see `admin.rs:327-351`).
A generic builder would either over-fit one shape or bloat the call
sites with `.and_filter("col", value)` chains.

**Decision**: revisit only when a second surface with an identical
filter set lands.

### Row → DTO `.try_get()` chains — 10 instances

`rows.into_iter().map(|r| Summary { field: r.try_get(...), ... })`.
Each DTO differs in field count and type (UserSummary: 12 fields,
CompanySummary: 5). Macro would need per-DTO templates; the win is
~20 LOC for substantial abstraction tax + audit difficulty.

**Decision**: stays inline. Audit-friendly by design.

### `From<XRow> for X { ... }` conversions in db.rs — 7 impls

Same shape: field-by-field map. ~85 LOC total. A derive macro
(e.g. `derive_more::Into`) would help but adds a dep + obscures
which fields ship over the wire. Reviewability wins.

**Decision**: stays as-is.

### COALESCE sparse PATCH SQL — 5 functions

`UPDATE T SET col = COALESCE($n, col), …`. 5 update fns in db.rs
share the shape but the column lists vary 2–11 entries.
SQL-generation macro would save ~10 LOC at the cost of every
update fn becoming opaque to grep-for-column-name.

**Decision**: keep inline. The 11-COALESCE `update_user` is the
worst offender at 12 LOC; not bad enough to abstract.

### Stats DTOs (`UserStats`, `FileStats`, `ChartStats`, …) — 6 structs

All share `{ total, by_X, last_Y }` shape but field names + meanings
are domain-specific (`active_7d` vs `with_projects` vs
`avg_cleanness`). A `StatsTemplate<T>` generic would bitrot — every
addition would pollute every other surface.

**Decision**: keep distinct. The wire-shape stability matters more
than the impl-side dedup.

---

## Summary table

| # | Pattern | N | LOC | Difficulty | Decision |
|---|---|---|---|---|---|
| A | `.map_err(db_err)?` (or `From<sqlx::Error>`) | 134 | ~200 | low | **Ship** |
| B | `count_total` / `count_where` helpers | 43 | ~100 | low | **Ship** |
| C | Move pagination helpers to shared module | 2 defs | ~12 | trivial | **Ship** |
| – | `group_count` | 6 | – | – | ✓ done |
| – | `ensure_owner` | 32 | – | – | ✓ done |
| – | `window_cutoff` / `bucket_interval` | 5 | – | – | ✓ done |
| ✗ | Optional-filter WHERE | 42 | ~120 | medium | declined (variation load-bearing) |
| ✗ | Row → DTO try_get | 10 | ~20 | medium | declined (audit cost) |
| ✗ | `From<Row>` impls | 7 | ~30 | high (macro) | declined (dep risk) |
| ✗ | COALESCE PATCH SQL | 5 | ~10 | high | declined (grep cost) |
| ✗ | Stats DTOs genericize | 6 | – | high | declined (domain variation) |

**Aggregate quick-win**: ~330 LOC saved across the three "ship"
items, all low-risk, all reviewable in a single PR.

---

## Next steps

A, B, C can land as three separate commits in one session — `~330
LOC` net deletion, no behaviour change. If Em greenlights, the
order I'd ship them:

1. **C first** — pagination dedup. Trivial; flushes the simplest
   duplication.
2. **A second** — `db_err` helper (then optional `From<sqlx::Error>`
   follow-up). High volume, mechanical, easy to review.
3. **B third** — count helpers. Lower volume than A; benefits from
   landing after `db_err` so the helper signatures stay tight
   (`pub async fn count_total(...) -> sqlx::Result<i64>` then the
   call site does `.map_err(db_err)?`).

— Gus, audit run 2026-05-24
