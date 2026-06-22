# 0022 — De-admin-scope user surfaces: one engine, two surfaces

Historical reasoning record. The leak class below lived in the **predecessor**
(the original `redpash-rust-pwa`, the reference the lean rebuild ports from): user
pages read platform-admin list endpoints. The lean tree closes it **by
construction** — there are no `/admin/*` list endpoints to leak, every user list
flows through the reach-scoped registry, and the server-driven rail reuses the
*same* reach. This runbook preserves the WHY (the "one engine, two surfaces"
architecture Em locked on 2026-06-08) and records which staged pieces shipped vs
deferred against the lean tree.

Source on lean:
[`objects.rs`](../../../backend/crates/api/src/objects.rs) (the generic
`GET /api/objects/:type` reach-scoped list),
[`rail.rs`](../../../backend/crates/api/src/rail.rs) (the server-driven nav that
reuses the same reach), [`admin.rs`](../../../backend/crates/api/src/admin.rs) (the
reduced platform-admin surface), [`rbac.rs`](../../../backend/crates/api/src/rbac.rs)
(`principals` / `require_rule`). Code-area docs:
[objects.md](../code/backend/objects.md), [rbac.md](../code/backend/rbac.md),
[api-routes.md](../code/backend/api-routes.md).

## Symptom (predecessor)

Building the dashboard Overview surfaced that Home — a **non-admin** app — listed
most of its tabs from `/admin/*` endpoints (`/admin/users`, `/admin/companies`,
`/admin/teams`, `/admin/charts`, …). Those were gated by a platform-admin
middleware and returned **all rows**. It only "worked" because the operator was a
platform admin: a real non-admin gets **403/empty**, and an admin **over-sees the
whole platform** where they should see only their RBAC reach. Shared pickers
(cases, the cell-editor entity picker) borrowed `/admin/users` /
`/admin/companies` the same way. A pre-RBAC holdover — surfaced once RBAC was in.

## Root cause

`/admin/*` is the wrong source for a user surface. Those endpoints are
platform-scoped (every row) by design; reading them from a user page makes the
view's correctness depend on the *operator's* admin flag, not the *caller's*
reach. The fix isn't to harden the admin endpoints — it's to give user surfaces a
**reach-scoped** source and never point a non-admin page at `/admin/*`. That split
is the architecture Em locked.

## Architecture — "one engine, two surfaces" (Em's calls, 2026-06-08)

> Plan this properly, it's a big deal.

User surfaces are **de-admin-scoped via the object registry** and served by
**reach-scoped delivery**, the same shape every list takes:

1. **The object registry is the one list engine.** Route user lists through the
   generic `GET /api/objects/:type` (see [redpash-id.md](../code/backend/redpash-id.md)
   and [objects.md](../code/backend/objects.md) for the registry premise). The
   handler is type-agnostic: a new type's list Just Works the moment its
   `type_definitions` row exists — no per-type endpoint, no central place to add a
   leak.

2. **Reach-scoped delivery, not platform scope.** The server delivers only the
   caller's RBAC-reachable rows. `viewer = None` ⇒ platform admin (no filter); else
   the caller's principal closure (`rbac::principals`) is threaded as a `$N::text[]`
   bind into a membership reach clause. *Two surfaces* read that one delivery: the
   list itself (`objects.rs`) **and** the navigation rail (`rail.rs`), which reuses
   the **verbatim** reach clauses so the tree can never show structure the list
   would hide.

3. **Shaping is the client's job (the "engine" half).** The server does reach
   *delivery* + a coarse `q` substring fallback only; the real filter/search/sort
   runs in the in-browser Polars wasm engine — the same engine the Workspace table
   uses. Server `page`/`size`/`q` is the over-cap fallback. This is the
   wasm-replaces-js north-star (data governance: bring compute to the data); the
   in-browser engine ships as `frontend/framework/object-list/object-list.js`.

## How lean closes the leak class (by construction)

- **There are no `/admin/*` list endpoints.** The lean `admin.rs` is a single
  route — `PUT /api/admin/fields` (the field-permission override upsert,
  platform-admin only, leak-free 404 for everyone else). No
  `/admin/users` · `/admin/companies` · `/admin/teams` · `/admin/charts`, no
  `require_platform_admin_mw`, no `db::list_charts`. The platform-scoped list
  surface the predecessor leaked from simply **does not exist** to be read.

- **The generic list is reach-scoped, and `all_count` is too.** `objects.rs::list`
  builds `viewer` (admin → `None`, else `rbac::principals`) and filters on the
  `REACH` clause — membership on the object **or** its `scope_parent_id` (the
  cascade). Crucially `all_count` runs the *same* `REACH`, never `COUNT(*)` — so a
  tab KPI can't leak the platform total even when the rows themselves are scoped.
  Org builtins (user/company/team) and the data builtins (file/project/case)
  dispatch through `org_builtin(type_id)` to `builtin_list`, which runs the same
  reach over the **typed** table; custom types stay on the `entity_data` path. A
  caller's own user row is self-visible (the closure contains the caller's rid).

- **The rail reuses the same reach.** `rail.rs::type_count` carries the reach
  clauses **verbatim** from `objects.rs::org_builtin` (the comment says so), and the
  `instance_tree` reach mirrors the files/projects handlers. So the nav tree and
  the list agree by sharing the clause text, not by a second hand-written copy.

