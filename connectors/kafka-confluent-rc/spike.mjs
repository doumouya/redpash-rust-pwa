#!/usr/bin/env node
/* Purpose: see README.md for details.
 * Doc: connectors/kafka-confluent-rc/README.md
 *
 * kafka-confluent-rc — RedPash Connector for Kafka topics with
 * Confluent Schema Registry. Currently in spike form: 5 phases that
 * produce design-call data for CAS_75A0D1FD codec registry v1.1.
 * Productionization (load step into project_files + offset state +
 * multi-partition) follows codec registry v1.1.
 * Run via: node spike.mjs [phaseN]
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENV_PATH = resolvePath(__dirname, ".env");
const RESULTS_DIR = resolvePath(__dirname, "results");
const CONTRACTS_DIR = resolvePath(__dirname, "contracts");

// ── env loading (no dotenv dep — manual parse is trivial) ──────────
function loadEnv() {
  if (!existsSync(ENV_PATH)) {
    console.error(`✗ .env not found at ${ENV_PATH}`);
    console.error("  Copy .env.example → .env and populate values.");
    process.exit(1);
  }
  const env = {};
  for (const line of readFileSync(ENV_PATH, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return env;
}

function assertEnv(env, keys) {
  const missing = keys.filter((k) => !env[k]);
  if (missing.length) {
    console.error(`✗ .env missing required keys: ${missing.join(", ")}`);
    process.exit(1);
  }
}

// ── timing helpers ─────────────────────────────────────────────────
function now() { return performance.now(); }
function ms(t) { return Math.round(t * 100) / 100; }

async function timed(fn) {
  const t0 = now();
  let result, error;
  try { result = await fn(); }
  catch (e) { error = e; }
  return { latencyMs: ms(now() - t0), result, error };
}

// ── Schema Registry client (raw HTTP — no lib dep here so we control
// the wire shape) ──────────────────────────────────────────────────
function makeRegistryClient({ url, key, secret }) {
  const auth = "Basic " + Buffer.from(`${key}:${secret}`).toString("base64");
  const base = url.replace(/\/+$/, "");
  return {
    async get(path) {
      const r = await fetch(`${base}${path}`, {
        headers: { Authorization: auth, Accept: "application/vnd.schemaregistry.v1+json" },
      });
      if (!r.ok) {
        const body = await r.text().catch(() => "");
        const err = new Error(`SR ${r.status} ${r.statusText}: ${body.slice(0, 200)}`);
        err.status = r.status;
        err.body = body;
        throw err;
      }
      return r.json();
    },
  };
}

// ── PHASE 1 — subject discovery ───────────────────────────────────
async function phase1(sr, env) {
  console.log("\n── phase 1: subject discovery ───────────────────");
  const subjects = await sr.get("/subjects");
  console.log(`subjects: ${subjects.length}`);
  const limited = env.SUBJECTS ? env.SUBJECTS.split(",").map((s) => s.trim()).filter(Boolean) : subjects;
  const details = [];
  for (const subject of limited) {
    const versions = await sr.get(`/subjects/${encodeURIComponent(subject)}/versions`);
    const latest = await sr.get(`/subjects/${encodeURIComponent(subject)}/versions/latest`);
    const schemaJson = JSON.parse(latest.schema);
    details.push({
      subject,
      versions: versions.length,
      latestId: latest.id,
      latestVersion: latest.version,
      schemaType: schemaJson.type || schemaJson.name || "unknown",
      fieldCount: Array.isArray(schemaJson.fields) ? schemaJson.fields.length : 0,
    });
    console.log(`  ${subject.padEnd(40)} v${latest.version} id=${latest.id}  ${(schemaJson.name || "").padEnd(20)} ${schemaJson.fields?.length ?? "?"} fields`);
  }
  return { subjects: details, totalSubjects: subjects.length };
}

// ── PHASE 2 — cold-resolve latency ────────────────────────────────
async function phase2(sr, env, phase1Result) {
  console.log("\n── phase 2: cold-resolve latency ────────────────");
  const ids = phase1Result.subjects.map((s) => s.latestId);
  if (!ids.length) { console.log("(no subjects discovered, skipping)"); return null; }
  const cold = [];
  // No cache — each call is a fresh HTTP fetch.
  for (const id of ids) {
    const { latencyMs, error } = await timed(() => sr.get(`/schemas/ids/${id}`));
    cold.push({ id, latencyMs, error: error ? error.message : null });
    console.log(`  id=${String(id).padEnd(8)} ${latencyMs}ms${error ? " ✗ " + error.message : ""}`);
  }
  const latencies = cold.filter((c) => !c.error).map((c) => c.latencyMs);
  const stats = latencies.length ? {
    n: latencies.length,
    min: Math.min(...latencies),
    max: Math.max(...latencies),
    mean: ms(latencies.reduce((a, b) => a + b, 0) / latencies.length),
    p50: ms([...latencies].sort((a, b) => a - b)[Math.floor(latencies.length / 2)]),
  } : null;
  console.log(`  → cold: min=${stats?.min} p50=${stats?.p50} mean=${stats?.mean} max=${stats?.max}ms (n=${stats?.n})`);
  return { cold, stats };
}

// ── PHASE 3 — warm cache hit ──────────────────────────────────────
async function phase3(sr, phase1Result) {
  console.log("\n── phase 3: warm cache hit ──────────────────────");
  const ids = phase1Result.subjects.map((s) => s.latestId);
  if (!ids.length) { console.log("(no subjects discovered, skipping)"); return null; }
  // Build a Map cache (mimicking what the codec would do).
  const cache = new Map();
  // Prime
  for (const id of ids) {
    const r = await sr.get(`/schemas/ids/${id}`);
    cache.set(id, r);
  }
  console.log(`  primed cache with ${cache.size} schemas`);
  // Warm-hit timing — read from Map, no HTTP.
  const warm = [];
  for (const id of ids) {
    const { latencyMs } = await timed(() => Promise.resolve(cache.get(id)));
    warm.push({ id, latencyMs });
  }
  const latencies = warm.map((w) => w.latencyMs);
  const stats = {
    n: latencies.length,
    min: Math.min(...latencies),
    max: Math.max(...latencies),
    mean: ms(latencies.reduce((a, b) => a + b, 0) / latencies.length),
  };
  console.log(`  → warm: min=${stats.min} mean=${stats.mean} max=${stats.max}ms (n=${stats.n})`);
  return { warm, stats };
}

// ── PHASE 4 — failure modes ──────────────────────────────────────
async function phase4(env) {
  console.log("\n── phase 4: failure modes ───────────────────────");
  const results = {};

  // 4a: wrong URL (DNS / connection error)
  const wrongUrl = makeRegistryClient({
    url: "https://this-host-does-not-exist-1234.confluent.cloud",
    key: env.SCHEMA_REGISTRY_KEY,
    secret: env.SCHEMA_REGISTRY_SECRET,
  });
  results.wrongUrl = await timed(() => wrongUrl.get("/subjects"));
  console.log(`  4a wrong URL  → ${results.wrongUrl.error?.message?.slice(0, 80) || "(unexpected ok)"}  (${results.wrongUrl.latencyMs}ms)`);

  // 4b: wrong auth (401)
  const wrongAuth = makeRegistryClient({
    url: env.SCHEMA_REGISTRY_URL,
    key: "wrong-key",
    secret: "wrong-secret",
  });
  results.wrongAuth = await timed(() => wrongAuth.get("/subjects"));
  console.log(`  4b wrong auth → ${results.wrongAuth.error?.message?.slice(0, 80) || "(unexpected ok)"}  (${results.wrongAuth.latencyMs}ms)`);

  // 4c: missing schema_id (404)
  const sr = makeRegistryClient({
    url: env.SCHEMA_REGISTRY_URL,
    key: env.SCHEMA_REGISTRY_KEY,
    secret: env.SCHEMA_REGISTRY_SECRET,
  });
  results.missingId = await timed(() => sr.get(`/schemas/ids/99999999`));
  console.log(`  4c missing id → ${results.missingId.error?.message?.slice(0, 80) || "(unexpected ok)"}  (${results.missingId.latencyMs}ms)`);

  return results;
}

// ── PHASE 5 — end-to-end Avro decode ─────────────────────────────
async function phase5(env, phase1Result) {
  console.log("\n── phase 5: end-to-end decode (Confluent + raw Avro) ──");
  // CLI override for ad-hoc consumes against a non-default topic:
  //   node spike.mjs phase5 <topic>
  //   node spike.mjs phase5 <topic> <subject>     (subject = which contracts/ schema to decode against)
  const cliTopic   = process.argv[3];
  const cliSubject = process.argv[4];
  const topic = cliTopic || env.KAFKA_TOPIC;
  if (!topic || !env.KAFKA_KEY) {
    console.log("(KAFKA_TOPIC + KAFKA_KEY not set, skipping)");
    return null;
  }
  console.log(`  topic: ${topic}${cliTopic ? " (CLI override)" : ""}`);
  let SchemaRegistry, Kafka, avsc;
  try {
    ({ SchemaRegistry } = await import("@kafkajs/confluent-schema-registry"));
    ({ Kafka } = await import("kafkajs"));
    avsc = (await import("avsc")).default;
  } catch (e) {
    console.log(`✗ deps not installed (npm install in connectors/kafka-confluent-rc/): ${e.message}`);
    return { error: e.message };
  }
  const registry = new SchemaRegistry({
    host: env.SCHEMA_REGISTRY_URL,
    auth: { username: env.SCHEMA_REGISTRY_KEY, password: env.SCHEMA_REGISTRY_SECRET },
  });
  // Pre-fetch + compile the raw Avro type for the fallback path. The
  // fallback path is what real-world producers using Datagen / raw-Avro
  // configs require — Confluent's `{magic, schema_id}` framing is NOT
  // universal. The spike's biggest find (2026-06-01): assume nothing
  // about wire format until you measure it.
  let rawType = null;
  // Subject resolution priority:
  //   1. CLI override (cliSubject)
  //   2. Match by topic name convention: `<topic>-value` (Confluent default for values)
  //   3. Fallback to phase1's first discovered subject
  const targetSubjectName =
    cliSubject ||
    phase1Result.subjects.find((s) => s.subject === `${topic}-value`)?.subject ||
    phase1Result.subjects[0]?.subject;
  const targetSubject = phase1Result.subjects.find((s) => s.subject === targetSubjectName);
  if (targetSubject) {
    try {
      const sr = makeRegistryClient({
        url: env.SCHEMA_REGISTRY_URL,
        key: env.SCHEMA_REGISTRY_KEY,
        secret: env.SCHEMA_REGISTRY_SECRET,
      });
      const latest = await sr.get(`/subjects/${encodeURIComponent(targetSubject.subject)}/versions/latest`);
      rawType = avsc.Type.forSchema(JSON.parse(latest.schema));
      console.log(`  decoding against subject: ${targetSubject.subject} (v${latest.version}, id=${latest.id})`);
    } catch (e) {
      console.log(`  ⚠ raw-avro type compile failed for ${targetSubject.subject}: ${e.message}`);
    }
  }
  const kafka = new Kafka({
    clientId: "redpash-spike",
    brokers: [env.KAFKA_BOOTSTRAP],
    ssl: true,
    sasl: { mechanism: "plain", username: env.KAFKA_KEY, password: env.KAFKA_SECRET },
  });
  const consumer = kafka.consumer({ groupId: `redpash-spike-${Date.now()}` });
  await consumer.connect();
  await consumer.subscribe({ topic, fromBeginning: true });
  console.log(`  consuming one message from ${topic}…`);
  const decoded = await new Promise((resolve) => {
    const timeout = setTimeout(() => resolve({ error: "timeout 10s, no message" }), 10000);
    consumer.run({
      eachMessage: async ({ message }) => {
        clearTimeout(timeout);
        try {
          const head = message.value.slice(0, 8).toString("hex");
          const magic = message.value.readUInt8(0);
          // Try BOTH paths so we record both latencies + know which
          // shape the topic actually serves.
          const confluent = await timed(() => registry.decode(message.value));
          let raw = { result: undefined, error: new Error("rawType unavailable") };
          if (rawType) raw = await timed(() => Promise.resolve(rawType.fromBuffer(message.value)));
          resolve({
            rawLength: message.value.length,
            wireHeadHex: head,
            magicByte: magic,
            confluentDecode: {
              latencyMs: confluent.latencyMs,
              error: confluent.error ? confluent.error.message : null,
              keyCount: confluent.result && typeof confluent.result === "object" ? Object.keys(confluent.result).length : null,
            },
            rawAvroDecode: {
              latencyMs: raw.latencyMs,
              error: raw.error ? raw.error.message : null,
              keyCount: raw.result && typeof raw.result === "object" ? Object.keys(raw.result).length : null,
              valuePreview: raw.result && typeof raw.result === "object"
                ? JSON.stringify(raw.result).slice(0, 300) : null,
            },
          });
        } catch (e) {
          resolve({ error: e.message });
        }
      },
    });
  });
  await consumer.disconnect();
  if (decoded.error) {
    console.log(`  ✗ ${decoded.error}`);
  } else {
    console.log(`  consumed ${decoded.rawLength} bytes; wire head 0x${decoded.wireHeadHex}`);
    console.log(`  magic byte: 0x${decoded.magicByte.toString(16).padStart(2, "0")} (Confluent expects 0x00)`);
    const c = decoded.confluentDecode;
    const r = decoded.rawAvroDecode;
    console.log(`  confluent.decode: ${c.error ? "✗ " + c.error.slice(0, 80) : "✓ " + c.keyCount + " keys"} (${c.latencyMs}ms)`);
    console.log(`  raw avro decode:  ${r.error ? "✗ " + r.error.slice(0, 80) : "✓ " + r.keyCount + " keys"} (${r.latencyMs}ms)`);
    if (r.valuePreview) console.log(`  preview: ${r.valuePreview}`);
  }
  return decoded;
}

// ── bootstrap-contracts: fetch every (subject, version) from the
// registry with the credentials we already have + save each response
// envelope to contracts/. After this runs once, the codec can resolve
// schemas file-based at runtime with zero registry calls. The file
// shape matches GET /subjects/{subject}/versions/{version} exactly so
// it's round-trippable. Re-run when schemas evolve. ───────────────
// `bootstrap-contracts diff` — drift detector. Compares the registry's
// current state to what's in contracts/ and surfaces:
//   (a) subjects in registry not in local       (new producer schemas)
//   (b) subjects local not in registry          (deleted or never bootstrapped)
//   (c) versions in registry not in local       (new version registered)
//   (d) content drift on a (subject, version)   (shouldn't happen given
//                                                Confluent's immutability
//                                                invariant; catches local edits)
// Read-only — does NOT modify either side. The first write-aware capability
// per [[data-contract-first]] extension (Em 2026-06-01): credentials are a
// stewardship mandate, not just a read pass.
async function bootstrapContractsDiff(sr) {
  console.log("\n── bootstrap-contracts diff: drift between local + registry ──");
  if (!existsSync(CONTRACTS_DIR)) {
    console.log("(no local contracts/ — run `bootstrap-contracts` first)");
    return { driftDetected: false };
  }
  // Read local index
  const indexPath = resolvePath(CONTRACTS_DIR, "index.json");
  if (!existsSync(indexPath)) {
    console.log("(no contracts/index.json — run `bootstrap-contracts` first)");
    return { driftDetected: false };
  }
  const localIndex = JSON.parse(readFileSync(indexPath, "utf8"));
  const localBySubject = new Map();
  for (const c of localIndex.contracts || []) {
    if (!localBySubject.has(c.subject)) localBySubject.set(c.subject, new Map());
    localBySubject.get(c.subject).set(c.version, c);
  }

  // Walk current registry state
  const remoteSubjects = await sr.get("/subjects");
  const drift = {
    subjectsAddedInRegistry: [],
    subjectsRemovedFromRegistry: [],
    versionsAddedInRegistry: [],
    contentDrift: [],
  };

  for (const subject of remoteSubjects) {
    const versions = await sr.get(`/subjects/${encodeURIComponent(subject)}/versions`);
    if (!localBySubject.has(subject)) {
      drift.subjectsAddedInRegistry.push({ subject, versions });
      console.log(`  + subject "${subject}" exists in registry, NOT local (v: ${versions.join(",")})`);
      continue;
    }
    const localVersions = localBySubject.get(subject);
    for (const v of versions) {
      if (!localVersions.has(v)) {
        drift.versionsAddedInRegistry.push({ subject, version: v });
        console.log(`  + ${subject} v${v} in registry, NOT local`);
        continue;
      }
      // Content drift check
      const remote = await sr.get(`/subjects/${encodeURIComponent(subject)}/versions/${v}`);
      const localFile = resolvePath(CONTRACTS_DIR, localVersions.get(v).envelope);
      if (!existsSync(localFile)) {
        console.log(`  ⚠ index references ${localFile} but file missing`);
        continue;
      }
      const local = JSON.parse(readFileSync(localFile, "utf8"));
      const remoteSchema = typeof remote.schema === "string" ? remote.schema : JSON.stringify(remote.schema);
      const localSchema = typeof local.schema === "string" ? local.schema : JSON.stringify(local.schema);
      if (remoteSchema !== localSchema) {
        drift.contentDrift.push({ subject, version: v, localId: local.id, remoteId: remote.id });
        console.log(`  ✗ ${subject} v${v} DIFFERS  local id=${local.id} vs remote id=${remote.id}`);
      }
    }
  }
  for (const [localSub] of localBySubject) {
    if (!remoteSubjects.includes(localSub)) {
      drift.subjectsRemovedFromRegistry.push(localSub);
      console.log(`  − subject "${localSub}" in local, NOT in registry (deleted upstream?)`);
    }
  }

  const driftDetected =
    drift.subjectsAddedInRegistry.length > 0 ||
    drift.subjectsRemovedFromRegistry.length > 0 ||
    drift.versionsAddedInRegistry.length > 0 ||
    drift.contentDrift.length > 0;
  if (!driftDetected) {
    console.log("  ✓ local contracts/ in sync with registry");
  } else {
    console.log(`\n  drift detected — run \`bootstrap-contracts\` to refresh local`);
  }
  return { driftDetected, drift };
}

async function bootstrapContracts(sr) {
  console.log("\n── bootstrap-contracts: fetch + cache all schemas locally ──");
  if (!existsSync(CONTRACTS_DIR)) mkdirSync(CONTRACTS_DIR, { recursive: true });
  const subjects = await sr.get("/subjects");
  console.log(`  ${subjects.length} subject(s) discovered`);
  const saved = [];
  for (const subject of subjects) {
    const versions = await sr.get(`/subjects/${encodeURIComponent(subject)}/versions`);
    for (const v of versions) {
      const envelope = await sr.get(`/subjects/${encodeURIComponent(subject)}/versions/${v}`);
      // Sanitize subject for filesystem (subject names may contain '/').
      const safe = subject.replace(/[/\\:]/g, "_");

      // Write BOTH forms for full Confluent ecosystem compatibility
      // (Confluent VS Code extension convention, Em 2026-06-01):
      //   `<subject>-v<n>.json`   — full Confluent registry envelope
      //                              (subject + version + id + metadata
      //                              + schema as string). Round-trippable
      //                              with the registry.
      //   `<subject>-v<n>.avsc`   — bare Avro schema (envelope.schema
      //                              parsed + pretty-printed). What
      //                              avro tooling (avro-tools, avsc lib,
      //                              code generators) consumes natively.
      const envName  = `${safe}-v${v}.json`;
      const bareName = `${safe}-v${v}.avsc`;
      const envPath  = resolvePath(CONTRACTS_DIR, envName);
      const barePath = resolvePath(CONTRACTS_DIR, bareName);
      writeFileSync(envPath, JSON.stringify(envelope, null, 2) + "\n");
      let bareWritten = false;
      try {
        const bareSchema = typeof envelope.schema === "string"
          ? JSON.parse(envelope.schema) : envelope.schema;
        writeFileSync(barePath, JSON.stringify(bareSchema, null, 2) + "\n");
        bareWritten = true;
      } catch (e) {
        console.log(`  ⚠ failed to extract bare schema for ${subject} v${v}: ${e.message}`);
      }
      saved.push({ subject, version: v, id: envelope.id, envelope: envName, bare: bareWritten ? bareName : null });
      console.log(`  ✓ ${envName.padEnd(40)} id=${envelope.id}${bareWritten ? `  + ${bareName}` : ""}`);
    }
  }
  // Write an index so consumers can map (subject, version) → file
  // without re-globbing the dir.
  const indexPath = resolvePath(CONTRACTS_DIR, "index.json");
  writeFileSync(indexPath, JSON.stringify({
    generatedAt: new Date().toISOString(),
    registryUrl: process.env.__SR_URL__ || "(see .env)",
    contracts: saved,
  }, null, 2) + "\n");
  console.log(`\n✓ ${saved.length} contract(s) saved (envelope + bare .avsc) to contracts/`);
  console.log(`✓ index written to contracts/index.json`);
  return { saved };
}

// ── runner ────────────────────────────────────────────────────────
async function main() {
  const env = loadEnv();
  const phase = process.argv[2];
  const wantAll = !phase;

  assertEnv(env, ["SCHEMA_REGISTRY_URL", "SCHEMA_REGISTRY_KEY", "SCHEMA_REGISTRY_SECRET"]);

  const sr = makeRegistryClient({
    url: env.SCHEMA_REGISTRY_URL,
    key: env.SCHEMA_REGISTRY_KEY,
    secret: env.SCHEMA_REGISTRY_SECRET,
  });

  // Standalone commands — no phases, one-off operations + exit.
  if (phase === "bootstrap-contracts") {
    process.env.__SR_URL__ = env.SCHEMA_REGISTRY_URL;
    const sub = process.argv[3];
    if (sub === "diff") {
      await bootstrapContractsDiff(sr);
    } else {
      await bootstrapContracts(sr);
    }
    return;
  }

  const out = { startedAt: new Date().toISOString(), env: { registryUrl: env.SCHEMA_REGISTRY_URL } };
  const outPath = resolvePath(RESULTS_DIR, `run-${out.startedAt.replace(/[:.]/g, "-")}.json`);
  // Write partial results on any throw so a phase-5 bug doesn't lose
  // phases 1-4 data. The runner is for exploration, not idempotent ops.
  const flush = (reason) => {
    out.finishedAt = new Date().toISOString();
    if (reason) out.terminatedReason = reason;
    if (!existsSync(RESULTS_DIR)) mkdirSync(RESULTS_DIR, { recursive: true });
    writeFileSync(outPath, JSON.stringify(out, null, 2));
    console.log(`\n${reason ? "⚠" : "✓"} results written to ${outPath}`);
  };

  try {
    let p1;
    if (wantAll || phase === "phase1") {
      p1 = await phase1(sr, env);
      out.phase1 = p1;
    }
    if (wantAll || phase === "phase2") {
      if (!p1) p1 = await phase1(sr, env);
      out.phase2 = await phase2(sr, env, p1);
    }
    if (wantAll || phase === "phase3") {
      if (!p1) p1 = await phase1(sr, env);
      out.phase3 = await phase3(sr, p1);
    }
    if (wantAll || phase === "phase4") {
      out.phase4 = await phase4(env);
    }
    if (wantAll || phase === "phase5") {
      if (!p1) p1 = await phase1(sr, env);
      out.phase5 = await phase5(env, p1);
    }
    flush();
  } catch (err) {
    out.error = { message: err.message, stack: err.stack };
    flush(`crash: ${err.message}`);
    throw err;
  }
}

main().catch((err) => {
  console.error("✗ spike failed:", err);
  process.exit(1);
});
