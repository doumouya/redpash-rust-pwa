// Modal helper — renders the redpash-components library glass modal
// (`.rp-modal--glass` shell + `.modal` panel, from auth-modals.css) so
// it matches the landing page's login / contact modals. Kept as a
// native <dialog> for free ESC / focus-trap / top-layer: the <dialog>
// IS the `.rp-modal--glass` overlay, the inner div IS the `.modal`
// panel. The <dialog> UA box is neutralised by `dialog.rp-modal--glass`
// rules in styles/components/modal.css.
//
// The auth-specific brand header (.rp-modal-brand wordmark) is
// deliberately omitted — these are utility modals, not auth screens.

export function openModal({ title, body, actions = [], onClose }) {
  const dlg = document.createElement("dialog");
  dlg.className = "rp-modal--glass";          // overlay / backdrop shell
  dlg.setAttribute("aria-modal", "true");

  const panel = document.createElement("div");
  panel.className = "modal";                  // glass panel
  panel.innerHTML =
    `<button class="modal-close" aria-label="Close" data-close>`
    + `<i class="bi bi-x-lg bi-sm"></i></button>`
    + (title ? `<div class="modal-title">${title}</div>` : "");

  // Body — a Node is appended as-is; a string is set as innerHTML on a
  // plain content div.
  if (body instanceof Node) {
    panel.appendChild(body);
  } else if (body != null) {
    const content = document.createElement("div");
    content.innerHTML = body;
    panel.appendChild(content);
  }

  // Action buttons — library `.btn` classes, right-aligned footer row.
  if (actions.length) {
    const actEl = document.createElement("div");
    actEl.className = "modal-actions";
    for (const a of actions) {
      const btn = document.createElement("button");
      btn.className = `btn btn-${a.variant ?? "ghost"}`;
      btn.textContent = a.label;
      btn.addEventListener("click", () => a.onClick?.({ close }));
      actEl.appendChild(btn);
    }
    panel.appendChild(actEl);
  }

  dlg.appendChild(panel);

  function close(result) {
    dlg.close();
    dlg.remove();
    onClose?.(result);
  }

  dlg.addEventListener("click", (e) => {
    // The × button (or its icon).
    if (e.target.closest("[data-close]")) { close(); return; }
    // Backdrop click — the click lands on the <dialog> overlay itself,
    // not the inner `.modal` panel.
    if (e.target === dlg) close();
  });
  dlg.addEventListener("cancel", (e) => { e.preventDefault(); close(); });

  document.body.appendChild(dlg);
  dlg.showModal();
  return { close };
}
