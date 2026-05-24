// Login page — the RedPash sign-in surface.
//
// Leads with the product: upload a CSV, watch RedPash clean it in the
// browser via WebAssembly. The file never leaves the page. Cleaning
// summary + a mini-table preview of the cleaned rows appears under
// the button. Then sign in: Google OAuth (a full-page redirect) or,
// on localhost, the dev shortcut.

import { api } from "/scripts/api.js";
import { getEngine, gateBySize } from "/scripts/wasm-engine.js";
import { esc } from "/scripts/dom.js";

// Cap the rendered preview rows. The mini-table viewport shows 7 rows
// + a sticky header; the user can scroll vertically through whatever
// is rendered. Cap keeps the DOM bounded on a 5 MB-cap file that
// could otherwise be tens of thousands of rows.
const PREVIEW_ROW_CAP = 500;

export default function login(app) {
  // ─── upload path → wasm (file never leaves browser) ───────────
  const fileInput   = app.querySelector("#rp-demo-file");
  const uploadBtn   = app.querySelector("#rp-demo-upload");
  const localResult = app.querySelector("#rp-demo-local-result");
  const localMsg    = app.querySelector("#rp-demo-local-msg");
  const tableHost   = app.querySelector("#rp-demo-local-table");

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

      // 3. Wasm engine — same code as the server's auto_clean.
      const engine  = await getEngine();
      const cleaned = JSON.parse(engine.auto_clean(JSON.stringify(rows)));
      const elapsed = Math.round(performance.now() - t0);

      renderLocalResult(file.name, rows.length, cleaned.rows || [], cleaned.summary, elapsed);
      if (localMsg) localMsg.textContent = "";
    } catch (err) {
      // Surface whatever the wasm side gives us; if console_error_panic_hook
      // is installed Rust panics carry their site + payload.
      console.error("[demo upload]", err);
      const detail = err && (err.message || err.toString());
      if (localMsg) {
        localMsg.textContent = "Couldn’t process this file"
          + (detail ? " — " + detail : "")
          + ". Details in the console.";
      }
    } finally {
      uploadBtn.disabled = false;
      uploadBtn.classList.remove("is-busy");
      // Reset input so re-picking the same file re-fires change.
      if (fileInput) fileInput.value = "";
    }
  });

  function renderLocalResult(name, rowCount, rows, summary, elapsedMs) {
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
    renderMinitable(rows);
    localResult.hidden = false;
  }

  function renderMinitable(rows) {
    if (!tableHost) return;
    if (!rows.length) { tableHost.innerHTML = ""; return; }
    const headers = Object.keys(rows[0]);
    const shown = rows.slice(0, PREVIEW_ROW_CAP);
    const truncated = rows.length > PREVIEW_ROW_CAP;
    const head = '<thead><tr>'
      + headers.map((h) => '<th>' + esc(h) + '</th>').join("")
      + '</tr></thead>';
    const body = '<tbody>'
      + shown.map((r) => '<tr>'
          + headers.map((h) => {
              const v = r[h];
              return '<td' + (v == null ? ' class="is-null"' : '') + '>'
                + esc(v == null ? "—" : v) + '</td>';
            }).join("")
          + '</tr>').join("")
      + '</tbody>';
    const note = truncated
      ? '<p class="rp-login__minitable-note">Showing first '
        + PREVIEW_ROW_CAP + ' of ' + rows.length + ' rows — sign up to keep the full file.</p>'
      : '';
    tableHost.innerHTML = '<table class="rp-login__minitable">' + head + body + '</table>' + note;
  }

  // ─── sign in ───────────────────────────────────────────────────
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
// cells. Sufficient for the demo cap (5 MB); production upload paths
// still run server-side via the data crate's parse.rs (which catches
// more edge cases like custom delimiters and encoding sniffing).
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

