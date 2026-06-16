/* report-builder — the "show me [measure] for each [breakdown]" form. A product-
   agnostic shell: it knows nothing about files or endpoints — it takes the
   available columns + the aggregation vocabulary, and emits the builder STATE
   ({groupBy, measures}) on Run. The consumer turns that into a server ReportSpec
   (the workspace does, via report-spec.js) and renders the result wherever it
   likes (a bare grid-view). Group-by columns are removable chips; measures are
   fn × column rows. Pivot / windows / top-N / sort are the Advanced surface for
   a later pass.

   mountReportBuilder(host, {
     columns: [{key, label}],
     aggFns:  [{value, label}],            // the aggregation vocabulary
     onRun({ groupBy: [key], measures: [{col, fn}] }),
     onClear?(),
   }) -> { el, update({columns}), destroy }

   Composes atoms.button + mountSelect; sole owner of every .rp-rb* class
   (ui-fork-audit R4). knobs: none. */

import { el } from "../boot/dom.js";
import { button } from "../atoms/atoms.js";
import { mountSelect } from "../select/select.js";
import { register } from "../registry/component-registry.js";

export function mountReportBuilder(host, cfg) {
  let columns = cfg.columns ?? [];
  const aggFns = cfg.aggFns ?? [];
  const defaultFn = () => aggFns[0]?.value ?? "count";
  let groupBy = []; // [colKey]
  let measures = [{ col: "", fn: defaultFn() }];

  const root = el("div", { class: "rp-rb" });
  const gbWrap = el("div", { class: "rp-rb-section" });
  const mWrap = el("div", { class: "rp-rb-section" });
  const foot = el("div", { class: "rp-rb-foot" },
    button({ label: "Clear", variant: "ghost", onClick: clearAll }),
    button({ label: "Run", variant: "accent", onClick: run }));
  root.append(gbWrap, mWrap, foot);

  const colOpts = () => columns.map((c) => ({ value: c.key, label: c.label ?? c.key }));
  const colLabel = (k) => columns.find((c) => c.key === k)?.label ?? k;

  function renderGroupBy() {
    gbWrap.replaceChildren(el("h3", { class: "rp-rb-heading" }, "Group by"));
    const chips = el("div", { class: "rp-rb-chips" });
    if (!groupBy.length) chips.append(el("span", { class: "rp-rb-empty" }, "the whole file"));
    for (const k of groupBy) {
      chips.append(el("button", {
        class: "rp-rb-chip", type: "button", title: "Remove",
        onclick: () => { groupBy = groupBy.filter((x) => x !== k); render(); },
      }, el("span", {}, colLabel(k)), el("i", { class: "bi bi-x" })));
    }
    gbWrap.append(chips);
    const unused = columns.filter((c) => !groupBy.includes(c.key));
    if (unused.length) {
      const addHost = el("span", { class: "rp-rb-add" });
      mountSelect(addHost, {
        options: [{ value: "", label: "+ add column…" }, ...unused.map((c) => ({ value: c.key, label: c.label ?? c.key }))],
        value: "",
        onChange: (v) => { if (v) { groupBy.push(v); render(); } },
      });
      gbWrap.append(addHost);
    }
  }

  function renderMeasures() {
    mWrap.replaceChildren(el("h3", { class: "rp-rb-heading" }, "Measures"));
    const list = el("div", { class: "rp-rb-measures" });
    measures.forEach((m, i) => {
      const fnHost = el("span", { class: "rp-rb-mfn" });
      mountSelect(fnHost, { options: aggFns, value: m.fn, onChange: (v) => { m.fn = v; } });
      const colHost = el("span", { class: "rp-rb-mcol" });
      mountSelect(colHost, {
        options: [{ value: "", label: "column…" }, ...colOpts()],
        value: m.col,
        onChange: (v) => { m.col = v; },
      });
      const rm = button({
        label: "✕", variant: "ghost", size: "sm",
        onClick: () => {
          measures.splice(i, 1);
          if (!measures.length) measures.push({ col: "", fn: defaultFn() });
          render();
        },
      });
      rm.classList.add("rp-rb-mremove");
      list.append(el("div", { class: "rp-rb-measure" }, fnHost, colHost, rm));
    });
    mWrap.append(list);
    const add = button({
      label: "+ Add measure", variant: "ghost", size: "sm",
      onClick: () => { measures.push({ col: "", fn: defaultFn() }); render(); },
    });
    add.classList.add("rp-rb-add-measure");
    mWrap.append(add);
  }

  function render() { renderGroupBy(); renderMeasures(); }

  function clearAll() {
    groupBy = [];
    measures = [{ col: "", fn: defaultFn() }];
    render();
    cfg.onClear?.();
  }
  function run() {
    cfg.onRun?.({
      groupBy: [...groupBy],
      measures: measures.filter((m) => m.col).map((m) => ({ col: m.col, fn: m.fn })),
    });
  }

  render();
  host.append(root);
  return {
    el: root,
    update: (p = {}) => { if (p.columns) columns = p.columns; render(); },
    destroy: () => root.remove(),
  };
}

register("report-builder", mountReportBuilder);
