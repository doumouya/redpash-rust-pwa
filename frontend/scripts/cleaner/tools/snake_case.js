// Rename every column header to snake_case.

export function mount(ctx) {
  const { host, dispatch } = ctx;

  const apply = document.createElement("button");
  apply.className = "rp-btn rp-btn--sm rp-btn--primary";
  apply.textContent = "Snake_case all columns";

  const help = document.createElement("p");
  help.className = "rp-muted rp-tools__hint";
  help.textContent = "Customer Name → customer_name · Order-Date → order_date · EMAIL → email";

  apply.addEventListener("click", () => {
    dispatch({ tool: "step", kind: "snake_case_columns", params: {} });
  });

  host.append(apply, help);
  return { update() {} };
}
