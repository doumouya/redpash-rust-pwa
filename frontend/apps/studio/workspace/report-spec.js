/* report-spec — the Data Cleaner's REPORT vocabulary as DATA. Reading this file
   reveals what a report can ask: the aggregation functions on offer + how the
   builder's state becomes the server's ReportSpec (POST /api/group/preview).

   Each AGG_FN `value` is a `shared::report::AggFn` (snake_case) the group_by
   engine dispatches (backend/crates/data/src/group_by.rs). The full ReportSpec
   also carries pivot columns / windows / top-N / sort — those are the "Advanced"
   surface for a later pass; this first cut covers the "show me [measure] for each
   [breakdown]" core that answers most questions. */

export const AGG_FNS = [
  { value: "count", label: "Count" },
  { value: "count_distinct", label: "Count distinct" },
  { value: "sum", label: "Sum" },
  { value: "mean", label: "Average" },
  { value: "min", label: "Min" },
  { value: "max", label: "Max" },
  { value: "first", label: "First" },
  { value: "last", label: "Last" },
];

const LABEL = Object.fromEntries(AGG_FNS.map((a) => [a.value, a.label]));

/** Build a server ReportSpec from the builder's state.
 *  { groupBy: [colKey], measures: [{col, fn}], filter?: FilterNode } -> ReportSpec.
 *  Incomplete measures (no column) are dropped; an empty groupBy yields a single
 *  summary row (the engine's no-group path). */
export function buildReportSpec({ groupBy = [], measures = [], filter = null } = {}) {
  const aggregations = measures
    .filter((m) => m && m.col && m.fn)
    .map((m) => ({ col: m.col, fn: m.fn, alias: `${LABEL[m.fn] ?? m.fn} of ${m.col}` }));
  const spec = { group_by: groupBy.filter(Boolean), aggregations };
  if (filter) spec.filter = filter;
  return spec;
}
