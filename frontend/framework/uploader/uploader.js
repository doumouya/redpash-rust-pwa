/* uploader — drop zone + picker. The Workspace's primary entry.
   mountUploader(host, {label?, hint?, accept?, multiple?, onFile(file), onFiles(files)}) —
   single by default (onFile); pass `multiple:true` + `onFiles` to accept several
   at once. handle.busy(on, msg?) toggles the in-flight state (msg shows progress). */

import { el } from "../boot/dom.js";
import { spinner } from "../atoms/atoms.js";
import { register } from "../registry/component-registry.js";

export function mountUploader(host, cfg) {
  const defaultLabel =
    cfg.label ?? (cfg.multiple ? "Drop CSVs here, or click to choose" : "Drop a CSV here, or click to choose");
  const fileInput = el("input", { type: "file", accept: cfg.accept ?? ".csv,.tsv,.txt" });
  if (cfg.multiple) fileInput.multiple = true;
  const label = el("div", {}, defaultLabel);
  const zone = el(
    "div",
    { class: "rp-uploader", role: "button", tabindex: "0" },
    label,
    cfg.hint ? el("div", { class: "rp-uploader-hint" }, cfg.hint) : null,
    fileInput
  );

  // Hand off the picked files: the multi-aware callback when present, else the
  // single-file callback with the first file (back-compat).
  function pick(fileList) {
    const files = [...(fileList || [])].filter(Boolean);
    // Clear the input so re-picking the SAME file still fires `change` (a retry
    // after a failed upload) — `change` only fires when the value differs.
    fileInput.value = "";
    if (!files.length) return;
    if (cfg.onFiles) cfg.onFiles(files);
    else cfg.onFile?.(files[0]);
  }
  zone.addEventListener("click", () => fileInput.click());
  zone.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") fileInput.click();
  });
  fileInput.addEventListener("change", () => pick(fileInput.files));
  zone.addEventListener("dragover", (e) => {
    e.preventDefault();
    zone.classList.add("is-over");
  });
  zone.addEventListener("dragleave", () => zone.classList.remove("is-over"));
  zone.addEventListener("drop", (e) => {
    e.preventDefault();
    zone.classList.remove("is-over");
    pick(e.dataTransfer?.files);
  });

  host.append(zone);
  return {
    el: zone,
    busy(on, msg) {
      zone.classList.toggle("is-busy", !!on);
      // Disable the input while in flight — blocks the picker via click AND the
      // keyboard path (Enter/Space), which pointer-events:none alone does not.
      fileInput.disabled = !!on;
      label.replaceChildren(on ? spinner() : document.createTextNode(defaultLabel));
      if (on && msg) label.append(document.createTextNode(" " + msg));
    },
    update() {},
    destroy: () => zone.remove(),
  };
}

register("uploader", mountUploader);
