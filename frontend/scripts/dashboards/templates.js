// Dashboard layout templates.
//
// Each entry maps a `template_id` (saved in the dashboard's spec) to a
// CSS-grid description + the list of slot ids the user fills. Slots
// are referenced by name in the widget editor and rendered into the
// matching grid-area at preview time.
//
// Adding a new template = one entry here. The runtime just reads the
// grid + slot list — no other code needs to know.

export const TEMPLATES = {
  "1x1": {
    label: "Single panel",
    grid: { columns: "1fr", rows: "minmax(320px, 1fr)", areas: `"main"` },
    slots: [{ id: "main", label: "Main" }],
  },
  "2x2": {
    label: "2 × 2 grid",
    grid: { columns: "1fr 1fr", rows: "1fr 1fr", areas: `"a b" "c d"` },
    slots: [
      { id: "a", label: "Top left" },
      { id: "b", label: "Top right" },
      { id: "c", label: "Bottom left" },
      { id: "d", label: "Bottom right" },
    ],
  },
  "kpi-row-2x1": {
    label: "KPI row + 2 charts",
    grid: {
      columns: "1fr 1fr 1fr",
      rows: "auto 1fr",
      areas: `"k1 k2 k3" "main-a main-a main-b"`,
    },
    slots: [
      { id: "k1",     label: "KPI 1",  hint: "KPI works best here" },
      { id: "k2",     label: "KPI 2",  hint: "KPI works best here" },
      { id: "k3",     label: "KPI 3",  hint: "KPI works best here" },
      { id: "main-a", label: "Left chart" },
      { id: "main-b", label: "Right chart" },
    ],
  },
  "chart-side-table": {
    label: "Chart + side table",
    grid: { columns: "2fr 1fr", rows: "1fr", areas: `"chart side"` },
    slots: [
      { id: "chart", label: "Chart" },
      { id: "side",  label: "Side table" },
    ],
  },
  "header-3x2": {
    label: "Header + 3 × 2",
    grid: {
      columns: "1fr 1fr 1fr",
      rows: "auto 1fr 1fr",
      areas: `"hdr hdr hdr" "a b c" "d e f"`,
    },
    slots: [
      { id: "hdr", label: "Header (text)" },
      { id: "a",   label: "Top left"   }, { id: "b", label: "Top middle"   }, { id: "c", label: "Top right"   },
      { id: "d",   label: "Bottom left"}, { id: "e", label: "Bottom middle"}, { id: "f", label: "Bottom right"},
    ],
  },
};

/// Default widget shapes per kind — keeps the editor pre-filled with
/// something sensible the moment a kind is picked.
export const KIND_DEFAULTS = {
  kpi:   () => ({ label: "KPI", agg: { col: "*", fn: "count" } }),
  chart: () => ({ chart_type: "bar", group_by: "", agg: { col: "*", fn: "count" } }),
  table: () => ({ group_by: [], aggregations: [{ col: "*", fn: "count", alias: "" }] }),
  text:  () => ({ markdown: "## Heading\n\nWrite anything." }),
};
