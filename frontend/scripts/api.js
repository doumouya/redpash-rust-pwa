// ─────────────────────── /api client ───────────────────────
//
// Thin fetch wrapper. Responsibilities:
//   • Prefix every path with /api so callers write api.get("/projects").
//   • Send + receive JSON (Content-Type, Accept) and parse errors into
//     real Error objects with `status` and `body` attached.
//   • Single place to add auth headers later (cookie now, Bearer for
//     Google OAuth in Phase 4).
//
// Anything that needs the raw Response (file downloads, streaming
// exports) bypasses this and calls fetch directly.

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

  const res = await fetch(BASE + path, {
    method,
    headers,
    body: payload,
    credentials: "same-origin",
    signal: opts.signal,
  });

  if (res.status === 204) return null;
  // Session expired (or never existed). Redirect to the landing page
  // so the user can sign in again. Skip the redirect when we're
  // already on landing — otherwise it loops.
  if (res.status === 401) {
    const onLanding = (location.hash || "#/landing") === "#/landing"
                   || location.hash.startsWith("#/landing");
    if (!onLanding) {
      location.hash = "#/landing";
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

export const api = {
  get:    (p, opts)    => request("GET",    p, undefined, opts),
  post:   (p, b, opts) => request("POST",   p, b, opts),
  patch:  (p, b, opts) => request("PATCH",  p, b, opts),
  put:    (p, b, opts) => request("PUT",    p, b, opts),
  delete: (p, opts)    => request("DELETE", p, undefined, opts),
};
