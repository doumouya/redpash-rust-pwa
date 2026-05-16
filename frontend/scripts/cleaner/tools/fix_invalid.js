// Replace a specific sentinel value (e.g. "N/A", "999", "-1") with
// either a clean replacement or null. Useful right after profiling
// when you've spotted a junk value polluting a column.

export function mount(ctx) {
  const { host, columns, dispatch } = ctx;
  let cols = columns ?? [];

  const colSel = document.createElement("select");
  colSel.className = "rp-tools__input";
  const sentinel = document.createElement("input");
  sentinel.className = "rp-tools__input";
  sentinel.placeholder = "Sentinel value (e.g. N/A)";
  const replacement = document.createElement("input");
  replacement.className = "rp-tools__input";
  replacement.placeholder = "Replace with (blank = null)";

  const apply = document.createElement("button");
  apply.className = "rp-btn rp-btn--sm rp-btn--primary";
  apply.textContent = "Replace";
  apply.disabled = true;

  function renderCols() {
    colSel.innerHTML = cols.map((c) => `<option value="${esc(c.name)}">${esc(c.name)}</option>`).join("");
  }
  function refresh() {
    apply.disabled = !colSel.value || !sentinel.value;
  }
  colSel.addEventListener("change", refresh);
  sentinel.addEventListener("input", refresh);

  apply.addEventListener("click", () => {
    const params = { column: colSel.value, sentinel: sentinel.value };
    if (replacement.value !== "") params.replacement = replacement.value;
    dispatch({ tool: "step", kind: "fix_invalid", params });
    sentinel.value = ""; replacement.value = ""; refresh();
  });

  host.append(colSel, sentinel, replacement, apply);
  renderCols(); refresh();

  return { update(ctx2) { cols = ctx2.columns ?? []; renderCols(); refresh(); } };
}

function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;" }[c])); }
