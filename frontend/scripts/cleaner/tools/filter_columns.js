// Keep only the checked columns; drop everything else. Useful for
// trimming a wide CSV down to the columns that matter.

export function mount(ctx) {
  const { host, columns, dispatch } = ctx;
  let cols = columns ?? [];

  const list = document.createElement("div");
  list.className = "rp-tools__cols";

  const apply = document.createElement("button");
  apply.className = "rp-btn rp-btn--sm rp-btn--primary";
  apply.textContent = "Keep checked columns";

  const help = document.createElement("p");
  help.className = "rp-muted rp-tools__hint";
  help.textContent = "Unchecked columns will be dropped.";

  function renderList() {
    list.innerHTML = cols.map((c) => `
      <label class="rp-tools__col">
        <input type="checkbox" value="${esc(c.name)}" checked />
        <span>${esc(c.name)}</span>
        <small>${esc(c.dtype)}</small>
      </label>`).join("");
  }

  apply.addEventListener("click", () => {
    const keep = Array.from(list.querySelectorAll("input:checked")).map((i) => i.value);
    if (!keep.length) return;
    dispatch({ tool: "step", kind: "filter_columns", params: { cols: keep } });
  });

  host.append(list, apply, help);
  renderList();

  return { update(ctx2) { cols = ctx2.columns ?? []; renderList(); } };
}

function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;" }[c])); }
