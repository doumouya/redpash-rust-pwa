/* admin/monitoring — the audit-tools observability surface. Two rail sections
   (Audit runs · Audit findings) over the platform audit trail (audit.run /
   audit.finding, served by /api/monitoring/audit-*) — the same suite that backs
   the ci-audit ratchet, made visible in-app. Read-only. Ported + adapted from the
   prerelease monitoring page; the backend (schema + ingest + endpoints) is the
   backend lane (M2) — until it lands, each view shows its empty-state.

   Page lane: composes framework components (stat · chart · redtable · empty-state);
   no inline styles or framework-class literals (each component owns its own). */

import { assemblePage } from "../../../framework/page-assembly/page-assembly.js";
import { mountStat } from "../../../framework/stat/stat.js";
import { mountRedTable } from "../../../framework/redtable/redtable.js";
import { mountEmptyState } from "../../../framework/empty-state/empty-state.js";
import { renderChart, synthesizeOption } from "../../../framework/chart/render.js";
import { chartTheme } from "../../../framework/chart/theme.js";
import { api } from "../../../framework/boot/api.js";
import { el } from "../../../framework/boot/dom.js";
import { fmtDateTime } from "../../../framework/boot/format.js";

const PAGE_SIZE = 50;
const sha7 = (s) => (s ? String(s).slice(0, 7) : "—");

// a compact one-line summary of a run's stats jsonb — its shape is the backend's,
// so stay tolerant: prefer a `count`, else join the numeric entries.
function headline(stats) {
  if (!stats || typeof stats !== "object") return "—";
  if (typeof stats.count === "number") return `${stats.count} finding${stats.count === 1 ? "" : "s"}`;
  const parts = Object.entries(stats).filter(([, v]) => typeof v === "number").map(([k, v]) => `${k} ${v}`);
  return parts.length ? parts.join(" · ") : "—";
}

// A KPI chart card: synthesize the option from {label:count} (or {name,value}[])
// and render it into a sized slot, reflowing on resize. Returns { destroy }.
function kpiChart(host, { kind, type, data, title }) {
  const slot = el("div", { class: "pg-admin-monitoring-chartslot" });
  const card = el("div", { class: "pg-admin-monitoring-card" },
    title ? el("div", { class: "pg-admin-monitoring-card-title" }, title) : null, slot);
  host.append(card);
  const cfg = {
    kind, type, theme: chartTheme(), legend: kind === "pie", legendPos: "bottom",
    tooltip: true, axisLine: true, splitLines: true, option: synthesizeOption(data, kind),
  };
  const inst = renderChart(slot, { cfg }, cfg.theme);
  const ro = new ResizeObserver(() => inst?.resize?.());
  ro.observe(slot);
  return { destroy: () => { ro.disconnect(); inst?.dispose?.(); } };
}

export default async function mount(root, ctx) {
  let live = [];   // disposable handles of the CURRENT view (charts own ECharts + an observer)
  let seq = 0;     // guards rapid rail switches racing their fetches

  const page = assemblePage(root, {
    session: ctx.getSession(),
    activePageId: "monitoring",
    title: "Monitoring",
    meta: "audit-tools logs — the suite behind the CI ratchet",
    // The server-driven rail (GET /api/rail/monitoring) lists the two audit views;
    // clicking one swaps the surface (the page owns one "main" section).
    rail: {
      active: "runs",
      onRailTab: (tab) => {
        if (tab?.kind !== "section") return;
        page.rail?.setActive(tab.id);
        showView(tab.id);
      },
    },
    sections: [{ key: "main" }],
  });

  const main = page.section("main");

  function clear() {
    live.forEach((h) => h?.destroy?.());
    live = [];
    main.replaceChildren();
  }
  function empty(what) {
    mountEmptyState(main, {
      title: `No audit ${what} yet`,
      line: "Run the audit suite, then redpash-audit-ingest, to populate this view.",
    });
  }
  const kpis = () => { const k = el("div", { class: "pg-admin-monitoring-kpis" }); main.append(k); return k; };
  const tableHost = () => { const t = el("div", { class: "pg-admin-monitoring-table" }); main.append(t); return t; };

  async function showView(id) {
    const my = ++seq;
    clear();
    if (id === "findings") return showFindings(my);
    return showRuns(my);
  }

  async function showRuns(my) {
    let stats = null, list = null;
    try { stats = await api.get("/monitoring/audit-runs/stats"); } catch { /* BE absent (M2) */ }
    try { list = await api.get(`/monitoring/audit-runs?page=1&size=${PAGE_SIZE}`); } catch { /* BE absent */ }
    if (my !== seq) return; // a newer view won the race
    const rows = list?.rows ?? [];
    if (!rows.length) { empty("runs"); return; }
    const k = kpis();
    live.push(mountStat(k, { label: "Total runs", value: stats?.total ?? rows.length }));
    live.push(mountStat(k, { label: "Last 7 days", value: stats?.last_7d ?? "—" }));
    if (stats?.by_tool) live.push(kpiChart(k, { kind: "cartesian", type: "bar", data: stats.by_tool, title: "Runs by tool" }));
    live.push(mountRedTable(tableHost(), {
      columns: [
        { key: "time", label: "Time" }, { key: "tool", label: "Tool" },
        { key: "sha", label: "SHA" }, { key: "branch", label: "Branch" },
        { key: "headline", label: "Headline" },
      ],
      rows: rows.map((r) => ({
        __k: String(r.id), time: fmtDateTime(r.ran_at), tool: r.tool,
        sha: sha7(r.git_sha), branch: r.git_branch || "—", headline: headline(r.stats),
      })),
      rowKey: (r) => r.__k, mode: "pager", interaction: "browse",
    }));
  }

  async function showFindings(my) {
    let stats = null, list = null;
    try { stats = await api.get("/monitoring/audit-findings/stats"); } catch { /* BE absent */ }
    try { list = await api.get(`/monitoring/audit-findings?page=1&size=${PAGE_SIZE}`); } catch { /* BE absent */ }
    if (my !== seq) return;
    const rows = list?.rows ?? [];
    if (!rows.length) { empty("findings"); return; }
    const k = kpis();
    live.push(mountStat(k, { label: "Total findings", value: stats?.total ?? rows.length }));
    if (stats?.by_severity) live.push(kpiChart(k, { kind: "pie", type: "pie", data: stats.by_severity, title: "By severity" }));
    if (stats?.by_kind) live.push(kpiChart(k, { kind: "cartesian", type: "bar", data: stats.by_kind, title: "By kind" }));
    live.push(mountRedTable(tableHost(), {
      columns: [
        { key: "run", label: "Run" }, { key: "tool", label: "Tool" },
        { key: "kind", label: "Kind" }, { key: "finding", label: "Finding" },
        { key: "severity", label: "Severity" },
      ],
      rows: rows.map((f) => ({
        __k: `${f.run_id}:${f.finding_key}`, run: f.run_id, tool: f.tool,
        kind: f.kind, finding: f.finding_key, severity: f.severity ?? "—",
      })),
      rowKey: (r) => r.__k, mode: "pager", interaction: "browse",
    }));
  }

  showRuns(++seq); // initial view (rail active: "runs")

  return { destroy: () => { live.forEach((h) => h?.destroy?.()); live = []; page.destroy(); } };
}
