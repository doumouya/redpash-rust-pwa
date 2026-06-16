/* node:test over the Data Cleaner's clean-catalog — the op palette as data.
   The contract: each op's `id` IS the backend step `kind` and each field value
   IS the exact param the step reads. So every option value MUST be a value the
   backend `data::steps::apply` dispatch accepts — otherwise the op 400s at
   POST /files/:rid/steps. This test locks the three known value divergences
   (cast dtype, fill_nulls strategy, format_dates on_incomplete) shut so they
   can never regress. Pure (no DOM). Run via: sh tools/test-fe.sh */

import { test } from "node:test";
import assert from "node:assert/strict";

const { CLEAN_OPS, cleanOp, opEnabled } = await import(
  "../apps/studio/workspace/clean-catalog.js"
);

// The backend's accepted param vocabularies (backend/crates/data/src/steps/*,
// mirrored in docs/internal/code/frontend/backend.md). An option value outside
// these sets ships an op that 400s.
const CAST_DTYPES = new Set(["int", "float", "str", "bool", "date", "datetime", "time"]);
const FILL_STRATEGIES = new Set(["fixed", "zero", "forward"]);
const ON_INCOMPLETE = new Set(["null", "drop", "keep"]);

/** The declared option values for an op's enum field. */
function optionValues(opId, fieldKey) {
  const op = cleanOp(opId);
  assert.ok(op, `${opId} exists in the catalog`);
  const field = (op.fields ?? []).find((f) => f.key === fieldKey);
  assert.ok(field, `${opId} declares a "${fieldKey}" field`);
  // options are [value, label] pairs
  return (field.options ?? []).map((o) => o[0]);
}

test("cast.dtype options are all backend-accepted dtypes", () => {
  for (const v of optionValues("cast", "dtype")) {
    assert.ok(CAST_DTYPES.has(v), `cast dtype "${v}" must be one of ${[...CAST_DTYPES]}`);
  }
});

test("fill_nulls.strategy options are all backend-accepted strategies", () => {
  for (const v of optionValues("fill_nulls", "strategy")) {
    assert.ok(FILL_STRATEGIES.has(v), `fill_nulls strategy "${v}" must be one of ${[...FILL_STRATEGIES]}`);
  }
});

test("format_dates.on_incomplete options are backend-accepted AND include drop", () => {
  const vals = optionValues("format_dates", "on_incomplete");
  for (const v of vals) {
    assert.ok(ON_INCOMPLETE.has(v), `on_incomplete "${v}" must be one of ${[...ON_INCOMPLETE]}`);
  }
  assert.ok(vals.includes("drop"), "format_dates must offer the backend's `drop` option");
});

test("build() passes the reconciled enum value straight through to params", () => {
  assert.equal(cleanOp("cast").build(["amount"], { dtype: "int" }).dtype, "int");
  assert.equal(cleanOp("fill_nulls").build(["qty"], { strategy: "zero", value: "" }).strategy, "zero");
  assert.equal(
    cleanOp("format_dates").build(["d"], { fmt: "%Y-%m-%d", on_incomplete: "drop" }).on_incomplete,
    "drop"
  );
});

test("build() threads the selection into the param shape the engine expects", () => {
  assert.deepEqual(cleanOp("drop_columns").build(["a", "b"], {}), { cols: ["a", "b"] });
  assert.deepEqual(cleanOp("fix_invalid").build(["a", "b"], { sentinels: ["N/A"] }), {
    columns: ["a", "b"],
    sentinels: ["N/A"],
  });
  const jc = cleanOp("join_columns").build(["first", "last"], { sep: " ", new_name: "" });
  assert.equal(jc.col1, "first");
  assert.equal(jc.col2, "last");
  assert.equal(jc.new_name, "first_last");
});

test("opEnabled gates column ops by selection count; globals always on", () => {
  assert.ok(opEnabled(cleanOp("snake_case_columns"), 0)); // global
  assert.ok(!opEnabled(cleanOp("cast"), 0)); // needs 1
  assert.ok(opEnabled(cleanOp("cast"), 1));
  assert.ok(!opEnabled(cleanOp("cast"), 2)); // max 1
  assert.ok(!opEnabled(cleanOp("join_columns"), 1)); // needs exactly 2
  assert.ok(opEnabled(cleanOp("join_columns"), 2));
});
