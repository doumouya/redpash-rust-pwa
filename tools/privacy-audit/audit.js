#!/usr/bin/env node
/* privacy-audit — the GDPR / Privacy-by-Design fidelity floor.
 *
 * Encodes the 2026-06-16 independent privacy assessment (docs/privacy/
 * assessment-2026-06-16.md) as STATIC checks, so every finding becomes a
 * ratcheted backlog item: ci-audit floors the count (tools/ci-audit/
 * baseline.json: "privacy"), and a NEW privacy regression fails CI. Each
 * check maps to a Privacy-by-Design principle (the 7 of Art. 25 /
 * https://gdpr-info.eu/issues/privacy-by-design/) and a GDPR article.
 *
 * Contract (matches tools/ci-audit/ratchet.mjs):
 *   - writes audit.json with `findings` (OPEN gaps — counted) + `accepted`
 *     (documented exceptions — NOT counted) + `strengths` + `stats`.
 *   - writes report.html (human-readable, grouped by severity).
 *   - process.exit(findings.length)  → the violation count.
 *
 * These are deliberately HEURISTIC line/structure scans (the house audit
 * style — no Rust/JS parser). Each check documents what it keys on; a
 * refactor that moves the pattern re-trips or clears the check. When a check
 * is wrong, refine the algorithm here — don't work around it.
 *
 * Checks (F-IDs trace to the assessment register):
 *   F-A erasure-blob-orphan      F-G no-pii-classification
 *   F-B comment-not-scrubbed     F-H no-subject-export
 *   F-C no-retention-automation  F-I no-read-access-audit
 *   F-D no-transparency          F-K idb-clear-on-logout
 *   F-E chart-spec-cell-data     F-L comment-plaintext-stale-doc
 *   F-F connector-secret-plaintext
 *   F-J sample-cell-in-registry  → ACCEPTED exception (Em, 2026-06-16) */

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..");
const p = (...s) => path.join(ROOT, ...s);
const rel = (f) => path.relative(ROOT, f);

const API_SRC = p("backend", "crates", "api", "src");
const MIGRATIONS = p("backend", "migrations");
const FRONTEND = p("frontend");

const findings = []; // OPEN gaps — counted by the ratchet
const accepted = []; // documented exceptions — surfaced, not counted
const strengths = []; // credit where due (informational)

// ── helpers ─────────────────────────────────────────────────────────────────
function readSafe(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}
function walk(dir, exts, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.isDirectory()) {
      if (!["node_modules", "wasm", "wasm-src", "dist", "vendor"].includes(ent.name))
        walk(path.join(dir, ent.name), exts, out);
    } else if (exts.some((e) => ent.name.endsWith(e))) {
      out.push(path.join(dir, ent.name));
    }
  }
  return out;
}
function readAll(files) {
  return files.map((f) => ({ file: f, text: readSafe(f) }));
}
// first {file,line,text} where `re` matches across the given files, else null
function locate(files, re) {
  for (const f of [].concat(files)) {
    const text = readSafe(f);
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i])) return { file: rel(f), line: i + 1, text: lines[i].trim() };
    }
  }
  return null;
}
function add(f) {
  (f.status === "accepted" ? accepted : findings).push(f);
}

const apiFiles = walk(API_SRC, [".rs"]);
const apiText = readAll(apiFiles);
const apiBlob = apiText.map((x) => x.text).join("\n");
const sqlFiles = walk(MIGRATIONS, [".sql"]);
const sqlBlob = sqlFiles.map(readSafe).join("\n");

const DB = p("backend", "crates", "api", "src", "db.rs");
const EVENT = p("backend", "crates", "api", "src", "event.rs");
const CASES = p("backend", "crates", "api", "src", "cases.rs");
const DTYPE = p("backend", "crates", "data", "src", "dtype.rs");
const CHART_EDITOR = p("frontend", "framework", "chart-editor", "chart-editor.js");
const INIT_SQL = p("backend", "migrations", "20260612000000_init.sql");
const CARGO = readSafe(p("backend", "Cargo.toml")) + "\n" + readSafe(p("backend", "crates", "api", "Cargo.toml"));

