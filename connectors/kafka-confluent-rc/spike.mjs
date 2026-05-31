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
  if (!env.KAFKA_TOPIC || !env.KAFKA_KEY) {
    console.log("(KAFKA_TOPIC + KAFKA_KEY not set, skipping)");
    return null;
  }
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
  if (phase1Result.subjects.length) {
    try {
      const sub = phase1Result.subjects[0];
      const sr = makeRegistryClient({
        url: env.SCHEMA_REGISTRY_URL,
        key: env.SCHEMA_REGISTRY_KEY,
        secret: env.SCHEMA_REGISTRY_SECRET,
      });
      const latest = await sr.get(`/subjects/${encodeURIComponent(sub.subject)}/versions/latest`);
      rawType = avsc.Type.forSchema(JSON.parse(latest.schema));
    } catch (e) {
      console.log(`  ⚠ raw-avro type compile failed: ${e.message}`);
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
  await consumer.subscribe({ topic: env.KAFKA_TOPIC, fromBeginning: true });
  console.log(`  consuming one message from ${env.KAFKA_TOPIC}…`);
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
