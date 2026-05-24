// Report builder — the second tab in the filter panel. Edits a
// ReportSpec (shared::report::ReportSpec) against the open file and
// runs it through POST /api/group/preview (group.rs:25, renamed from
// the old /api/reports/preview after the object-model hard refresh).
//
// Targets the full pipeline (group_by + aggregations + windows +
// top-N) per docs/internal/architecture columns-redtable.md's sibling
// docs/features/reports.md. This module ships group_by + aggregations
// first (C1); windows + top-N land in follow-up commits with the
// builder shape unchanged — they're extra sections, not rewires.
//
// ctx: { fileRid, columns, onPreview(GroupPage), onError(err), setStatus(text, kind) }
//   - fileRid:   () => string | null
//   - columns:   () => ColumnMeta[]
//   - onPreview: called with the /preview response so the workspace
//                can render the sample table where it wants (panel,
//                main area, etc.) — keeps render decisions outside
//                this module.
//   - setStatus: surface inline messages (apply errors / "no fields
//                yet" warnings).

import { api } from "/scripts/api.js";

// Aggregation functions — vocabulary from shared::report::AggFn. The
// values are exactly what the backend expects (snake_case enum).
const AGG_FNS = [
  ["count",          "Count"],
  ["count_distinct", "Count distinct"],
  ["sum",            "Sum"],
  ["mean",           "Mean"],
  ["min",            "Min"],
  ["max",            "Max"],
  ["first",          "First"],
  ["last",           "Last"],
  ["median",         "Median"],
  ["q1",             "Q1 (25%)"],
  ["q3",             "Q3 (75%)"],
];

