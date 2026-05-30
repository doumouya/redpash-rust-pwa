/* Purpose: see doc for details.
 * Doc: docs/internal/code/frontend/scripts/charts/render.md */
// charts/render.js — chart spec → live ECharts instance.
//
// Slice B of the chart-pipeline unification (Em 2026-05-27). Sits on
// top of Slice A's `buildOption` and adds the missing piece for
// dynamic data: a `source` discriminant that names where the chart's
// data comes from, plus a resolver that fetches + normalises + injects
// it into the spec before `buildOption` runs.
//
// The unification it unlocks
// ---------------------------
// Designer charts and Monitoring charts have always rendered through
// separate paths because their data shape differs:
//   - Designer:  cfg.option carries the data baked at save time.
//   - Monitoring (today): per-kind kpiX(el, data, opts) functions in
//                /scripts/echarts-kpi.js take a fresh `{label:count}`
//                or `[{ts,value}]` blob and emit their own option shape.
// `renderChart` lets both flows go through buildOption by injecting
// the fetched data into the cfg.option shape buildOption already
// reads from. The kpiX functions stay — their compact KPI-tile shape
// is intentionally different from a full designer chart; migrating
// them to a single buildOption call needs a "compact mode" flag
// that's out of Slice B's scope.
//
// Spec shape
// ----------
//   {
//     id:     "rp-mon-req-status",           // DOM id of the chart slot
//     title:  "By status",                   // optional, used for the title
//     cfg:    { kind, type, legend, … },     // designer cfg shape (Slice A vocabulary)
//     source: { kind: "baked" }              // default — data already in cfg.option
//           | { kind: "monitoring-stats",    // fetch from a stats endpoint at render time
//               endpoint: "/monitoring/requests/stats",
//               pointer:  "status_mix",      // dotted path into the response JSON
//               window:   "24h" }            // optional query param appended as ?window=
//   }
//
// Source kinds today
// ------------------
//   - baked              — cfg.option already carries the data, no fetch
//   - monitoring-stats   — GET ${endpoint} (+ ?window=…), extract `pointer`,
//                          normalise per cfg.kind, inject into cfg.option
//
// Future source kinds (sketched but unimplemented):
//   - file              — pull from `/api/files/:rid/page` + transform via report engine
//   - report            — pull from `/api/reports/:rid/run` (replaces today's chart-as-File)
//   - logs              — pull from Gus's pending unified `/api/monitoring/logs`

import { api } from "/scripts/api.js";
import { ensureRegisteredThemes } from "/scripts/echarts-theme.js";
import { THEMES, buildOption } from "/scripts/charts/build.js";

// ── resolve a chart's data per its source discriminant ──────────────
// Returns `null` for the baked path (cfg.option already has the
// values, buildOption reads them directly). Returns a normalised
// payload otherwise, ready to feed into `synthesizeOption`.
export async function resolveData(source) {
  if (!source || source.kind === "baked") return null;

  if (source.kind === "monitoring-stats") {
    if (!source.endpoint) {
      throw new Error("monitoring-stats source needs an `endpoint`");
    }
    const qs = source.window
      ? "?window=" + encodeURIComponent(source.window)
      : "";
    const stats = await api.get(source.endpoint + qs);
    // Optional transform — computes a derived scalar from two pointers
    // instead of returning the raw pointer value. Unlocks the gauge
    // tabs whose stats endpoint exposes a numerator + a total but no
    // pre-computed percentage (Home companies active_30d/total, charts
    // last_7d/total, Monitoring events last_24h/total, …). Without a
    // transform the source returns readPointer(stats, pointer) as
    // before — fully backward-compatible.
    if (source.transform) return applyTransform(stats, source);
    return readPointer(stats, source.pointer);
  }

  throw new Error("unknown chart source kind: " + source.kind);
}

// Compute a derived scalar from a stats response per `source.transform`.
// One transform kind today — `ratio`: (numerator / denominator) * scale.
//   source.pointer            → numerator pointer
//   transform.denominator     → denominator pointer
//   transform.scale           → multiplier (default 100, i.e. a percent)
// Returns a single Number for the gauge to render, or 0 when the
// denominator is missing/zero (a 0% gauge beats a NaN / blank tile).
// New transform kinds (delta, sum, …) extend the switch.
export function applyTransform(stats, source) {
  const t = source.transform || {};
  if (t.kind === "ratio") {
    const num   = Number(readPointer(stats, source.pointer)) || 0;
    const denom = Number(readPointer(stats, t.denominator)) || 0;
    const scale = t.scale == null ? 100 : Number(t.scale);
    if (!denom) return 0;
    return Math.round((num / denom) * scale * 10) / 10;  // 1-decimal
  }
  throw new Error("unknown transform kind: " + t.kind);
}

