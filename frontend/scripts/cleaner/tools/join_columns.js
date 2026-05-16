// Concatenate two columns into a new one. Source columns are dropped.

export function mount(ctx) {
  const { host, columns, dispatch } = ctx;
  let cols = columns ?? [];

  const c1 = sel(); const c2 = sel();
  const sep = document.createElement("input");
  sep.className = "rp-tools__input";
  sep.placeholder = "Separator (default: space)";
  const newName = document.createElement("input");
  newName.className = "rp-tools__input";
  newName.placeholder = "New column name (optional)";

  const apply = document.createElement("button");
  apply.className = "rp-btn rp-btn--sm rp-btn--primary";
  apply.textContent = "Join columns";

  function renderCols() {
    [c1, c2].forEach((s, i) => {
      s.innerHTML = cols.map((c, j) => `<option value="${esc(c.name)}"${i === 0 && j === 0 || i === 1 && j === 1 ? "" : ""}>${esc(c.name)}</option>`).join("");
    });
    if (cols.length > 1) {
      c1.selectedIndex = 0;
      c2.selectedIndex = 1;
    }
  }

  apply.addEventListener("click", () => {
    if (c1.value === c2.value) return;
    const params = { col1: c1.value, col2: c2.value };
    if (sep.value)    params.sep      = sep.value;
    if (newName.value) params.new_name = newName.value;
    dispatch({ tool: "step", kind: "join_columns", params });
    sep.value = ""; newName.value = "";
  });

  host.append(c1, c2, sep, newName, apply);
  renderCols();

  return { update(ctx2) { cols = ctx2.columns ?? []; renderCols(); } };
}

function sel() {
  const s = document.createElement("select");
  s.className = "rp-tools__input";
  return s;
}
function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;" }[c])); }
