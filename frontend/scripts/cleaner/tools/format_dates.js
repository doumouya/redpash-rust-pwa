// Parse + reformat a date column. strftime format string drives the
// output. Unparseable values:
//   null  → become null (default)
//   drop  → the row is removed entirely
//   keep  → original value is preserved

const FORMATS = [
  { value: "%Y-%m-%d",   label: "2024-01-15 (ISO)" },
  { value: "%d/%m/%Y",   label: "15/01/2024 (EU)" },
  { value: "%m/%d/%Y",   label: "01/15/2024 (US)" },
  { value: "%Y/%m/%d",   label: "2024/01/15" },
  { value: "%d %b %Y",   label: "15 Jan 2024" },
];

export function mount(ctx) {
  const { host, columns, dispatch } = ctx;
  let cols = columns ?? [];

  const colSel = document.createElement("select");
  colSel.className = "rp-tools__input";

  const fmtSel = document.createElement("select");
  fmtSel.className = "rp-tools__input";
  fmtSel.innerHTML = FORMATS.map((f) =>
    `<option value="${f.value}">${f.label}</option>`).join("");

  const onSel = document.createElement("select");
  onSel.className = "rp-tools__input";
  onSel.innerHTML = `
    <option value="null">Unparseable → null</option>
    <option value="drop">Unparseable → drop row</option>
    <option value="keep">Unparseable → keep original</option>
  `;

  const apply = document.createElement("button");
  apply.className = "rp-btn rp-btn--sm rp-btn--primary";
  apply.textContent = "Format dates";

  function renderCols() {
    colSel.innerHTML = cols.map((c) => `<option value="${esc(c.name)}">${esc(c.name)} <small>(${esc(c.dtype)})</small></option>`).join("");
  }

  apply.addEventListener("click", () => {
    if (!colSel.value) return;
    dispatch({
      tool: "step",
      kind: "format_dates",
      params: { column: colSel.value, fmt: fmtSel.value, on_incomplete: onSel.value },
    });
  });

  host.append(colSel, fmtSel, onSel, apply);
  renderCols();

  return { update(ctx2) { cols = ctx2.columns ?? []; renderCols(); } };
}

function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;" }[c])); }
