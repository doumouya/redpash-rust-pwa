// Fill null cells.
//   strategy = fixed | zero | forward
//   column   = optional (omit → fill all columns)
//   value    = required when strategy = fixed

export function mount(ctx) {
  const { host, columns, dispatch } = ctx;
  let cols = columns ?? [];

  const colSel = sel("rp-fill-col");
  const stratSel = sel("rp-fill-strategy");
  stratSel.innerHTML = `
    <option value="fixed">Fixed value</option>
    <option value="zero">Zero (0)</option>
    <option value="forward">Forward-fill</option>
  `;
  const valueInput = document.createElement("input");
  valueInput.className = "rp-tools__input";
  valueInput.placeholder = "Replacement value (e.g. Unknown)";

  const apply = document.createElement("button");
  apply.className = "rp-btn rp-btn--sm rp-btn--primary";
  apply.textContent = "Fill nulls";

  function renderCols() {
    colSel.innerHTML = `<option value="">— All columns —</option>` +
      cols.map((c) => `<option value="${esc(c.name)}">${esc(c.name)} <small>(${esc(c.dtype)})</small></option>`).join("");
  }
  function refresh() {
    valueInput.hidden = stratSel.value !== "fixed";
    apply.disabled = stratSel.value === "fixed" && !valueInput.value;
  }
  stratSel.addEventListener("change", refresh);
  valueInput.addEventListener("input", refresh);

  apply.addEventListener("click", () => {
    const params = { strategy: stratSel.value };
    if (colSel.value)               params.column = colSel.value;
    if (stratSel.value === "fixed") params.value  = valueInput.value;
    dispatch({ tool: "step", kind: "fill_nulls", params });
  });

  host.append(colSel, stratSel, valueInput, apply);
  renderCols(); refresh();

  return { update(ctx2) { cols = ctx2.columns ?? []; renderCols(); } };
}

function sel(id) {
  const s = document.createElement("select");
  s.className = "rp-tools__input";
  s.id = id;
  return s;
}
function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;" }[c])); }
