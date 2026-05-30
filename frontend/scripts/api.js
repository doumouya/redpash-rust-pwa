/* Purpose: see doc for details.
 * Doc: docs/internal/code/frontend/scripts/api.md */
// ─────────────────────── /api client ───────────────────────
//
// Thin fetch wrapper. Responsibilities:
//   • Prefix every path with /api so callers write api.get("/projects").
//   • Send + receive JSON (Content-Type, Accept) and parse errors into
//     real Error objects with `status` and `body` attached.
//   • Capture `x-request-id` from every response so frontend events
//     (errors, lifecycle reports via /scripts/events.js) can correlate
//     to the originating backend request — operators pivot from an FE
//     error in the events table to its backend log line via the shared
//     id. The header is set by `request_id_mw` server-side; we mirror
//     it here as the "last seen" correlation handle (per-window, mutable).
//   • Single place to add auth headers later (cookie now, Bearer for
//     Google OAuth in Phase 4).
//
// Anything that needs the raw Response (file downloads, streaming
// exports) bypasses this and calls fetch directly.

import { reportEvent, _setLastRequestId } from "/scripts/events.js";

const BASE = "/api";

async function request(method, path, body, opts = {}) {
  const headers = { Accept: "application/json", ...(opts.headers ?? {}) };
  let payload;
  if (body !== undefined) {
    if (body instanceof FormData) {
      payload = body; // multipart — let the browser set the boundary
    } else {
      headers["Content-Type"] = "application/json";
      payload = JSON.stringify(body);
    }
  }

  let res;
  try {
    res = await fetch(BASE + path, {
      method,
      headers,
      body: payload,
      credentials: "same-origin",
      signal: opts.signal,
    });
  } catch (err) {
    // Transport failure — offline, DNS, connection refused. No response
    // reached the server, so the backend has no record of it; this is
    // the frontend's to log. An AbortError is an intentional
    // cancellation (navigation, a superseded request) — not a failure.
    if (err.name !== "AbortError") {
      reportEvent({
        kind:    "network_error",
        message: err.message || "fetch failed",
        source:  "api.js#request",
        context: { method, path },
      });
      err._rpLogged = true;
    }
    throw err;
  }

  // Push the request correlation id into events.js's module state
  // BEFORE any early-return branch (204 / 401) so the most recent
  // request_id is always captured regardless of status. Fetch is
  // case-insensitive on header names per the spec but lowercase is
  // the canonical Axum emit shape. State lives in events.js (not
  // here) to keep the events.js "never import api.js" rule intact —
  // we push, it owns; no circular import.
  const ridHeader = res.headers.get("x-request-id");
  if (ridHeader) _setLastRequestId(ridHeader);

  if (res.status === 204) return null;
  // Session expired (or never existed). Redirect to the login page
  // so the user can sign in again. Skip the redirect when we're
  // already on login — otherwise it loops.
  if (res.status === 401) {
    const onLogin = (location.hash || "#/login") === "#/login"
                 || location.hash.startsWith("#/login");
    if (!onLogin) {
      location.hash = "#/login";
    }
    const err = new Error("Not signed in");
    err.status = 401;
    throw err;
  }
  const text = await res.text();
  const data = text ? safeJson(text) : null;
  if (!res.ok) {
    const err = new Error((data && data.error) || (data && data.message) || `HTTP ${res.status}`);
    err.status = res.status;
    err.body = data;
    throw err;
  }
  return data;
}

function safeJson(text) {
  try { return JSON.parse(text); } catch { return text; }
}

// ─────────────── localStorage SWR helpers ───────────────
//
// Phase 1 (Tier 1 A/B) — see docs/frontend/suggestion-localstorage.md.
// Pattern: read the parsed JSON from localStorage synchronously while
// kicking off a fresh GET in parallel. Caller paints cached immediately
// (instant first frame), then awaits fresh for the correction pass.
//
//   const { cached, fresh } = api.getCached("/projects");
//   if (cached) paint(cached);     // sync; no flicker on warm cache
//   const live = await fresh;
//   paint(live);                   // overwrite with authoritative data
//
// Invalidation = overwrite-on-fetch (`fresh` writes the cache on resolve).
// Manual `invalidateCached` exists for the asymmetric cases: PATCH /me
// changes prefs server-side, so rpSavePref clears the /me cache so the
// next read fetches.
//
// Cache key derivation: `rp-cache-${version}${path}` — version bump is
// the schema-migration safety valve (mirrors the SW CACHE_VERSION
// pattern). Callers can override with opts.key for custom derivation
// like `(rid, updated_at)` envelope keys later in Phase 1 C.
const _CACHE_VERSION = "v1";

function _cacheKey(path, opts) {
  if (opts?.key) return opts.key;
  const v = opts?.version ?? _CACHE_VERSION;
  return `rp-cache-${v}${path}`;
}

function _readCache(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

function _writeCache(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); }
  catch {} // quota exceeded, private mode, etc. — non-fatal
}

// Returns `{ cached, fresh }`. cached is sync-readable (null if no
// entry yet); fresh is the network promise that also writes the cache
// on success. Doesn't catch — caller decides what to do on fetch error
// (typically falling back to the cached value already painted).
function getCached(path, opts = {}) {
  const key    = _cacheKey(path, opts);
  const cached = _readCache(key);
  const fresh  = request("GET", path, undefined, opts).then((data) => {
    _writeCache(key, data);
    return data;
  });
  return { cached, fresh };
}

// Drop a cached entry. Used by callers that mutate the resource via
// PATCH/POST/DELETE and need the next read to fetch (e.g. rpSavePref
// after PATCH /me). For overwrite-on-fetch lists this is rarely
// needed — the next list read will overwrite naturally.
function invalidateCached(path, opts = {}) {
  const key = _cacheKey(path, opts);
  try { localStorage.removeItem(key); } catch {}
}

// Phase 1 / Tier 2 E — idle pre-warm. Each page calls this after its
// own primary content has painted, listing the other pages' list
// endpoints. requestIdleCallback fires when the browser would otherwise
// be doing nothing, so the warm-up doesn't compete with user
// interaction. Failures are swallowed — pre-warm is best-effort.
//
// Usage:
//   api.prewarm(["/files", "/users"]);  // after Home finishes
//   api.prewarm(["/projects", "/reports", "/dashboards"]);  // after Reports
//
// On browsers without requestIdleCallback (older Safari) we fall back
// to setTimeout — close enough; the cost is a tiny delay before the
// idle fetch fires.
function prewarm(paths, opts = {}) {
  if (!Array.isArray(paths) || !paths.length) return;
  const schedule = typeof window !== "undefined" && typeof window.requestIdleCallback === "function"
    ? window.requestIdleCallback.bind(window)
    : (cb) => setTimeout(cb, 200);
  schedule(() => {
    for (const p of paths) {
      try { getCached(p, opts).fresh.catch(() => {}); } catch {}
    }
  });
}

export const api = {
  get:    (p, opts)    => request("GET",    p, undefined, opts),
  post:   (p, b, opts) => request("POST",   p, b, opts),
  patch:  (p, b, opts) => request("PATCH",  p, b, opts),
  put:    (p, b, opts) => request("PUT",    p, b, opts),
  delete: (p, opts)    => request("DELETE", p, undefined, opts),
  getCached,
  invalidateCached,
  prewarm,
};
