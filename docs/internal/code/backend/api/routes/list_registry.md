---
title: backend/crates/api/src/routes/list_registry.rs
source: ../../../../../../backend/crates/api/src/routes/list_registry.rs
owner: Torv
section: Internal · Code · backend · api · routes
last modified date: 2026-06-08
---

# list_registry.rs

## Purpose

The **LIST provider registry** — reach-scoped delivery of a builtin object type's
rows for `GET /api/objects/:type`. Mirrors `codec_registry` / `validate_rules::
RuleRegistry` (the Providers pattern: `OnceLock<HashMap>` + `with_builtins` /
`register` / `get`), but the work is async + DB-touching — the async twin of
`Codec.validate`.

Architecture (Em, 2026-06-08 — "one engine, two surfaces"): the **server's job is
reach-scoped *delivery***; **shaping** (filter / search / sort / paginate) runs in
the data-engine wasm on the **client** (the Workspace `clientMode` precedent). So a
provider returns the caller's RBAC-reachable rows as a uniform `Page<Value>` and
does NOT honour the type's chips — those are client filters. `page/size/q/sort`
pass through only for the **over-cap server fallback**. A new builtin type = one
`register` call; **custom** types fall through to the `entity_data` default in
[objects.rs](objects.md). No central `match` — O(1) per new type
([[project-decades-of-innovation]]).

## Public surface

- `pub type ListFuture<'a>` — `Pin<Box<dyn Future<Output=Result<Page<Value>>> + Send + 'a>>`.
- `pub type ProviderFn` — `for<'a> fn(&AppState, &str /*caller*/, &AdminQuery, Option<&[String]> /*viewer*/) -> ListFuture`.
- `pub struct ListProvider { type_id, list }`, `pub struct ListProviderRegistry` (`new`/`with_builtins`/`register`/`get`).
- `pub fn registry() -> &'static ListProviderRegistry` — process-wide `OnceLock`, builtins seeded.

Builtin providers: `chart` (wraps the reach core `admin::charts_page`), `file`,
`company`, `team`, `user`, `membership`. `viewer = None` ⇒ admin (no reach
filter); `Some(principals)` ⇒ caller + teams (`routes::list_viewer`).

## Reach predicates (per object family)

- **chart / file** (project_files): member of the file's project OR its company
  (`m.object_redpash_id IN (f.project_redpash_id, p.company_id)`). `file` is DATA
  files only (`file_type NOT IN ('chart','dashboard')` — charts/dashboards are
  their own types).
- **company**: member of the company (`= c.redpash_id`). `team`: member of the
  team OR its company (`IN (t.redpash_id, t.company_id)`). Both carry `my_role`
  (caller's highest tier) via a per-row subquery on `caller`.
- **user**: company-share — the caller, plus anyone sharing a `CMP_` membership
  with the caller (admin ⇒ all). Mirrors `db::users::list_users`.
- **membership**: "my memberships" — `m.member_redpash_id = ANY(principals)` UNION-ed
  across all four scopes (project/company/case/team). NB: `membership` is not yet a
  registered `type_definitions` row, so `/api/objects/membership` 404s until S3
  registers it (it's an edge, not an entity — list-only).

## Drift-prone areas

- **`all_count` MUST be reach-scoped**, never `db::count_total` (a platform total) —
  else a tab KPI leaks the global count even when rows are scoped. Every provider
  computes `all_count` as the reach-only pre-search count.
- **`Page<Value>` row keys are the frontend contract.** Each provider serializes
  the proven `*Summary` struct (`to_value_page`), so the keys match the existing
  `/admin/*` tab column specs exactly. A renamed/missing `serde` key renders a
  blank cell silently — keep the Summary shapes in lockstep with the LIST_VIEWS specs.
- **Async fn-pointer bound:** providers are named `fn(..) -> ListFuture` returning
  `Box::pin(async move {…})` (not closures) — keeps the `for<'a> fn` coercion
  unambiguous. A provider holding a non-`Send` guard across `.await` breaks the bound.

## Related

- [routes/objects.rs](objects.md) — the generic handler that dispatches to a provider / entity_data.
- [routes/admin.rs](admin.md) — `charts_page` (the chart provider's reach core) + the `*Summary` shapes lifted by the other providers.
- [codec_registry](../codec_registry.md) · [validate_rules](../validate_rules.md) — the registry pattern this mirrors.
- [admin-scope-audit](../../tools/audit-suite/admin-scope-audit.md) — the gate that drives the user-surface repoint to these endpoints.
