/* virtual-rows — internal windowing util for redtable (NOT a registered
   component). Keeps ~40 <tr> in the DOM regardless of row count; two spacer
   rows keep the scrollbar honest. The renderRow callback must be a pure
   synchronous string/element builder (the scroll hot loop).
   NOTE: inline style writes here are sanctioned measured-geometry (the
   ui-fork-audit R9 framework allowlist). */

const WINDOW = 40;
const OVERSCAN = 10;

export function createVirtualRows({ scrollHost, tbody, rowCount, rowHeight, renderRow }) {
  const topSpacer = document.createElement("tr");
  const bottomSpacer = document.createElement("tr");
  for (const sp of [topSpacer, bottomSpacer]) {
    sp.appendChild(document.createElement("td"));
    sp.firstChild.colSpan = 999;
    sp.firstChild.style.padding = "0";
    sp.firstChild.style.border = "0";
  }

  let count = rowCount;

  function paint() {
    const scrollTop = scrollHost.scrollTop;
    const first = Math.max(0, Math.floor(scrollTop / rowHeight) - OVERSCAN);
    const last = Math.min(count, first + WINDOW + OVERSCAN * 2);

    topSpacer.firstChild.style.height = `${first * rowHeight}px`;
    bottomSpacer.firstChild.style.height = `${Math.max(0, (count - last) * rowHeight)}px`;

    const frag = document.createDocumentFragment();
    frag.append(topSpacer);
    for (let i = first; i < last; i++) frag.append(renderRow(i));
    frag.append(bottomSpacer);
    tbody.replaceChildren(frag);
  }

  let raf = 0;
  function onScroll() {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      paint();
    });
  }
  scrollHost.addEventListener("scroll", onScroll, { passive: true });
  paint();

  return {
    repaint: paint,
    setCount(n) {
      count = n;
      paint();
    },
    destroy() {
      scrollHost.removeEventListener("scroll", onScroll);
      if (raf) cancelAnimationFrame(raf);
    },
  };
}
