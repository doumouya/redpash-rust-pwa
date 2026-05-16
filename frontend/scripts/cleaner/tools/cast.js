// Change a column's dtype. Unparseable values become null (strict=false).

const DTYPES = [
  { value: "int",      label: "Integer" },
  { value: "float",    label: "Float" },
  { value: "str",      label: "Text" },
  { value: "bool",     label: "Boolean" },
  { value: "date",     label: "Date" },
  { value: "datetime", label: "Datetime" },
  { value: "time",     label: "Time" },
];

export function mount(ctx) {
  const { host, columns, dispatch } = ctx;
  let cols = columns ?? [];

  const colSel = document.createElement("select");
  colSel.className = "rp-tools__input";
  const dtypeSel = document.createElement("select");
  dtypeSel.className = "rp-tools__input";
  dtypeSel.innerHTML = DTYPES.map((d) => `<option value="${d.value}">${d.label}</option>`).join("");

  const apply = document.createElement("button");
  apply.className = "rp-btn rp-btn--sm rp-btn--primary";
  apply.textContent = "Cast column";

  function renderCols() {
    colSel.innerHTML = cols.map((c) => `<option value="${esc(c.name)}">${esc(c.name)} <small>(${esc(c.dtype)})</small></option>`).join("");
  }

  apply.addEventListener("click", () => {
    if (!colSel.value) return;
    dispatch({ tool: "step", kind: "cast", params: { column: colSel.value, dtype: dtypeSel.value } });
  });

  host.append(colSel, dtypeSel, apply);
  renderCols();

  return { update(ctx2) { cols = ctx2.columns ?? []; renderCols(); } };
}

function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;" }[c])); }
