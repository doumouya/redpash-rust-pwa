/* dashboard-grid — the Designer canvas: a cols×rows grid (default 15×10, a 3:2
   screen → square cells) where each element is placed by `{x,y,w,h}` (cell
   coords, 0-based). View mode renders the elements; editable mode adds drag-move
   + SE-resize (both snap to whole cells, clamped to the canvas) and a remove
   affordance, firing onLayoutChange after each commit. Sole owner of `.rp-dg-*`.
   Framework component: the per-cell grid placement is geometry (`.style.grid*`),
   the same measured-geometry posture as virtual-rows/menu — kept out of app code,
   which composes this and never touches `.style`.

   mountDashboardGrid(host, { cols?, rows?, elements:[{id,x,y,w,h,mount(body)→h?}],
     editable?, onLayoutChange?(layout), onRemove?(id) })
   → { el, getLayout(), addElement(e), removeElement(id), setEditable(b), update({elements}), destroy } */

import { el } from "../boot/dom.js";
import { register } from "../registry/component-registry.js";

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export function mountDashboardGrid(host, cfg = {}) {
  const cols = cfg.cols || 15;
  const rows = cfg.rows || 10;
  let editable = !!cfg.editable;
  const onLayoutChange = cfg.onLayoutChange;
  const onRemove = cfg.onRemove;

  const grid = el("div", { class: "rp-dg" });
  grid.style.setProperty("--dg-cols", String(cols));
  grid.style.setProperty("--dg-rows", String(rows));
  grid.classList.toggle("is-editable", editable);
  host.append(grid);

  // id → { e, cell, handle }  (e is the live {id,x,y,w,h,mount} record)
  const cells = new Map();

  const cellW = () => grid.clientWidth / cols;
  const cellH = () => grid.clientHeight / rows;
  const place = (cell, e) => {
    cell.style.gridColumn = `${e.x + 1} / span ${e.w}`;
    cell.style.gridRow = `${e.y + 1} / span ${e.h}`;
  };
  const commit = () => onLayoutChange?.(getLayout());

  function renderCell(e) {
    const cell = el("div", { class: "rp-dg-cell", "data-dg-id": e.id });
    place(cell, e);
    const body = el("div", { class: "rp-dg-cell-body" });
    cell.append(body);
    if (editable) {
      const bar = el("div", { class: "rp-dg-cell-bar" },
        el("span", { class: "rp-dg-grip", title: "Drag to move" }),
        el("button", {
          class: "rp-dg-del", type: "button", title: "Remove",
          onClick: () => { removeElement(e.id); onRemove?.(e.id); },
        }, "×"),
      );
      cell.append(bar, el("span", { class: "rp-dg-resize", title: "Drag to resize" }));
      wireDrag(cell, e, bar);
      wireResize(cell, e);
    }
    grid.append(cell);
    const handle = e.mount ? e.mount(body) : null;
    cells.set(e.id, { e, cell, handle });
  }

  // Drag-move: grab the bar (not the body) → translate the pointer delta into
  // whole-cell steps, clamp to the canvas, re-place live, commit on release.
  function wireDrag(cell, e, grabEl) {
    grabEl.addEventListener("pointerdown", (ev) => {
      if (ev.target.closest(".rp-dg-del")) return;
      ev.preventDefault();
      const sx = ev.clientX, sy = ev.clientY, ox = e.x, oy = e.y;
      const cw = cellW(), ch = cellH();
      const move = (m) => {
        e.x = clamp(ox + Math.round((m.clientX - sx) / cw), 0, cols - e.w);
        e.y = clamp(oy + Math.round((m.clientY - sy) / ch), 0, rows - e.h);
        place(cell, e);
      };
      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        cell.classList.remove("is-dragging");
        commit();
      };
      cell.classList.add("is-dragging");
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    });
  }

  // SE-resize: grab the corner handle → grow/shrink w/h in whole cells, min 1×1,
  // clamped so the element stays inside the canvas.
  function wireResize(cell, e) {
    const handle = cell.querySelector(".rp-dg-resize");
    handle.addEventListener("pointerdown", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const sx = ev.clientX, sy = ev.clientY, ow = e.w, oh = e.h;
      const cw = cellW(), ch = cellH();
      const move = (m) => {
        e.w = clamp(ow + Math.round((m.clientX - sx) / cw), 1, cols - e.x);
        e.h = clamp(oh + Math.round((m.clientY - sy) / ch), 1, rows - e.y);
        place(cell, e);
      };
      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        cell.classList.remove("is-resizing");
        commit();
      };
      cell.classList.add("is-resizing");
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    });
  }

  function getLayout() {
    return [...cells.values()].map(({ e }) => ({ id: e.id, x: e.x, y: e.y, w: e.w, h: e.h }));
  }

  function addElement(e) {
    const rec = { x: 0, y: 0, w: 3, h: 2, ...e };
    renderCell(rec);
    commit();
    return rec;
  }

  function removeElement(id) {
    const c = cells.get(id);
    if (!c) return;
    c.handle?.destroy?.();
    c.cell.remove();
    cells.delete(id);
    commit();
  }

  function setEditable(next) {
    editable = !!next;
    grid.classList.toggle("is-editable", editable);
    // Re-render so the edit chrome (bar/handles + listeners) appears/clears.
    const snapshot = [...cells.values()].map(({ e }) => e);
    cells.forEach(({ cell }) => cell.remove());
    cells.clear();
    snapshot.forEach(renderCell);
  }

  (cfg.elements || []).forEach((e) => renderCell({ ...e }));

  return {
    el: grid,
    getLayout,
    addElement,
    removeElement,
    setEditable,
    update: (p = {}) => {
      if (p.elements) {
        cells.forEach(({ cell, handle }) => { handle?.destroy?.(); cell.remove(); });
        cells.clear();
        p.elements.forEach((e) => renderCell({ ...e }));
      }
    },
    destroy: () => {
      cells.forEach(({ handle }) => handle?.destroy?.());
      grid.remove();
    },
  };
}

register("dashboard-grid", mountDashboardGrid);
