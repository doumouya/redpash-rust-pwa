---
title: 0009 — dev frontend edits don't show up (static assets ship no cache-control)
section: Internal
order: 9
last modified date: 2026-05-31
case_id: CAS_35090747FD78414D8CD060A73181A414
status: resolved
---

# 0009 — dev frontend edits don't show up (static assets ship no cache-control)

**Date:** 2026-05-31 · **Area:** `backend/crates/api/src/routes/mod.rs` (`ServeDir` static-asset fallback) · **Status:** resolved — debug-only `cache-control: no-cache` layer landed on the static fallback; verified live (header present, conditional GET → 304, `/api/*` unaffected).

> **Filing note:** Originally filed under the legacy `NNNN-<slug>.md`
> name because the cases MCP was 401-blocked at discovery (pre-v2, see
> [runbook 0008](CAS_097E36B6F6904E429401F4951A54BA9B-mcp-cases-session-auto-refresh.md)).
> Once the bridge was restored the case was allocated and this entry was
> renamed to its `CAS_<rid>-<slug>.md` form per the
> [cadence](../processes/bug-case-runbook-cadence.md).

## Problem Statement

In dev (`cargo run`, frontend served from the repo), editing any
`frontend/**/*.css` or `frontend/**/*.js` file does **not** reflect in
the browser on a normal reload — the browser keeps serving the old
version. A plain refresh isn't enough; even `Ctrl+Shift+R` is unreliable
for nested resources (CSS `@import` chains, ES-module sub-imports).

Observed repeatedly this session by multiple Torv:
- @mention / collapsible-panel / surface-colour work: Playwright loads
  served an ancient `partials/cases.html` + `scripts/pages/cases.js`
  (composer markup absent, `#rp-cases-detail-side` absent) while `curl`
  of the same URLs returned the current files — i.e. server fresh,
  browser stale. Interactive verification was blocked until a manual
  cache-bust (`fetch(url, {cache:'reload'})` / dynamic `import(url + '?v=' + …)`).
- Column-drag CSS work (runbook 0007) hit the same wall; Em had to run a
  cache-bust one-liner because `Ctrl+Shift+R` wasn't enough on the
  nested CSS `@import`s.

Symptom signature: `curl -sI http://localhost:8080/<asset>` shows a
`last-modified` header and **no** `cache-control` / `etag`.

## Troubleshooting steps

1. `curl -s http://localhost:8080/partials/cases.html | grep <new-markup>` → present. Server serves the current file.
2. In-browser `document.querySelector(<new-element>)` → absent; `fetch(url, {cache:'no-store'})` of the same URL → current content. Confirms the staleness is the **browser HTTP cache**, not the server or a service worker.
3. Service worker ruled out: `frontend/service-worker.js` is presence-only (no `fetch` interception, no Cache Storage); unregistering it + clearing `caches` changed nothing.
4. `curl -sI` the asset → only `last-modified` present; no `cache-control`, no `etag`.
5. Confirmed the cache-bust workarounds that *do* work: `fetch(url, {cache:'reload'})` to re-prime, or dynamic `import("/scripts/…?v=" + Date.now())` (a new URL → cache miss). Both sidestep the stale entry rather than fixing the cause.

## RCA

The static-asset fallback is a bare `tower_http` `ServeDir`:

```rust
// backend/crates/api/src/routes/mod.rs:221
let frontend = ServeDir::new("../frontend").append_index_html_on_directories(true);
// …
.fallback_service(frontend)   // :225
```

`ServeDir` emits `last-modified` (and serves `304` on a conditional
`If-Modified-Since`) but sends **no** `cache-control` and **no** `etag`.
Per the HTTP caching spec, when a response has no explicit freshness
directive, the browser may apply **heuristic freshness** — typically
~10% of `(now − last-modified)`. For a file last modified days ago that
window is hours, so the browser treats its cached copy as fresh and
**does not issue a conditional GET at all** — the `304` path never runs.
Result: edits are invisible until the heuristic window lapses or the
cache is manually busted. This is a dev-ergonomics bug (prod ships
versioned/fingerprinted assets, so it doesn't bite there), but it
silently costs verification time and has masqueraded as "my edit didn't
save" more than once.

## Solution

**Landed** ([`mod.rs`](../code/backend/api/routes/mod.md)): a
`Cache-Control` header is attached to the static-asset responses so the
browser always revalidates. Implemented as a debug-gated
`SetResponseHeaderLayer` wrapping the `ServeDir` fallback (added the
`set-header` tower-http feature). `no-cache` was chosen over `no-store`:

- `cache-control: no-cache` — *allows* caching but forces a conditional
  GET every time; `ServeDir`'s existing `last-modified`/`304` path then
  makes revalidation cheap. Preferred (keeps `304`s, kills staleness).
- `cache-control: no-store` — never cache; simplest, slightly chattier.
  Acceptable dev-only.

The layer wraps the `ServeDir` **service** (built before
`.fallback_service()`), not the outer router — this is what scopes it to
static assets and keeps `/api/*` untouched. Applying `.layer()` to the
router after `.fallback_service()` would have leaked the header onto the
API responses too.

```rust
#[cfg(debug_assertions)]
use tower::ServiceBuilder;
#[cfg(debug_assertions)]
use tower_http::set_header::SetResponseHeaderLayer;
#[cfg(debug_assertions)]
use axum::http::header::CACHE_CONTROL;

let frontend = ServeDir::new("../frontend").append_index_html_on_directories(true);

#[cfg(debug_assertions)]
let frontend = ServiceBuilder::new()
    .layer(SetResponseHeaderLayer::overriding(
        CACHE_CONTROL,
        HeaderValue::from_static("no-cache"),
    ))
    .service(frontend);

Router::new().nest("/api", api).fallback_service(frontend)
```

**Production-safe gate:** the whole thing is behind
`#[cfg(debug_assertions)]` (imports included, so release builds don't
warn on unused imports), so a release binary that ever falls back to
`ServeDir` keeps normal caching. Scoped to the static fallback, never
`/api/*`.

*Deferred:* a fuller story (asset fingerprinting / `etag` + long
`max-age` for prod) is out of scope; this is purely the dev-loop fix.

## Post Checking

Once the header lands, to verify:
1. `curl -sI http://localhost:8080/styles/cases.css` → shows `cache-control: no-cache`.
2. Edit a `.css`/`.js` under `frontend/`, normal browser reload → change visible without any manual cache-bust.
3. Re-request an unchanged asset → `304 Not Modified` (revalidation working, bytes not re-sent).
4. Confirm `/api/*` responses are unaffected (no new `cache-control`).

Until then, the workaround for anyone verifying frontend edits in an
automated browser: `fetch(url, {cache:'reload'})` to re-prime, or
dynamic `import(url + "?v=" + Date.now())` for ES modules.
