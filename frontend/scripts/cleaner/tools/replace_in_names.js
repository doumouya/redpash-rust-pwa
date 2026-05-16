// Find/replace across all column headers. Replace blank = remove the
// found text from every header that contains it.

export function mount(ctx) {
  const { host, dispatch } = ctx;

  const find = document.createElement("input");
  find.className = "rp-tools__input";
  find.placeholder = "Find in column names";
  const repl = document.createElement("input");
  repl.className = "rp-tools__input";
  repl.placeholder = "Replace with (blank = remove)";

  const apply = document.createElement("button");
  apply.className = "rp-btn rp-btn--sm rp-btn--primary";
  apply.textContent = "Replace in headers";
  apply.disabled = true;

  find.addEventListener("input", () => { apply.disabled = !find.value; });

  apply.addEventListener("click", () => {
    dispatch({ tool: "step", kind: "replace_in_names", params: { find: find.value, replace: repl.value } });
    find.value = ""; repl.value = ""; apply.disabled = true;
  });

  host.append(find, repl, apply);
  return { update() {} };
}
