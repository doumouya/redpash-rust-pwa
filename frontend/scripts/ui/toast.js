// Minimal toast helper. Mounts into #toasts; auto-dismisses after 4s.
// Variants follow the rp-toast--{info,success,warning,error} tokens.

function push(message, variant = "info", ttl = 4000) {
  const host = document.getElementById("toasts");
  if (!host) return;
  const node = document.createElement("div");
  node.className = `rp-toast rp-toast--${variant}`;
  node.textContent = message;
  host.appendChild(node);
  requestAnimationFrame(() => node.classList.add("is-visible"));
  setTimeout(() => {
    node.classList.remove("is-visible");
    setTimeout(() => node.remove(), 200);
  }, ttl);
}

export const toast = {
  info:    (m) => push(m, "info"),
  success: (m) => push(m, "success"),
  warning: (m) => push(m, "warning"),
  error:   (m) => push(m, "error", 6000),
};
