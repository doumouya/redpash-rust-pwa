---
title: Cases
section: API
order: 11
last modified date: 2026-05-29
---

# `/api/cases/*`

Cases + comments — the Jira-flow workstream (case
CAS_DC7EDAF82F1E494F846D83FA71C411A2). Cases are the team's
coordination + customer-ticket layer on top of the audit-everything
spine: every lifecycle change (status, priority, assignee, type,
project, company, category) emits an `events.kind = 'case_*'` row
through the standard `event::record` path so the detail page's
**Activity** tab is literally `SELECT * FROM events WHERE
context->>'case' = $1`.

**Reporter + case-owner live in `memberships`** (mig 026
`case_people_to_memberships`) — the same polymorphic membership pattern
projects / companies use. The `Case` DTO surfaces them as
hydrated `reporter_id` / `assignee_id` + `*_display_name` via LATERAL
joins on `memberships WHERE object_redpash_id = c.redpash_id AND
relationship_attribute IN ('Reporter','Case Owner')`. There is no
`cases.reporter_id` / `cases.assignee_id` column.

> **Dev relaxation.** v1 is dev-permissive — any authenticated user can
> read / write any case. Visibility + RBAC overlays land in v3 alongside
> the customer-facing reporter path. The `source=internal|external`
> filter is the only access-shape gate today.

**Route file:** [`crates/api/src/routes/cases.rs`](../../backend/crates/api/src/routes/cases.rs)
**DTO:** [`shared::case`](../../backend/crates/shared/src/case.rs) — `Case`, `CaseDetail`, `Comment`, `Category`, `CaseCreateRequest`, `CasePatchRequest`, `CommentRequest`
**Spec:** [`docs/internal/jira-flow-proposition/proposition.md`](../internal/jira-flow-proposition/proposition.md)
**Migrations:** 015 (cases + comments) · 017 (categories) · 022 (entity registry) · 026 (case-people → memberships)

---

## `GET /api/cases`

Paginated case list. Powers the Home page's Cases tab + the cases
kanban + the case-list rail.

### Query parameters

| Param      | Type   | Default      | Notes |
|------------|--------|--------------|-------|
| `status`   | string | —            | Filter — `backlog`/`todo`/`in_progress`/`in_review`/`done` |
| `assignee` | string | —            | Filter — case-owner user RID |
| `project`  | string | —            | Filter — project RID the case is scoped to |
| `q`        | string | —            | Free-text search across title + description |
| `source`   | string | —            | `internal` (reporter is a member of the canonical RedPash company) or `external` (NOT member, or no reporter). Validated server-side — a typo returns `400 invalid`. When `state.internal_company_id` is `None`, the filter is a no-op. |
| `page`     | u32    | 1            | 1-indexed |
| `size`     | u32    | 50           | Clamped `[1, 500]` |
| `sort`     | string | `updated_at` | One of `title` · `type` · `status` · `priority` · `assignee_display_name` · `reporter_display_name` · `project_id` · `company_id` · `category_name` · `created_at` · `updated_at`. Bad value → falls back to `updated_at` (silent, not an error). |
| `dir`      | string | `desc`       | `asc` or `desc` |

### Response

```jsonc
200 OK
{
  "items": [ /* Case[] */ ],
  "total": 187,
  "page":  1,
  "size":  50
}
```

Each `Case` row carries:
- Lifecycle fields: `type`, `status`, `priority`.
- `reporter_id` / `assignee_id` resolved from the `memberships` LATERAL
  (`Reporter` and `Case Owner` `relationship_attribute`s).
- Hydrated `reporter_display_name` / `assignee_display_name` from the
  `users` join on the membership; `display_name || rid || "—"` is the
  FE rendering rule.
- Hydrated `category_name` + `category_parent_name` from the
  `case_categories` LATERAL — the FE shows "Backend > API" without a
  per-row fetch.
- `error_message` — raw payload for auto-triaged error cases (null for
  manually filed).

### Errors

| Status | `kind`            | When |
|--------|-------------------|------|
| 400    | `invalid`         | `source` not in `internal | external` |
| 401    | `unauthenticated` | OAuth enabled, no session |
| 500    | `db`              | Postgres unreachable |

---

## `POST /api/cases`

Create a case. Reporter defaults to the session user — written as a
`Reporter` membership in the same tx as the `cases` row insert (and the
preceding `register_entity('case', rid)` handshake).

```jsonc
POST /api/cases
{
  "title":         "Cleaner errors on Excel xlsx with merged cells",   // required
  "description":   "Repro: upload …",                                  // optional, markdown
  "type":          "bug",            // optional, defaults to "task" — bug|feature|task|epic
  "priority":      "high",           // optional, defaults to "medium" — low|medium|high|critical
  "assignee_id":   "USR_…",          // optional — written as a "Case Owner" membership
  "project_id":    "PRJ_…",          // optional — scope to a project
  "company_id":    "CMP_…",          // optional — scope to a company
  "error_message": "Polars error: …",// optional — for auto-triaged cases
  "category_id":   "CAT_…"           // optional — leaf or parent rid (see /categories)
}
```

