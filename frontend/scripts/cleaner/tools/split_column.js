// Split one column on a delimiter into N new columns (capped at 10).
// New columns are named `{column}_1`, `{column}_2`, … Source column is
// dropped unless "Keep original" is checked.

export function mount(ctx) {
  const { host, columns, dispatch } = ctx;
  let cols = columns ?? [];

  const colSel = document.createElement("select");
  colSel.className = "rp-tools__input";
  const sep = document.createElement("input");
  sep.className = "rp-tools__input";
  sep.placeholder = "Separator (default: ,)";

  const keepWrap = document.createElement("label");
  keepWrap.className = "rp-tools__check";
  keepWrap.innerHTML = `<input type="checkbox" /> <span>Keep original column</span>`;
  const keep = keepWrap.querySelector("input");

  const apply = document.createElement("button");
  apply.className = "rp-btn rp-btn--sm rp-btn--primary";
  apply.textContent = "Split column";

  function renderCols() {
    colSel.innerHTML = cols.map((c) => `<option value="${esc(c.name)}">${esc(c.name)}</option>`).join("");
  }

  apply.addEventListener("click", () => {
    const params = { column: colSel.value, keep_original: keep.checked };
    if (sep.value) params.sep = sep.value;
    dispatch({ tool: "step", kind: "split_column", params });
    sep.value = "";
  });

  host.append(colSel, sep, keepWrap, apply);
  renderCols();

  return { update(ctx2) { cols = ctx2.columns ?? []; renderCols(); } };
}

function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;" }[c])); }
