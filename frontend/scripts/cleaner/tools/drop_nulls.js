// Drop rows with null/empty cells.
//   • No columns checked  → drop rows where ANY column is null.
//   • One+ columns checked → drop rows where ANY of those is null.

export function mount(ctx) {
  const { host, columns, dispatch } = ctx;
  let cols = columns ?? [];

  const list = document.createElement("div");
  list.className = "rp-tools__cols";

  const apply = document.createElement("button");
  apply.className = "rp-btn rp-btn--sm rp-btn--primary";
  apply.textContent = "Drop rows";

  const help = document.createElement("p");
  help.className = "rp-muted rp-tools__hint";
  help.textContent = "Leave all unchecked to drop rows with any null; check specific columns to restrict.";

  function renderList() {
    list.innerHTML = cols.map((c) => `
      <label class="rp-tools__col">
        <input type="checkbox" value="${esc(c.name)}" />
        <span>${esc(c.name)}</span>
        <small>${esc(c.dtype)}</small>
      </label>`).join("");
  }

  apply.addEventListener("click", () => {
    const selected = Array.from(list.querySelectorAll("input:checked")).map((i) => i.value);
    dispatch({ tool: "step", kind: "drop_nulls", params: { cols: selected } });
  });

  host.append(list, apply, help);
  renderList();

  return { update(ctx2) { cols = ctx2.columns ?? []; renderList(); } };
}

function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;" }[c])); }
