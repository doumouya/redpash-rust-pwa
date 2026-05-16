// Encoding tool — dropdown of common codecs. Selecting one POSTs
// /api/files/:rid/encoding, which updates the DB row, invalidates the
// cache, and triggers a fresh hydrate using the new encoding.
//
// `mojibake` (½ instead of é, for instance) most often means the file
// is latin-1 / windows-1252 misread as UTF-8 — this is the recovery
// path for those uploads.

const COMMON = [
  { value: "utf-8",        label: "UTF-8" },
  { value: "utf-16le",     label: "UTF-16 LE" },
  { value: "utf-16be",     label: "UTF-16 BE" },
  { value: "windows-1252", label: "Windows-1252 (CP1252)" },
  { value: "iso-8859-1",   label: "Latin-1 (ISO-8859-1)" },
  { value: "iso-8859-15",  label: "Latin-9 (ISO-8859-15)" },
  { value: "windows-1250", label: "Windows-1250 (CE Europe)" },
  { value: "macintosh",    label: "MacRoman" },
];

export function mount(ctx) {
  const { host, summary, dispatch } = ctx;
  let current = summary?.encoding ?? "";

  const select = document.createElement("select");
  select.className = "rp-tools__input";
  // Include the current encoding even if it isn't in COMMON, so the
  // selector reflects reality after a server-side detection.
  const all = [...COMMON];
  if (current && !all.some((o) => o.value === current)) {
    all.unshift({ value: current, label: current });
  }
  select.innerHTML = all
    .map((o) => `<option value="${o.value}"${o.value === current ? " selected" : ""}>${o.label}</option>`)
    .join("");

  const apply = document.createElement("button");
  apply.className = "rp-btn rp-btn--sm rp-btn--primary";
  apply.textContent = "Apply";
  apply.disabled = true;

  select.addEventListener("change", () => {
    apply.disabled = select.value === current;
  });
  apply.addEventListener("click", () => {
    dispatch({ tool: "encoding", encoding: select.value });
  });

  const help = document.createElement("p");
  help.className = "rp-muted rp-tools__hint";
  help.textContent = "Auto-detected on upload. Override if accents or special characters look wrong.";

  host.append(select, apply, help);

  return {
    update(ctx2) {
      current = ctx2.summary?.encoding ?? current;
      // Refresh selection without rebuilding the DOM.
      if (![...select.options].some((o) => o.value === current)) {
        const opt = new Option(current, current, true, true);
        select.add(opt, 0);
      }
      select.value = current;
      apply.disabled = true;
    },
  };
}