// ── F-A — erasure: disk blobs orphan on delete (Art. 17) ─────────────────────
{
  const db = readSafe(DB);
  if (/fn\s+delete_entity/.test(db) && !/(remove_file|fs::remove)/.test(db)) {
    add({
      id: "F-A", severity: "High", principle: "5 End-to-End Security (lifecycle)", article: "Art. 17",
      title: "Disk blobs orphan on delete",
      evidence: [
        locate(DB, /fn\s+delete_entity/),
        // attachment single-delete DOES remove_file, but case-cascade delete does not
        locate(CASES, /remove_file/) || { file: rel(CASES), line: 0, text: "(no blob sweep on case delete)" },
      ].filter(Boolean),
      risk: "delete_entity is SQL-only; project-file .bin (and, on case delete, attachment .bin) survive on disk after the row is gone — recoverable after a deletion request.",
      recommendation: "remove_file(storage_path) inside delete_entity / the case-delete cascade, plus a BlobGuard reaper sweep for already-orphaned blobs.",
    });
  }
}

// ── F-B — user scrub does not anonymise case_comments.body (Art. 17) ─────────
{
  const db = readSafe(DB);
  if (/fn\s+scrub_user_tx/.test(db) && !/case_comments/.test(db)) {
    add({
      id: "F-B", severity: "High", principle: "7 Respect for User Privacy", article: "Art. 17",
      title: "User scrub leaves case-comment text",
      evidence: [locate(DB, /fn\s+scrub_user_tx/)].filter(Boolean),
      risk: "scrub_user_tx nulls profile PII but never touches case_comments — a deleted user's free-text comments (possible PII) persist; only author_id is nulled.",
      recommendation: "In scrub_user_tx, anonymise or tombstone the user's case_comments.body (e.g. '[deleted]') in the same transaction.",
    });
  }
}

