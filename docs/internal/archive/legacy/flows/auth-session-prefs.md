---
title: Login → session → prefs applied
section: Internal
order: 44
last modified date: 2026-05-24
status: filled
---

# Flow: Login → session → prefs applied

User signs in → `GET /api/me` resolves identity + prefs in one
round-trip → localStorage cache seeded → first paint reflects
server-of-truth UI state (theme, density, fontSize) without
flashing defaults.

The fast first-paint is the load-bearing UX detail. Three
sequenced layers conspire to prevent FOUC:

1. **Pre-module inline script** (synchronous, before CSS evaluates)
   reads localStorage and slaps data-attrs on `<html>`.
2. **`prefs.js` module load** runs the one-shot legacy-key
   migration so the inline script's reads stay valid.
3. **`loadSession` after `/api/me`** overwrites the cache with
   server-of-truth and re-applies data-attrs.

## The trace — boot

1. **`index.html`** loads. Inline `<script>` runs *before any
   module*:
   ```js
   try {
     var d = document.documentElement;
     function rp(name, legacy, ok) {
       var raw = localStorage.getItem("rp-pref-" + name);
       if (raw != null) { try { var v = JSON.parse(raw); if (ok(v)) return v; } catch (_) {} }
       if (legacy) { var lv = localStorage.getItem(legacy); if (ok(lv)) return lv; }
       return null;
     }
     var t  = rp("theme",    "rp-theme",     v => v === "light" || v === "dark");
     var dn = rp("density",  "rp-density",   v => /^compact|cozy|comfortable$/.test(v));
     var fs = rp("fontSize", "rp-font-size", v => /^sm|md|lg$/.test(v));
     if (t)  d.dataset.theme    = t;
     if (dn) d.dataset.density  = dn;
     if (fs) d.dataset.fontSize = fs;
   } catch (e) {}
   ```
   Reads **both** new (`rp-pref-*`, JSON-encoded) and legacy
   (`rp-density`, raw strings) namespaces so the transitional
   window doesn't flash.
2. **CSS evaluates**. Selectors like `html[data-density="compact"]`
   override token values. First paint is correct.
3. **`scripts/main.js` (module) loads.** Imports
   `seedPrefs` from `prefs.js`. `prefs.js`'s top-level code
   runs the **legacy-key migration**: for each pref name in
   `LEGACY_KEYS`, if `rp-<key>` exists, copy to
   `rp-pref-<name>` (JSON-encoded) and remove the legacy key.
   One-shot, idempotent.
4. **`main.js::loadSession()`** runs:
   ```js
   try {
     session = await api.get("/me");
     seedPrefs(session?.prefs);
   } catch (err) {
     session = err.status === 404
       ? { dev: true, username: "dev", display_name: "Dev user" }
       : null;
   }
   ```
5. **`api.get("/me")`** issues `GET /api/me` with the
   `rp_session` cookie (if any).
6. **Server** (`routes::me::get_me`):
   - `resolve_user_rid(state, headers)` →
     - Has `rp_session` cookie? → `db::find_session_user` →
       returns the user RID.
     - No cookie, OAuth disabled → `state.dev_user` fallback.
     - No cookie, OAuth enabled → `401 unauthenticated`. The
       outer `capture_mw` records this as a `kind="http_error"`
       event with the canonical reason.
   - `db::find_user_by_id(&pool, &rid)` — the SQL is
     `SELECT ... COALESCE((SELECT jsonb_object_agg(p.key, p.value)
     FROM user_preferences p WHERE p.user_redpash_id = users.redpash_id),
     '{}'::jsonb) AS prefs ...` — folds the prefs table into a
     flat object inline.
   - `db::list_global_sentinels(&pool)` returns the canonical
     shared sentinels (promoted from `sentinel_submissions`).
   - Response: `{ ...UserProfile fields, prefs: { ... }, global_sentinels: [...] }`.
7. **Back in `loadSession`**, `seedPrefs(session.prefs)`:
   ```js
   for (const [name, value] of Object.entries(serverPrefs)) {
     localStorage.setItem(`rp-pref-${name}`, JSON.stringify(value));
   }
   applyAllPrefs();   // re-write data-attrs from the now-current cache
   ```
   If the server's `density` differs from what the inline script
   applied (e.g. the user changed it on another device since
   their last load here), this is the **catch-up paint** —
   atomic, single-tick.
8. **Router mounts the active page** — `mount(path)`. Every
   `getPref(name)` from this point on is synchronous and
   returns the server-of-truth value.

