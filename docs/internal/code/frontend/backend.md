# Backend contracts the frontend speaks (routes + engine)

This is the API surface from the frontend's point of view — enough to wire a page
without reading the Rust crates. Routes mount under `/api` via nested routers
(`backend/crates/api/src/main.rs`). State-changing methods pass a CSRF origin
guard; the upload cap is 256 MiB. The same binary serves the static frontend as a
fallback (dev default bind `127.0.0.1:8080`; the dev server used in this repo runs
on `:8099`).

**The page shape.** `{ columns, rows, total }` (sometimes `+ offset`) is produced
by `data::view::page` and is the SAME object the wasm engine emits — server and
client are byte-identical. **`rows` are arrays of stringified cells aligned to
`columns`** (not objects); the frontend zips them into row objects. `/page` and
`/group/preview` both return this shape.

**Auth model.** Session = an opaque `rp_session` cookie (HttpOnly, SameSite=Lax,
Secure in release). Most reads gate by extraction alone (any authed caller,
reach-filtered); mutations gate via `rbac::require_action(Action::{View|Edit|Delete})`.
**Denials are leak-free: a forbidden/missing/foreign resource returns the same
`404 not_found` as a wrong path** — never `403`.

---

## Route catalog

### `/api/auth/*`
| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/auth/google/start` | — | 302 → Google; sets `rp_oauth_state` |
| GET | `/auth/google/callback` | `?code&state&error?` | 302 → `/`; sets `rp_session` |
| POST | `/auth/logout` | — | `204`; clears session |
| POST | `/auth/claim-admin` | — | `200 {claimed:true}` for the first claimant while no admin exists, else `404` |
| POST | `/auth/dev-login` | `{user_id?}` (empty → dev user) | `204`; sets `rp_session`. **Debug builds only.** |

### `/api/me`
| Method | Path | Response |
|---|---|---|
| GET | `/me` | `{ user, is_platform_admin, settings: {…resolved platform→role→user cascade} }` |

One request boots the client (user + admin flag + behavior cascade).

### `/api/files/*`
| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/files?limit=` | — (default 50, 1–200) | `{ items:[{rid, filename, project_id, project_name, rows, cols, cleanness, created_at}] }` |
| POST | `/files` | multipart `file` (req), `project?`, `tld?` | `{ rid, filename, encoding, cleanness, columns, fully_null_rows, size_bytes }` |
| GET | `/files/:rid` | — | `{ rid, rows, cols, cleanness, columns }` |
| PATCH | `/files/:rid` | `{ filename }` | `{ rid, filename }` |
| GET | `/files/:rid/page?offset=&limit=` | — (offset 0, limit 100, capped at `ROW_CAP`) | `{ columns, rows, total, offset }` |
| POST | `/files/:rid/page` | `{ offset?, limit? }` + **`QuerySpec`** (flattened) | `{ columns, rows, total, offset }` — applied **(filter AND search) → sort → page**; `total` = post-(filter+search) count (sort never changes it); empty query == GET page |
| GET | `/files/:rid/steps` | — | `{ steps:[{kind, params, applied}], can_undo, can_redo }` |
| POST | `/files/:rid/steps` | `{ kind, params? }` | refreshed summary `{rid, rows, cols, cleanness, columns}` |
| POST | `/files/:rid/undo` · `/redo` | — | refreshed summary |
| GET | `/files/:rid/export?format=` | — (`csv` default, `xlsx`, `json`) | file bytes + `Content-Disposition` |
| POST | `/files/:rid/sql` | `{ sql, tables?:[{name,file_id}], materialize_as? }` | `{ columns, rows, total }` (≤500 rows; primary file is table `t`) |
| POST | `/files/:rid/sql/materialize` | same body | `{ rid, filename, rows }` — writes a NEW file |
| GET | `/files/:rid/joins` | — | `{ files:[{file_id, filename, candidates:[{this_col, other_col, matches, this_uniques, other_uniques, samples}]}] }` |
| POST | `/files/:rid/joins` | `{ other_file, left_keys:[…], right_keys:[…], join_type?:"inner", materialize_as? }` | `{ rid, filename, rows }` — materializes a NEW file |

> **No `score` route exists.** Cleanness surfaces three ways: the `cleanness`
> field on upload/summary responses, the wasm `Workbook.score()` / `parse_score()`
> payload, and per-file cleanness in list/rail rows.

> **Client-side window (wasm `Workbook`).** Mirrors `/page`: `page(offset, limit)`
> (bare), `filter_page(filterJson, offset, limit)`, and the composable
> `view(queryJson?, offset, limit)` where **`queryJson` = `QuerySpec`** — applies
> **(filter AND search) → sort → page**, byte-identical to POST `/page` for the
> same bytes.
>
> **`QuerySpec` = `{ filter?: FilterNode, search?: string, sort?: SortKey[] }`** —
> the ONE window-query shape both surfaces speak (the POST `/page` body flattens
> it with `offset`/`limit`). `search` is free-text matched **case-insensitively
> against every column cast to text** — find "20" in a numeric column as readily
> as a name — and ANDs with the structured `filter`. **`SortKey` = `{ col,
> descending?: bool }`** (a `SortKey[]` is a multi-column sort, first key primary,
> ascending by default) — the table-column sort, distinct from `ReportSpec.sort`
> `{col, dir}`.

**Hydration model:** the parsed frame is cached per `rid`; on a miss the immutable
base CSV is read and the applied `project_steps` history is **replayed**
(`data::steps::replay`). Editing is non-destructive — undo flips a step's
`applied` flag; the base CSV is never mutated.

### `/api/group/preview`
| Method | Path | Body | Response |
|---|---|---|---|
| POST | `/group/preview` | `{ file_id, spec: ReportSpec }` | `{ columns, rows, total }` (page ≤ `ROW_CAP`) |

Stateless: hydrate → `data::group_by::execute` in `spawn_blocking`. View-gated.
There is no stored Report entity — a report is a derived view.

### Other routes (reference)
| Path | Method | Shape |
|---|---|---|
| `/rail/:view` | GET | `{ groups:[{id, name, icon?, count?, collapsed, tabs:[{id, name, icon, kind, dot?, renamable?, hidable?}]}] }`. Views: `workspace` (projects→files, default), `org`, `settings`, `console`, `designer`. Workspace leaf `kind="file"`; `dot` = clean/warn/dirty by cleanness ≥90/≥70/else. |
| `/search?q=&limit=` | GET | `{ q, ms, results:[{kind, rid, label, sub, hash}] }`. Kinds: project/file(+chart/dashboard)/user/company/team. `hash` is a SPA deep-link. |
| `/settings/:scope_type/:scope_id/:key` | GET·PUT·DELETE | scope ∈ platform\|company\|role\|user (platform uses `_` for id). PUT `{value}` → `204`; DELETE resets to default. |
| `/types` | GET | `{ types:[{type_id, display_name, display_name_plural, rid_prefix, grid_served, is_builtin, fields:[{key, label, data_type, perm_class, field_group, scope, ordinal, cells:{owner,admin,member,viewer}, options?}]}] }` |
| `/objects/:type[/:rid]` | GET·POST·PATCH·DELETE | one generic handler over `entity_data`; org builtins user/company/team dispatch to typed tables on the same wire shape. List: `{items, total, all_count, page, size}`. |
| `/projects` | GET·PATCH | `{ items:[{rid, name, file_count, is_default, created_at}] }`. `is_default` is DERIVED from the caller's `default_project_id`. |
| `/admin/fields` | PUT | `{type_id, field, role, can_read, can_write}` → `204` (platform admin; leak-free 404 otherwise). |
| `/health?deep=1` | GET | `{status, version, db?}`. |

---

## Data engine (the Rust `data` crate)

### Cleaning steps — `data::steps::apply` dispatch
A step is `{ kind: String, params: Value }`. `kind` is free-form text — **a new op
needs no DB/DTO/route change**; unknown kinds error as `InvalidSpec`. Every
supported kind:

| kind | params (key fields) |
|---|---|
| `drop_columns` | `{ cols:[string] }` |
| `filter_columns` | `{ cols:[string] }` (names to KEEP, in order) |
| `rename_column` | `{ from, to }` |
| `snake_case_columns` | `{}` |
| `replace_in_names` | `{ find, replace? }` |
| `drop_rows` | `{ indices:[int] }` — **position-based** |
| `filter_rows` | `{ combinator?:"and"\|"or", predicates:[{column, op, value?, case_sensitive?}] }` (lifted into one `FilterNode`; `case_sensitive` defaults **true** for persisted steps) |
| `drop_nulls` | `{ cols?:[string] }` (empty = all) |
| `set_cell` | `{ row:int, column, value? }` (null/blank → NULL) — **position-based** |
| `fill_nulls` | `{ strategy?:"fixed"\|"zero"\|"forward", column?, value? }` |
| `cast` | `{ column, dtype:"int"\|"float"\|"str"\|"bool"\|"date"\|"datetime"\|"time" }` — locale-aware FR number/bool coercion **only when the source column is `String`** |
| `change_case` | `{ mode:"lower"\|"upper" }` (string columns only) |
| `replace_text` | `{ column, find, replace?, is_regex?:bool }` |
| `fix_invalid` | `{ sentinels:[…], columns?:[…], replacement? }` (legacy `{column, sentinel}` still replays; null replacement → NULL) |
| `unwrap_csv` | `{}` — **single-column frames only** (errors otherwise); per-row delimiter+quote sniff |
| `join_columns` | `{ col1, col2, sep?=" ", new_name? }` — exactly 2 columns |
| `split_column` | `{ column, sep?=",", keep_original?=false }` — caps at **MAX_PARTS = 10** new columns |
| `format_dates` | `{ column, fmt?="%Y-%m-%d" (must contain a `%` specifier), on_incomplete?="null"\|"drop"\|"keep" }` |

> **`unwrap_csv` / `join_columns` / `split_column` / `format_dates` are fully
> implemented** in `data::steps::structure` (each with a real Polars impl + a
> passing test). A stale comment in `steps/mod.rs` still calls them "deferred" —
> ignore it; the dispatch routes to working impls.
>
> `set_cell` and `drop_rows` are **position-based** — the reason the Data Cleaner
> gates edit/delete under a filter (see [`data-cleaner.md`](data-cleaner.md)).

### Group-by / reports — `data::group_by::execute(df, &ReportSpec)`
`ReportSpec` (`shared/src/report.rs`, all `#[serde(default)]`):
- `group_by:[string]` (row groups), `group_by_cols:[string]` (column/pivot groups — combined into one group_by)
- `aggregations:[{ col, fn: AggFn, alias? }]` — `col:"*"` is the count-of-rows shortcut
- `filter?` — a `FilterNode` JSON value (pre-filter, same tree as the cleaner)
- `show_details`/`show_subtotals` (default true), `show_total` (false)
- `sort:[{col, dir:"asc"|"desc"}]`, `top_n?:{n, order_by, direction?, partition_by?}`, `windows:[WindowSpec]`, `charts:[ChartSpec]`

`AggFn` (snake_case): **`count`, `count_distinct`, `sum`, `mean`, `min`, `max`,
`first`, `last`, `median`, `q1`, `q3`**. (`report-spec.js` exposes the first 8.)
Behavior: no group + no agg → single `{rows}` summary; group + no agg → implicit
`count`. `WindowSpec.fn` supports aggregate windows (`sum|mean|count|min|max`,
optional `as_percent`) + value windows (`lag|lead|first_value|last_value`, require
`order_by`).

### Filters — `FilterNode` (`shared/src/filter.rs`)
THE one canonical filter shape (day-one decision #4), `#[serde(tag="node",
rename_all="snake_case")]`:
- `{ "node":"group", "op":"and"|"or", "children":[FilterNode] }` — empty children = match-all
- `{ "node":"pred", "col", "op":PredOp, "value"?, "case_sensitive"? }` (wire default `false`)

`PredOp` (snake_case): **`eq`, `neq`, `contains`, `not_contains`, `starts_with`,
`ends_with`, `gt`, `gte`, `lt`, `lte`, `between` (`value:[low,high]`), `in`
(`value:[…]`), `is_null`, `not_null`**. Compiled by `data::filter::apply_filter`
(**recursive** over nested groups — so DC3c's nested AND/OR is a frontend-only
change). Numeric ops cast value→f64; string ops cast the column→String.

### wasm — `data::wasm` (the resident client engine)
Same engine the server links; the JS method surface is generated from
`#[wasm_bindgen]`. Top-level `parse_score(bytes, tld?)` → score JSON. `Workbook`
(snake_case methods):

| Method | Signature | Returns |
|---|---|---|
| `from_csv` | `(bytes, tld?)` constructor | `Workbook` |
| `page` | `(offset, limit)` | JSON `{columns, rows, total}` |
| `filter_page` | `(filter_json, offset, limit)` | `{columns, rows, total}`, `total` = filtered height |
| `score` | `()` | `{rows, cols, score, report{…}, columns, sentinels}` |
| `rows` / `cols` | `()` | `usize` |

---

## DC3 needs NO new backend
- **Reports** → `POST /api/group/preview` with a `ReportSpec`.
- **Every clean op** → `POST /api/files/:rid/steps` with `{kind, params}` — all in the `apply` dispatch above.
- **Nested AND/OR filters** → the recursive `FilterNode`, consumed identically by `/files/:rid/page`, the `filter_rows` step, `group/preview`'s pre-filter, and wasm `filter_page`.

No new routes, no new wasm wrappers.
