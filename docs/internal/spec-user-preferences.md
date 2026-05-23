---
title: User preferences — object spec
section: Internal
last modified date: 2026-05-23
---

# `user_preferences` — object spec

> **Internal — RedPash team only.** Spec for promoting user prefs out
> of the current two-store split (`localStorage` on the client +
> `users.prefs` JSONB on the server, unsynced) into a first-class
> object with cross-device sync, per-key history, and queryable
> distribution. Gus, 2026-05-23, drafted in response to Em's "describe
> the object schemas for this new object, and how it'll work with the
> existing setup."

## TL;DR

1. **One new table.** `user_preferences` — `(user_redpash_id, key)` PK,
   `value` as JSONB, `updated_at` per row.
2. **`users.prefs` JSONB column retires.** Existing `learned_sentinels`
   + `share_sentinels` data migrates into rows; the column is dropped.
3. **One sync endpoint.** `PATCH /api/me/prefs` does sparse upsert. The
   existing `GET /api/me` keeps returning a flat `prefs: { key: value }`
   object — transparent to clients.
4. **`prefs.js` becomes an SWR cache** (exactly what its existing
   comment promises): boot-fetch seeds `localStorage`, `getPref`
   reads instantly, `setPref` writes localStorage + fires async PATCH.
5. **Cross-device sync becomes free.** A user signs in on another
   device and density / fontSize / etc. follow them.
6. **No frontend rewrite.** `getPref` / `setPref` keep their
   signatures. Setting page wiring unchanged. The change is invisible
   above the prefs.js helpers.

## 1. The current gap (why a new object)

