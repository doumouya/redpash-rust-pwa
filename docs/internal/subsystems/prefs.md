---
title: User preferences
section: Internal
order: 26
last modified date: 2026-05-24
owners: Gus (table + endpoints) + Torv (SWR cache + boot apply)
status: filled
---

# User preferences

Two-layer model: server `user_preferences` table is the source of
truth; client `localStorage` is a write-through SWR cache so
`getPref(name)` is synchronous and first paint sees user-of-truth
values instead of defaults.

Spec + decision history: [specs/user-preferences](../specs/user-preferences.md).
Source of truth: `backend/crates/api/src/db.rs` (`get_user_prefs` /
`patch_user_prefs`), `backend/crates/api/src/routes/me.rs`
(`patch_me_prefs` + the deprecation forward), `frontend/scripts/prefs.js`,
`frontend/index.html` (FOUC-safe inline apply).

## Storage layout

```
public.user_preferences (mig 023)
├── user_redpash_id  TEXT  FK→users ON DELETE CASCADE
├── key              TEXT
├── value            JSONB
├── updated_at       TIMESTAMPTZ
└── PRIMARY KEY (user_redpash_id, key)
```

JSONB value — accepts scalars, arrays, booleans without an enum-
of-shapes per key. Per-key `updated_at` gives free per-pref change
history.

There is **no schema CHECK on `key`**. The pref catalog lives in
the client (`frontend/scripts/prefs.js::PREFS`) plus the engine's
own consumers (`learned_sentinels` etc.); adding a new pref needs
zero schema change. New keys just appear as new rows.

The legacy `users.prefs` JSONB column was dropped in migration 024
(commit `4443210`); no fallback / dual-store remains.

## Two pref classes

The client's `PREFS` registry is intentionally **permissive** — it
only governs UI prefs that need validation + `<html>` data-attr
reflection. Everything else is a passthrough.

| Class | Examples | Registry entry? | Behavior |
|---|---|---|---|
| **UI prefs** | `density`, `fontSize`, `rowsPerPage`, `showRowNumbers`, `showStageDots` | ✅ entry with `values: [...]` + `default` + optional `attr` | Validated against enum; `setPref` reflects to `<html data-<attr>>`; `getPref` returns default when cache empty / malformed |
| **Server-originated prefs** | `learned_sentinels`, `share_sentinels`, future feature toggles | ❌ no entry needed | Cached as transparent passthrough; readable via `getPref(name)`; no validation, no attr; consumer-specific code reads them |

Adding a new UI pref requires a registry entry; adding a new
server-side toggle (a server reads `users.prefs` directly today,
or via a future `prefs::flag(...)` helper) requires no client
change at all — it just appears in `/api/me`'s `prefs` object on
the next boot and caches automatically.

## Read path — `GET /api/me`

The endpoint folds `user_preferences` rows into a flat
`prefs: { key: value }` JSON object via a subquery:

```sql
SELECT u.*,
       COALESCE(
         (SELECT jsonb_object_agg(p.key, p.value)
            FROM user_preferences p
           WHERE p.user_redpash_id = users.redpash_id),
         '{}'::jsonb
       ) AS prefs,
       ...
  FROM users u
 WHERE u.redpash_id = $1
```

Wire shape on `UserProfile.prefs` is unchanged from when it
sourced from `users.prefs` JSONB — every consumer that read
`session.prefs.X` keeps working transparently. Wire contract:
[specs/user-preferences](../specs/user-preferences.md).

## Write path — `PATCH /api/me/prefs`

Body: `shared::user::PrefsPatch { prefs: serde_json::Value }`.
Sparse upsert; only keys present in the patch are written:

```sql
INSERT INTO user_preferences (user_redpash_id, key, value, updated_at)
SELECT $1, kv.key, kv.value, now()
  FROM jsonb_each($2::jsonb) AS kv(key, value)
ON CONFLICT (user_redpash_id, key) DO UPDATE
   SET value      = EXCLUDED.value,
       updated_at = now();
```

Returns `204 No Content` on success.

### The `share_sentinels` gate

Privacy-impacting toggle that has to live in the only write path.
After every prefs PATCH:

1. Snapshot `learned_sentinels` from *before* the patch
   (`find_user_by_id`).
2. Apply the patch (`patch_user_prefs`).
3. Re-read; if post-patch `share_sentinels === true`, diff
   `learned_sentinels` and mirror **new** entries to the shared
   `sentinel_submissions` table — with the user's RID.

The gate lives server-side because the client can't be trusted to
skip a consent dialog and then directly PATCH `learned_sentinels`.

