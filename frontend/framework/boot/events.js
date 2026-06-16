/* events.js — frontend error capture: what the backend structurally cannot
   see (uncaught exceptions, unhandled rejections, page-mount failures).
   RULE: this module NEVER imports api.js (recursion guard) — when the events
   POST endpoint lands it will use raw fetch. Buffered + deduped; capped. */

const buffer = [];
const CAP = 100;
const seen = new Map(); // kind|message → last ts (10s dedup window)

function capture(kind, message, detail) {
  const key = `${kind}|${message}`;
  const now = Date.now();
  if (seen.has(key) && now - seen.get(key) < 10_000) return;
  seen.set(key, now);
  if (buffer.length >= CAP) return;
  buffer.push({ kind, message, detail, at: new Date().toISOString() });
  console.warn(`[rp:${kind}]`, message, detail ?? "");
}

export function installErrorCapture() {
  window.addEventListener("error", (e) =>
    capture("uncaught", e.message, `${e.filename}:${e.lineno}`)
  );
  window.addEventListener("unhandledrejection", (e) =>
    capture("rejection", String(e.reason?.message ?? e.reason))
  );
}

export function captureMountError(page, err) {
  capture("mount", `page ${page} failed`, String(err?.message ?? err));
}

export function pendingEvents() {
  return buffer.slice();
}