[`monitoring-schemas.md §8`](monitoring-schemas.md#8-user-preferences-—-usersprefs-jsonb-and-the-clientserver-split)
documents the current state. Summary:

- **Client store** (`localStorage`): 5 UI prefs (`density`, `fontSize`,
  `rowsPerPage`, `showRowNumbers`, `showStageDots`) + theme.
- **Server store** (`users.prefs` JSONB): only `learned_sentinels` +
  `share_sentinels` are actually read/written. Patched through
  `PATCH /api/me`.
- **No sync.** A density change on device A is invisible on device B.
  The two stores hold disjoint key sets today.

The `prefs.js` source comment already names the intended endgame:

> *"When a user-prefs backend endpoint lands, the localStorage layer
> becomes an SWR cache and these helpers swap to hit
> `/api/users/:rid/prefs` underneath; the consumer-facing API doesn't
> change."*

This spec is that endpoint, with the storage object spec'd out.

## 2. Proposed schema

```sql
CREATE TABLE user_preferences (
    user_redpash_id  TEXT        NOT NULL
                     REFERENCES users(redpash_id) ON DELETE CASCADE,
    key              TEXT        NOT NULL,
    /* JSONB so we get scalar strings (density, fontSize), booleans
       (share_sentinels), and arrays (learned_sentinels) in one
       column without an enum-of-shapes per key. */
    value            JSONB       NOT NULL,
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_redpash_id, key)
);
CREATE INDEX user_preferences_user_idx ON user_preferences (user_redpash_id);
/* Optional, only if distribution queries get common —
   "what's the density distribution across the org?" */
-- CREATE INDEX user_preferences_key_idx  ON user_preferences (key);
```

### Why a separate table (not a column on `users`)

| Concern | `users.prefs` JSONB (today) | `user_preferences` table (proposed) |
|---|---|---|
| Per-key `updated_at` | ❌ One mtime for the whole blob | ✅ Per-row |
| Granular PATCH | Read-merge-write the whole JSONB | One row UPSERT |
| Distribution queries (`COUNT(*) WHERE key='density' GROUP BY value`) | JSONB introspection per row | Plain GROUP BY |
| Audit-trail extensibility (add `set_by`, `source`, `was_default`) | Schemaless drift | Real columns when needed |
| Row-bloat | A heavy `learned_sentinels` array bloats every full-user fetch | Heavy rows fetched only when their key is asked for |

### Why JSONB (not TEXT) for `value`

- Client-side: `localStorage` stores strings, but the values we hold
  are heterogeneous (`"compact"`, `"25"`, `true`, `["foo", "bar"]`).
  TEXT would force every caller to JSON-parse the value anyway.
- Server-side: distribution queries can introspect (`value = '"cozy"'::jsonb`,
  `WHERE value @> '"foo"'` for "users with `foo` in their sentinels").
- Wire: serde maps directly. No double-encoding.

### Why scalar (key, value), not row-per-user-with-columns

- New prefs ship without a migration. Add to the client's `PREFS`
  registry, ship a row, done.
- The pref *catalog* (the list of valid keys + their value rules)
  lives in the client `prefs.js` and a future server-side default
  registry. The table doesn't validate keys — it stores what's set.
  Defaults come from the registry on read, not from the DB.

## 3. How it works with the existing setup

### Read path

```
GET /api/me           — already exists; response gains a `prefs`
                        field built from a LEFT JOIN over
                        user_preferences. Same wire shape as today
                        (object of {key: value}); transparent to
                        clients. NO new endpoint required for read.
```

The server folds the rows into a flat object before returning:

```sql
SELECT json_object_agg(key, value) AS prefs
  FROM user_preferences
 WHERE user_redpash_id = $1
```

Empty result → `{}`. The client's `prefs.js` already merges with the
PREFS registry defaults on the read side, so unknown / missing keys
fall back gracefully.

### Write path

```
PATCH /api/me/prefs      ← new endpoint
  body: { prefs: { density: "compact", rowsPerPage: "50" } }
  →
    INSERT INTO user_preferences (user_redpash_id, key, value, updated_at)
    SELECT $1, key, value, now()
      FROM jsonb_each($2::jsonb) AS k(key, value)
    ON CONFLICT (user_redpash_id, key) DO UPDATE
      SET value = EXCLUDED.value, updated_at = now();
```

Sparse: only keys present in the patch are touched. Unmentioned keys
keep their existing values. To reset a key to default:

```
DELETE /api/me/prefs/:key   ← alternative, simpler than sentinel values
```

Or simpler still: omit `DELETE` for v1, document that "to reset, PATCH
with the default value." Add `DELETE` if a real use case emerges.

### Client integration — prefs.js becomes an SWR cache

**One cache, every pref.** Both UI prefs (`density`, `fontSize`, …)
and server-originated prefs (`learned_sentinels`, `share_sentinels`,
…) flow through the same localStorage SWR layer. No two-store
split survives this spec — that's the whole point.

```js
// On app boot (after /api/me resolves):
//   serverPrefs = response.prefs                // { density: "compact",
//                                                    learned_sentinels: [...],
//                                                    share_sentinels: true,
//                                                    ... }
//   for ([k, v] of Object.entries(serverPrefs)) localStorage.setItem(`rp-pref-${k}`, JSON.stringify(v))
//
// On setPref(name, value):
//   localStorage.setItem(`rp-pref-${name}`, JSON.stringify(value))
//   if (PREFS[name]?.attr) applyAllPrefs()      // CSS-driven prefs only
//   api.patch("/me/prefs", { prefs: { [name]: value } })
//                                               // fire-and-forget; errors retry on next page load
```

`getPref` signature unchanged. Settings page wiring unchanged. The
change is invisible above `prefs.js`.

### The client `PREFS` registry stays permissive

There are two kinds of prefs from the client's point of view:

| Class | Examples | Registry entry? | Caching |
|---|---|---|---|
| **UI prefs** — validated enum, CSS-reflected | density, fontSize, rowsPerPage, showRowNumbers, showStageDots | ✅ `PREFS[name]` declares `values: […]` + `default` + optional `attr` | localStorage |
| **Server-originated prefs** — opaque payloads consumed by specific code paths | learned_sentinels, share_sentinels, and any future server-set behavioral toggle | ❌ no registry entry needed | localStorage |

The registry governs *UI prefs' ergonomics* (default fallback when
storage is empty, value-list validation on `setPref`, `<html>`
attr reflection). Server-originated prefs don't need any of that —
they're cached as a transparent passthrough and read directly by
their consumers.

