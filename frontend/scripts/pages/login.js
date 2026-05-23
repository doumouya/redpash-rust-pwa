// Login page — the RedPash sign-in surface.
//
// It leads with the product: a live CSV scan. The textarea is pre-
// filled with a deliberately messy sample; "Scan this CSV" POSTs the
// raw text to /api/demo/parse (no auth, nothing stored) and shows
// what RedPash read — rows, columns, cleanness score, and the parse
// time.
//
// "Or upload a CSV" runs the same engine *in the browser* via
// WebAssembly (see frontend/wasm/ + frontend/scripts/wasm-engine.js).
// File is parsed client-side, gated to 5 MB by the wasm-engine size
// cap, and `auto_clean` runs over it locally — the file never leaves
// the page. Bigger files get the sign-up CTA.
//
// Then sign in: Google OAuth (a full-page redirect) or, on localhost,
// the dev shortcut.

import { api } from "/scripts/api.js";
import { getEngine, gateBySize } from "/scripts/wasm-engine.js";

// A deliberately messy CSV: a quoted comma, a value wrapped across two
// lines, mixed date formats, mixed booleans, an all-empty row.
const SAMPLE = [
  "Name,Joined,Revenue,Active",
  '"Smith, John",2021-03-01,"1,240.50",yes',
  "Jane Doe,01/04/2021,,TRUE",
  '"O\'Brien",2021-09-13,980,1',
  ",,,",
  '"Wrapped',
  'cell",2022-02-11,"2,000",no',
].join("\n");