// Read a dotted-path pointer into a JSON object. Missing path
// returns `undefined`, which `synthesizeOption` treats as "no data,
// fall back to buildOption's placeholder."
//
//   readPointer({ status_mix: { 200: 5, 500: 1 } }, "status_mix")
//   → { 200: 5, 500: 1 }
//
//   readPointer({ buckets: [{ p95_ms: 12 }, { p95_ms: 18 }] }, "buckets.p95_ms")
//   → [12, 18]      // array-walks pull the named field from each element
export function readPointer(obj, pointer) {
  if (obj == null || !pointer) return obj;
  const parts = pointer.split(".");
  let cur = obj;
  for (const p of parts) {
    if (cur == null) return undefined;
    if (Array.isArray(cur)) {
      cur = cur.map((item) => (item == null ? null : item[p]));
    } else {
      cur = cur[p];
    }
  }
  return cur;
}

// ── normalise + inject fetched data into a cfg.option shape ─────────
// buildOption reads data from cfg.option.{xAxis.data, series[0].data}.
// We don't try to replicate every per-kind branch — we just stamp the
// data into the shape buildOption already accepts. Three flavours
// cover today's chart kinds:
//   - pie family (pie/donut/rose/half_donut/radar): [{name, value}]
//   - cartesian + barh + scatter + pictorial: x labels + y values
//   - gauge: single headline number (buildOption sums values when the
//     first element isn't a single value, so the cartesian shape
//     works for gauges too — no special-case branch needed)
export function synthesizeOption(data, kind) {
  if (data == null) return null;

  // Scalar (a transform's ratio output, or any single-number pointer):
  // stamp it as the sole series value so buildOption's gauge branch
  // reads values[0]. Cartesian/bar kinds with a lone number render a
  // one-point series — harmless, but scalars are really for gauges.
  if (typeof data === "number") {
    return { series: [{ data: [data] }] };
  }

  // Pie-family expects [{name, value}] OR { label: number }.
  // buildOption's pieData fallback reads `series[0].data[0]` as an
  // object to detect this shape.
  if (kind === "pie" || kind === "radar") {
    const items = normaliseToNameValue(data);
    return { series: [{ data: items }] };
  }

  // Cartesian + bar + line + area + scatter + barh + pictorial +
  // gauge all read `xAxis.data` (labels) + `series[0].data` (values)
  // OR `yAxis.data` (for barh, which puts the categorical axis on Y).
  // buildOption already prefers xAxis.data → yAxis.data → fallback,
  // so we only need to stamp xAxis.data + the values; the per-kind
  // builder maps it into whichever axis it owns.
  const { labels, values } = normaliseToLabelsValues(data);
  return {
    xAxis: { data: labels },
    yAxis: { data: labels },  // barh reads from yAxis; harmless on others
    series: [{ data: values }],
  };
}

// ── helpers ─────────────────────────────────────────────────────────
// Accept the two shapes monitoring endpoints actually return:
//   - HashMap<String, u64> serialised as { "key": 5, "key2": 3 }
//   - Vec<{name|label, count|value}>
function normaliseToNameValue(input) {
  if (Array.isArray(input)) {
    return input
      .filter((d) => d && (d.name || d.label) != null)
      .map((d) => ({
        name:  String(d.name ?? d.label),
        value: Number(d.value ?? d.count ?? 0),
      }));
  }
  if (input && typeof input === "object") {
    return Object.entries(input)
      .filter(([, v]) => typeof v === "number" && !Number.isNaN(v))
      .map(([name, value]) => ({ name, value }));
  }
  return [];
}

function normaliseToLabelsValues(input) {
  const items = normaliseToNameValue(input);
  return {
    labels: items.map((i) => i.name),
    values: items.map((i) => i.value),
  };
}

// ── renderChart: the unified mount entry point ──────────────────────
// `el` is the slot to draw into; `spec` is the chart-spec object
// (id/title/cfg/source); `themeName` is the registered theme key
// (defaults to the spec's cfg.theme).
//
// Returns the ECharts instance so the caller manages dispose/resize
// — same contract as window.echarts.init.
export async function renderChart(el, spec, themeName) {
  if (!el || !window.echarts) return null;
  ensureRegisteredThemes();

  const cfg = { ...(spec.cfg || {}) };
  const themeKey = themeName || cfg.theme || "vintage";
  const t = THEMES[themeKey] || THEMES.vintage;

  // Fetch + inject if the spec carries a non-baked source. Failures
  // bubble out — the caller decides whether to swallow them (a tile
  // that fails to load shouldn't blank the whole tab).
  if (spec.source && spec.source.kind !== "baked") {
    const data = await resolveData(spec.source);
    const baked = synthesizeOption(data, cfg.kind);
    if (baked) cfg.option = baked;
  }

  const themeForInit = t.registered ? themeKey : undefined;
  // A DOM node can host only one ECharts instance. On a re-render (tab
  // switch, window-chip flip, live preview) one may already be bound to
  // this slot — init does NOT replace it, it warns and the orphaned
  // instance keeps its canvas + resize listeners alive (memory leak).
  // Dispose any existing instance on the element first.
  const existing = window.echarts.getInstanceByDom(el);
  if (existing) { try { existing.dispose(); } catch { /* already gone */ } }
  const inst = window.echarts.init(el, themeForInit);
  inst.setOption(buildOption(cfg, t));
  return inst;
}