Concrete behavior:

```js
// UI pref — registry-governed
getPref("density")              // "compact" — validated against PREFS.density.values
setPref("density", "compact")   // writes localStorage, updates <html data-density>, PATCHes server

// Server-originated pref — passthrough
getPref("learned_sentinels")    // ["foo", "bar"] — JSON-parsed from localStorage, no validation
setPref("learned_sentinels", ["foo", "bar", "baz"])
                                // writes localStorage, PATCHes server, no <html> reflection
                                //   (no PREFS entry → setPref skips the attr/validation steps)
```

This keeps the registry focused on what it earns its keep on (CSS-
driven UX prefs), without it becoming the master list of every key
anyone might store. Adding a server-side pref needs zero client
work — it just appears in `/api/me`'s prefs object on the next boot,
caches automatically, and is `getPref`-readable.

**One small `getPref` / `setPref` API change** to make this work:
the helpers branch on whether `PREFS[name]` exists. Registered → run
the validation + attr path. Unregistered → JSON encode/decode the
value and pass through. ~10 LOC delta on prefs.js.

**localStorage key convention** changes from per-pref bespoke keys
(`rp-density`, `rp-font-size`, …) to a uniform `rp-pref-<name>`
namespace. Old keys migrate once at boot ("if `rp-density` exists,
move it to `rp-pref-density`, delete the old one"). Trivial; one-
shot.

### Migration of existing data

```sql
-- 1. Move existing learned_sentinels + share_sentinels into rows.
INSERT INTO user_preferences (user_redpash_id, key, value)
SELECT redpash_id, 'learned_sentinels', prefs -> 'learned_sentinels'
  FROM users
 WHERE prefs ? 'learned_sentinels'
   AND jsonb_typeof(prefs -> 'learned_sentinels') = 'array';

INSERT INTO user_preferences (user_redpash_id, key, value)
SELECT redpash_id, 'share_sentinels', prefs -> 'share_sentinels'
  FROM users
 WHERE prefs ? 'share_sentinels'
   AND jsonb_typeof(prefs -> 'share_sentinels') = 'boolean';

-- 2. Drop the JSONB column once readers are switched.
--    Done in a SECOND migration after the API code points at
--    user_preferences, not the column. Two-phase to avoid downtime
--    if any deployed instance still reads users.prefs.
-- ALTER TABLE users DROP COLUMN prefs;
```

## 4. What changes in the current workflow

| Surface | Today | After |
|---|---|---|
| Settings page change (density / fontSize / …) | Writes localStorage only. Server never knows. | Writes localStorage AND `PATCH /api/me/prefs`. Server-of-truth. |
| Sign-in on a second device | Default prefs (cozy / md / …). Surprising. | Prefs follow the user. |
| `GET /api/me` response shape | `prefs: <JSONB from users.prefs>` | Same — `prefs: <object built from user_preferences>`. Transparent. |
| `PATCH /api/me` with `prefs` field | Shallow-merges into `users.prefs` | **Deprecated** — moved to `PATCH /api/me/prefs`. Backward-compat: keep the old path forwarding for one release. |
| `learned_sentinels` / `share_sentinels` reads | `users.prefs -> 'learned_sentinels'` JSONB introspection | Per-row read; same flat-object shape returned by `/api/me` so the consumer in `me.rs` unchanged above the `value` extraction. |
| `users` table | `prefs` JSONB column carries everything | `prefs` column dropped (Phase 2 migration after readers switch). |

### What does NOT change

- `prefs.js` public API (`getPref` / `setPref` / `applyAllPrefs` /
  the `PREFS` registry).
- Settings page code.
- `<html>` data-attr reflection for CSS-driven prefs (density,
  fontSize, …).
- Theme handling (lives in `theme.js`, separate concern, untouched
  by this spec).

## 5. Wire DTOs

```rust
// crates/shared/src/user.rs — augment existing UserProfile to keep
// the same `prefs` field; the source switches under the hood.
pub struct UserProfile {
    // ...
    /// Flat { key: value } object built from user_preferences on
    /// the server. Same wire shape as today; the data source moves.
    pub prefs: serde_json::Value,
    // ...
}

// crates/shared/src/user.rs — PrefsPatch unchanged; the request
// shape stays { prefs: {key: value, ...} }. Route moves to
// PATCH /api/me/prefs.
pub struct PrefsPatch {
    pub prefs: serde_json::Value,
}

// Optional admin / inspector DTO if we ever want to see a user's
// pref rows with their per-key updated_at — not in the v1 scope.
// pub struct UserPreferenceRow {
//     pub key:        String,
//     pub value:      serde_json::Value,
//     pub updated_at: chrono::DateTime<chrono::Utc>,
// }
```

## 6. Endpoints (v1 scope)

| Endpoint | Body / params | Returns | Status |
|---|---|---|---|
| `GET /api/me` | — | `UserProfile` (now incl. server-of-truth `prefs`) | **existing — internal change only** |
| `PATCH /api/me/prefs` | `{ prefs: { k: v, ... } }` | `204` | **new** |
| `PATCH /api/me` with `prefs` field | (deprecated) | `200` for one release, then `400` with `deprecated_field` kind | **change** |

Out of scope for v1 (defer):

- `DELETE /api/me/prefs/:key` — reset-to-default. Workaround: PATCH
  with the default value.
- `GET /api/admin/users/:rid/prefs` — admin inspector. Add when
  support workflow needs it.
- `user_preference_changes` audit table — add when a real "who
  flipped this?" need surfaces. The events table can carry change
  events in the interim (kind = `pref_change`), or `updated_at` per
  row is sufficient.

## 7. Open decisions (need your weigh-in)

1. **Drop the `users.prefs` column, or leave it for catch-all
   server-side flags that don't deserve a row?** I'd vote drop —
   "one place per concern" beats schemas-with-escape-hatches. But
   if a future admin/support tool wants ad-hoc `users.prefs.foo`
   storage, leaving the column is one column's worth of optionality.
2. **Two-phase migration or single?** Two-phase (insert rows, switch
   readers, then drop column) is safer for any environment where
   the API and DB might be at different revisions during deploy.
   Solo-dev / localhost can do single-phase. Recommend two-phase as
   muscle memory for when prod ships.
3. **`PATCH /api/me` with `prefs` — deprecate or proxy forever?**
   Recommend one-release deprecation: forward to the new endpoint,
   warn in `tracing::warn` so audit catches stragglers, then
   tombstone with a 400 in the next release.
4. **Migrate the client's UI prefs in the same release, or land
   the table first and the client sync in a follow-up?** Recommend
   bundling — the value of the new table is the sync; landing the
   storage without the sync is shipping infra debt.

## 8. Scope estimate

| Slice | Files touched | LOC |
|---|---|---|
| Migration `0NN_user_preferences.sql` (table + index + data migration) | 1 new | ~40 |
| Backend: route `PATCH /api/me/prefs` + GET-folding into `/api/me` | `routes/me.rs` + `db.rs` | ~80 |
| Frontend: prefs.js boot-fetch + write-through | `frontend/scripts/prefs.js` + the boot wiring in `main.js` | ~30 |
| Backend: deprecate `PATCH /api/me` `.prefs` field with a forward | `routes/me.rs` | ~15 |
| Phase 2 migration: drop `users.prefs` column (separate commit, after readers switch) | 1 new migration | ~5 |
| Total | 5 files, 2 migrations | ~170 LOC |

Half a day of focused work end-to-end. Aim for one PR with the v1
slice (everything except the Phase 2 column drop, which lands
separately).

## 9. Open spikes (concrete, runnable)

None — the design is well-grounded in the existing surfaces; nothing
requires "measure this first" to commit to. The two judgment calls
(JSONB vs TEXT for value, separate table vs JSONB column on users)
were both made above on engineering grounds, not on data this spec
needs.

— Gus