export function mountReport(panelBody, ctx) {
  // ── spec state ────────────────────────────────────────────────────
  // groupBy: ordered list of column names — the leftmost columns of
  // the subtotals table.
  // aggregations: ordered list of { col, fn, alias }. col is "" for
  // count(*); fn is one of AGG_FNS; alias is optional display label.
  let groupBy      = [];
  let aggregations = [];

  // ── containers ────────────────────────────────────────────────────
  const statusEl = document.createElement("div");
  statusEl.className = "rt-report-status";
  statusEl.hidden = true;
  const builderEl = document.createElement("div");
  builderEl.className = "rt-report-builder";
  const previewEl = document.createElement("div");
  previewEl.className = "rt-report-preview";
  previewEl.hidden = true;

  panelBody.innerHTML = "";
  panelBody.append(statusEl, builderEl, previewEl);

  // ── render ────────────────────────────────────────────────────────
  function renderBuilder() {
    const cols = ctx.columns() || [];
    if (!cols.length) {
      builderEl.innerHTML = '<p class="rt-report-empty">Open a file to build a report.</p>';
      return;
    }
    builderEl.innerHTML =
        renderGroupBySection(cols)
      + renderAggregationsSection(cols);
  }

  // Group-by — the row-grouping columns. Each group becomes one row in
  // the subtotals table. Render as a chip-style picker: a list of
  // selected chips on top, an "Add column ▾" dropdown to add more.
  function renderGroupBySection(cols) {
    const chips = groupBy.map((name) =>
      '<span class="rt-report-chip">'
      +   esc(name)
      +   '<button class="rt-report-chip-del" type="button" data-group-del="'
      +     esc(name) + '" title="Remove"><i class="bi bi-x"></i></button>'
      + '</span>').join('');
    const available = cols.filter((c) => !groupBy.includes(c.name));
    const addDd = available.length
      ? '<div class="rt-dd-wrap rt-report-add">'
        + '<button class="rt-btn rt-btn--glass" type="button" data-dd="rtReportGroupDd">'
        +   '<i class="bi bi-plus-lg"></i> Add column'
        + '</button>'
        + '<div class="rt-dd" id="rtReportGroupDd">'
        +   available.map((c) =>
              '<div class="rt-dd-item" data-group-add="' + esc(c.name) + '">'
              + esc(c.name) + '</div>').join('')
        + '</div>'
        + '</div>'
      : '<p class="rt-report-empty">Every column is already grouped.</p>';
    return '<section class="rt-report-sect">'
      +    '<span class="rt-field-lbl">Group by</span>'
      +    (groupBy.length
            ? '<div class="rt-report-chips">' + chips + '</div>'
            : '<p class="rt-report-empty">No group columns — preview returns one grand row.</p>')
      +    addDd
      +    '</section>';
  }

  // Aggregations — list of { col, fn, alias } rows. Each row has a
  // column picker, an agg-fn picker, an optional alias input, and a
  // delete button. The first row of count(*) is implicit when the
  // list is empty (engine returns one count column per group).
  function renderAggregationsSection(cols) {
    const colOptions = '<option value="">(count *)</option>'
      + cols.map((c) =>
          '<option value="' + esc(c.name) + '">' + esc(c.name) + '</option>').join('');
    const rows = aggregations.map((a, i) =>
      '<div class="rt-report-agg" data-i="' + i + '">'
      + '<select class="rt-pred-col" data-key="col">'
      +   cols.map((c) =>
            '<option value="' + esc(c.name) + '"'
            + (c.name === a.col ? ' selected' : '') + '>'
            + esc(c.name) + '</option>').join('')
      +   '<option value=""' + (a.col === "" ? ' selected' : '') + '>(count *)</option>'
      + '</select>'
      + '<select class="rt-pred-op" data-key="fn">'
      +   AGG_FNS.map(([v, l]) =>
            '<option value="' + esc(v) + '"'
            + (v === a.fn ? ' selected' : '') + '>'
            + esc(l) + '</option>').join('')
      + '</select>'
      + '<input class="rt-pred-val" data-key="alias" type="text"'
      +   ' placeholder="alias (optional)" value="' + esc(a.alias || "") + '" />'
      + '<button class="rt-pred-del" type="button" data-agg-del="' + i + '"'
      +   ' title="Remove aggregation"><i class="bi bi-x-lg"></i></button>'
      + '</div>').join('');
    return '<section class="rt-report-sect">'
      +    '<span class="rt-field-lbl">Aggregations</span>'
      +    (aggregations.length
            ? '<div class="rt-report-aggs">' + rows + '</div>'
            : '<p class="rt-report-empty">No aggregations — preview shows row count per group.</p>')
      +    '<button class="rt-btn rt-btn--glass rt-report-add-agg" type="button">'
      +      '<i class="bi bi-plus-lg"></i> Add aggregation'
      +    '</button>'
      +    '</section>';
  }

  // Sample preview — render the subtotals + grand total inline. Cap
  // rows so a many-group preview doesn't dominate the panel; the user
  // gets a "showing N of M" footer when truncated. Details + matrix
  // sections aren't shown here; they're noise inside a builder panel.
  function renderPreview(page) {
    if (!page) { previewEl.hidden = true; previewEl.innerHTML = ""; return; }
    const sub = page.subtotals;
    if (!sub || !sub.rows?.length) {
      previewEl.hidden = false;
      previewEl.innerHTML = '<p class="rt-report-empty">No rows in this preview.</p>';
      return;
    }
    const MAX = 50;
    const shown = sub.rows.slice(0, MAX);
    const more  = Math.max(0, sub.rows.length - MAX);
    const head  = '<thead><tr>'
      + sub.columns.map((c) => '<th>' + esc(c) + '</th>').join('')
      + '</tr></thead>';
    const body  = '<tbody>'
      + shown.map((r) => '<tr>'
          + r.map((v, i) =>
              '<td class="' + (typeof v === "number" ? "is-num" : "") + '">'
              + (v == null ? '<span class="is-muted">—</span>' : esc(String(v)))
              + '</td>').join('')
          + '</tr>').join('')
      + (page.total
          ? '<tr class="is-total">'
            + page.total.map((v, i) =>
                '<td class="' + (typeof v === "number" ? "is-num" : "") + '">'
                + (v == null ? '' : esc(String(v)))
                + '</td>').join('')
            + '</tr>'
          : '')
      + '</tbody>';
    previewEl.hidden = false;
    previewEl.innerHTML =
        '<div class="rt-report-preview-head">'
      +   '<span class="rt-report-preview-meta">'
      +     '<b>' + sub.total + '</b> group' + (sub.total === 1 ? '' : 's')
      +     ' · ' + page.ms + ' ms'
      +   '</span>'
      + '</div>'
      + '<div class="rt-report-preview-wrap">'
      +   '<table class="rp-table rt-report-preview-table">'
      +     head + body
      +   '</table>'
      + '</div>'
      + (more
          ? '<p class="rt-report-empty">' + more + ' more group'
            + (more === 1 ? '' : 's') + ' not shown.</p>'
          : '');
  }

  // ── click delegation ──────────────────────────────────────────────
  builderEl.addEventListener("click", (e) => {
    const addBtn = e.target.closest("[data-group-add]");
    if (addBtn) {
      const name = addBtn.dataset.groupAdd;
      if (name && !groupBy.includes(name)) {
        groupBy.push(name);
        renderBuilder();
      }
      // Close the dropdown if it's a global rt-dd-wrap.
      addBtn.closest(".rt-dd")?.classList.remove("open");
      return;
    }
    const delBtn = e.target.closest("[data-group-del]");
    if (delBtn) {
      groupBy = groupBy.filter((n) => n !== delBtn.dataset.groupDel);
      renderBuilder();
      return;
    }
    const aggDelBtn = e.target.closest("[data-agg-del]");
    if (aggDelBtn) {
      const i = +aggDelBtn.dataset.aggDel;
      aggregations.splice(i, 1);
      renderBuilder();
      return;
    }
    if (e.target.closest(".rt-report-add-agg")) {
      const cols = ctx.columns() || [];
      aggregations.push({
        col:   cols[0]?.name || "",
        fn:    "count",
        alias: "",
      });
      renderBuilder();
    }
  });

  // Field changes propagate to the spec live so the user doesn't have
  // to remember to commit before Apply.
  builderEl.addEventListener("change", (e) => {
    const row = e.target.closest(".rt-report-agg");
    if (!row) return;
    const i = +row.dataset.i;
    if (!aggregations[i]) return;
    const key = e.target.dataset.key;
    if (key === "col" || key === "fn") aggregations[i][key] = e.target.value;
  });
  builderEl.addEventListener("input", (e) => {
    const row = e.target.closest(".rt-report-agg");
    if (!row || e.target.dataset.key !== "alias") return;
    aggregations[+row.dataset.i].alias = e.target.value;
  });

  // ── spec build + apply ────────────────────────────────────────────
  function buildSpec() {
    return {
      group_by:       [...groupBy],
      group_by_cols:  [],
      // Aggregations: drop empty alias keys so the backend infers a
      // default. Map shape matches shared::report::Aggregation:
      // { col, fn, alias? }. fn comes through as the snake_case enum.
      aggregations:   aggregations.map((a) => {
        const out = { col: a.col, fn: a.fn };
        if (a.alias) out.alias = a.alias;
        return out;
      }),
      filter:         null,
      show_details:   false,
      show_subtotals: true,
      show_total:     true,
      sort:           [],
      charts:         [],
      top_n:          null,
      windows:        [],
    };
  }

  async function apply(busyBtn) {
    const rid = ctx.fileRid();
    if (!rid) { ctx.setStatus?.("Open a file before running a report.", "warn"); return; }
    if (busyBtn) { busyBtn.disabled = true; busyBtn.classList.add("is-busy"); }
    try {
      const page = await api.post("/group/preview",
                                  { source_file_id: rid, spec: buildSpec() });
      renderPreview(page);
      ctx.onPreview?.(page);
    } catch (err) {
      const msg = (err && (err.body?.message || err.body?.error)) || err?.message || "Preview failed";
      ctx.setStatus?.(msg + (err?.status ? " (" + err.status + ")" : ""), "err");
    } finally {
      if (busyBtn) { busyBtn.disabled = false; busyBtn.classList.remove("is-busy"); }
    }
  }

  function clear() {
    groupBy = [];
    aggregations = [];
    renderBuilder();
    renderPreview(null);
  }

  renderBuilder();
  return {
    refresh()  { renderBuilder(); },
    apply,
    clear,
    getSpec()  { return buildSpec(); },
  };
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}
