---
title: Report — object metadata
section: Internal
order: 54
last modified date: 2026-05-28
owner: Torv
status: draft — per the object-metadata sweep ([index](index.md))
---

# Report — derived view (no entity, no RID prefix)

**Report is not a stored entity.** The object-model hard-refresh
(2026-06-01, migration `20260601000001_drop_reports.sql`) dropped
the prior `reports` table outright. What remains is a *derived view*
over the canonical schema: a csv-typed [file](file.md) + the
chart-typed files sourcing from it (via `project_files.source_file_id`).

**This doc exists** to pin the conceptual contract — what consumers
should expect when they ask "where's the Report?" — and to anchor
the `ReportSpec` DTO, which survives the entity removal because
the group-by + aggregation engine still consumes it.

**Anchoring schema:**
- A "Report" is the conceptual triple: `(csv-file, attached-charts,
  group-by-spec)`.
  - csv-file: `project_files` row, `file_type='csv'`.
  - attached-charts: `project_files` rows, `file_type='chart'`,
    `source_file_id = <csv-rid>`.
  - group-by-spec: an in-memory `ReportSpec` value composed by the
    report-builder UI, OR re-derived from one of the attached charts'
    spec.

**DTO:** `backend/crates/shared/src/report.rs` — `ReportSpec` +
descendants (`Aggregation`, `AggFn`, `SortSpec`, `TopNFilter`,
`WindowSpec`, `ChartSpec`). The DTO is alive even though the entity
isn't.
**Routes:** none directly. Report-shaped data flows through:
- `POST /api/files/:rid/page` (paginated csv read with sorts +
  filters + cols — drives the report's source view).
- `POST /api/group/preview` (stateless group-by engine — takes a
  ReportSpec, returns subtotals + details + matrix).
- The chart endpoints (`/api/charts/*` — see [chart](chart.md)) for
  the per-chart slicing.

---

## Supported calls

Report itself has no endpoints. The verbs below name the calls
that consume / produce report-shaped data:

| Verb | Wire | Notes |
|---|---|---|
| `compose` | client-side | The report-builder UI composes a `ReportSpec` from the user's group-by + aggregation + filter clicks. State lives in the FE (`scripts/report.js`) until persisted. |
| `preview` | `POST /api/group/preview` | Stateless. Body: `{ source_file_id, spec: ReportSpec }`. Returns the engine output (subtotals / details / matrix per the spec's `show_*` toggles + the chart preview data). |
| `persist (one chart)` | `POST /api/charts` | Saves one chart out of the report into a CHT_ row. The chart's `spec.group_by` / `agg_col` / `agg_fn` carries the slicing; the report's ReportSpec is NOT itself stored. |
| `persist (dashboard)` | `POST /api/dashboards` with `widgets: [{ kind: 'chart', spec: { chart_id } }, …]` | The dashboard is the canonical "save my report" surface — a dashboard composition of the chart-typed files that were attached to the report. See [dashboard](dashboard.md). |
| `read` | — | **Reports aren't read individually.** To re-open the same report-shaped view, the user opens the source CSV in the Workspace + the chart-builder mode re-composes the slicing from the saved charts. |
| `update / delete` | — | **Not applicable.** Report is a derived view; there's nothing to update or delete on the Report side. Edits land on the source CSV or on the attached charts. |
| `list` | — | **Not applicable.** Reports surface implicitly as "a CSV that has ≥1 chart sourcing it" — the file_stages view's `design` rollup IS the catalog of report-shaped files. |

---

## Fields

Report has no row. The persistent state of a report is split across
two real objects:

```
source_file_id (lives in: project_files, on chart rows)
  Type:        TEXT / String — FK to project_files.redpash_id
  Properties:  (Create, Update via the chart endpoints — see chart.md)
  Description: Anchors one or more chart rows to the report's csv
               source. The set of chart rows with the same
               source_file_id IS the attached-chart set for that
               report.
```

```
group_by, group_by_cols, aggregations, filter, show_*, sort,
top_n, windows  (live in: the ChartSpec.option JSONB, on chart rows)
  Type:        — (composed into ECharts option at save time)
  Properties:  Create, Update via the chart endpoints
  Description: The ReportSpec inputs that produced this chart are
               baked into the chart's spec (the FE replays them
               into the option). Re-opening the report consults
               this for re-rendering.
```

The ReportSpec DTO surfaces on the wire only as the **request body**
for `/api/group/preview` — never as a row, never as a list shape.
See `shared/src/report.rs` for the canonical struct:

```
ReportSpec {
  group_by:      Vec<String>          — row-axis grouping
  group_by_cols: Vec<String>          — pivot/column-axis grouping (Salesforce-matrix mode when non-empty)
  aggregations:  Vec<Aggregation>     — { col, fn: AggFn, alias? }
  filter:        Option<JSON>         — shared::filter::FilterNode or legacy array form
  show_details / show_subtotals / show_total — render toggles
  sort:          Vec<SortSpec>        — sort keys applied post-aggregate
  charts:        Vec<ChartSpec>       — per-chart slicings authored alongside
  top_n:         Option<TopNFilter>   — { n, order_by, direction, partition_by }
  windows:       Vec<WindowSpec>      — derived columns via Polars over()
}
```

---

## Enum constraints

`AggFn ∈ { count, count_distinct, sum, mean, min, max, first, last,
median, q1, q3 }` — Rust enum in `shared/src/report.rs`. Wire
representation: snake_case serde. 11 values today.

`SortSpec.dir ∈ { asc, desc }` — anything else falls back to asc.

`TopNFilter.direction ∈ { asc, desc }` — defaults to desc (top-N).

`WindowSpec.fn ∈ { sum, mean, count, min, max, lag, lead,
first_value, last_value }` — aggregate kinds vs value kinds.
Value kinds require `order_by`; lag/lead also use `offset`.

`ChartSpec.kind ∈ { bar, bar_horizontal, line, area, pie, funnel,
gauge, pictorial_bar, scatter, heatmap, radar, boxplot, calendar,
matrix }` — same 13-value enum as [chart](chart.md#enum-constraints)
since the ChartSpec is shared between the in-memory report-builder
state and the persisted Chart row's spec field.

---

## Relationships

Report has no FKs of its own (no row to FK from). The relationships
that constitute a report live on the underlying entities:

```
csv-file ← chart files (via project_files.source_file_id)
  Cardinality:  1:N (one CSV anchors many charts; the set IS the report)
  On delete:    CASCADE on csv delete (every chart sourcing it dies)
  Surfaced as:  the `file_stages.stage = 'design'` rollup — a file
                with ≥1 chart sourcing it.
```

```
attached charts ← dashboard widgets (via spec.widgets[].spec.chart_id)
  Cardinality:  N:N (a dashboard can reference many charts;
                many dashboards can reference one chart)
  On delete:    No FK; dangling widget refs render as error tiles
  Surfaced as:  see [dashboard](dashboard.md).
```

---

## Audit events

None directly. Report is a derived view; user actions on report-
shaped data emit events on the underlying entities:

- Building a report → no event until something persists.
- Saving a chart out of the report → `chart_create` (see [chart](chart.md)).
- Composing a dashboard from the attached charts → `dashboard_create`
  (see [dashboard](dashboard.md)).
- Re-running the preview → no event (stateless engine call;
  request_log captures the HTTP hit but doesn't emit a domain event).
- Editing the source CSV → `step_apply` / `file_patch` on the
  underlying [file](file.md).

The RBAC permission catalog will likely not generate per-report
permissions — instead, access to the source CSV + the attached
charts gates access to the report (the natural slice; charts and
files are the addressable entities). Report-as-permission-key would
require RBAC to derive ephemeral keys from the (file, chart-set)
tuple, which doesn't fit the static-catalog model. Worth re-
examining when RBAC scope is concrete.

---

## Status note — graduation criteria

This is the **13th and final** object-metadata doc per
CAS_E2D56EC0CDAF44A39DEB4752D3F92351's authoring order. With this
landed, the spec set covers every standard object in RedPash —
the 11 entities plus the 2 derived views (Chart + Dashboard) plus
this conceptual anchor (Report).

Per the index doc:

> When all 13 land, the spec graduates from "draft" to "stable"
> (update the index.md status frontmatter). RBAC unblocked at that
> point — the permission key catalog can be auto-derived from the
> property tables.

The index frontmatter update lands in the next commit.