See [data-engine §sentinels](data-engine.md#sentinels--global--per-user)
for the global promotion path.

## Deprecation forward — `PATCH /api/me` with `prefs` field

For one release, `PATCH /api/me` with a `prefs` field still works
— forwards to `apply_prefs_patch` with a `tracing::warn` so any
straggler caller surfaces in the log. Next release lands a
400 `kind="deprecated_field"`. Decoupled from the migration 024
column drop (which already happened) because they're independent
retirements.

## Client side — `frontend/scripts/prefs.js`

Three exports the rest of the codebase touches:

| Function | Purpose |
|---|---|
| `getPref(name)` | Synchronous read. Registered: validation + default fallback. Unregistered: JSON-parse + passthrough (`null` if uncached). |
| `setPref(name, value)` | Write. Registered: enum-validated; reflects to `<html>` attr. All: writes localStorage + fire-and-forget PATCH `/api/me/prefs`. |
| `seedPrefs(serverPrefs)` | Called once at boot by `main.js::loadSession`. Overwrites localStorage from the server's `prefs` object + reapplies CSS-attr prefs. |
| `applyAllPrefs()` | Iterates the registry; writes each registered pref's value to `<html data-<attr>>`. Safe to call repeatedly. |

### localStorage namespace

Unified to `rp-pref-<name>` (e.g. `rp-pref-density`,
`rp-pref-learned_sentinels`). Values are **always JSON-encoded** so
the cache handles strings, arrays, booleans, numbers identically:

```
localStorage["rp-pref-density"]            === '"compact"'
localStorage["rp-pref-learned_sentinels"]  === '["foo","bar"]'
localStorage["rp-pref-share_sentinels"]    === 'true'
```

Legacy migration runs once at module load — moves `rp-density`,
`rp-font-size`, `rp-rows-per-page`, `rp-show-rownum`,
`rp-show-stage-dots` into the new namespace (JSON-encoding the
raw string), then removes the old keys.

### FOUC-safe inline apply

`frontend/index.html` runs a tiny inline `<script>` *before* any
module loads so the visual prefs (`theme`, `density`, `fontSize`)
land on `<html>` data attrs before the CSS evaluates — no flash of
the wrong sizing on first paint.

The inline script reads **both** the new `rp-pref-*` namespace
(JSON-decoded) and the legacy keys (raw strings), so the
transitional window — first load after migration 023 / new
prefs.js code lands, before the in-module migration runs — doesn't
flash. After one release of soak this dual-read can drop to
new-only.

## Write-through semantics

`setPref(name, value)` is **optimistic**:

1. Writes localStorage immediately (synchronous; the next
   `getPref` returns the new value).
2. Reflects to `<html data-<attr>>` if the pref is CSS-driven.
3. Fires `api.patch("/me/prefs", { prefs: { [name]: value } })`
   fire-and-forget.

A network failure on the PATCH:

- Doesn't fail the user action (the local cache + reflection
  already landed).
- Doesn't retry (would have been useful for offline mode; not in
  scope today).
- Resolves on the *next* boot — `seedPrefs(session.prefs)`
  overwrites localStorage from the server's authoritative state.
  So a failed write effectively reverts on the next page load
  (the server doesn't know about it).

For the rare keys where eventual consistency would be bad (e.g.,
`share_sentinels` — opting in vs out has real consequences), the
write-through has to land before the user sees confirmation. The
Settings page wires those with `await` per their reactivity needs.
Today there are no such keys; `share_sentinels` is currently the
edge case if/when the UI exposes it.

## Pref catalog (current)

UI prefs (registered):

| Name | Values | Default | CSS attr |
|---|---|---|---|
| `density` | `compact / cozy / comfortable` | `cozy` | `data-density` |
| `fontSize` | `sm / md / lg` | `md` | `data-fontSize` |
| `rowsPerPage` | `10 / 25 / 50 / 100 / all` | `25` | — (read by JS) |
| `showRowNumbers` | `1 / 0` | `1` | `data-showRownum` |
| `showStageDots` | `1 / 0` | `1` | `data-showStageDots` |

Server-originated prefs (passthrough):

| Name | Type | Used by |
|---|---|---|
| `learned_sentinels` | `string[]` | Cleaner's Fix-invalid modal (`reads via getPref`); server-side merge with global sentinels in `/api/me`. |
| `share_sentinels` | `bool` | The PATCH gate (server-side); future Settings toggle (client-side). |

Theme (`rp-theme` → `<html data-theme>`) lives separately in
`frontend/scripts/theme.js` — pre-dated the prefs consolidation
and has its own boot wiring. Treat it like the other UI prefs
mentally; the implementation is just historically split.

## Adding a new pref

**UI pref** (validated, CSS-reflected):

1. Add a registry entry in `frontend/scripts/prefs.js::PREFS`:
   `{ values: [...], default: "X", attr: "<dataAttrName>" | null }`.
2. If `attr` is set, add the matching CSS selectors
   (`html[data-<attr>="..."] { ... }`).
3. If the pref needs a UI control, add it to the Settings page.
   `setPref(name, newValue)` is the only thing that wires.

**Server-side pref** (a server-read flag, e.g. a feature gate):

1. Just read it server-side via `users.prefs.X` — wait, no — read
   the actual `user_preferences` row via `db::get_user_prefs(pool,
   user_rid).await?` (or a more specialized helper). It'll appear
   in `/api/me`'s `prefs` object automatically; the client caches
   it without registry changes.
2. If the client needs to read it too, just `getPref(name)` —
   returns the JSON-parsed value if cached, `null` otherwise.

## Cross-cuts

- **Sync timing matters at boot.** `seedPrefs` is called inside
  `loadSession()` *after* the `/api/me` response lands and
  *before* any page mounts. If a route's first render reads
  `getPref(...)`, it sees the server-of-truth value — not the
  prior session's cache. The inline FOUC script handles the
  pre-`loadSession` paint for CSS-reflected prefs.
- **Cross-device sync is free.** Sign in on a second device,
  `seedPrefs` overwrites that device's local cache with the
  server state. The cache is a cache, not a source.
- **No prefs change history (yet).** Per-row `updated_at` is the
  primitive; if a real "who changed what, when" need surfaces, the
  events table can carry it (`kind = "pref_change"`) or a sibling
  `user_preference_changes` table lands. Out of scope today.
- **Future admin inspector.** Spec §6 reserves
  `GET /api/admin/users/:rid/prefs` for support workflows; not
  built yet.
