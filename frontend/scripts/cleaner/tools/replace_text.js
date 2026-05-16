// Find/replace inside one column's cells. Toggle the regex flag to
// switch between literal and pattern matching. Set "Replace with" blank
// to behave like `remove_text` from the Django app.

export function mount(ctx) {
  const { host, columns, dispatch } = ctx;
  let cols = columns ?? [];

  const colSel = document.createElement("select");
  colSel.className = "rp-tools__input";

  const find = document.createElement("input");
  find.className = "rp-tools__input";
  find.placeholder = "Find";
  const repl = document.createElement("input");
  repl.className = "rp-tools__input";
  repl.placeholder = "Replace with (blank = remove)";

  const regexWrap = document.createElement("label");
  regexWrap.className = "rp-tools__check";
  regexWrap.innerHTML = `<input type="checkbox" /> <span>Treat "Find" as regex</span>`;
  const regex = regexWrap.querySelector("input");

  const apply = document.createElement("button");
  apply.className = "rp-btn rp-btn--sm rp-btn--primary";
  apply.textContent = "Apply";
  apply.disabled = true;

  function renderCols() {
    colSel.innerHTML = cols.map((c) => `<option value="${esc(c.name)}">${esc(c.name)}</option>`).join("");
  }
  function refresh() { apply.disabled = !colSel.value || !find.value; }
  colSel.addEventListener("change", refresh);
  find.addEventListener("input", refresh);

  apply.addEventListener("click", () => {
    dispatch({
      tool: "step",
      kind: "replace_text",
      params: {
        column:   colSel.value,
        find:     find.value,
        replace:  repl.value,
        is_regex: regex.checked,
      },
    });
  });

  host.append(colSel, find, repl, regexWrap, apply);
  renderCols(); refresh();

  return { update(ctx2) { cols = ctx2.columns ?? []; renderCols(); refresh(); } };
}

function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;" }[c])); }
