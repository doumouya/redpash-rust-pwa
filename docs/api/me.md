---
title: Me
section: API
order: 2
last modified date: 2026-05-29
---

# `/api/me`

The session user's profile. Single endpoint, but the resolution logic
behind it (`resolve_user_rid`) is reused by **every** owner-scoped
handler in the codebase — so this page doubles as the spec for "who is
this request for?"

**Route file:** [`crates/api/src/routes/me.rs`](../../backend/crates/api/src/routes/me.rs)
**DTO:** [`shared::user::UserProfile`](../objects/user.md)

---

## `GET /api/me`

Returns the `UserProfile` for whoever owns the request.

### Resolution order

1. **`rp_session` cookie present** → look up `sessions.session_id` → if
   the row is unexpired, return its user.
2. **No session cookie + OAuth unconfigured** → fall back to the
   bootstrap `dev_user`. This is local-dev mode — there is exactly one
   user record per machine.
3. **No session cookie + OAuth configured** → `401 unauthenticated`.
   The frontend's `api.js` catches this and redirects the browser to
   `#/landing`.

### Response

```jsonc
200 OK
{
  "redpash_id":   "USR_5F3C7A21D8E94B6E92A1C0F4B3D7E0A2",
  "username":     "em.doumouya.5f3c7a21",
  "email":        "em.doumouya@gmail.com",
  "display_name": "Emmanuel Doumouya",
  "avatar_url":   "https://lh3.googleusercontent.com/a/…",
  "job_title":    null,
  "organisation": null,
  "use_case":     null,
  "plan":         "free",
  "locale":       "en",
  "prefs":        {},
  "global_sentinels": ["???", "ndispo"]
}
```

`google_sub` is **not** returned — it's a private auth detail kept in
the row but stripped from the DTO.

See [objects/user.md](../objects/user.md) for the full field reference.

### `global_sentinels` — shared cleanness vocabulary

The `/api/me` payload is wrapped in a `MeResponse` envelope that
`#[serde(flatten)]`s the `UserProfile` and adds session-scoped
context the frontend needs at bootstrap. Today: `global_sentinels` —
the canonical sentinel values that have been flagged by **at least 2
distinct users** via the Cleaner's *Fix invalid values* modal (see
[features/cleanness.md](../features/cleanness.md) and
the workspace cleaner mode in [features/cleaner.md](../features/cleaner.md)).

The list is sourced from the `global_sentinels` view (a
`COUNT(DISTINCT user_id) >= 2 GROUP BY canonical` over
`sentinel_submissions`). Frontend caches it in `STATE.globalSentinels`
on cleaner mount and unions it with `prefs.learned_sentinels` +
this-session ad-hoc additions before every `?extra=` scan call.

The envelope lives only on `GET /api/me` — other `UserProfile`
returning endpoints (`/api/users`, `find_user_by_id` callers) keep the
plain DTO shape.

### Errors

| Status | `kind`              | When |
|--------|---------------------|------|
| 401    | `unauthenticated`   | OAuth enabled and no valid `rp_session` cookie |
| 404    | `not_found`         | Session cookie pointed at a deleted user row (rare; race with manual DB cleanup) |
| 500    | `db` / `internal`   | Postgres unreachable / unexpected error |

---

## `resolve_user_rid` (the shared helper)

The resolver is exported as `pub` from `routes::me` and re-exported as
`pub(crate)` from `routes::mod`. Every owner-scoped handler calls it
first:

```rust
async fn list(State(state): State<AppState>, headers: HeaderMap)
    -> Result<Json<…>, AppError>
{
    let user = super::resolve_user_rid(&state, &headers).await?;
    // …owner-scoped query…
}
```

**Every** owner-scoped handler now calls it — list endpoints
(`/api/projects`, `/api/charts`, `/api/dashboards`, `/api/cases`),
upload (`POST /api/files/upload`), `PATCH /api/me` / `/api/me/prefs`,
**and** every detail handler on `/api/{projects,charts,dashboards,files,cases}/:rid/*`.
Detail handlers pair it with the ownership gate below.

## `ensure_owner` (the shared 404 gate)