Returns `201 Created` + the freshly hydrated `Case` (re-fetched through
the memberships + categories LATERALs so `*_display_name`s are
populated).

> **Reporter == Assignee edge.** When the session user is also the
> assignee, both relationships land on the same `(case, user)`
> membership pair. The composite PK `(object_redpash_id,
> user_redpash_id)` means Case Owner wins (`ON CONFLICT DO NOTHING`
> on the Reporter insert); the case shows a blank `reporter_id` in
> that rare scenario — Em's call to accept as reality rather than
> introduce a 3-part PK to disambiguate.

### Errors

| Status | `kind`            | When |
|--------|-------------------|------|
| 400    | `invalid`         | Empty `title` |
| 401    | `unauthenticated` | OAuth enabled, no session |
| 500    | `db`              | INSERT failed |

---

## `GET /api/cases/:rid`

The case detail. Three sections in one payload — case row + comments
(chronological ASC) + activity feed (audit-log `Event` rows filtered
by `context->>'case' = :rid`, ASC).

```jsonc
200 OK
{
  "case":     { /* Case */ },
  "comments": [ /* Comment[] */ ],
  "activity": [ /* Event[] — audit log */ ]
}
```

| Status | `kind`      | When |
|--------|-------------|------|
| 404    | `not_found` | Case RID missing |

---

## `PATCH /api/cases/:rid`

Sparse update. **Every non-None field emits its own
`case_<field>_change` event** through the audit-trail discipline — the
Activity feed renders "Em changed status from todo to in_progress" as a
discrete row, not a bundled multi-field diff. Assignee changes write
through to the `Case Owner` membership (DELETE the previous + INSERT
the new + `ON CONFLICT` upsert) in the same tx.

```jsonc
PATCH /api/cases/CAS_…
{
  "title":         "…",       // optional
  "description":   "…",       // optional
  "type":          "bug",     // optional
  "status":        "done",    // optional
  "priority":      "high",    // optional
  "assignee_id":   "USR_…",   // optional — membership transfer; empty string → unassign
  "project_id":    "PRJ_…",   // optional
  "company_id":    "CMP_…",   // optional
  "error_message": "…",       // optional
  "category_id":   "CAT_…"    // optional
}
```

Returns the updated `Case`.

| Status | `kind`      | When |
|--------|-------------|------|
| 404    | `not_found` | Case RID missing |

---

## `DELETE /api/cases/:rid`

Hard-delete the case via `delete_entity` (`DELETE FROM entities WHERE
id = $1`). The registry cascade takes out the `cases` row, its
`case_comments`, and its `memberships` (Reporter + Case Owner) — every
edge resolved by FK, no triggers.

```
204 No Content
```

| Status | `kind`      | When |
|--------|-------------|------|
| 404    | `not_found` | Case RID missing |

---

## `GET /api/cases/categories`

Flat list of categories the caller can pick from. v1 returns the global
/ built-in seed taxonomy; v3 will union per-company entries once RBAC
overlays per-user visibility.

```jsonc
200 OK
{ "items": [ /* Category[] */ ] }
```

Each row has `parent_id` (null = root) so the FE picker groups into a
hierarchy without a second fetch.

---

## Comments

### `GET /api/cases/:rid/comments`

Chronological thread (`ASC` by `created_at`). Same shape as the
embedded list on `CaseDetail`.

```jsonc
200 OK
{ "items": [ /* Comment[] */ ] }
```

### `POST /api/cases/:rid/comments`

```jsonc
POST /api/cases/CAS_…/comments
{ "body": "Repro confirmed on Polars 0.43 + merged cells in row 0." }
```

Author is the session user (FK is `ON DELETE SET NULL` so the comment
outlives the author's deletion — the thread keeps its evidence). The
freshly-minted `CMT_…` is returned.

### `PATCH /api/cases/:rid/comments/:cmt_rid`

Edit a comment in place. Sets `is_edited = true` and refreshes
`updated_at`. **Author-only** is the target gate; today dev-permissive
(`is_edited` flag is still flipped so the thread renders "(edited)").

```jsonc
PATCH /api/cases/CAS_…/comments/CMT_…
{ "body": "Updated repro: also fires on .xls + merged cells." }
```

### `DELETE /api/cases/:rid/comments/:cmt_rid`

Hard-delete. **Author-only** is the target gate; dev-permissive today.

```
204 No Content
```

---

## Activity feed (no endpoint)

The detail page's **Activity** tab is served as part of
[`GET /api/cases/:rid`](#get-apicasesrid). There is no separate
`/api/cases/:rid/activity` endpoint — by design, it shares the
[events](events.md) audit-log table (`SELECT * FROM events WHERE
context->>'case' = :rid ORDER BY occurred_at ASC`). Adding a new tracked
lifecycle field is just one more `event::record` call at the mutation
site — the feed picks it up for free.

---

## Related

- [events.md](events.md) — the audit-log table the Activity feed reads.
- [companies.md](companies.md) — `source=internal|external` resolves
  against the canonical RedPash company membership.
- [admin.md](admin.md) — the admin Cases list (paginated, cross-user).
- [`docs/internal/jira-flow-proposition/proposition.md`](../internal/jira-flow-proposition/proposition.md)
  — the workstream spec.
