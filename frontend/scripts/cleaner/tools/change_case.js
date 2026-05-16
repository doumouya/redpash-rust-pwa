// Lowercase / uppercase / titlecase every string cell.

export function mount(ctx) {
  const { host, dispatch } = ctx;

  const sel = document.createElement("select");
  sel.className = "rp-tools__input";
  sel.innerHTML = `
    <option value="lower">lowercase</option>
    <option value="upper">UPPERCASE</option>
  `;

  const apply = document.createElement("button");
  apply.className = "rp-btn rp-btn--sm rp-btn--primary";
  apply.textContent = "Change case";

  apply.addEventListener("click", () => {
    dispatch({ tool: "step", kind: "change_case", params: { mode: sel.value } });
  });

  host.append(sel, apply);
  return { update() {} };
}