export default function login(app) {
  // ── live demo (paste path → server) ──────────────────────────
  const input   = app.querySelector("#rp-demo-input");
  const runBtn  = app.querySelector("#rp-demo-run");
  const result  = app.querySelector("#rp-demo-result");
  const demoMsg = app.querySelector("#rp-demo-msg");

  if (input) input.value = SAMPLE;

  function renderResult(d) {
    const score = Math.round(d.score);
    const scoreEl = app.querySelector("#rp-demo-score");
    scoreEl.textContent = score;
    scoreEl.style.color = score >= 80 ? "var(--rp-ok)"
                        : score >= 50 ? "var(--rp-warn)"
                        : "var(--rp-accent)";
    const ms = d.parse_ms < 1 ? "<1 ms" : d.parse_ms + " ms";
    app.querySelector("#rp-demo-stats").innerHTML = [
      "<span class=\"rp-login__stat\"><b>" + d.rows + "</b> rows</span>",
      "<span class=\"rp-login__stat\"><b>" + d.columns + "</b> cols</span>",
      "<span class=\"rp-login__stat\"><b>" + d.type_mismatches + "</b> type mismatches</span>",
      "<span class=\"rp-login__stat\"><b>" + d.empty_pct.toFixed(1) + "%</b> empty</span>",
      "<span class=\"rp-login__stat rp-login__stat--time\">parsed in <b>" + ms + "</b></span>",
    ].join("");
    result.hidden = false;
  }

  // Raw fetch, not api.js: /api/demo/parse takes a CSV body, not JSON.
  runBtn?.addEventListener("click", async () => {
    const csv = (input?.value || "").trim();
    if (!csv) { if (demoMsg) demoMsg.textContent = "Paste some CSV first."; return; }
    runBtn.disabled = true;
    if (demoMsg) demoMsg.textContent = "";
    try {
      const res = await fetch("/api/demo/parse", {
        method:  "POST",
        headers: { "Content-Type": "text/csv" },
        body:    csv,
      });
      if (!res.ok) throw new Error("HTTP " + res.status);
      renderResult(await res.json());
    } catch {
      if (demoMsg) demoMsg.textContent = "Scan failed — is the server running?";
    } finally {
      runBtn.disabled = false;
    }
  });

  // ── upload path → wasm (file never leaves browser) ───────────
  const fileInput    = app.querySelector("#rp-demo-file");
  const uploadBtn    = app.querySelector("#rp-demo-upload");
  const localResult  = app.querySelector("#rp-demo-local-result");
  const localMsg     = app.querySelector("#rp-demo-local-msg");

  uploadBtn?.addEventListener("click", () => fileInput?.click());

  fileInput?.addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (localMsg) localMsg.textContent = "";
    try {
      // 1. Gate by demo cap. Bigger files get the sign-up CTA, never
      //    trigger the 3 MB wasm download.
      gateBySize(file);
      uploadBtn.disabled = true;
      uploadBtn.classList.add("is-busy");
      if (localMsg) localMsg.textContent = "Loading engine + parsing…";

      // 2. Read + parse client-side. The CSV parser below handles
      //    quoted fields, escaped quotes, and multi-line cells.
      const t0 = performance.now();
      const text = await file.text();
      const rows = csvToObjects(text);
      if (!rows.length) {
        if (localMsg) localMsg.textContent = "Couldn’t read any rows from this file.";
        return;
      }

      // 3. Wasm engine — same code as the server's auto_clean. Returns
      //    { rows, summary: { cells_trimmed, junk_blanked, duplicate_rows_dropped } }.
      const engine  = await getEngine();
      const cleaned = JSON.parse(engine.auto_clean(JSON.stringify(rows)));
      const elapsed = Math.round(performance.now() - t0);

      renderLocalResult(file.name, rows.length, cleaned.summary, elapsed);
      if (localMsg) localMsg.textContent = "";
    } catch (err) {
      if (localMsg) {
        localMsg.textContent = (err && err.message)
          || "Couldn’t process this file.";
      }
    } finally {
      uploadBtn.disabled = false;
      uploadBtn.classList.remove("is-busy");
      // Reset input so re-picking the same file re-fires change.
      if (fileInput) fileInput.value = "";
    }
  });

  function renderLocalResult(name, rowCount, summary, elapsedMs) {
    app.querySelector("#rp-demo-local-file").textContent = name;
    app.querySelector("#rp-demo-local-time").textContent =
      elapsedMs < 1 ? "<1 ms" : elapsedMs + " ms";
    const trimmed = summary?.cells_trimmed       ?? 0;
    const junked  = summary?.junk_blanked        ?? 0;
    const dupes   = summary?.duplicate_rows_dropped ?? 0;
    app.querySelector("#rp-demo-local-stats").innerHTML = [
      '<span class="rp-login__stat"><b>' + rowCount + '</b> rows</span>',
      '<span class="rp-login__stat"><b>' + trimmed + '</b> cells trimmed</span>',
      '<span class="rp-login__stat"><b>' + junked + '</b> junk blanked</span>',
      '<span class="rp-login__stat"><b>' + dupes + '</b> duplicates dropped</span>',
      '<span class="rp-login__stat rp-login__stat--local">100% in your browser</span>',
    ].join("");
    localResult.hidden = false;
  }

  // ── sign in ───────────────────────────────────────────────────
  const loginMsg = app.querySelector("#rp-login-msg");
  const dev = app.querySelector("#rp-login-dev");

  app.querySelector("#rp-login-google")?.addEventListener("click", () => {
    location.href = "/api/auth/google/start";
  });

  dev?.addEventListener("click", async () => {
    dev.disabled = true;
    if (loginMsg) loginMsg.textContent = "";
    try {
      await api.post("/auth/dev-login");
      location.hash = "#/home";
      location.reload();
    } catch (err) {
      dev.disabled = false;
      if (loginMsg) {
        loginMsg.textContent = err.status
          ? `Sign-in failed (${err.status}).`
          : "Sign-in failed — is the server running?";
      }
    }
  });
}

// ── client-side CSV parser ──────────────────────────────────────
// Hand-rolled state machine — handles RFC 4180 essentials: quoted
// fields with commas + "" -escaped quotes + newlines inside quoted
// cells. Sufficient for the demo's messy sample; production parse
// still runs server-side via /api/files/upload + the data crate's
// parse.rs (which catches more edge cases like custom delimiters
// and encoding sniffing).
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i += 2; continue; }
      if (c === '"') { inQuotes = false; i++; continue; }
      field += c; i++;
    } else {
      if (c === '"') { inQuotes = true; i++; continue; }
      if (c === ',') { row.push(field); field = ""; i++; continue; }
      if (c === '\r') { i++; continue; }
      if (c === '\n') { row.push(field); rows.push(row); row = []; field = ""; i++; continue; }
      field += c; i++;
    }
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// Treat the first row as headers; the rest become objects. Empty
// strings become null so the wasm engine's auto_clean sees the
// "missing cell" shape it expects.
function csvToObjects(text) {
  const rows = parseCsv(text);
  if (rows.length < 2) return [];
  const headers = rows[0].map((h, i) => h || ("col_" + (i + 1)));
  return rows.slice(1).map((r) => {
    const obj = {};
    headers.forEach((h, i) => {
      const v = i < r.length ? r[i] : "";
      obj[h] = v === "" ? null : v;
    });
    return obj;
  });
}