```rust
super::ensure_owner(
    db::project_owner(&state.db, &rid).await,  // Result<Option<owner_rid>>
    &user, "project", &rid,
)?;
```

Re-exported from `routes::mod` as `pub(crate)`. Pairs with one of the
lookup helpers — `project_owner`, `chart_owner`, `dashboard_owner`,
`file_owner` — each of which now resolves through the **owner-membership
LATERAL** (`memberships WHERE role='owner' ORDER BY joined_at LIMIT 1`)
instead of the dropped `projects.owner_id` column (post-mig 024). 404
with `kind="not_found"` on **both** "resource doesn't exist" and
"exists but not yours" — same message format so the existence of
someone else's resource is never leaked.

---

## `PATCH /api/me`

Sparse update of the session user's profile fields. Every field is
optional — `COALESCE` keeps any unsent column. **Prefs no longer live on
this endpoint** — `users.prefs` was dropped in mig 020 (prefs moved to
the [`user_preferences`](../db/schema.md#user_preferences) table). Use
[`PATCH /api/me/prefs`](#patch-apimepref) below for prefs writes; this
endpoint accepts a `prefs` field for one release as a deprecation forward
(routed to `/api/me/prefs` with a `tracing::warn`; next release returns
`400 deprecated_field`).

### Request body

```jsonc
{
  "display_name": "Emmanuel",            // optional — overwrites column
  "first_name":   "Emmanuel",
  "last_name":    "Doumouya",
  "job_title":    "Ops analyst",
  "organisation": "Acme",
  "use_case":     "weekly dossier exports",
  "locale":       "fr"
}
```

Server side: `UPDATE users SET <col> = COALESCE($n, <col>), …,
updated_at = now() WHERE redpash_id = $1 RETURNING …`.

---

## `PATCH /api/me/prefs`

Sparse upsert into [`user_preferences`](../db/schema.md#user_preferences)
for the session user. Body shape: `{ prefs: { key: value, … } }` — only the
keys present in the patch are written; unmentioned keys stay. JSONB values
(scalars, arrays, booleans) land verbatim. Returns `204 No Content`.

```jsonc
PATCH /api/me/prefs
{
  "prefs": {
    "theme":            "dark",
    "learned_sentinels": ["n/a", "?", "to-confirm"]
  }
}
```

The Settings page sends only `{ prefs: { … } }`; the Profile page hits
`PATCH /api/me` for the profile fields.

### Side-effect: sentinel learning loop

When the patch's merged `prefs.learned_sentinels` adds any new entries
**and** `prefs.share_sentinels === true`, the handler also writes one
row per *newly-added* canonical to `sentinel_submissions` via
`db::record_sentinel_submission`. This is the consent gate from the
shared-sentinel learning loop:

- The client is never trusted to perform the submission itself — the
  PATCH-handler diffs the prior `learned_sentinels` against the
  post-merge value and writes only the **new** entries.
- `share_sentinels === false` or `null` → personal `learned_sentinels`
  still persists, no DB write to `sentinel_submissions`.
- Insert failures are logged (`tracing::warn`) but never fail the
  PATCH — the user's personal pref landed; the global signal is
  best-effort.

See [features/cleanness.md](../features/cleanness.md) for how
submissions are promoted to the shared vocabulary and used by the
scorer; the Cleaner modal flow lives in
the workspace cleaner mode in [features/cleaner.md](../features/cleaner.md).

### Response

The refreshed `UserProfile` — same shape as `GET /api/me`.

### Errors

| Status | `kind`              | When |
|--------|---------------------|------|
| 401    | `unauthenticated`   | OAuth enabled, no session |
| 404    | `not_found`         | Session user row vanished mid-request (defensive) |
| 500    | `db`                | UPDATE failed |

The frontend's [`/profile`](../../frontend/scripts/pages/profile.js)
page sends every editable field on submit (no dirty-tracking); the
[`/settings`](../../frontend/scripts/pages/settings.js) page sends only
`{prefs: {…}}`.

---

## Related

- [auth.md](auth.md) — how the `rp_session` cookie gets minted.
- [objects/user.md](../objects/user.md) — DTO + table schema.
- [auth/google.md](../auth/google.md) — full OAuth setup walkthrough.