- **The IDOR guard sits on the write path** (day-one #3). A caller-supplied
  `scope_parent_id` on create must be reachable at `>= Member` via `require_rule`,
  or the create 404s leak-free — see
  [objects-scope-parent-idor.md](objects-scope-parent-idor.md) and
  [day-one.md #3](../../decisions/day-one.md). Orthogonal to this runbook (write vs
  read scope) but part of the same "the registry owns the scope boundary" story.

## Staged → shipped vs deferred (against the lean tree)

The 2026-06-08 plan staged the work; here is its state on lean.

- **S1 — backend reach-scoped list. SHIPPED**, but in a *simpler shape* than
  planned. The plan called for a `ListProviderRegistry` (`OnceLock<HashMap>` of
  per-type providers, mirroring a codec registry). Lean did **not** add that
  indirection: the org/data builtins are a small `org_builtin(type_id) -> (table,
  reach)` match in `objects.rs` that dispatches to `builtin_list`; custom types ride
  the `entity_data` path directly. There is **no `list_registry.rs` / `routes/`
  module** on lean — `objects.rs` and `rail.rs` are flat in
  `backend/crates/api/src/`. The wire shape the plan specified did ship:
  `{ items, total, all_count, page, size }`, rows flat with `rid` injected. `q`
  is the coarse server-side substring fallback.

- **S3 — frontend repoint. SHIPPED.** No user-facing page reads `/admin/*` on lean.
  The shared `object-list.js` component fetches `/objects/:type` (reach-scoped) and
  does CRUD through `/objects/:type[/:rid]`; the server rail (`/api/rail/:view`)
  supplies the type tabs. The **only** `/admin/*` literal in `frontend/` is the
  Console's `PUT /admin/fields` — an admin page calling the one surviving admin
  write, which is correct and stays explicit.

- **The detector exists and is GREEN.** `tools/admin-scope-audit/audit.js` is the
  regression gate: it parses the apps registry (lean: `frontend/framework/boot/apps.js`,
  `admin: true` on the app), builds the import graph, and fails (exit 1) on any
  `/admin/*` string literal reachable from a non-admin page. Its `ALLOW{}` is **reset
  to empty** on lean — the prerelease allowlist named pages (home.js, the chart banks)
  the lean cut removed. Lean reports **0 leaks**.

- **DEFERRED (not silenced):**
  - **`membership` user-scoping.** A membership is an *edge*, not a registered
    entity-type, so `/api/objects/membership` 404s (it isn't in `org_builtin` and has
    no `type_definitions` row). Re-scoping the membership list needs either a
    `type_definitions` registration or a dedicated `/api/memberships` route — neither
    is on lean.
  - **Client-derived KPI gauges.** Repointed tabs dropped their per-tab KPI gauges
    (reach delivery returns rows, not platform aggregates). Computing the gauges
    client-side from the list payload is the deferred follow-on.
  - **S2/S4 — the shared client-engine shaping + the dashboard Overview.** The
    original Lane-2 task. Reads already flow through the registry, so the Overview is
    a *config* of the same `/api/objects/:type` data (the `object-list.js` `source`
    override is the seam — e.g. Overview points at `/files`); the shared
    client-engine shaping layer is the next lane.

## Lessons / risks

- **Reach-scope `all_count`, never `COUNT(*)`.** A tab KPI must scope its total the
  same way it scopes its rows, or it leaks the platform count even when the visible
  rows are correct. `objects.rs::list` and `builtin_list` both bind `viewer` into the
  `all_count` query.
- **The rail and the list must share clause TEXT.** Two hand-written reach copies
  drift; lean keeps `rail.rs::type_count` byte-for-byte identical to
  `objects.rs::org_builtin` (and the comment pins the intent) so they can't disagree.
- **Row keys are the frontend contract.** `builtin_list` derives display columns from
  `registry_display_fields` and `objects.rs` injects `rid`/`owner`/`scope_parent`; a
  renamed key blanks a cell silently — the column⋂row-keys intersection in
  `object-list.js` is what keeps every field, so `/types` and `/objects` must agree on
  the field set (they share `registry_display_fields`).
- **The simpler shape was the right call.** A `ListProviderRegistry` would have been
  a closed-enum dressed as a framework — a per-type provider list in code. The lean
  `org_builtin` match + `entity_data` default is smaller and the *custom* path needs
  no entry at all, which is the registry payoff the plan was reaching for.

## Verify (on lean)

- `node tools/admin-scope-audit/audit.js` — exit 0, "no user-surface /admin/* leaks".
- `cargo test -p api` — `rail.rs` carries `mapped_views_pick_their_mode` /
  `org_dynamic_keeps_builtins_and_drops_non_org_builtins` (the TypeList shape, unit
  tests). The reach is exercised live against a real pool in `tests/rail_reach.rs`
  (via `rail::workspace_tree_for` and the org-TypeList counts) — and since
  `rail.rs::type_count` carries the `objects.rs::org_builtin` clauses **verbatim**,
  that live test proves the list reach by proxy. `objects::registry_display_fields`
  (the shared field set) has its own live test in `tests/registry_fields.rs`, and the
  create-time IDOR guard is in `tests/objects_idor.rs`. There is no sqlx integration
  harness over the `/objects` HTTP handler itself — a cross-tenant list RBAC matrix is
  a 2-user manual test, pending.
- Spot-check: a non-admin `GET /api/objects/user` returns only reachable users with a
  reach-scoped `all_count`; `GET /api/objects/membership` 404s (deferred, by design).
