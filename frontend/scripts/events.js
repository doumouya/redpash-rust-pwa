// ─────────────────── frontend event capture ───────────────────
//
// Phase 2 of the Events system (see docs/api/events.md). The backend
// `capture_mw` middleware already logs every 4xx/5xx response — this
// module captures what the backend structurally CANNOT see:
//
//   • uncaught JS exceptions          — window "error"
//   • unhandled promise rejections    — window "unhandledrejection"
//   • transport failures              — a `fetch` that never reached
//                                       the server (offline, DNS,
//                                       connection refused), so no
//                                       request was ever logged
//   • page-module load / mount errors — a route's script 404s or throws
//
// HTTP error *responses* are deliberately NOT re-reported here: the
// backend owns them, and re-logging would double every failure.
//
// Hard rules — an observability layer must never break what it
// observes:
//   • never throw, never block the app;
//   • never recurse — reportEvent uses raw `fetch`, NOT api.js.
//     Routing it through api.js would make a failed event POST trip
//     the network funnel, which would POST another event, forever.

const ENDPOINT = "/api/events";

// An error inside a render / animation loop can fire every frame.
// Suppress a repeat of the same kind|message within this window.
const DEDUP_MS = 10_000;
const _lastSent = new Map(); // "kind|message" → epoch ms

// A hard ceiling so one pathological session can't flood the table.
// Dedup collapses repeats; this bounds distinct events too.
const SESSION_CAP = 100;
let _sentCount = 0;

function _truncate(value, max) {
  const s = String(value ?? "");
  return s.length > max ? s.slice(0, max) + "…" : s;
}

// Fire-and-forget POST to /api/events. Swallows everything — a logging
// call must not surface its own failure to the app, and must not
// recurse. Identity (user / session) is stamped server-side from the
// cookie; we only send the event's own fields.
export function reportEvent({ level = "error", kind, message, source, context, request_id } = {}) {
  if (!kind || !message) return;
  if (_sentCount >= SESSION_CAP) return;

  const key  = `${kind}|${message}`;
  const now  = Date.now();
  const prev = _lastSent.get(key);
  if (prev && now - prev < DEDUP_MS) return;
  _lastSent.set(key, now);
  _sentCount++;

  const body = {
    level,
    kind,
    message: _truncate(message, 1000),
    source:  source ? _truncate(source, 200) : undefined,
    request_id: request_id || undefined,
    context: {
      url:   location.href,
      route: location.hash || "(none)",
      ...(context || {}),
    },
  };

  try {
    fetch(ENDPOINT, {
      method:      "POST",
      headers:     { "Content-Type": "application/json" },
      body:        JSON.stringify(body),
      credentials: "same-origin",
      keepalive:   true, // still sends if the page is unloading
    }).catch(() => {}); // network down → drop it, never recurse
  } catch {}
}

// Install the global capture handlers. Called once, early, from main.js
// so handlers are armed before the rest of the app runs.
let _installed = false;
export function installErrorCapture() {
  if (_installed) return;
  _installed = true;

  // Uncaught exceptions. The "error" event also fires for failed
  // resource loads (<img>, <script>) — those carry no `error` object;
  // skip them, they're noisy and rarely actionable here.
  window.addEventListener("error", (e) => {
    if (!e.error && !e.message) return;
    reportEvent({
      kind:    "js_error",
      message: e.message || String(e.error),
      source:  e.filename ? `${e.filename}:${e.lineno}:${e.colno}` : undefined,
      context: { stack: _truncate(e.error?.stack, 2000) },
    });
  });

  // Promise rejections with no `.catch()`. Errors thrown by api.js
  // carry `.status` (HTTP errors — already logged backend-side by
  // capture_mw) or `_rpLogged` (transport errors — already logged by
  // the funnel in api.js). Skip both: this handler is for genuinely
  // unhandled non-API rejections.
  window.addEventListener("unhandledrejection", (e) => {
    const reason = e.reason;
    if (reason && (reason.status || reason._rpLogged)) return;
    reportEvent({
      kind:    "unhandled_rejection",
      message: reason?.message || String(reason),
      context: { stack: _truncate(reason?.stack, 2000) },
    });
  });
}
