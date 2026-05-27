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
Source of truth: `backend/crates/api/src/db/users.rs`
(`patch_user_prefs` lives in the users sub-module; the read path goes
through `find_user_by_*` which folds prefs in via the correlated
`user_preferences` subquery), `backend/crates/api/src/routes/me.rs`
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

## Rust internals — server table + share_sentinels gate

### `patch_user_prefs` — sparse upsert

```rust
pub async fn patch_user_prefs(
    pool:  &PgPool,
    rid:   &str,
    patch: &serde_json::Value,
) -> sqlx::Result<()> {
    let Some(obj) = patch.as_object() else { return Ok(()); };
    if obj.is_empty() { return Ok(()); }
    sqlx::query(
        "INSERT INTO user_preferences (user_redpash_id, key, value, updated_at)
         SELECT $1, kv.key, kv.value, now()
           FROM jsonb_each($2::jsonb) AS kv(key, value)
         ON CONFLICT (user_redpash_id, key) DO UPDATE
            SET value      = EXCLUDED.value,
                updated_at = now()",
    )
    .bind(rid)
    .bind(patch)
    .execute(pool)
    .await?;
    Ok(())
}
```

**Single SQL statement** for the whole patch — `jsonb_each`
expands the JSON object into rows; `INSERT … SELECT … ON CONFLICT
DO UPDATE` upserts each one. Trip to the DB: 1 round-trip.
Atomicity: per-row (each key is its own UPSERT inside the
implicit transaction; no whole-patch rollback). Acceptable
because prefs are independent — a partial write is no worse than
the final state of the keys that did land.

**Early-return on empty patch**: `PATCH /api/me` with no `prefs`
field returns `Some(serde_json::Value::Null)` from the body
parser; the `as_object()` returns None and we return `Ok(())`
without a DB hit.

### `get_user_prefs` via subquery — no separate function call

The "read prefs for user" path doesn't exist as a standalone
helper — it's folded into `find_user_by_id` / `find_user_by_username`
/ `list_users` / etc. via the subquery:

```sql
SELECT u.redpash_id, u.username, ..., 
       COALESCE(
         (SELECT jsonb_object_agg(p.key, p.value)
            FROM user_preferences p
           WHERE p.user_redpash_id = users.redpash_id),
         '{}'::jsonb
       ) AS prefs,
       u.first_name, u.last_name
  FROM users u
 WHERE u.redpash_id = $1
```

**Why subquery, not JOIN**: a JOIN would multiply rows when the
user has multiple prefs (one row per pref). `jsonb_object_agg`
inside a correlated subquery folds the prefs back into a single
JSON object before returning — keeps the user row as one row.

**`COALESCE(…, '{}'::jsonb)`**: a user with zero prefs returns
the empty object instead of NULL. The wire shape stays consistent
(always an object).

### The `share_sentinels` gate — diff algorithm

```rust
async fn apply_prefs_patch(
    state:    &AppState,
    user_rid: &str,
    patch:    &serde_json::Value,
) -> Result<(), AppError> {
    let prior_learned = db::find_user_by_id(&state.db, user_rid).await?
        .and_then(|u| canon_str_array(u.prefs.get("learned_sentinels")))
        .unwrap_or_default();

    db::patch_user_prefs(&state.db, user_rid, patch).await?;

    let after_user = db::find_user_by_id(&state.db, user_rid).await?
        .ok_or_else(|| AppError::not_found("not_found", "current user not found"))?;

    let share: bool = after_user.prefs.get("share_sentinels")
        .and_then(|v| v.as_bool()).unwrap_or(false);
    if share {
        let after = canon_str_array(after_user.prefs.get("learned_sentinels")).unwrap_or_default();
        let prior_set: HashSet<&String> = prior_learned.iter().collect();
        for canonical in after.iter().filter(|s| !prior_set.contains(s)) {
            if let Err(e) = db::record_sentinel_submission(&state.db, canonical, user_rid).await {
                tracing::warn!(error = %e, canonical, "sentinel_submissions insert failed (non-fatal)");
            }
        }
    }
    Ok(())
}
```

**The diff is post-patch, not pre-patch**: we read prefs *after*
the patch lands. Why? The patch might be:
- `{ share_sentinels: true }` alone — turning on sharing without
  changing the learned set. No new entries to share.
- `{ learned_sentinels: [...] }` alone — adding entries while
  share is already true. Diff matters.
- Both together — adding entries AND turning on sharing in one
  PATCH. Diff against the prior (un-shared) state ships every
  new entry.

The pre-patch snapshot of `learned_sentinels` is the baseline;
the post-patch state is what's now committed. The diff
(`after - prior`) is the set of *new* entries the user added in
this PATCH that should mirror to the shared table.

**`canon_str_array` — normalization helper**:

```rust
fn canon_str_array(v: Option<&serde_json::Value>) -> Option<Vec<String>> {
    let arr = v?.as_array()?;
    let mut out: Vec<String> = arr.iter()
        .filter_map(|x| x.as_str().map(|s| s.trim().to_ascii_lowercase()))
        .filter(|s| !s.is_empty())
        .collect();
    out.sort();
    out.dedup();
    Some(out)
}
```

- `trim().to_ascii_lowercase()` — canonical form for matching.
  Otherwise `"N/A"` vs `"n/a"` would look distinct to the diff.
- `sort().dedup()` — set semantics for the comparison; the JSON
  array may have duplicates if a careless client double-submits.

