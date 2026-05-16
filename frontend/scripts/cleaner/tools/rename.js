// Rename a single column. The redtable's column-× icon handles drops;
// this tool is the inverse for renames.

export function mount(ctx) {
  const { host, columns, dispatch } = ctx;
  let cols = columns ?? [];

  const colSel = document.createElement("select");
  colSel.className = "rp-tools__input";
  const newInput = document.createElement("input");
  newInput.className = "rp-tools__input";
  newInput.placeholder = "New column name";

  const apply = document.createElement("button");
  apply.className = "rp-btn rp-btn--sm rp-btn--primary";
  apply.textContent = "Rename";

  function renderCols() {
    colSel.innerHTML = cols.map((c) => `<option value="${esc(c.name)}">${esc(c.name)}</option>`).join("");
  }
  function refresh() {
    apply.disabled = !newInput.value.trim() || newInput.value.trim() === colSel.value;
  }
  colSel.addEventListener("change", refresh);
  newInput.addEventListener("input", refresh);

  apply.addEventListener("click", () => {
    const to = newInput.value.trim();
    if (!to || !colSel.value) return;
    dispatch({ tool: "step", kind: "rename_column", params: { from: colSel.value, to } });
    newInput.value = "";
    refresh();
  });

  host.append(colSel, newInput, apply);
  renderCols(); refresh();

  return { update(ctx2) { cols = ctx2.columns ?? []; renderCols(); refresh(); } };
}

function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;" }[c])); }
