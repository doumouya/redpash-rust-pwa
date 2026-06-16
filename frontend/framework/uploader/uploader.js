/* uploader — drop zone + picker. The Workspace's primary entry.
   mountUploader(host, {label?, hint?, accept?, onFile(file)}) —
   handle.busy(bool) toggles the in-flight state. */

import { el } from "../boot/dom.js";
import { spinner } from "../atoms/atoms.js";
import { register } from "../registry/component-registry.js";

export function mountUploader(host, cfg) {
  const fileInput = el("input", { type: "file", accept: cfg.accept ?? ".csv,.tsv,.txt" });
  const label = el("div", {}, cfg.label ?? "Drop a CSV here, or click to choose");
  const zone = el(
    "div",
    { class: "rp-uploader", role: "button", tabindex: "0" },
    label,
    cfg.hint ? el("div", { class: "rp-uploader-hint" }, cfg.hint) : null,
    fileInput
  );

  function pick(file) {
    if (file) cfg.onFile?.(file);
  }
  zone.addEventListener("click", () => fileInput.click());
  zone.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") fileInput.click();
  });
  fileInput.addEventListener("change", () => pick(fileInput.files?.[0]));
  zone.addEventListener("dragover", (e) => {
    e.preventDefault();
    zone.classList.add("is-over");
  });
  zone.addEventListener("dragleave", () => zone.classList.remove("is-over"));
  zone.addEventListener("drop", (e) => {
    e.preventDefault();
    zone.classList.remove("is-over");
    pick(e.dataTransfer?.files?.[0]);
  });

  host.append(zone);
  return {
    el: zone,
    busy(on) {
      zone.classList.toggle("is-busy", !!on);
      label.replaceChildren(on ? spinner() : document.createTextNode(cfg.label ?? "Drop a CSV here, or click to choose"));
    },
    update() {},
    destroy: () => zone.remove(),
  };
}

register("uploader", mountUploader);
