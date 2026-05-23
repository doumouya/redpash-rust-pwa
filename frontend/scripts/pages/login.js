// Login page — the RedPash sign-in surface.
//
// It leads with the product: a live CSV scan. The textarea is
// pre-filled with a deliberately messy sample; "Scan this CSV" POSTs
// the raw text to /api/demo/parse (no auth, nothing stored) and shows
// what RedPash read — rows, columns, cleanness score, and the parse
// time. Then sign in: Google OAuth (a full-page redirect) or, on
// localhost, the dev shortcut.

import { api } from "/scripts/api.js";

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
  // ── live demo ─────────────────────────────────────────────────
  const input  = app.querySelector("#rp-demo-input");
  const runBtn = app.querySelector("#rp-demo-run");
  const result = app.querySelector("#rp-demo-result");
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