**Submission failures are non-fatal**: the user's personal pref
already landed; if the shared-sentinel insert fails (DB
transient), we `warn` and skip. The pref is the user's; the
shared signal is best-effort.

**Race window**: between the pre-snapshot and the patch, another
PATCH could land for the same user. In practice impossible
(serialized per-user via the session), but if multi-device
concurrent edits ever become a thing, the diff could include a
"new" entry that was actually added by the other request. Minor
overcounting in `sentinel_submissions`; the `(canonical, user_id)`
PK absorbs the duplicate via the ON CONFLICT DO NOTHING in
`record_sentinel_submission`.

## JS internals — prefs.js implementation

### `setPref` write-through

```js
export function setPref(name, value) {
  const spec = PREFS[name];
  if (spec && !spec.values.includes(value)) return false;
  try { localStorage.setItem(storageKey(name), JSON.stringify(value)); }
  catch { /* private mode — non-fatal; the server PATCH below still goes */ }
  if (spec?.attr) document.documentElement.dataset[spec.attr] = value;
  api.patch("/me/prefs", { prefs: { [name]: value } })
     .catch((err) => {
       if (err && err.status && err.status !== 401) {
         console.warn("[prefs] write-through failed for", name, err);
       }
     });
  return true;
}
```

**Three-stage commit**:

1. **localStorage** — synchronous, fire-and-forget. May throw in
   private mode; caught silently.
2. **`<html>` data-attr** — synchronous, only for registered
   prefs with `attr`. Triggers CSS recompute.
3. **Server PATCH** — async, fire-and-forget. Cancellation
   doesn't happen (no AbortController); a stale call from before
   a rapid follow-up will land *after* the follow-up, potentially
   overwriting it. In practice the next boot's `seedPrefs`
   reconciles.

**Race window** of step 3: two `setPref(density, ...)` in quick
succession might land out-of-order on the server. The "stale
overwrites fresh" outcome reverts on next boot's seedPrefs. For
critical prefs (today none), use `await api.patch(...)`
explicitly — matters for `share_sentinels` if a UI ever exposes
toggling it.

**401 silent**: during the brief window between page load and
login completion, prefs.js's setPref calls 401. Logging those as
warnings would noise the console; skipped.

### `getPref` read

```js
export function getPref(name) {
  const spec = PREFS[name];
  let raw;
  try { raw = localStorage.getItem(storageKey(name)); }
  catch { return spec ? spec.default : null; }
  if (raw == null) return spec ? spec.default : null;
  let parsed;
  try { parsed = JSON.parse(raw); } catch { parsed = raw; }
  if (spec) {
    return spec.values.includes(parsed) ? parsed : spec.default;
  }
  return parsed;
}
```

**Three sources of "default" on registered prefs**: storage
unavailable, storage empty, stored value not in the enum's
`values` list. All three fall back to `spec.default` —
defensive against a manual localStorage edit that broke the
shape.

**JSON.parse fallback to raw string**: if a cached value
predates the JSON-encoding migration (rare; would only happen if
the legacy-key migration's storage call failed mid-flight), the
raw string fallback keeps the read working.

### Legacy migration

```js
const LEGACY_KEYS = {
  density:        "rp-density",
  fontSize:       "rp-font-size",
  rowsPerPage:    "rp-rows-per-page",
  showRowNumbers: "rp-show-rownum",
  showStageDots:  "rp-show-stage-dots",
};
try {
  for (const [name, legacyKey] of Object.entries(LEGACY_KEYS)) {
    const v = localStorage.getItem(legacyKey);
    if (v == null) continue;
    if (localStorage.getItem(storageKey(name)) == null) {
      localStorage.setItem(storageKey(name), JSON.stringify(v));
    }
    localStorage.removeItem(legacyKey);
  }
} catch { /* private mode — non-fatal */ }
```

**Idempotent**: legacy keys get removed once moved; a second
import is a no-op. The `if (... == null) { set }` clause avoids
overwriting a freshly-written new-namespace value with the stale
legacy value if both somehow co-exist.

**One-shot at module load**: the cost is 5 localStorage reads +
N writes (where N = how many legacy keys exist). Fixed at first
launch after the prefs migration ships; ~zero on every load
after.

## Optimization map

| Phase | Cost | Optimization horizon |
|---|---|---|
| `getPref` (steady state) | constant — localStorage read + JSON.parse | n/a |
| `setPref` (steady state) | constant — localStorage write + PATCH | n/a |
| `seedPrefs` boot | O(server pref count) localStorage writes | only fires once per boot |
| `patch_user_prefs` SQL | 1 round-trip, O(patch_key_count) UPSERTs | n/a — single statement |
| `share_sentinels` diff | 2 user reads + N submission inserts | only fires when the gate is on AND learned_sentinels grew |
| `find_user_by_id` (the prefs subquery hop) | 1 SQL, ~1ms | indexed; fine |

**Subquery vs LEFT JOIN approach** for the prefs roll-up: a JOIN
+ `GROUP BY u.redpash_id` would multiply user-row count by
average prefs-per-user (~5-10 today). Postgres handles it; the
subquery's `jsonb_object_agg` is slightly more efficient because
it stays per-user-row and never materializes the cross product.
Either works; the subquery is what's coded.

**A `user_preference_changes` audit table** (per the spec's
deferred items) would cost: one row per setPref → O(setPref
frequency) writes. If/when shipped, would land with a retention
policy (90d) — `events` table absorbs short-term lifecycle
needs in the meantime.