## The trace — sign-in (Google OAuth)

1. User clicks "Continue with Google" on the login page.
2. `location.href = "/api/auth/google/start"` — full-page
   navigation (not a fetch — we need the redirect dance).
3. **Server** (`routes::auth::start`): builds Google's
   authorization URL with `state` + `nonce` cookies; 303 redirect.
4. **Google**: user consents; redirects back to
   `/api/auth/google/callback?code=...&state=...`.
5. **Server** (`routes::auth::callback`):
   - Verifies `state` cookie matches; verifies `id_token`
     signature + nonce.
   - `db::upsert_google_user(sub, email, name, avatar)` —
     find-or-create on Google's `sub` claim (stable per
     account across name/email changes).
   - `db::insert_session(user_redpash_id)` →
     `SES_<uuid>`; sets the `rp_session` cookie (HttpOnly,
     SameSite=Lax).
   - `event::record(kind="auth_login_success", user, …)`.
   - 303 redirect to `/` (frontend reloads).
6. **Frontend reload**: same boot sequence as above, now with a
   valid session cookie → `/api/me` returns the real user +
   `prefs` → `seedPrefs` lights up cross-device prefs.

## The trace — pref change (after boot)

User toggles density in Settings:

1. **Settings page** calls `setPref("density", "compact")`.
2. **`prefs.js::setPref`**:
   - Registered? Yes (in `PREFS` registry). Validate against
     `["compact", "cozy", "comfortable"]` → passes.
   - `localStorage.setItem("rp-pref-density", '"compact"')`.
   - `document.documentElement.dataset.density = "compact"`
     → CSS reacts immediately.
   - `api.patch("/me/prefs", { prefs: { density: "compact" } })`
     fire-and-forget. Returns 204 on success.
3. **Server** (`routes::me::patch_me_prefs`):
   - `resolve_user_rid` (401 if missing).
   - `apply_prefs_patch(state, user_rid, &body.prefs)` →
     `db::patch_user_prefs` does `INSERT ... ON CONFLICT
     (user_redpash_id, key) DO UPDATE` per JSON key.
   - share_sentinels gate evaluates (irrelevant for
     density; only fires when the patch involves
     learned/share_sentinels).
   - 204.
4. **Cross-device propagation**: nothing pushed. Next time
   the user opens the app on another device, that device's
   `seedPrefs` reads the updated value.

## The trace — logout

1. User clicks the sign-out icon in the topbar.
2. Frontend POSTs `/api/auth/logout`.
3. **Server** (`routes::auth::logout`):
   - `read_cookie("rp_session")` → session RID.
   - `db::delete_session(&pool, &sid)`.
   - `Set-Cookie: rp_session=; Max-Age=0` (clears the cookie).
4. Frontend sets `location.hash = "#/login"` and reloads.
5. Next boot's `/api/me` returns 401 (no session); `session =
   null`; router routes to `/login`.

## Expected noise

- **401 on `/api/me`** when there's no session — by design, not
  a bug. It's how the boot flow detects "not signed in". The
  `capture_mw` records each one as `kind="http_error"` in
  `events` and `request_log` — see [events-and-logs](../subsystems/events-and-logs.md#what-expected-noise-looks-like)
  for why these are the dominant 4xx in monitoring.
- **303s on `/auth/google/{start,callback}`** — the OAuth
  dance is a sequence of redirects. p95 latency on the
  callback can be 5s+ because of Google's token exchange.

## Cache vs server divergence

The two stores can diverge under three conditions:

1. **`setPref`'s PATCH failed** (network blip, server 5xx).
   The local cache reflects the user's intent; the server
   doesn't know. Next boot, `seedPrefs(session.prefs)`
   overwrites local with the (stale) server state — effectively
   reverting the change.
2. **A second device's `setPref` succeeded** but the first
   device's session is still warm. The first device's
   localStorage is stale until next boot.
3. **A successful PATCH that the server then rolled back**
   (transactional collision, unlikely with the simple upsert).
   Same recovery — next boot reseeds.

All three resolve on next boot. Acceptable for prefs (no key is
both load-bearing and time-critical); revisit if a future
pref class has stronger consistency needs.

## Cross-refs

- The prefs subsystem (both halves):
  [prefs](../subsystems/prefs.md).
- The user-preferences spec:
  [specs/user-preferences](../specs/user-preferences.md).
- Auth routes + cookie + session table:
  [api-routes](../subsystems/api-routes.md).
- Events + 401 noise reading:
  [events-and-logs](../subsystems/events-and-logs.md).
