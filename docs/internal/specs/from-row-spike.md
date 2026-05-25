---
title: FromRow spike — threshold finding
section: Internal
order: 37
last modified date: 2026-05-25
owner: Torv
status: filled
---

# FromRow spike — threshold finding

The rs-audit pattern catalog has flagged `row.try_get(_) DTO mapping`
as a **declined** pattern with growing hits — 148 → 171 across the
last three audit runs, well past the 20-hit revisit threshold.
Gus's recommendation (Woz.md, 2026-05-25 18:57) was to spike a
real DTO migration to `sqlx::FromRow` and determine the **threshold
N** at which the FromRow rollout repays its boilerplate cost.

This doc captures the measurements and the resulting recommendation.

---

## Spike #1 — `UserSummary` (1 construction site)

`UserSummary` lives in `shared::admin::UserSummary` with one
construction site at `routes/admin.rs:250` (12-field inline map
inside `list_users`'s row → DTO closure).

**Hypothetical migration shape** (not executed — would require
adding `sqlx` as a feature-gated optional dep to `shared/`, or a
private `*Row` struct in `api` matching the established pattern
for `UserRow` / `FileRow` / `ChartRow` in `db.rs`):

```rust
// Path A — in api/src/db.rs, matching the existing convention
#[derive(FromRow)]
struct UserSummaryRow { /* 12 fields */ }
impl From<UserSummaryRow> for UserSummary { /* 12 field copies */ }

// usage in admin.rs
let rows: Vec<UserSummaryRow> = sqlx::query_as(&sql)
    .bind(...).fetch_all(&state.db).await?;
let rows: Vec<UserSummary> = rows.into_iter().map(Into::into).collect();
```

**Measurement (without running cargo)**:

- Current inline closure: 12-line map inside the `let rows: Vec<UserSummary> = rows.into_iter().map(|r| UserSummary { … }).collect();` block.
- Proposed: 14-line `UserSummaryRow` struct + 14-line `impl From` + ~2-line caller change. **Net +18 LOC.**
- Audit hits retired: 12 `r.try_get("…")` calls → 0. **Δ = −12 hits** out of 171 (~7%).

Result: paused at **N=1 construction site** with a negative
LOC verdict. Worth the audit-hit reduction only if N is high enough
that the From impl boilerplate amortizes.

---

## Spike #2 — `ProjectSummary` (1 centralized helper, 2 callers)

`ProjectSummary` already has a manual helper `row_to_project()`
in `db.rs:595-612` (15 LOC, called from `list_projects` +
`get_project`). So the rollout target isn't "N inline map blocks
in route handlers" — it's "one centralized helper that already
exists".

**Actual migration**:

```rust
#[derive(FromRow)]
struct ProjectRow {
    redpash_id:         String,
    name:               String,
    description:        Option<String>,
    file_count:         i64,                // db returns BIGINT; coerce in From
    stage:              String,
    status:             String,
    is_default:         bool,
    owner_id:           String,
    owner_display_name: String,
    owner_username:     String,
    company_id:         Option<String>,
    created_at:         DateTime<Utc>,
    updated_at:         DateTime<Utc>,
}
impl From<ProjectRow> for ProjectSummary {
    fn from(r: ProjectRow) -> Self {
        Self {
            redpash_id:         r.redpash_id,
            name:               r.name,
            description:        r.description,
            file_count:         r.file_count.max(0) as u32,
            cleanness_pct:      None,
            stage:              r.stage,
            status:             r.status,
            is_default:         r.is_default,
            owner_id:           r.owner_id,
            owner_display_name: r.owner_display_name,
            owner_username:     r.owner_username,
            company_id:         r.company_id,
            created_at:         r.created_at,
            updated_at:         r.updated_at,
        }
    }
}
// callers gain explicit type annotation
let rows: Vec<ProjectRow> = sqlx::query_as(&sql)…
Ok(rows.into_iter().map(Into::into).collect())
```

**Measurement** (`cargo check -p api` clean, run 2026-05-25 ~19:05):

| Metric                                          | Before | After | Δ |
|---|---|---|---|
| LOC in `db.rs` for ProjectSummary mapping       | 15+2  | 33+2 | **+18** |
| `row.try_get(_) DTO mapping` audit hits         | 171   | 170  | **−1**  |
| `repeated-lines (≥4×)` redundant lines          | 1233  | 1252 | **+19** |
| `cargo check -p api`                            | clean | clean | — |

The migration **added repeated lines** because the `From<ProjectRow>
for ProjectSummary` impl is itself the canonical repeat pattern the
audit catches (`Self { redpash_id: r.redpash_id, name: r.name, …}`
is the same shape across `UserRow → UserProfile`, `FileRow →
FileFull`, `ChartRow → Chart`).

**Verdict**: REVERTED. The migration is documented here for
future readers; not shipped to `prerelease`.

---

## Why FromRow doesn't repay in this codebase

Every existing `*Row → DTO` conversion needs an `impl From<*Row>`
because:

1. **Type mismatches** — Postgres returns BIGINT (`i64`) and
   INTEGER (`i32`); RedPash DTOs use `u32` / `u64` so the count
   subqueries deserialize cleanly into the wire shape. Each
   conversion is `r.field.max(0) as u32` or `r.field.map(|v| v as u64)`.
2. **Computed fields** — `cleanness_pct: None` on `ProjectSummary`
   (populated by hydrate, not the DB row); `memberships: Vec::new()`
   on `UserProfile`; `fully_null_rows: None` on `FileSummary`.
3. **Denormalization** — joined columns map to nested structs
   (`CompanySummary { company: Company { … } }`) or to renamed
   fields.

Each rules out `#[derive(FromRow)]` directly on the wire DTO; each
forces the `*Row` shadow type + `impl From` pattern. That pattern
**preserves** the row-to-DTO LOC roughly 1:1 (sometimes more, when
struct + impl boilerplate exceeds the inline map closure).

The audit pattern `row.try_get(_) DTO mapping` counts every
`r.try_get(…)` call site. The migration retires `try_get` calls
from `db.rs` but the From impl re-emits the same struct-field
copies that the manual helper had — same lines, different
location. **The redundant-lines counter increases**, not decreases.

## Recommendation

1. **Retire the `row.try_get(_) DTO mapping` declined-pattern
   entry from `tools/rs-audit/audit.js`**, OR re-frame the signal.
   The 171 hits aren't payable via FromRow rollout — they're
   structurally cheap, and any "reduction" rolls the same code
   into a sibling From impl.
2. **Keep FromRow where it already lands** (`UserRow`, `FileRow`,
   `ChartRow`) — the structural value is compile-time field-name
   validation on `query_as<_, *Row>`, not LOC reduction. Don't
   spread the pattern to DTOs that don't already need it.
3. **The real `row.try_get` reduction lever** is reducing the
   number of distinct DTOs we project per resource, not changing
   how each DTO is constructed. E.g.: the parallel
   `UserSummary` / `UserProfile` / `UserBadge` triplet → one DTO
   with optional fields would cut multiple From impls. That's a
   different refactor (wire-shape consolidation), not a FromRow
   rollout.

## Re-frame for the rs-audit pattern catalog

Suggested edit to `tools/rs-audit/audit.js` — change the entry from:

```js
{ name: 'row.try_get(_) DTO mapping', status: 'declined',
  notes: 'duplication exists but variation is load-bearing; …' }
```

to:

```js
{ name: 'row.try_get(_) DTO mapping', status: 'declined',
  notes: 'row.try_get is structurally cheap — FromRow doesn\'t \
          repay (see specs/from-row-spike.md). Track for the \
          DTO-consolidation refactor, not for FromRow rollout.' }
```

Or remove from the catalog entirely if the consensus is that the
signal is misleading enough to retire.

---

## Acknowledgments

Gus (Woz.md 18:57) caught the framing error in the v1 spike
("widen, don't park"); the deliverable is a threshold finding
plus the recommendation, not a yes/no on FromRow itself.
