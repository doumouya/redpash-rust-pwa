/* joins-wizard — the multi-file join flow. Renders INTO host (the orchestrator
   opens the modal; this never opens its own). It OWNS its markup; sole owner
   of .rp-jw*.

   mountJoinsWizard(host, {
     detect: () => Promise<{ files: [{
        file_id, filename, candidates: [{
          this_col, other_col, matches, this_uniques, other_uniques, samples:[…] }] }] }>,
     onExecute: (body) => Promise<any>,   // { other_file, left_keys:[this_col],
                                          //   right_keys:[other_col], join_type, materialize_as }
     onCancel: () => void,
   }) -> { el, update, destroy }

   On mount it calls detect() (spinner -> results). A list of candidate files;
   selecting one reveals its candidate key pairs as pickable rows (radio-like).
   A join_type <select> (Inner/Left/Right/Outer/Cross, default Inner) + a
   "Result name" input (-> materialize_as). Footer: Join (accent, disabled until
   a pair is chosen) + Cancel. Empty detect result => empty-state. */

import { el } from "../boot/dom.js";
import { button, input, chip, spinner } from "../atoms/atoms.js";
import { mountSelect } from "../select/select.js";
import { mountEmptyState } from "../empty-state/empty-state.js";
import { register } from "../registry/component-registry.js";

const JOIN_TYPES = [
  { value: "inner", label: "Inner" },
  { value: "left", label: "Left" },
  { value: "right", label: "Right" },
  { value: "outer", label: "Outer" },
  { value: "cross", label: "Cross" },
];

export function mountJoinsWizard(host, cfg) {
  const root = el("div", { class: "rp-jw" });

  let files = [];
  let selectedFile = null; // a file object from detect()
  let selectedPair = null; // a candidate { this_col, other_col, … }
  let joinType = "inner";
  let resultName = "";

  // mutable region nodes
  const body = el("div", { class: "rp-jw-body" });
  const foot = el("div", { class: "rp-jw-foot" });
  const cancelBtn = button({ label: "Cancel", variant: "ghost", onClick: () => cfg.onCancel?.() });
  const joinBtn = button({ label: "Join", variant: "accent", onClick: execute });
  foot.append(cancelBtn, joinBtn);
  root.append(body, foot);

  function setJoinEnabled() {
    joinBtn.disabled = !selectedPair;
  }

  function showLoading() {
    body.replaceChildren(
      el("div", { class: "rp-jw-loading" }, spinner(), el("span", {}, "Finding joinable files…"))
    );
    foot.replaceChildren(cancelBtn, joinBtn); // footer persists; Join disabled
    setJoinEnabled();
  }

  function showError(message) {
    body.replaceChildren(
      el("div", { class: "rp-jw-error" }, message || "Could not detect joinable files.")
    );
    setJoinEnabled();
  }

  function showEmpty() {
    body.replaceChildren();
    mountEmptyState(body, {
      title: "No joinable files",
      line: "Upload another file to this project to join against it.",
    });
    foot.replaceChildren(cancelBtn); // nothing to join — only Cancel
  }

  function fileRow(file) {
    const active = selectedFile && selectedFile.file_id === file.file_id;
    const n = (file.candidates ?? []).length;
    const btn = el(
      "button",
      {
        class: `rp-jw-file${active ? " is-active" : ""}`,
        type: "button",
        "aria-pressed": active ? "true" : "false",
        onclick: () => {
          selectedFile = file;
          selectedPair = null;
          render();
        },
      },
      el("span", { class: "rp-jw-file-name" }, file.filename ?? file.file_id),
      el("span", { class: "rp-jw-file-meta" }, `${n} key${n === 1 ? "" : "s"}`)
    );
    return btn;
  }

  function pairRow(cand) {
    const active =
      selectedPair &&
      selectedPair.this_col === cand.this_col &&
      selectedPair.other_col === cand.other_col;
    const head = el(
      "div",
      { class: "rp-jw-pair-head" },
      el("span", { class: "rp-jw-pair-keys" },
        el("code", { class: "rp-jw-key" }, cand.this_col),
        el("span", { class: "rp-jw-arrow" }, "→"),
        el("code", { class: "rp-jw-key" }, cand.other_col)
      ),
      el("span", { class: "rp-jw-matches" }, `${cand.matches ?? 0} matches`)
    );
    const samples = el("div", { class: "rp-jw-samples" },
      ...(cand.samples ?? []).slice(0, 6).map((s) => chip({ label: String(s) }))
    );
    return el(
      "button",
      {
        class: `rp-jw-pair${active ? " is-active" : ""}`,
        type: "button",
        "aria-pressed": active ? "true" : "false",
        onclick: () => {
          selectedPair = cand;
          render();
        },
      },
      head,
      (cand.samples ?? []).length ? samples : null
    );
  }

  function renderResults() {
    body.replaceChildren();

    const fileList = el("div", { class: "rp-jw-files" },
      el("h3", { class: "rp-jw-heading" }, "File to join"),
      ...files.map(fileRow)
    );
    body.append(fileList);

    if (selectedFile) {
      const cands = selectedFile.candidates ?? [];
      const pairs = el("div", { class: "rp-jw-pairs" },
        el("h3", { class: "rp-jw-heading" }, "Key to join on")
      );
      if (cands.length) {
        pairs.append(...cands.map(pairRow));
      } else {
        pairs.append(el("p", { class: "rp-jw-nokeys" }, "No matching key columns for this file."));
      }
      body.append(pairs);

      // options row: join type + result name
      const opts = el("div", { class: "rp-jw-opts" });
      const typeHost = el("span", { class: "rp-jw-type" });
      mountSelect(typeHost, {
        options: JOIN_TYPES,
        value: joinType,
        onChange: (v) => (joinType = v),
      });
      const nameInput = input({
        placeholder: "Result name (optional)",
        value: resultName,
        onInput: (v) => (resultName = v),
      });
      nameInput.classList.add("rp-jw-name");
      opts.append(
        el("label", { class: "rp-jw-opt" }, el("span", { class: "rp-jw-opt-label" }, "Join type"), typeHost),
        el("label", { class: "rp-jw-opt" }, el("span", { class: "rp-jw-opt-label" }, "Result name"), nameInput)
      );
      body.append(opts);
    }

    foot.replaceChildren(cancelBtn, joinBtn);
    setJoinEnabled();
  }

  function render() {
    if (!files.length) {
      showEmpty();
      return;
    }
    renderResults();
  }

  async function execute() {
    if (!selectedPair || !selectedFile) return;
    const body = {
      other_file: selectedFile.file_id,
      left_keys: [selectedPair.this_col],
      right_keys: [selectedPair.other_col],
      join_type: joinType,
    };
    const name = resultName.trim();
    if (name) body.materialize_as = name;
    joinBtn.disabled = true;
    try {
      await cfg.onExecute?.(body);
    } catch (e) {
      // re-enable so the user can retry; surface nothing fancy (dev UX)
      setJoinEnabled();
      throw e;
    }
  }

  async function load() {
    showLoading();
    try {
      const res = await cfg.detect?.();
      files = (res && res.files) || [];
      render();
    } catch (e) {
      showError(e && e.message);
    }
  }

  host.append(root);
  load();

  return {
    el: root,
    update: () => render(),
    destroy: () => root.remove(),
  };
}

register("joins-wizard", mountJoinsWizard);
