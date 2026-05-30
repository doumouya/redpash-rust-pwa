---
title: Internal · Code · Backend · shared — atomic docs for backend/crates/shared/src/
section: Internal · Code · Backend · shared
order: 9
last modified date: 2026-05-30
---

# shared crate — atomic docs

DTOs that travel over the wire. Pure types — no logic, no
side-effects, no HTTP. The api crate and (via wasm-bindgen) the
frontend both depend on this crate, so changes here ripple to both
sides of the JS↔Rust boundary. One file per resource.

**Coverage at baseline (2026-05-30):** 16 atomic units, 0 documented.

## Files

| File | Atomic doc | DTOs / surface |
|---|---|---|
| `lib.rs` | [lib.md](lib.md) | crate root, re-exports |
| `user.rs` | [user.md](user.md) | `UserProfile`, `UserPreferences` |
| `project.rs` | [project.md](project.md) | `ProjectSummary` |
| `file.rs` | [file.md](file.md) | `FileSummary`, `ColumnMeta`, `PageQuery`, `Row` |
| `step.rs` | [step.md](step.md) | `ProjectStep`, `StepRequest` |
| `filter.rs` | [filter.md](filter.md) | `FilterNode` (Group/Leaf), `FilterOp`, `FilterSpec` |
| `report.rs` | [report.md](report.md) | `ReportSpec`, `Aggregation`, `AggFn`, `SortSpec`, `TopNFilter`, `WindowSpec` (no `Report` entity — derived view) |
| `dashboard.rs` | [dashboard.md](dashboard.md) | `DashboardSpec`, `Widget` |
| `chart.rs` | [chart.md](chart.md) | `ChartSpec` |
| `company.rs` | [company.md](company.md) | `Company`, `CompanyMember`, `CompanySummary` |
| `case.rs` | [case.md](case.md) | `Case`, `Comment`, status / priority / type enums |
| `event.rs` | [event.md](event.md) | `Event` capture DTO |
| `monitoring.rs` | [monitoring.md](monitoring.md) | request/event/run/finding stats DTOs |
| `search.rs` | [search.md](search.md) | omnisearch result DTOs |
| `admin.rs` | [admin.md](admin.md) | admin-page DTOs (users/companies/files/steps stats) |
| `optimization.rs` | [optimization.md](optimization.md) | `OptimizationPoint` + measurement DTOs |

## Related

- [Backend pillar landing](../index.md)
- [Architecture: js-rust-boundary](../../../architecture/js-rust-boundary.md) — DTOs ARE the boundary
- [Architecture: object-model](../../../architecture/object-model.md) — the locked 2-entity model
- [Spec: filter-dto](../../../specs/filter-dto.md)
