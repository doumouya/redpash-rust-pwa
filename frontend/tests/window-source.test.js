/* node:test over window-source's clientSource — the peak-op RECLAIM lifecycle.
   The invariant under test: the resident engine (parse-once → windows/sql) lives
   for the source's lifetime, while a heavy op (score) runs in a THROWAWAY engine
   that is terminated the moment it returns — so the peak-op high-water never
   sticks to the resident frame. No DOM; we stub Worker + fetch + location.
   Run via: sh tools/test-fe.sh */

import { test } from "node:test";
import assert from "node:assert/strict";

// ── stub the browser surface clientSource reads (Worker / fetch / location) ──
// Every FakeWorker registers itself so a test can assert how many engines were
// spawned and which were terminated (= reclaimed).
const workers = [];

class FakeWorker {
  constructor() {
    this.posts = [];
    this.terminated = false;
    this.onmessage = null;
    this.onerror = null;
    workers.push(this);
  }
  postMessage(msg, _transfer) {
    this.posts.push(msg);
    // canned engine replies; view/sql/score return a JSON STRING (the real
    // engine does, and clientSource JSON.parses it).
    const reply = {
      init: { ready: true },
      load: { rows: 100, cols: 5 },
      view: '{"columns":["a"],"rows":[],"total":0}',
      sql: '{"columns":["a"],"rows":[],"total":0}',
      score: '{"score":42}',
    }[msg.op];
    // respond asynchronously, as a real worker would, after onmessage is set
    queueMicrotask(() => {
      if (this.terminated) return;
      this.onmessage?.({ data: { id: msg.id, ok: true, result: reply } });
    });
  }
  terminate() { this.terminated = true; }
}

globalThis.Worker = FakeWorker;
globalThis.location = { origin: "http://localhost", hash: "" };
globalThis.fetch = async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) });

const { clientSource } = await import("../framework/engine/window-source.js");

function reset() { workers.length = 0; }

test("open: one resident engine spawns and parses; nothing terminated", async () => {
  reset();
  const src = clientSource("rid1");
  await src.ready;
  assert.equal(workers.length, 1, "exactly one (resident) engine");
  assert.equal(workers[0].terminated, false, "resident stays alive");
  // it ran init + load (the parse), in that order
  assert.deepEqual(workers[0].posts.map((p) => p.op), ["init", "load"]);
});

test("window + sql run on the resident engine — no new engine spawned", async () => {
  reset();
  const src = clientSource("rid1");
  await src.window(null, 0, 50);
  await src.sql("select * from t");
  assert.equal(workers.length, 1, "still just the resident engine");
  assert.deepEqual(
    workers[0].posts.map((p) => p.op),
    ["init", "load", "view", "sql"],
  );
});

test("score runs in a throwaway engine that is terminated (reclaimed); resident untouched", async () => {
  reset();
  const src = clientSource("rid1");
  const report = await src.score();
  assert.deepEqual(report, { score: 42 }, "score JSON string is parsed");
  assert.equal(workers.length, 2, "a second (peak-op) engine was spawned");
  const [resident, peak] = workers;
  assert.equal(peak.terminated, true, "the peak-op engine is terminated → memory reclaimed");
  assert.equal(resident.terminated, false, "the resident engine survives the heavy op");
  // the peak engine re-parsed before scoring (frames aren't transferable)
  assert.deepEqual(peak.posts.map((p) => p.op), ["init", "load", "score"]);
});

test("a newer score supersedes the prior peak-op engine (at most one alive)", async () => {
  reset();
  const src = clientSource("rid1");
  await src.ready;
  const first = src.score();
  const second = src.score();
  await Promise.allSettled([first, second]);
  // resident (1) + two peak-op engines (2,3); both peak engines terminated
  const peaks = workers.slice(1);
  assert.ok(peaks.length >= 2, "each score spawned its own peak-op engine");
  assert.ok(peaks.every((w) => w.terminated), "no peak-op engine is left running");
  assert.equal(workers[0].terminated, false, "resident still alive");
});

test("destroy terminates the resident engine", async () => {
  reset();
  const src = clientSource("rid1");
  await src.ready;
  src.destroy();
  assert.equal(workers[0].terminated, true, "resident reclaimed on destroy");
});
