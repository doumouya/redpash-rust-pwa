# API routes — the catalog the frontend speaks

The `api` crate's HTTP surface from the frontend's point of view — enough to wire a
page without reading the Rust crates. Routes mount under `/api` via nested routers
(`backend/crates/api/src/main.rs`). State-changing methods pass a CSRF origin guard
(`middleware::origin_guard`, defense-in-depth over `SameSite=Lax`); the upload cap is
**256 MiB** (`DefaultBodyLimit`). The same binary serves the static frontend as a
fallback. The dev server in this repo runs on **`:8080`** — the default bind is
`127.0.0.1:8080` (`REDPASH_BIND`); exposing beyond loopback is an explicit override,
never a default (day-one #10).

> The `data`-crate compute surface (`steps::apply`, `group_by::execute`, the
> `FilterNode`, the wasm `Workbook`) lives in [`data-engine.md`](data-engine.md). This
> doc is the HTTP catalog only.

**The page shape.** `{ columns, rows, total }` (sometimes `+ offset`) is produced by
`data::view::page` and is the SAME object the wasm engine emits — server and client are
byte-identical. **`rows` are arrays of stringified cells aligned to `columns`** (not
objects); the frontend zips them into row objects. `/files/:rid/page`, `/files/:rid/sql`,
and `/group/preview` all return this shape.

**Auth model.** Session = an opaque `rp_session` cookie (HttpOnly, SameSite=Lax, Secure
in release — the Secure attribute has ONE flip point: on in release, off in debug, by
compile profile not env). Most reads gate by extraction alone (any authed `Caller`,
reach-filtered); mutations gate via `rbac::require_action(Action::{View|Edit|Delete})`.
**Denials are leak-free: a forbidden/missing/foreign resource returns the same
`404 not_found` as a wrong path** — never `403` (403 only where reach is already proven).

---

## Route catalog

### `/api/auth/*`
| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/auth/google/start` | — | 302 → Google; sets `rp_oauth_state` |
| GET | `/auth/google/callback` | `?code&state&error?` | 302 → `/`; clears state cookie, sets `rp_session` |
| POST | `/auth/logout` | — | `204`; clears session |
| POST | `/auth/claim-admin` | — | `200 {claimed:true}` for the first claimant while no admin exists, else leak-free `404` |
| POST | `/auth/dev-login` | `{user_id?}` (empty body → dev user) | `204`; sets `rp_session`. **Debug builds only** — the route is `cfg`-compiled OUT of release binaries, not gated by a runtime flag. |

### `/api/me`
| Method | Path | Response |
|---|---|---|
| GET | `/me` | `{ user, is_platform_admin, settings: {…resolved platform→role→user cascade} }` |
| GET | `/me/export` | the **data-subject access / portability** bundle (GDPR) — scoped to `caller.rid`, so a subject only exports themselves; emits a `data_export` audit event |

One request boots the client (user + admin flag + behavior cascade). The FE hides
surfaces off this payload; the backend gates remain the real boundary.

### `/api/files/*`
| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/files?limit=` | — (default 50, clamped 1–200) | `{ items:[{rid, filename, project_id, project_name, rows, cols, cleanness, created_at}] }` (CSV only, newest first, reach-scoped) |
| POST | `/files` | multipart `file` (req), `project?`, `tld?` | `{ rid, filename, encoding, cleanness, columns, fully_null_rows, size_bytes }` |
| GET | `/files/:rid` | — | `{ rid, rows, cols, cleanness, columns }` |
| PATCH | `/files/:rid` | `{ filename }` | `{ rid, filename }` (Edit; rail's inline rename) |
| GET | `/files/:rid/page?offset=&limit=` | — (offset 0, limit 100, capped at `ROW_CAP`) | `{ columns, rows, total, offset }` |
| POST | `/files/:rid/page` | `{ offset?, limit? }` + **`QuerySpec`** (flattened) | `{ columns, rows, total, offset }` — applied **(filter AND search) → sort → page**; `total` = post-(filter+search) count (sort never changes it); empty query == GET page |
| GET | `/files/:rid/steps` | — | `{ steps:[{kind, params, applied, ordinal, cleanness}], can_undo, can_redo, baseline_cleanness }` |
| POST | `/files/:rid/steps` | `{ kind, params? }` | refreshed summary `{rid, rows, cols, cleanness, columns}` — commit ONE step |
| POST | `/files/:rid/steps/preview` | `{ offset?, limit?, steps:[{kind, params?}] }` | `{ columns, rows, total, offset }` — apply the staged (unsaved) chain on top of the committed frame, NO persist (View-gated; ≤ `STAGED_STEP_CAP`=256 steps) |
| POST | `/files/:rid/steps/batch` | `{ steps:[{kind, params?}] }` | refreshed summary — commit the staged buffer as ONE atomic Save (whole chain pre-flighted; any invalid step aborts before anything persists; empty buffer = no-op; ≤256) |
| POST | `/files/:rid/undo` · `/redo` | — | refreshed summary (flips a step's `applied` flag) |
| GET | `/files/:rid/export?format=` | — (`csv` default, `xlsx`, `json`) | file bytes + `Content-Disposition: attachment; filename="<rid>.<ext>"` |
| POST | `/files/:rid/sql` | `{ sql, tables?:[{name,file_id}], materialize_as? }` | `{ columns, rows, total }` (≤500 rows; primary file is table `t`; every referenced file View-gated; read-only guard lives inside `data::sql`) |
| POST | `/files/:rid/sql/materialize` | same body | `{ rid, filename, rows }` — writes a NEW file via the sealed pipeline |
| GET | `/files/:rid/joins` | — | `{ files:[{file_id, filename, candidates:[{this_col, other_col, matches, this_uniques, other_uniques, samples}]}] }` (overlap-coefficient key detection across the project's other CSVs) |
| POST | `/files/:rid/joins` | `{ other_file, left_keys:[…], right_keys:[…], join_type?:"inner", materialize_as? }` | `{ rid, filename, rows }` — materializes a NEW file |

**Steps timeline.** `GET /steps` returns the full history (applied + undone) so the
cleaning timeline renders the replay model truthfully; the genesis `original` marker is
excluded from the `steps` list and its score rides out separately as `baseline_cleanness`
(the upload score). `can_undo`/`can_redo` derive from the `applied` flags.

> **No `score` route exists.** Cleanness surfaces three ways: the `cleanness` field on
> upload/summary responses (and per-step `cleanness` + `baseline_cleanness` on `/steps`),
> the wasm `Workbook.score()` / `parse_score()` payload, and per-file cleanness in
> list/rail rows.

**Hydration model:** the parsed frame is cached per `rid`; on a miss the immutable base
CSV is read and the applied `project_steps` history is **replayed** (`data::steps::replay`).
Editing is non-destructive — undo flips a step's `applied` flag; the base CSV is never
mutated. Reads never write back to the DB (stats refresh only on mutation, via `refresh`).
Hydration is single-flight per `rid`.

> See [`data-engine.md`](data-engine.md) for `QuerySpec`/`FilterNode`/`SortKey` shapes and
> the wasm `Workbook` mirror of `/page`.

### `/api/group/preview`
| Method | Path | Body | Response |
|---|---|---|---|
| POST | `/group/preview` | `{ file_id, spec: ReportSpec }` | `{ columns, rows, total }` (page ≤ `ROW_CAP`) |

Stateless: View-gate → hydrate → `data::group_by::execute` in `spawn_blocking`. There is
no stored Report entity (the object-model lock) — a report/chart is a derived view.

### `/api/rail/:view`
| Method | Path | Response |
|---|---|---|
| GET | `/rail/:view` | `{ groups:[{id, name, icon?, count?, collapsed, renamable?, hidable?, tabs:[{id, name, icon, kind, dot?, renamable?, hidable?}]}] }` |

ONE server-side resolver builds every page's left rail from a tiny `view → RailView`
descriptor map, reach-filtered against the SAME principal closure every list uses
(`viewer = None` ⇒ platform admin, no filter; else the caller's principals). Any authed
`Caller` — extraction IS the gate; the rail shows only reachable structure, so it never
leaks. An **unmapped view falls through to the `workspace` InstanceTree** (pages light up
with the Browse rail before their own descriptor lands). New pages add a match arm, not a
handler ("framework, not product").

**The full descriptor set** (`rail::descriptor`):

| `:view` | Mode | Shape |
|---|---|---|
| `workspace` (default / any unmapped) | InstanceTree | projects → their CSV files (`leaf_where = file_type = 'csv'`). Group = a reachable project; tab leaf `kind="file"`, `dot` = clean/warn/dirty by cleanness ≥90 / ≥70 / else (omitted when no score yet); leaves `renamable`+`hidable`. `count` = reachable leaves under the group. |
| `org` | TypeList (`OrgDynamic`) | ONE "objects" group; tabs = the org builtins (user/company/team) PLUS every non-builtin custom type, ordinal order. Each tab `kind="type"` with a reach-scoped instance `count`. |
| `registry` | TypeList (`RegistryDynamic`) | the `org` set PLUS the data builtins `file`/`project` — the registry superset the admin can browse/filter/delete on the redtable. |
| `settings` | PrefGroups | ONE "settings" group; tabs = the DISTINCT `field_group` sections of the `preference` type's user-scope fields, ordinal order (`kind="prefgroup"`, icon `bi-sliders`). No reach filter — prefs are the caller's own. |
| `console` | Sections | ONE "Console" group of STATIC page chrome (`kind="section"`): `visibility` (App visibility), `fields` (Objects & fields), `policies` (Policies). The page's `onRailTab` scrolls the surface to the section. |
| `cases` | Sections | ONE "Status" group of workflow-stage filter tabs (the kanban columns, `kind="section"`): `all`, `backlog`, `todo`, `in_progress`, `in_review`, `done`. `id` MATCHES the status enum so the page filters on it client-side. |
| `designer` | InstanceTree | projects → chart/dashboard files (`leaf_where = file_type IN ('chart', 'dashboard')`, leaf `kind="chart"`). Page not built yet — the descriptor is staged. |

> **Drift fix (this doc):** the previous catalog listed only `workspace/org/settings/
> console/designer`. The live `descriptor()` also exposes **`registry`** (the data
> registry: org set + file/project) and **`cases`** (the workflow-stage filter rail) —
> both now documented above.

### `/api/search`
| Method | Path | Response |
|---|---|---|
| GET | `/search?q=&limit=` | `{ q, ms, results:[{kind, rid, label, sub, hash}] }` |

ONE flat, `kind`-discriminated result list; the FE groups by kind. Every source REUSES
the rail's reach-scoped query verbatim, then ILIKE-filters by `q`, prefix-boosts, and
ranks. Bounded twice: a per-kind SQL `LIMIT` (5) and a kind-balanced round-robin total
cap (default 20, max 100). Empty/whitespace `q` → empty results. Kinds:
**project / file / user / company / team**, with `file` sliced by `file_type` into
`file` (csv) / `chart` / `dashboard`. `hash` is a SPA deep-link (e.g.
`#/workspace?file=<rid>`).

### `/api/settings/:scope_type/:scope_id/:key`
| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/settings/:scope_type/:scope_id/:key` | — | `{ key, value }` (leak-free `404` if unset/forbidden) |
| PUT | `/settings/:scope_type/:scope_id/:key` | `{value}` or the bare value | `204` |
| DELETE | `/settings/:scope_type/:scope_id/:key` | — | `204` — resets to the next cascade layer / code default |

`scope_type ∈ platform | company | role | user` (platform uses a placeholder id, the FE
sends `_`, normalized to `''`). Write RBAC: user scope → self (or platform admin); role/
platform → platform admin only; company → effective ≥ Admin on that company. Read RBAC:
user scope → self/admin; platform/role/company → any authed caller (policies shape
everyone's UI; they are not secrets). Definitions live in frontend code
(`registerPref`/`registerPolicy`); this API stores scoped VALUES and serves the resolved
cascade (also exposed on `/api/me`).

### `/api/types`
| Method | Path | Response |
|---|---|---|
| GET | `/types` | `{ types:[{type_id, display_name, display_name_plural, rid_prefix, grid_served, is_builtin, fields:[{key, label, data_type, perm_class, field_group, scope, ordinal, cells:{owner,admin,member,viewer}, options?}]}] }` |

The TypeDefinition contract: every registered type + its field catalog, per-role `cells`
DERIVED from `perm_class` then overlaid with the sparse `field_permissions` overrides.
Any authed caller — the FE builds grids/editors off this; the backend gates stay the
boundary. Reads LIVE from the DB (a custom type is "a row, not a migration", and an admin
override must show on the next GET).

**Derive-all-fields (this is the key behavior).** Beyond the curated `type_fields`,
`/types` appends every **uncataloged real table column** as a **readonly display field**,
so the registry shows the WHOLE object without a per-column migration ("derive, don't
store"). The derivation is driven by `objects::registry_display_fields(pool, type_id)`:

- It returns `Some(..)` only for the **org builtins** (`org_builtin`: user / company /
  team / file / project / case) — the types the registry grid serves. For non-builtin
  (entity_data) types it returns `None`, so nothing is derived.
- For the **editable** builtins (user/company/team) it returns the curated `type_fields`
  only (`cataloged=true`) — their catalog IS their editable field set.
- For the **read-only registry** builtins (`registry_read_only`: file / project / case)
  it returns the type_fields catalog FIRST (in curated ordinal, `cataloged=true`), THEN
  every remaining real column of the typed table in schema order (`cataloged=false`),
  minus `HIDDEN_COLUMNS` (`google_sub`, `storage_path`, `columns_meta`, `spec` — server
  secrets/paths/opaque blobs).
- `types::payload` then pushes each `cataloged=false` column as a field with
  `perm_class:"readonly"`, `data_type:"string"`, a `title_case`d label, and an ordinal
  past the curated ones. Readonly + absence from `field_permissions` ⇒ display-only.

This is THE field set both `/types` (column headers) and `/objects` (row data) share, so
the FE's column ⋂ row-keys intersection keeps every field. **The write gate is
unaffected:** PATCH/create validate against the curated `type_fields`
(`objects::validate_payload`), so deriving display fields never widens what writes accept.

> **Drift fix (this doc):** the previous catalog omitted the derive-all behavior. The
> registry shows the whole read-only object (file/project/case) via derived readonly
> display fields — no per-column migration.

### `/api/objects/:type[/:rid]`
| Method | Path | Response |
|---|---|---|
| GET | `/objects/:type` | `{ items, total, all_count, page, size }` (paged list) |
| POST | `/objects/:type` | the created object |
| GET · PATCH · DELETE | `/objects/:type/:rid` | one object / updated / `204` |

ONE generic handler over the polymorphic `entity_data` (JSONB) store — a new custom type
gets full CRUD + RBAC + audit with ZERO new code. Gating is the type-agnostic
`require_action`; the IDOR guard (day-one #3) gates a caller-supplied `scope_parent_id`
behind ≥ Member reach on the parent. The **org builtins** (user/company/team) dispatch to
their TYPED tables on the same wire shape (catalog-validated fields, the field gate after
the coarse Edit gate, reach-scoped lists mirroring the entity_data reach clause); the
read-only registry types (file/project/case) are browse + DELETE only.

### `/api/projects`
| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/projects?limit=` | — (default 50, clamped 1–200) | `{ items:[{rid, name, file_count, is_default, created_at}] }` |
| POST | `/projects` | `{ name }` | the created project `{ rid, name, file_count:0, is_default:false, created_at }` — any authed caller (a top-level container, no parent gate); creator auto-owned |
| PATCH | `/projects/:rid` | `{ name }` | `{ rid, name }` (Edit; rail's inline rename) |

The caller's reach-scoped projects, newest first, each with a CSV `file_count`. Reach =
membership on the project or its company (admin → all). `is_default` is **DERIVED** from
the caller's `users.default_project_id`, never a stored column.

### `/api/cases[/:rid]`
| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/cases` | — | reach-scoped `{ items }` (newest first) |
| POST | `/cases` | `{ title, description?, case_type?, priority?, assignee_id?, project_id?, company_id? }` | the created case — Member+ on each supplied scope_parent (the IDOR guard); status = the workflow initial |
| GET | `/cases/workflows` | — | the workflow transition map (stages + allowed transitions) |
| GET | `/cases/:rid` | — | one case (View reach; leak-free `404`) |
| PATCH | `/cases/:rid` | `{ status }` | the updated case — **workflow-enforced**: an illegal `from→to` is `422` |
| POST | `/cases/:rid/comments` | `{ body }` | the created comment (Member+) |
| GET · POST | `/cases/:rid/attachments` | POST: multipart `file` | list / the created attachment (METADATA-ONLY — no customer bytes in the DB) |
| GET · DELETE | `/cases/:rid/attachments/:att` | — | download / `204` (per-attachment IDOR guard `WHERE id AND case_id`) |

A case is a registry entity (`case` type) driven by a **workflow-as-data** engine — the PATCH transition is
enforced against a pure transition map (internal live; external dormant). Attachments mirror the
project-files storage model (metadata in Postgres, the blob in the project_files store), never customer
bytes in the DB. See [cases.md](cases.md).

### `/api/channels` · `/api/messages`
| Method | Path | Body / Query | Response |
|---|---|---|---|
| GET | `/channels` | — | the caller's channels only (reach = membership): `{ items:[{ rid, name (DM ⇒ the other member), kind, last_message, last_at, unread }] }` |
| POST | `/channels` | `{ name?, kind, member_ids[] }` | the channel; `kind:"dm"` is **GET-or-create** by member set; any authed caller (global chat v1) |
| POST | `/channels/:rid/read` | `{ at? }` (default now) | upserts the `(channel,user)` read baseline — unread = messages newer than `at` |
| GET | `/messages` | `?channel=<rid>&after=<ISO cursor?>` | `{ items }` ascending (`View` reach on the channel); a bad `after` ⇒ clean `400` |
| POST | `/messages` | `{ channel_id, body }` | the created message (`Edit` reach); empty body ⇒ `400` |

In-app chat (channels + DMs) on the **registry substrate** — a channel is a scoped entity
(membership = who's in), a DM a 2-member channel, a message an entity scoped to its channel,
so RBAC reach is the generated channel-membership cascade with **no messaging-specific
authorization**. Bodies are raw Markdown (FE renders safe `md→html`, no server sanitizer —
the `case_comments` contract). Near-real-time = **polling** (`?after=<cursor>`); SSE/Web Push
are a later phase. See [messaging.md](messaging.md).

### `/api/monitoring/*`
| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/monitoring/audit-runs?page&size&tool&q` | — | `{ items:[{id, tool, ran_at, git_sha, git_branch, stats}], total, page, size }` |
| GET | `/monitoring/audit-runs/stats` | — | `{ total, by_tool:{tool→count}, last_7d }` |
| GET | `/monitoring/audit-findings?page&size&run&tool&kind&q` | — | `{ items:[{run_id, tool, kind, finding_key, severity}], total, page, size, run }` |
| GET | `/monitoring/audit-findings/stats?run&tool` | — | `{ total, by_severity:{low/med/high→count}, by_kind:{kind→count}, run }` |

Read-only audit trail behind the Admin Monitoring page — the audit suite's runs + findings
(the `audit.*` schema written by the `redpash-audit-ingest` bin). **Platform admin only**;
every handler is leak-free `404` for non-admins. `size` clamps 1–200. Findings default to the
most-recent run (per `tool`) when `run` is omitted, and the stats scope to that SAME run so the
KPI strip matches the list. The rows are NOT registry entities (a system `audit` schema).

### `/api/admin`
| Method | Path | Body | Response |
|---|---|---|---|
| PUT | `/admin/fields` | `{type_id, field, role, can_read, can_write}` | `204` (platform admin; leak-free `404` for everyone else and for an unknown role / unknown `(type_id, field)`) |

Upserts ONE sparse `field_permissions` override cell (overlays the derived `perm_class`
matrix; emits a `field_permission_set` audit event).

### `/api/health`
| Method | Path | Response |
|---|---|---|
| GET | `/health?deep=1` | `{ status, version, db? }` — `?deep=1` (or `?deep`) also pings Postgres; a dead DB ⇒ `status:"degraded"`, `db:"down"` |

Liveness; the `version` is the crate version. No auth.
