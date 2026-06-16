/* node:test over the type registry (S7): one shared fetch, typeById lookup,
   invalidate() clears, and a failed fetch never poisons future reads.
   Run via: sh tools/test-fe.sh (node --test frontend/tests/). */

import { test } from "node:test";
import assert from "node:assert/strict";

/* browser shims the api wrapper expects at call time */
let calls = 0;
let respond = null;
globalThis.fetch = async () => {
  calls++;
  return respond();
};
globalThis.location = { hash: "" }; // api.js touches location.hash on 401 only

const ok = (body) => ({
  ok: true,
  status: 200,
  text: async () => JSON.stringify(body),
});
const down = () => ({
  ok: false,
  status: 503,
  text: async () => JSON.stringify({ error: "down" }),
});

const reg = await import("../framework/registry/type-registry.js");

const CATALOG = {
  types: [
    {
      type_id: "user",
      display_name: "User",
      display_name_plural: "Users",
      rid_prefix: "USR",
      grid_served: false,
      fields: [
        {
          key: "display_name",
          label: "Display name",
          data_type: "text",
          perm_class: "identity",
          ordinal: 1,
          cells: { owner: "rw", admin: "rw", member: "r", viewer: "r" },
        },
      ],
    },
  ],
};

test("getTypes: one fetch, shared by every caller", async () => {
  respond = () => ok(CATALOG);
  const a = await reg.getTypes();
  const b = await reg.getTypes();
  assert.equal(calls, 1);
  assert.equal(a, b); // the same cached array, not a re-fetch
  assert.equal(a[0].type_id, "user");
});

test("typeById: lookup over the cache, null for unknown", async () => {
  assert.equal((await reg.typeById("user")).display_name_plural, "Users");
  assert.equal(await reg.typeById("nope"), null);
  assert.equal(calls, 1); // still the one fetch
});

test("invalidate: the next read re-fetches", async () => {
  reg.invalidate();
  respond = () => ok({ types: [] });
  assert.deepEqual(await reg.getTypes(), []);
  assert.equal(calls, 2);
});

test("a failed fetch does not poison the cache", async () => {
  reg.invalidate();
  respond = down;
  await assert.rejects(reg.getTypes(), /down/);
  respond = () => ok(CATALOG);
  const types = await reg.getTypes(); // recovers — no stale rejected promise
  assert.equal(types[0].type_id, "user");
});
