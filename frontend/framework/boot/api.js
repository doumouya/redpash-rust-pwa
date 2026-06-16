/* api.js — the one fetch wrapper. JSON in/out, errors carry .status/.body,
   401 bounces to login. Pages and components import this; events.js never
   does (one-way dependency). */

async function request(method, path, body, opts = {}) {
  const init = { method, headers: {}, ...opts };
  if (body !== undefined && !(body instanceof FormData)) {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  } else if (body instanceof FormData) {
    init.body = body;
  }
  const resp = await fetch(`/api${path}`, init);
  if (resp.status === 401) {
    location.hash = "#/login";
  }
  const text = await resp.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!resp.ok) {
    const err = new Error(data?.error || `${resp.status}`);
    err.status = resp.status;
    err.body = data;
    throw err;
  }
  return data;
}

export const api = {
  get: (path, opts) => request("GET", path, undefined, opts),
  post: (path, body) => request("POST", path, body),
  put: (path, body) => request("PUT", path, body),
  patch: (path, body) => request("PATCH", path, body),
  del: (path) => request("DELETE", path),
  upload: (path, formData) => request("POST", path, formData),
};
