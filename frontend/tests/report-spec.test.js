/* node:test over report-spec: buildReportSpec maps the builder state to the
   server ReportSpec — group keys, measures→aggregations (with alias), dropping
   incomplete measures, and the optional pre-filter. Pure (no DOM).
   Run via: sh tools/test-fe.sh */

import { test } from "node:test";
import assert from "node:assert/strict";

const { AGG_FNS, buildReportSpec } = await import(
  "../apps/studio/workspace/report-spec.js"
);

test("empty state → empty spec, no filter key", () => {
  const spec = buildReportSpec({});
  assert.deepEqual(spec, { group_by: [], aggregations: [] });
  assert.ok(!("filter" in spec));
});

test("group-by + measures → aggregations with fn/col/alias", () => {
  const spec = buildReportSpec({
    groupBy: ["city"],
    measures: [{ col: "amount", fn: "sum" }, { col: "id", fn: "count" }],
  });
  assert.deepEqual(spec.group_by, ["city"]);
  assert.deepEqual(spec.aggregations, [
    { col: "amount", fn: "sum", alias: "Sum of amount" },
    { col: "id", fn: "count", alias: "Count of id" },
  ]);
});

test("incomplete measures (no column) are dropped", () => {
  const spec = buildReportSpec({ groupBy: ["city"], measures: [{ col: "", fn: "sum" }, { col: "amount", fn: "mean" }] });
  assert.equal(spec.aggregations.length, 1);
  assert.equal(spec.aggregations[0].col, "amount");
});

test("a filter node rides along as spec.filter", () => {
  const filter = { node: "group", op: "and", children: [{ node: "pred", col: "city", op: "eq", value: "paris" }] };
  const spec = buildReportSpec({ groupBy: [], measures: [], filter });
  assert.deepEqual(spec.filter, filter);
});

test("AGG_FNS values are snake_case AggFn keys", () => {
  for (const a of AGG_FNS) assert.match(a.value, /^[a-z][a-z_]*$/);
  assert.ok(AGG_FNS.some((a) => a.value === "count_distinct"));
});
