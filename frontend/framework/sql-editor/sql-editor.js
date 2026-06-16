/* sql-editor — the Workspace SQL console. Sole owner of .rp-sqleditor-*.
   knobs: --rp-sqleditor-input-min-h

   mountSqlEditor(host, {
     value?: string,                         // seed query (the last one run)
     suggestName?: () => string,             // default name for "Save as file"
     onRun(query) -> Promise<page>,          // run; resolve = caller showed the result
     onMaterialize(query, name) -> Promise,  // write the result as a new file
   }) -> { el, query(), destroy }

   A read-only SQL textarea over the open file (exposed as table `t`), Run +
   "Save as file" (materialize), and an inline status line. Engine-agnostic: the
   page wires onRun/onMaterialize to the window-source seam (client-first Polars
   SQL, server fallback + server materialize). The read-only guard lives in the
   shared engine, so this surface needs no validation of its own. On a successful
   Run the page swaps the grid to the result + closes this panel, so success
   shows nothing here; an ERROR keeps the panel open with the message. */

import { el } from "../boot/dom.js";
import { button, input } from "../atoms/atoms.js";
import { register } from "../registry/component-registry.js";

export function mountSqlEditor(host, cfg) {
  const root = el("div", { class: "rp-sqleditor" });

  const area = el("textarea", {
    class: "rp-sqleditor-input",
    placeholder: "SELECT * FROM t LIMIT 100",
    spellcheck: "false",
    rows: "6",
  });
  area.value = cfg.value ?? "";

  const status = el("div", { class: "rp-sqleditor-status" });
  const setStatus = (msg, tone) => {
    status.textContent = msg ?? "";
    status.dataset.tone = tone ?? "";
  };

  const name = input({ placeholder: "result name", value: cfg.suggestName?.() ?? "" });
  name.classList.add("rp-sqleditor-name");

  const run = button({ label: "Run", variant: "accent", onClick: doRun });
  const save = button({ label: "Save as file", variant: "ghost", onClick: doSave });

  root.append(
    el("div", { class: "rp-sqleditor-hint" }, "Query the open file as table ", el("code", { class: "rp-sqleditor-t" }, "t"), " — read-only."),
    area,
    el("div", { class: "rp-sqleditor-foot" },
      status,
      el("div", { class: "rp-sqleditor-actions" }, name, save, run)
    )
  );

  async function doRun() {
    const q = area.value.trim();
    if (!q) return;
    setStatus("Running…", "muted");
    run.disabled = true;
    try {
      await cfg.onRun?.(q); // success: the page swapped the grid + closed this panel
    } catch (e) {
      setStatus(e?.message || "Query failed", "danger");
    } finally {
      run.disabled = false;
    }
  }

  async function doSave() {
    const q = area.value.trim();
    if (!q) return;
    setStatus("Saving…", "muted");
    save.disabled = true;
    try {
      await cfg.onMaterialize?.(q, name.value.trim() || "query_result");
      setStatus("Saved as a new file.", "ok");
    } catch (e) {
      setStatus(e?.message || "Save failed", "danger");
    } finally {
      save.disabled = false;
    }
  }

  host.append(root);
  return { el: root, query: () => area.value, destroy: () => root.remove() };
}

register("sql-editor", mountSqlEditor);
