/* node:test over the filter-panel's PURE FilterNode logic (no DOM). Covers the
   row -> Pred assembly (value shaping per op, skip-incomplete, combinator) and
   the Group -> rows decomposition (incl. the one-level-only advanced fallback).
   Run via: sh tools/test-fe.sh */

import { test } from "node:test";
import assert from "node:assert/strict";

const {
  assembleFilter,
  decomposeFilter,
  rowComplete,
  rowToPred,
  predToRow,
  blankRow,
  PRED_OPS,
} = await import("../framework/filter-panel/filter-node.js");

test("PRED_OPS covers all 14 shared PredOps", () => {
  const expected = [
    "eq", "neq", "contains", "not_contains", "starts_with", "ends_with",
    "gt", "gte", "lt", "lte", "between", "in", "is_null", "not_null",
  ];
  assert.deepEqual(PRED_OPS.map((o) => o.value), expected);
});

test("rowComplete: text ops need a value; valueless ops do not; between needs both bounds", () => {
  assert.ok(!rowComplete({ col: "", op: "eq", value: "x" })); // no column
  assert.ok(!rowComplete({ col: "a", op: "eq", value: "  " })); // blank value
  assert.ok(rowComplete({ col: "a", op: "eq", value: "x" }));
  assert.ok(rowComplete({ col: "a", op: "is_null" })); // valueless
  assert.ok(rowComplete({ col: "a", op: "not_null" }));
  assert.ok(!rowComplete({ col: "a", op: "between", from: "1", to: "" }));
  assert.ok(rowComplete({ col: "a", op: "between", from: "1", to: "9" }));
});

test("assembleFilter: builds a top Group, skips incomplete rows", () => {
  const rows = [
    { col: "status", op: "eq", value: "open" },
    { col: "", op: "eq", value: "ignored" }, // incomplete -> skipped
    { col: "country", op: "is_null" },
  ];
  const node = assembleFilter(rows, "and");
  assert.equal(node.node, "group");
  assert.equal(node.op, "and");
  assert.equal(node.children.length, 2);
  assert.deepEqual(node.children[0], { node: "pred", col: "status", op: "eq", value: "open" });
  assert.deepEqual(node.children[1], { node: "pred", col: "country", op: "is_null" });
});

test("assembleFilter: empty / all-incomplete rows => match-all Group", () => {
  assert.deepEqual(assembleFilter([], "and"), { node: "group", op: "and", children: [] });
  assert.deepEqual(
    assembleFilter([blankRow()], "or"),
    { node: "group", op: "or", children: [] }
  );
});

test("rowToPred: between => numeric [lo,hi]; non-numeric kept as text", () => {
  assert.deepEqual(
    rowToPred({ col: "amount", op: "between", from: "100", to: "500" }).value,
    [100, 500]
  );
  assert.deepEqual(
    rowToPred({ col: "code", op: "between", from: "A1", to: "Z9" }).value,
    ["A1", "Z9"]
  );
});

test("rowToPred: in => trimmed, non-empty comma list as array", () => {
  assert.deepEqual(
    rowToPred({ col: "country", op: "in", value: " us, fr , , de " }).value,
    ["us", "fr", "de"]
  );
});

test("rowToPred: is_null/not_null omit value; case_sensitive only when true", () => {
  const p = rowToPred({ col: "x", op: "is_null" });
  assert.equal("value" in p, false);
  assert.equal("case_sensitive" in p, false);
  const cs = rowToPred({ col: "x", op: "eq", value: "Y", caseSensitive: true });
  assert.equal(cs.case_sensitive, true);
});

test("decomposeFilter: round-trips a flat Group back into rows", () => {
  const node = { node: "group", op: "or", children: [
    { node: "pred", col: "status", op: "eq", value: "open" },
    { node: "pred", col: "amount", op: "between", value: [10, 20] },
    { node: "pred", col: "tag", op: "in", value: ["a", "b"] },
    { node: "pred", col: "note", op: "is_null" },
  ] };
  const { combinator, rows } = decomposeFilter(node);
  assert.equal(combinator, "or");
  assert.equal(rows.length, 4);
  assert.equal(rows[0].value, "open");
  assert.equal(rows[1].from, "10");
  assert.equal(rows[1].to, "20");
  assert.equal(rows[2].value, "a, b");
  assert.equal(rows[3].op, "is_null");
  // and re-assembles to an equivalent tree
  const back = assembleFilter(rows, combinator);
  assert.deepEqual(back.children[0], { node: "pred", col: "status", op: "eq", value: "open" });
});

test("decomposeFilter: empty / non-group => one blank row, AND", () => {
  for (const v of [undefined, null, { node: "group", op: "and", children: [] }, { node: "pred", col: "x", op: "eq", value: "1" }]) {
    const d = decomposeFilter(v);
    assert.equal(d.combinator, "and");
    assert.equal(d.rows.length, 1);
  }
});

test("assembleFilter: a nested group row becomes a real nested Group node (DC3c)", () => {
  const rows = [
    { col: "status", op: "eq", value: "open" },
    { group: true, op: "or", children: [
      { col: "country", op: "eq", value: "fr" },
      { col: "country", op: "eq", value: "us" },
    ] },
  ];
  const node = assembleFilter(rows, "and");
  assert.equal(node.children.length, 2);
  assert.deepEqual(node.children[0], { node: "pred", col: "status", op: "eq", value: "open" });
  assert.deepEqual(node.children[1], {
    node: "group", op: "or",
    children: [
      { node: "pred", col: "country", op: "eq", value: "fr" },
      { node: "pred", col: "country", op: "eq", value: "us" },
    ],
  });
});

test("assembleFilter: an empty nested group (no complete children) is dropped", () => {
  const rows = [
    { col: "a", op: "eq", value: "1" },
    { group: true, op: "and", children: [blankRow()] }, // nothing complete inside
  ];
  const node = assembleFilter(rows, "and");
  assert.equal(node.children.length, 1);
  assert.equal(node.children[0].col, "a");
});

test("decomposeFilter: a nested Group child round-trips into an editable group row (DC3c)", () => {
  const node = { node: "group", op: "and", children: [
    { node: "pred", col: "status", op: "eq", value: "open" },
    { node: "group", op: "or", children: [
      { node: "pred", col: "a", op: "eq", value: "1" },
      { node: "pred", col: "b", op: "gt", value: "5" },
    ] },
  ] };
  const { combinator, rows } = decomposeFilter(node);
  assert.equal(combinator, "and");
  assert.equal(rows.length, 2);
  assert.equal(rows[1].group, true);
  assert.equal(rows[1].op, "or");
  assert.equal(rows[1].children.length, 2);
  assert.equal(rows[1].children[0].col, "a");
  // and re-assembles to the same tree
  assert.deepEqual(assembleFilter(rows, combinator), node);
});

test("predToRow is the inverse of rowToPred for a plain text pred", () => {
  const pred = rowToPred({ col: "name", op: "contains", value: "smith", caseSensitive: true });
  const row = predToRow(pred);
  assert.equal(row.col, "name");
  assert.equal(row.op, "contains");
  assert.equal(row.value, "smith");
  assert.equal(row.caseSensitive, true);
});
