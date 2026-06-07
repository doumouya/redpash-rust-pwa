---
title: UserPreference — object metadata
section: Internal
order: 51
last modified date: 2026-05-30
owner: Torv
status: draft — per the object-metadata sweep ([index](index.md))
---

# UserPreference (user_preferences row)

One key-value preference for one user. Composite PK `(user_redpash_id,
key)` — no `redpash_id`, never URL-addressable. Promoted out of the
`users.prefs` JSONB column in mig 023 (`users.prefs` itself dropped
in mig 024) so per-key writes don't race + SWR-friendly clients can
cache per-key values + one bug in a pref can't corrupt the rest of
the JSONB blob.

Folded back into the `UserProfile.prefs` field at SELECT time via
a correlated subquery (`COALESCE(jsonb_object_agg(p.key, p.value),
'{}'::jsonb)`); from the wire's perspective the user still has a
single `prefs: {…}` object, but the storage is row-per-key.

**Backing table:** `user_preferences` (migration
`20260606000001_user_preferences.sql`, ord 023).
**DTO:** `backend/crates/shared/src/user.rs::PrefsPatch` (the PATCH
body shape). No "UserPreference" DTO — the surface IS the merged
`prefs: serde_json::Value` field on UserProfile.
**Routes:** `backend/crates/api/src/routes/me.rs` (PATCH
`/api/me/prefs` — the sparse-upsert path).

Key registry lives **client-side** at
`frontend/scripts/prefs.js#PREFS` — pref names + enum value sets +
defaults + the `<html>` data-attr they reflect to. Server is
agnostic about the meaning of any key; it stores whatever JSON the
client sends.

---

## Supported calls

| Verb | Wire | Notes |
|---|---|---|
| `upsert` | `PATCH /api/me/prefs` | Body: `PrefsPatch { prefs: { <key>: <value>, … } }`. Sparse — only the keys present overwrite. Empty / non-object input is a no-op (early return). Each top-level key in the body lands as one INSERT … ON CONFLICT DO UPDATE on `user_preferences`. Server-resolved user from the session. Returns 204; no body. |
| `delete (per-key)` | `PATCH /api/me/prefs` with `value: null` | Setting a key to JSON `null` deletes the row (FE convention; server doesn't yet specialise the delete path — the row carries `value: null` literal today). Will be tightened to a DELETE FROM in a follow-up when the FE consumer count justifies a dedicated path. |
| `read` | `GET /api/me` | Merged into `UserProfile.prefs` via the correlated subquery. No standalone `/api/me/prefs` GET — the wire shape is "always merged into the profile envelope". |
| `create / update / delete (per-row)` | — | **Not supported as user-facing per-row paths.** The row is the storage unit; the wire is always `(user, prefs_object)`. |
| `list` | — | **Not supported.** No `/api/admin/user-preferences` today; if RBAC needs cross-user pref auditing it'd ship as a new admin endpoint. |
| `search` | — | **Not supported.** |

---

## Fields

```
user_redpash_id
  Type:        TEXT NOT NULL / String — FK to users.redpash_id
  Properties:  Layout
  Description: The owning user. Part of the composite PK with
               `key`. CASCADE on user delete (prefs vanish with
               the user). Server-resolved from session on every
               PATCH — never client-settable.
```

```
key
  Type:        TEXT NOT NULL / String
  Properties:  Create, Layout
  Description: Pref name. Part of the composite PK. Free-text
               at the DB layer — registry + validation live in
               `frontend/scripts/prefs.js#PREFS`. Today's keys
               (non-exhaustive — registry grows):
                 theme, density, fontSize,
                 rowsPerPageWorkspace, rowsPerPageHome,
                 rowsPerPageMonitoring,
                 showRowNumbers, showStageDots,
                 csvDelimiter, csvEncoding, exportFormat,
                 share_sentinels, learned_sentinels,
                 monitoringCharts, homeCharts, homeActiveTab,
                 rail_hidden_projects, rail_hidden_files,
                 home_hidden_<tabKey>, cases_hidden.
```

```
value
  Type:        JSONB NOT NULL / serde_json::Value
  Properties:  Create, Update
  Description: Pref value. Scalar (theme: "dark"), boolean
               (share_sentinels: true), array
               (learned_sentinels: ["n/a", "?"]), object
               (monitoringCharts: { events: […], runs: […] })
               — JSONB carries any shape. Validation is
               client-side: the FE PREFS registry pins the
               enum value sets for registered keys; un-registered
               keys accept any JSON-encodable value.
```

```
updated_at
  Type:        TIMESTAMPTZ NOT NULL DEFAULT now() / chrono::DateTime<Utc>
  Properties:  (none — internal)
  Description: Set on INSERT, bumped on every UPDATE (the upsert
               SQL writes `updated_at = now()` in the ON CONFLICT
               clause). Not surfaced on the merged
               UserProfile.prefs object; investigation-only.
```

---

## Enum constraints

The pref **key** allow-list is enforced client-side at
`frontend/scripts/prefs.js#PREFS`. Registered keys (the ones in
PREFS) validate values against their enum `values: [...]` array
on every `setPref` call — invalid values are silently rejected
and `getPref` falls back to the registered `default`. Un-registered
keys (e.g. the dynamic per-tab `home_hidden_<tabKey>` family)
accept any JSON-encodable value.

Server is **agnostic** about the meaning of any key. The DB has
no CHECK constraints on `key` or `value`; pref enums live in the
registry where they can change without a migration. This was the
explicit design choice in mig 023 — adding a new pref needs zero
schema change.

`value`'s legal JSON types: scalar / boolean / array / object —
JSONB carries any. Most prefs use scalars or booleans (theme,
density, share_sentinels). A few use arrays
(learned_sentinels) or objects (monitoringCharts /
rail_hidden_*) for richer state.

---

## Relationships

```
user_redpash_id → User (USR_)
  Cardinality:  N:1 (a User has many UserPreference rows)
  On delete:    CASCADE (deleting a user drops their prefs)
  Hydrated as:  — (prefs surface as the merged JSONB blob on
                UserProfile.prefs; the row itself is never on
                the wire)
```

### Inverse relationships

```
UserPreference has no sub-rows.
```

---

## Audit events

Every `PATCH /api/me/prefs` emits one `me_prefs_update` event with
`context: { user, keys: [<names>] }` — **keys only**, never the values
(pref values may carry user content like `learned_sentinels`). The
event is emitted on the `me` lane — see
[user](user.md#audit-events). Pref writes are high-frequency (theme
toggle, density slider, font-size pick), so the keys-only shape keeps
the events stream investigable without ballooning it with user content.

Finer-grained per-key auditing (e.g. `pref_update` with
`context: { key, prev, next }` and a `pref_delete` for the null-value
path) is a possible future split following the `<object>_<verb>`
pattern, but is not emitted today.