// ── F-C — no retention / storage-limitation automation (Art. 5(1)(e)) ────────
{
  const partitioned = [];
  for (const f of sqlFiles) {
    const lines = readSafe(f).split("\n");
    lines.forEach((l, i) => {
      if (/PARTITION BY RANGE/i.test(l)) partitioned.push({ file: rel(f), line: i + 1, text: l.trim() });
    });
  }
  // Strip comments first — "Retention = DROP PARTITION" in a schema comment is
  // a stated INTENT, not running automation.
  const sqlNoComments = sqlBlob.replace(/--[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
  const apiNoComments = apiBlob.replace(/\/\/[^\n]*/g, "");
  const hasReap = /(DETACH PARTITION|DROP PARTITION|pg_cron|pg_partman)/i.test(sqlNoComments + apiNoComments);
  if (partitioned.length > 0 && !hasReap) {
    add({
      id: "F-C", severity: "High", principle: "5 End-to-End Security (lifecycle)", article: "Art. 5(1)(e)",
      title: "No retention automation",
      evidence: partitioned,
      risk: "events (incl. user_id), request_log and db_query_log are partitioned but never reaped; audit + personal data grow unbounded — no demonstrable storage limit.",
      recommendation: "Ship a scheduled DROP/DETACH PARTITION job per partitioned table + a stated retention window; batch-GC expired sessions.",
    });
  }
}

// ── F-D — no transparency / consent surface (Art. 13) ────────────────────────
{
  const feText = readAll(walk(FRONTEND, [".html", ".js"]));
  let hit = null;
  for (const { file, text } of feText) {
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      if (/bi-[\w-]*cookie|icon/i.test(l)) continue; // skip the bootstrap-icons cookie glyph
      if (/privacy[\s_-]?policy|cookie[\s_-]?(notice|consent|banner)|consent[\s_-]?(form|banner|prompt)|\bgdpr\b|data[\s_-]?protection[\s_-]?notice/i.test(l)) {
        hit = { file: rel(file), line: i + 1, text: l.trim() };
        break;
      }
    }
    if (hit) break;
  }
  if (!hit) {
    add({
      id: "F-D", severity: "High", principle: "6 Visibility & Transparency", article: "Art. 12-14",
      title: "No privacy notice or consent surface",
      evidence: [{ file: "frontend/", line: 0, text: "no privacy notice / consent / cookie surface found" }],
      risk: "No user-facing notice of what is collected, the lawful basis, or the controller/processor split — and no consent capture. Required before processing real personal data.",
      recommendation: "Publish a privacy notice + (where relevant) consent capture; document the controller (own users) vs processor (uploaded data) split.",
    });
  }
}

// ── F-E — chart/dashboard spec bakes customer-derived data into the registry ─
{
  const ce = readSafe(CHART_EDITOR);
  if (/synthesizeOption\s*\(/.test(ce) && /getPayload/.test(ce) && /\.\.\.c\b/.test(ce)) {
    add({
      id: "F-E", severity: "High", principle: "3 Privacy Embedded into Design", article: "Art. 5(1)(c),(e), 25",
      title: "Chart spec persists customer-derived data",
      evidence: [locate(CHART_EDITOR, /synthesizeOption\s*\(/), locate(CHART_EDITOR, /getPayload/)].filter(Boolean),
      risk: "spec.option carries the /group/preview result (group KEYS = raw cell values + aggregates) into project_files.spec in Postgres — contradicts the locked registry-redundancy.md AND the 'derive, don't store' binding rule. The recipe (group_by/agg) is already in the spec, so option is redundant.",
      recommendation: "Recipe-only: drop spec.option; re-derive it on load via /group/preview (Em decision 2026-06-16).",
    });
  }
}

// ── F-F — connector secrets stored plaintext (Art. 32) ───────────────────────
{
  // crypto DEPENDENCY (line-start), not the sqlx 'tls-rustls-ring' transport feature
  const cryptoDep = /^\s*(aes-gcm|aes|chacha20poly1305|orion|age|libsodium|sodiumoxide|crypto_box|rsa|ring)\s*=/m.test(CARGO);
  const connectorsExist = /\bconnectors\b/i.test(sqlBlob) || /REDPASH_MASTER_KEY/.test(sqlBlob + apiBlob);
  const encryptCode = /(fn\s+(encrypt|decrypt)\b|REDPASH_MASTER_KEY)/.test(apiBlob);
  if (connectorsExist && !cryptoDep && !encryptCode) {
    add({
      id: "F-F", severity: "High", principle: "5 End-to-End Security", article: "Art. 32",
      title: "Connector secrets unencrypted (declared, unimplemented)",
      evidence: [locate(INIT_SQL, /REDPASH_MASTER_KEY|encrypted/i) || { file: rel(INIT_SQL), line: 0, text: "encryption declared in schema comment" },
                 { file: "backend/Cargo.toml", line: 0, text: "no at-rest crypto dependency" }].filter(Boolean),
      risk: "init.sql promises connectors.config is v1:-encrypted under REDPASH_MASTER_KEY, but no crypto dependency or encrypt/decrypt code exists — secrets would be plaintext. (Latent: no live connector route yet.)",
      recommendation: "Implement the declared AEAD encryption under REDPASH_MASTER_KEY before any connector route ships.",
    });
  }
}

// ── F-G — no PII-classification dimension (Art. 25) ──────────────────────────
{
  if (/CREATE TABLE type_fields/i.test(sqlBlob) && !/(data_class|pii_class|sensitivity|pii_tag)/i.test(sqlBlob)) {
    add({
      id: "F-G", severity: "Medium", principle: "2 Privacy as the Default", article: "Art. 25",
      title: "No PII-classification dimension",
      evidence: [locate(INIT_SQL, /perm_class/) || { file: rel(INIT_SQL), line: 0, text: "type_fields has perm_class (access), no sensitivity column" }].filter(Boolean),
      risk: "type_fields.perm_class governs who-can-EDIT, not data sensitivity. With no data_class dimension, redaction / export-scoping / erasure cannot key off 'is this personal data'. Keystone gap.",
      recommendation: "Add an orthogonal data_class (none|personal|sensitive) column to type_fields; tag the PII fields; consumers derive from it.",
    });
  }
}

// ── F-H — no data-subject export / portability (Art. 15, 20) ─────────────────
{
  if (!/me\/export|export_my_data|data_subject|subject_access|portability/i.test(apiBlob)) {
    add({
      id: "F-H", severity: "Medium", principle: "7 Respect for User Privacy", article: "Art. 15, 20",
      title: "No data-subject export",
      evidence: [locate(p("backend","crates","api","src","me.rs"), /async fn|Router|route/) || { file: "backend/crates/api/src/me.rs", line: 0, text: "GET /api/me only; no subject export" }].filter(Boolean),
      risk: "No consolidated 'all my data' export — only per-file export exists. Cannot satisfy a subject access/portability request in machine-readable form.",
      recommendation: "Add /api/me/export aggregating the subject's data (key off F-G's data_class to omit secrets).",
    });
  }
}

// ── F-I — no read/access audit (Art. 30 accountability) ──────────────────────
{
  const hasEventCalls = /event::(info|warn|record)\s*\(/.test(apiBlob);
  // Extract each event KIND (the arg right after `pool`) — so a context-JSON
  // field like "can_read" can't masquerade as a read-audit.
  const kinds = [];
  for (const m of apiBlob.matchAll(/event::(?:info|warn|record)\s*\(/g)) {
    const slice = apiBlob.slice(m.index, m.index + 220);
    const comma = slice.indexOf(",");
    if (comma < 0) continue;
    const km = slice.slice(comma + 1).match(/^\s*(?:"([a-z0-9_]+)"|format!\(\s*"([^"]+)")/i);
    if (km) kinds.push((km[1] || km[2] || "").toLowerCase());
  }
  const hasReadAudit = kinds.some((k) => /(view|read|access|download|open)/.test(k));
  if (hasEventCalls && !hasReadAudit) {
    add({
      id: "F-I", severity: "Medium", principle: "5 End-to-End Security (accountability)", article: "Art. 30",
      title: "No read-access audit",
      evidence: [locate(EVENT, /fn\s+record/) || { file: rel(EVENT), line: 0, text: "events record create/update/delete only" }].filter(Boolean),
      risk: "The events trail logs mutations only — never reads. Cannot evidence WHO accessed which personal data, weakening the Art. 30 record of processing.",
      recommendation: "Emit access events for personal-data reads/downloads; redact context by F-G's data_class.",
    });
  }
}

// ── F-K — client storage not cleared on logout (Art. 17/32; latent) ──────────
{
  const logoutFile = locate(walk(FRONTEND, [".js"]), /\/auth\/logout/);
  if (logoutFile) {
    const f = p(logoutFile.file);
    const txt = readSafe(f);
    const clears = /(indexedDB|deleteDatabase|drop_table|localStorage\.clear|sessionStorage\.clear|idb)/i.test(txt);
    if (!clears) {
      add({
        id: "F-K", severity: "Medium", principle: "5 End-to-End Security (lifecycle)", article: "Art. 17, 32",
        title: "Logout doesn't wipe client storage",
        evidence: [logoutFile],
        risk: "Logout drops the server session + cookie but not IndexedDB/localStorage. Latent now (GlueSQL-idb unwired), but the moment on-device data lands, a shared device leaks the prior user's data.",
        recommendation: "On logout, clear IndexedDB (drop GlueSQL DB) + localStorage — wire BEFORE the idb store goes live.",
      });
    }
  }
}

// ── F-L — comment body plaintext + stale 'sanitized HTML' schema comment ─────
{
  const init = readSafe(INIT_SQL);
  const cases = readSafe(CASES);
  const staleClaim = /(sanitiz|whitelist[\s-]?rebuild)/i.test(init);
  // A real server-side HTML sanitizer is a DEPENDENCY, not a comment — the
  // "sanitize" tokens in cases.rs are the FE-escape note + filename-header code.
  const noServerSanitizer = !/(ammonia|sanitize[_-]?html|scrub_html|html[_-]?sanitiz)/i.test(CARGO);
  // Resolved EITHER by a real sanitizer dep (above) OR by a corrective, truthful
  // `COMMENT ON COLUMN case_comments.body` that supersedes the stale inline note.
  const docCorrected = /COMMENT ON COLUMN\s+case_comments\.body/i.test(sqlBlob);
  if (staleClaim && noServerSanitizer && !docCorrected && /case_comments/.test(cases)) {
    add({
      id: "F-L", severity: "Medium", principle: "5 End-to-End Security (integrity)", article: "Art. 32",
      title: "Comment body raw plaintext; schema comment misleads",
      evidence: [locate(INIT_SQL, /(sanitiz|whitelist[\s-]?rebuild)/i), locate(CASES, /case_comments/)].filter(Boolean),
      risk: "case_comments.body is stored raw; init.sql claims 'sanitized whitelist-rebuild HTML'. The defense rests solely on FE escaping — a non-FE consumer (API/mobile) could render stored HTML/script.",
      recommendation: "Either server-side sanitize on write or correct the stale schema comment to state 'raw text; FE escapes'.",
    });
  }
}

// ── F-J — columns_meta.sample cell value (ACCEPTED exception, Em 2026-06-16) ──
{
  const dtype = readSafe(DTYPE);
  if (/\bsample\b/.test(dtype)) {
    add({
      id: "F-J", status: "accepted", severity: "Medium", principle: "3 Privacy Embedded into Design", article: "Art. 5(1)(c)",
      title: "Sample cell value in the registry (accepted)",
      evidence: [locate(DTYPE, /\bsample\b/)].filter(Boolean),
      risk: "columns_meta.sample stores one representative cell value server-side (could be PII).",
      recommendation: "Accepted exception (UX) per registry-redundancy.md; mitigation = at-rest encryption of the registry sample/blobs (pending).",
    });
  }
}

// ── strengths (informational; not scored) ────────────────────────────────────
strengths.push(
  { title: "Compute-to-data architecture — raw rows stay client-side", ref: "docs/decisions/registry-redundancy.md" },
  { title: "Metadata-only attachment & file stores (no content in Postgres)", ref: "backend/migrations/20260617000000_case_priority_attachments.sql" },
  { title: "Leak-free 404 RBAC + IDOR-safe attachment download (WHERE id AND case_id)", ref: "backend/crates/api/src/cases.rs" },
  { title: "SSRF + TLS-required connector gate; no analytics/tracker/LLM egress", ref: "backend/crates/api/src/connectors_core.rs" },
  { title: "Erasure intent: scrub nulls PII, refuses to orphan sole-owned objects", ref: "backend/crates/api/src/db.rs" },
);

// ── emit audit.json (deterministic — no timestamp in the diffable body) ──────
const bySeverity = findings.reduce((m, f) => ((m[f.severity] = (m[f.severity] || 0) + 1), m), {});
const out = {
  tool: "privacy",
  spec: "GDPR + Privacy-by-Design (Art. 25) — see docs/privacy/assessment-2026-06-16.md",
  stats: { gaps: findings.length, accepted: accepted.length, bySeverity },
  findings,
  accepted,
  strengths,
};
fs.writeFileSync(path.join(__dirname, "audit.json"), JSON.stringify(out, null, 2) + "\n");

// ── emit report.html ─────────────────────────────────────────────────────────
const esc = (s) => String(s == null ? "" : s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
const sevColor = { Critical: "#d20f39", High: "#e64553", Medium: "#df8e1d", Low: "#1e66f5" };
const card = (f) => `
  <div class="card" style="border-left:4px solid ${sevColor[f.severity] || "#888"}">
    <div class="row"><span class="sev" style="background:${sevColor[f.severity] || "#888"}">${esc(f.severity)}</span>
      <strong>${esc(f.id)} — ${esc(f.title)}</strong>
      <span class="tag">${esc(f.article)}</span><span class="tag">PbD ${esc(f.principle)}</span></div>
    <div class="risk">${esc(f.risk)}</div>
    <div class="rec"><b>Recommendation:</b> ${esc(f.recommendation)}</div>
    <div class="ev">${(f.evidence || []).map((e) => `<code>${esc(e.file)}${e.line ? ":" + e.line : ""}</code>`).join(" ")}</div>
  </div>`;
const html = `<!doctype html><meta charset="utf-8"><title>RedPash — Privacy Assessment</title>
<style>
:root{font-family:ui-sans-serif,system-ui,sans-serif}
body{margin:0;background:#1e1e2e;color:#cdd6f4;padding:2rem;line-height:1.5}
h1{margin:0 0 .25rem}.sub{color:#9399b2;margin-bottom:1.5rem}
.summary{display:flex;gap:1rem;flex-wrap:wrap;margin-bottom:1.5rem}
.kpi{background:#313244;border-radius:.6rem;padding:.75rem 1.1rem}.kpi b{font-size:1.6rem;display:block}
.card{background:#313244;border-radius:.6rem;padding:.9rem 1.1rem;margin:.6rem 0}
.row{display:flex;gap:.5rem;align-items:center;flex-wrap:wrap}
.sev{color:#fff;font-size:.7rem;font-weight:700;padding:.1rem .5rem;border-radius:.4rem}
.tag{background:#45475a;color:#bac2de;font-size:.72rem;padding:.1rem .5rem;border-radius:.4rem}
.risk{margin:.5rem 0;color:#cdd6f4}.rec{color:#a6e3a1;font-size:.9rem}.ev{margin-top:.4rem}
code{background:#11111b;color:#89b4fa;padding:.1rem .35rem;border-radius:.3rem;font-size:.8rem}
h2{margin:1.5rem 0 .5rem;color:#f5c2e7}.acc{border-left:4px solid #585b70}.str{color:#a6e3a1}
</style>
<h1>RedPash — Independent Privacy Assessment</h1>
<div class="sub">GDPR &amp; Privacy-by-Design (Art. 25) · generated by tools/privacy-audit · ref docs/privacy/assessment-2026-06-16.md</div>
<div class="summary">
  <div class="kpi"><b>${findings.length}</b>open gaps</div>
  <div class="kpi"><b>${bySeverity.High || 0}</b>high</div>
  <div class="kpi"><b>${bySeverity.Medium || 0}</b>medium</div>
  <div class="kpi"><b>${accepted.length}</b>accepted</div>
</div>
<h2>Open findings (ratcheted)</h2>
${findings.map(card).join("")}
<h2>Accepted exceptions (documented, not scored)</h2>
${accepted.map((f) => `<div class="card acc">${card(f)}</div>`).join("") || "<p>None.</p>"}
<h2>Strengths (preserve these)</h2>
${strengths.map((s) => `<div class="card str">✓ ${esc(s.title)} <code>${esc(s.ref)}</code></div>`).join("")}
`;
fs.writeFileSync(path.join(__dirname, "report.html"), html);

// ── console summary + exit code = open-gap count ─────────────────────────────
if (findings.length) {
  console.error(`privacy-audit: ${findings.length} open finding(s), ${accepted.length} accepted\n`);
  for (const f of findings) console.error(`  [${f.severity}] ${f.id} ${f.title} (${f.article})`);
} else {
  console.log("privacy-audit: OK — no open privacy findings");
}
process.exit(findings.length);
