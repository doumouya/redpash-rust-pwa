// ─────────────────────── Redtable ───────────────────────
//
// A paged, sortable, filterable table bound to /api/files/:rid/page.
// It NEVER loads more than `state.size` rows in memory — the backend's
// Polars cache does the heavy lifting.
//
//   const table = mount(host, { rid, columns });
//   table.refresh();
//   table.setPage(3);
//   table.setSort("name", "asc");
//   table.setSearch("foo");
//   table.setFilters([{ col, op, value }]);
//   table.getFilters();
//   table.setVisibleCols(["a", "b"]);
//   table.destroy();
//
// State (read-only externally):
//   columns       array from /api/files/:rid (server-truth, all cols)
//   visibleCols   array of column names to render, in display order
//   size          page size (10/25/50/100/250)
//   sort/dir      column + direction
//   q             debounced global search string
//   filters       structured FilterSpec array (see shared::filter)

import { api } from "/scripts/api.js";

const VIEW_KEY = (rid) => `redpash.view.${rid}`;

// Last option's value is the "All rows" sentinel — the backend clamps
// it to its own ceiling (50k) so the browser doesn't choke.
const PAGE_SIZES = [
  { value: 10,      label: "10" },
  { value: 25,      label: "25" },
  { value: 50,      label: "50" },
  { value: 100,     label: "100" },
  { value: 250,     label: "250" },
  { value: 1000,    label: "1000" },
  { value: 1000000, label: "All" },
];

export function mount(host, opts) {
  const state = {
    rid:         opts.rid,
    columns:     opts.columns ?? [],
    visibleCols: (opts.columns ?? []).map((c) => c.name),
    page:        1,
    size:        opts.size ?? 25,
    // Multi-key sort. Array of `{col, dir: "asc"|"desc"}`, primary
    // first. No cap — Salesforce stops at 5; we don't.
    sortList:    [],
    q:           "",
    filters:     [],            // simple mode: array of leaves
    advanced:    null,          // FilterGroup tree; null when simple
    selectMode:  false,
    /// Absolute row indices selected for bulk delete. Indices come from
    /// the server (see Page.row_indices) so they remain correct even
    /// when filter / sort / search are active.
    selected:    new Set(),
    rowIndices:  [],            // current page's row indices (server-provided)
    rows:        [],
    total:       0,
    pages:       1,
    ms:          0,
    loading:     false,
    showRowNums: false,
    // Offset of the current page in the underlying view — used so row
    // numbers are global, not page-local.
    offset:      0,
  };

  host.innerHTML = `
    <div class="rp-redtable">
      <header class="rp-redtable__bar">
        <input class="rp-redtable__search" type="search" placeholder="Search rows…" />
        <div class="rp-redtable__filters" aria-label="Active filters"></div>
        <div class="rp-redtable__toolbar">
          <button class="rp-btn rp-btn--sm rp-btn--danger" data-delete hidden></button>
          <button class="rp-btn rp-btn--sm" data-refresh title="Refresh page">↻</button>
          <label class="rp-redtable__toggle" title="Select rows">
            <input type="checkbox" data-selectmode /> <span>☑</span>
          </label>
          <label class="rp-redtable__toggle" title="Show row numbers">
            <input type="checkbox" data-rownums /> <span>#</span>
          </label>
          <button class="rp-btn rp-btn--sm" data-cols-toggle>Columns ▾</button>
          <label class="rp-redtable__size">
            <span class="rp-muted">Rows</span>
            <select class="rp-tools__input"></select>
          </label>
        </div>
        <div class="rp-redtable__popover" data-cols-popover hidden></div>
      </header>
      <div class="rp-redtable__scroll">
        <table class="rp-redtable__table">
          <thead></thead>
          <tbody></tbody>
        </table>
      </div>
      <footer class="rp-redtable__footer">
        <button class="rp-btn rp-btn--sm" data-act="first">«</button>
        <button class="rp-btn rp-btn--sm" data-act="prev">‹</button>
        <span class="rp-redtable__paging"></span>
        <button class="rp-btn rp-btn--sm" data-act="next">›</button>
        <button class="rp-btn rp-btn--sm" data-act="last">»</button>
        <span class="rp-redtable__stats"></span>
      </footer>
    </div>
  `;
  const root      = host.firstElementChild;
  const thead     = root.querySelector("thead");
  const tbody     = root.querySelector("tbody");
  const paging    = root.querySelector(".rp-redtable__paging");
  const stats     = root.querySelector(".rp-redtable__stats");
  const search    = root.querySelector(".rp-redtable__search");
  const filtersEl = root.querySelector(".rp-redtable__filters");
  const colsBtn   = root.querySelector("[data-cols-toggle]");
  const colsPop   = root.querySelector("[data-cols-popover]");
  const sizeSel   = root.querySelector(".rp-redtable__size select");

  const rowNumsToggle  = root.querySelector('[data-rownums]');
  const selectToggle   = root.querySelector('[data-selectmode]');
  const refreshBtn     = root.querySelector('[data-refresh]');
  const deleteBtn      = root.querySelector('[data-delete]');

  // Hydrate persisted view (column order/visibility, page size, row nums).
  // localStorage is keyed by RID so each file remembers independently.
  // Stored cols are filtered against the live set; new server cols
  // append at the end.
  try {
    const raw = localStorage.getItem(VIEW_KEY(state.rid));
    if (raw) {
      const saved = JSON.parse(raw);
      if (Array.isArray(saved.visibleCols)) {
        const allowed = new Set(state.visibleCols);
        const filtered = saved.visibleCols.filter((n) => allowed.has(n));
        for (const n of state.visibleCols) {
          if (!filtered.includes(n)) filtered.push(n);
        }
        state.visibleCols = filtered;
      }
      if (typeof saved.size === "number" && PAGE_SIZES.some((p) => p.value === saved.size)) {
        state.size = saved.size;
      }
      if (typeof saved.showRowNums === "boolean") state.showRowNums = saved.showRowNums;
      // Restore the persisted filter tree. Leaves whose columns no
      // longer exist (e.g. a step dropped them while this session was
      // closed) are pruned so the table doesn't 400 on its first refresh.
      if (saved.filter && saved.filter.op && Array.isArray(saved.filter.children)) {
        const allowed = new Set(state.columns.map((c) => c.name));
        const pruned  = pruneTree(saved.filter, allowed);
        if (pruned) state.advanced = pruned;
      }
      if (Array.isArray(saved.sortList)) {
        const allowed = new Set(state.columns.map((c) => c.name));
        state.sortList = saved.sortList
          .filter((s) => s && typeof s.col === "string" && allowed.has(s.col));
      }
    }
  } catch {}
  if (state.showRowNums) rowNumsToggle.checked = true;

  sizeSel.innerHTML = PAGE_SIZES.map((p) =>
    `<option value="${p.value}"${p.value === state.size ? " selected" : ""}>${p.label}</option>`
  ).join("");

  // ─── Render ─────────────────────────────────────────
  function renderHeader() {
    const selCell = state.selectMode
      ? `<th class="rp-redtable__select"><input type="checkbox" data-select-all /></th>` : "";
    const numCell = state.showRowNums
      ? `<th class="rp-redtable__rownum" aria-label="Row number">#</th>` : "";
    const cells = state.visibleCols.map((name) => {
      const c = state.columns.find((col) => col.name === name);
      if (!c) return "";
      const sortIdx = state.sortList.findIndex((s) => s.col === name);
      let badge = "";
      if (sortIdx >= 0) {
        const dir = state.sortList[sortIdx].dir === "desc" ? "▾" : "▴";
        const ord = state.sortList.length > 1 ? ` <small>${sortIdx + 1}</small>` : "";
        badge = ` ${dir}${ord}`;
      }
      return `<th data-col="${esc(name)}" title="${esc(c.dtype)}">
                <span>${esc(name)}</span>${badge}
                <small>${esc(c.dtype)}</small>
                <button class="rp-redtable__col-x" data-drop title="Drop column" aria-label="Drop column ${esc(name)}">×</button>
              </th>`;
    }).join("");
    thead.innerHTML = `<tr>${selCell}${numCell}${cells}</tr>`;
    syncSelectAll();
  }

  function renderBody() {
    let extraCols = (state.showRowNums ? 1 : 0) + (state.selectMode ? 1 : 0);
    const colspan = Math.max(1, state.visibleCols.length) + extraCols;
    if (state.loading) {
      tbody.innerHTML = `<tr><td class="rp-muted" colspan="${colspan}">Loading…</td></tr>`;
      return;
    }
    if (!state.rows.length) {
      tbody.innerHTML = `<tr><td class="rp-muted" colspan="${colspan}">No rows match.</td></tr>`;
      return;
    }
    tbody.innerHTML = state.rows.map((row, i) => {
      const absIdx  = state.rowIndices[i] ?? (state.offset + i);
      const selCell = state.selectMode
        ? `<td class="rp-redtable__select"><input type="checkbox" data-row-idx="${absIdx}" ${state.selected.has(absIdx) ? "checked" : ""} /></td>` : "";
      const numCell = state.showRowNums
        ? `<td class="rp-redtable__rownum">${(absIdx + 1).toLocaleString()}</td>` : "";
      return `<tr>${selCell}${numCell}${row.map((cell) =>
        cell === null
          ? `<td class="rp-redtable__null">∅</td>`
          : `<td>${esc(cell)}</td>`
      ).join("")}</tr>`;
    }).join("");
  }

  function syncSelectAll() {
    const allCb = thead.querySelector('[data-select-all]');
    if (!allCb) return;
    const visibleIdxs = state.rowIndices ?? [];
    if (!visibleIdxs.length) { allCb.checked = false; allCb.indeterminate = false; return; }
    const allChecked = visibleIdxs.every((i) => state.selected.has(i));
    const someChecked = visibleIdxs.some((i) => state.selected.has(i));
    allCb.checked = allChecked;
    allCb.indeterminate = !allChecked && someChecked;
  }

  function renderDeleteBtn() {
    const n = state.selected.size;
    deleteBtn.hidden = n === 0;
    if (n > 0) deleteBtn.textContent = `Delete ${n.toLocaleString()}`;
  }

  function renderFilters() {
    if (state.advanced) {
      const count = countLeaves(state.advanced);
      filtersEl.innerHTML = `
        <span class="rp-chip rp-chip--advanced">
          Advanced filter · ${count} condition${count === 1 ? "" : "s"}
          <button data-clear-adv aria-label="Clear advanced filter">×</button>
        </span>`;
      return;
    }
    const chips = state.filters.map((f, i) => {
      const label = (f.op === "is_null" || f.op === "not_null")
        ? `${esc(f.col)} ${labelOp(f.op)}`
        : `${esc(f.col)} ${labelOp(f.op)} ${esc(formatValue(f.value))}`;
      return `<span class="rp-chip">${label}<button data-i="${i}" aria-label="Remove">×</button></span>`;
    });
    if (state.filters.length) {
      chips.push(`<button class="rp-chip rp-chip--clear" data-clear>Clear all</button>`);
    }
    filtersEl.innerHTML = chips.join("");
  }

  function countLeaves(node) {
    if (!node) return 0;
    if (Array.isArray(node.children)) {
      return node.children.reduce((n, c) => n + countLeaves(c), 0);
    }
    return 1;   // leaf
  }
  function formatValue(v) {
    if (Array.isArray(v)) return `${v[0]} – ${v[1]}`;
    return String(v ?? "");
  }

  function renderFooter() {
    paging.textContent = `Page ${state.page} of ${state.pages}`;
    stats.textContent  = `${state.total.toLocaleString()} rows · ${state.ms} ms`;
    root.querySelector('[data-act="first"]').disabled = state.page <= 1;
    root.querySelector('[data-act="prev"]').disabled  = state.page <= 1;
    root.querySelector('[data-act="next"]').disabled  = state.page >= state.pages;
    root.querySelector('[data-act="last"]').disabled  = state.page >= state.pages;
  }

  function renderColsPopover() {
    const rows = state.columns.map((c) => {
      const idx = state.visibleCols.indexOf(c.name);
      const visible = idx >= 0;
      return `
        <li data-col="${esc(c.name)}">
          <label><input type="checkbox" ${visible ? "checked" : ""} /> ${esc(c.name)}</label>
          <span class="rp-redtable__pop-order">
            <button data-move="up"   ${visible && idx > 0 ? "" : "disabled"} aria-label="Move up">↑</button>
            <button data-move="down" ${visible && idx >= 0 && idx < state.visibleCols.length - 1 ? "" : "disabled"} aria-label="Move down">↓</button>
          </span>
        </li>`;
    }).join("");
    colsPop.innerHTML = `
      <ul class="rp-redtable__pop-list">${rows}</ul>
      <footer class="rp-redtable__pop-foot">
        <button class="rp-btn rp-btn--sm" data-cols-reset>Reset</button>
      </footer>
    `;
  }

  // ─── Refresh ────────────────────────────────────────
  async function refresh() {
    state.loading = true;
    renderBody();
    const params = new URLSearchParams();
    params.set("page", state.page);
    params.set("size", state.size);
    if (state.sortList.length) params.set("sorts", JSON.stringify(state.sortList));
    if (state.q)    { params.set("q", state.q); }
    if (state.advanced)            params.set("filters", JSON.stringify(state.advanced));
    else if (state.filters.length) params.set("filters", JSON.stringify(state.filters));
    // Only send `cols` when visibility/order diverges from the server truth.
    const serverOrder = state.columns.map((c) => c.name);
    const sameAsServer = state.visibleCols.length === serverOrder.length
      && state.visibleCols.every((n, i) => n === serverOrder[i]);
    if (!sameAsServer) params.set("cols", state.visibleCols.join(","));
    try {
      const data = await api.get(`/files/${encodeURIComponent(state.rid)}/page?${params}`);
      state.rows       = data.rows ?? [];
      state.total      = data.total ?? 0;
      state.pages      = Math.max(1, data.pages ?? 1);
      state.ms         = data.ms ?? 0;
      state.rowIndices = data.row_indices ?? [];
      // Use the server's reported size (it clamps the "All" sentinel)
      // so row-number offsets stay correct on multi-page large frames.
      state.offset = (state.page - 1) * (data.size ?? state.size);
    } catch (err) {
      console.error("[redtable] page fetch failed", err);
      state.rows = []; state.total = 0; state.pages = 1;
    }
    state.loading = false;
    renderHeader();
    renderBody();
    renderFooter();
    persistView();
  }

  function persistView() {
    try {
      // Active filter as a unified tree (panel uses this shape too).
      const filter = state.advanced
        ?? (state.filters.length ? { op: "and", children: state.filters } : null);
      localStorage.setItem(VIEW_KEY(state.rid), JSON.stringify({
        visibleCols: state.visibleCols,
        size:        state.size,
        showRowNums: state.showRowNums,
        filter,
        sortList:    state.sortList,
      }));
    } catch {}
  }

  // ─── Wiring ─────────────────────────────────────────
  thead.addEventListener("click", (e) => {
    const dropBtn = e.target.closest("[data-drop]");
    if (dropBtn) {
      e.stopPropagation();
      const col = dropBtn.parentElement.dataset.col;
      opts.onDropColumn?.(col);
      return;
    }
    const th = e.target.closest("th[data-col]");
    if (!th) return;
    const col = th.dataset.col;
    const list = state.sortList.slice();
    const idx  = list.findIndex((s) => s.col === col);

    // shift-click = chain another key (no cap)
    // plain click  = replace the chain with just this key, cycle dir
    if (e.shiftKey) {
      if (idx === -1) {
        list.push({ col, dir: "asc" });
      } else if (list[idx].dir === "asc") {
        list[idx] = { col, dir: "desc" };
      } else {
        list.splice(idx, 1);
      }
    } else if (idx === -1 || list.length > 1) {
      list.splice(0, list.length, { col, dir: "asc" });
    } else if (list[idx].dir === "asc") {
      list[idx] = { col, dir: "desc" };
    } else {
      list.length = 0;
    }
    state.sortList = list;
    state.page = 1;
    refresh();
  });

  // Cell click → add an eq leaf to the simple-mode filter list. When an
  // advanced tree is active we skip; the user opens the modal to edit.
  // (Escape hatches: modifier keys, drag, or active text selection.)
  let _downX = 0, _downY = 0;
  tbody.addEventListener("mousedown", (e) => { _downX = e.clientX; _downY = e.clientY; });
  tbody.addEventListener("click", (e) => {
    if (e.altKey || e.shiftKey || e.ctrlKey || e.metaKey) return;
    if (Math.abs(e.clientX - _downX) > 3 || Math.abs(e.clientY - _downY) > 3) return;
    const selObj = window.getSelection();
    if (selObj && selObj.toString().length > 0) return;
    // Clicks on interactive elements (checkboxes, buttons) belong to
    // that element — never treat them as a "filter by this cell".
    if (e.target.matches("input, button, select, label")) return;
    const td = e.target.closest("td");
    if (!td || !td.parentElement) return;
    if (td.classList.contains("rp-redtable__rownum")) return;
    if (td.classList.contains("rp-redtable__select")) return;
    const rawIdx = Array.from(td.parentElement.children).indexOf(td);
    // Skip every leading helper column (select, then row-num).
    const extras = (state.selectMode ? 1 : 0) + (state.showRowNums ? 1 : 0);
    const idx = rawIdx - extras;
    const col = state.visibleCols[idx];
    if (!col) return;
    const isNull = td.classList.contains("rp-redtable__null");
    const leaf = isNull ? { col, op: "is_null" } : { col, op: "eq", value: td.textContent };

    if (state.advanced) {
      // Only append into a top-level AND. Otherwise we'd silently change
      // the semantics of an OR tree the user built explicitly.
      if (state.advanced.op !== "and") return;
      const exists = state.advanced.children.some((c) =>
        !Array.isArray(c.children) && c.col === leaf.col && c.op === leaf.op &&
        (c.value ?? null) === (leaf.value ?? null));
      if (exists) return;
      state.advanced = { ...state.advanced, children: [...state.advanced.children, leaf] };
    } else {
      const exists = state.filters.some((f) =>
        f.col === leaf.col && f.op === leaf.op &&
        (f.value ?? null) === (leaf.value ?? null));
      if (exists) return;
      state.filters.push(leaf);
    }
    state.page = 1;
    renderFilters(); refresh();
    opts.onFiltersChange?.();
  });

  filtersEl.addEventListener("click", (e) => {
    if (e.target.matches("[data-clear-adv]")) {
      state.advanced = null; state.page = 1;
      renderFilters(); refresh();
      opts.onFiltersChange?.(state.filters);
      return;
    }
    if (e.target.matches("[data-clear]")) {
      state.filters = []; state.page = 1;
      renderFilters(); refresh();
      opts.onFiltersChange?.(state.filters);
      return;
    }
    const btn = e.target.closest("[data-i]");
    if (btn) {
      state.filters.splice(Number(btn.dataset.i), 1);
      state.page = 1;
      renderFilters(); refresh();
      opts.onFiltersChange?.(state.filters);
    }
  });

  let searchDebounce;
  search.addEventListener("input", (e) => {
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => {
      state.q = e.target.value;
      state.page = 1;
      refresh();
    }, 250);
  });

  root.querySelector(".rp-redtable__footer").addEventListener("click", (e) => {
    const act = e.target.closest("[data-act]")?.dataset.act;
    if (!act) return;
    if (act === "first") state.page = 1;
    if (act === "prev")  state.page = Math.max(1, state.page - 1);
    if (act === "next")  state.page = Math.min(state.pages, state.page + 1);
    if (act === "last")  state.page = state.pages;
    refresh();
  });

  sizeSel.addEventListener("change", () => {
    state.size = Number(sizeSel.value);
    state.page = 1;
    refresh();
  });

  rowNumsToggle.addEventListener("change", () => {
    state.showRowNums = rowNumsToggle.checked;
    renderHeader();
    renderBody();
  });

  selectToggle.addEventListener("change", () => {
    state.selectMode = selectToggle.checked;
    if (!state.selectMode) state.selected.clear();
    renderHeader();
    renderBody();
    renderDeleteBtn();
  });

  refreshBtn.addEventListener("click", () => refresh());

  deleteBtn.addEventListener("click", () => {
    if (!state.selected.size) return;
    const indices = Array.from(state.selected).sort((a, b) => a - b);
    state.selected.clear();
    renderDeleteBtn();
    renderBody();      // immediate: clear checkbox state before the round-trip
    opts.onDeleteRows?.(indices);
  });

  // Select-mode body interactions: row checkboxes + select-all header.
  tbody.addEventListener("change", (e) => {
    const cb = e.target.closest('input[type="checkbox"][data-row-idx]');
    if (!cb) return;
    const idx = Number(cb.dataset.rowIdx);
    if (cb.checked) state.selected.add(idx);
    else            state.selected.delete(idx);
    syncSelectAll();
    renderDeleteBtn();
  });

  thead.addEventListener("change", (e) => {
    const cb = e.target.closest('input[type="checkbox"][data-select-all]');
    if (!cb) return;
    const visibleIdxs = state.rowIndices ?? [];
    if (cb.checked) visibleIdxs.forEach((i) => state.selected.add(i));
    else            visibleIdxs.forEach((i) => state.selected.delete(i));
    renderBody();
    renderDeleteBtn();
  });

  // Columns popover open/close + interactions.
  function toggleCols(open) {
    const next = open ?? colsPop.hidden;
    colsPop.hidden = !next;
    colsBtn.setAttribute("aria-expanded", next ? "true" : "false");
    if (next) renderColsPopover();
  }
  colsBtn.addEventListener("click", (e) => { e.stopPropagation(); toggleCols(); });
  document.addEventListener("click", (e) => {
    if (colsPop.hidden) return;
    if (!root.contains(e.target)) toggleCols(false);
  });
  colsPop.addEventListener("click", (e) => {
    e.stopPropagation();
    const li = e.target.closest("li[data-col]");
    if (e.target.matches("[data-cols-reset]")) {
      state.visibleCols = state.columns.map((c) => c.name);
      renderColsPopover(); renderHeader(); refresh();
      return;
    }
    if (!li) return;
    const name = li.dataset.col;
    const cb = e.target.closest('input[type="checkbox"]');
    if (cb) {
      if (cb.checked && !state.visibleCols.includes(name)) state.visibleCols.push(name);
      if (!cb.checked) state.visibleCols = state.visibleCols.filter((n) => n !== name);
      renderColsPopover(); renderHeader(); refresh();
      return;
    }
    const move = e.target.closest("[data-move]");
    if (move) {
      const dir = move.dataset.move;
      const i = state.visibleCols.indexOf(name);
      if (i < 0) return;
      const j = dir === "up" ? i - 1 : i + 1;
      if (j < 0 || j >= state.visibleCols.length) return;
      [state.visibleCols[i], state.visibleCols[j]] = [state.visibleCols[j], state.visibleCols[i]];
      renderColsPopover(); renderHeader(); refresh();
    }
  });

  renderHeader();
  renderBody();
  renderFilters();
  renderFooter();
  refresh();

  return {
    refresh,
    setPage(p) { state.page = p; refresh(); },
    setSort(col, dir) {
      state.sortList = col ? [{ col, dir: dir ?? "asc" }] : [];
      refresh();
    },
    setSearch(q) { state.q = q; state.page = 1; refresh(); },
    setFilters(value) {
      if (Array.isArray(value)) {
        state.filters = value;
        state.advanced = null;
      } else if (value && typeof value === "object" && value.op && Array.isArray(value.children)) {
        // Empty trees collapse to "no filter".
        if (value.children.length === 0) {
          state.filters  = [];
          state.advanced = null;
        } else {
          state.advanced = value;
          state.filters  = [];
        }
      } else {
        state.filters = [];
        state.advanced = null;
      }
      state.page = 1;
      renderFilters(); refresh();
    },
    getFilters() { return state.filters.slice(); },
    getAdvancedFilter() { return state.advanced; },
    /// Unified view: returns a FilterNode tree representing the active
    /// filter, or null if there isn't one. The filter panel reads this.
    getFilter() {
      if (state.advanced) return state.advanced;
      if (state.filters.length) return { op: "and", children: state.filters.map((l) => ({ ...l })) };
      return null;
    },
    isAdvanced() { return !!state.advanced; },
    setVisibleCols(arr) {
      if (!Array.isArray(arr)) return;
      state.visibleCols = arr.filter((n) => state.columns.some((c) => c.name === n));
      renderHeader(); refresh();
    },
    setColumns(cols) {
      // Any step (drop_rows, undo, redo, rename, …) lands here. Clear
      // the row selection so stale indices don't haunt the next delete.
      state.selected.clear();
      renderDeleteBtn();

      const oldNames = state.columns.map((c) => c.name);
      state.columns = cols;
      const newNames = cols.map((c) => c.name);
      const allowed  = new Set(newNames);

      if (oldNames.length === newNames.length) {
        // Same column count → treat divergences as positional renames so
        // the renamed column stays where the user left it (instead of
        // being pruned + appended at the end). Covers rename_column,
        // replace_in_names, snake_case_columns.
        const renameMap = new Map();
        for (let i = 0; i < newNames.length; i++) {
          if (oldNames[i] !== newNames[i]) renameMap.set(oldNames[i], newNames[i]);
        }
        state.visibleCols = state.visibleCols
          .map((n) => renameMap.get(n) ?? n)
          .filter((n) => allowed.has(n));
      } else {
        // Add or drop → prune what was removed and append the new ones.
        state.visibleCols = [
          ...state.visibleCols.filter((n) => allowed.has(n)),
          ...newNames.filter((n) => !state.visibleCols.includes(n)),
        ];
      }

      // Migrate filters across renames; drop those referencing gone cols.
      const renameLookup = oldNames.length === newNames.length
        ? new Map(oldNames.map((o, i) => [o, newNames[i]]))
        : null;
      const migrateCol = (name) => renameLookup?.get(name) ?? name;
      state.filters = state.filters
        .map((f) => ({ ...f, col: migrateCol(f.col) }))
        .filter((f) => allowed.has(f.col));
      if (state.advanced) state.advanced = renameTree(state.advanced, renameLookup, allowed);
      // Sort chain — migrate renames + drop refs to vanished columns.
      state.sortList = state.sortList
        .map((s) => ({ ...s, col: migrateCol(s.col) }))
        .filter((s) => allowed.has(s.col));

      renderFilters();
      renderHeader();
      refresh();
    },
    destroy() { host.innerHTML = ""; },
  };
}

function labelOp(op) {
  return {
    eq: "=", neq: "≠",
    contains: "contains", not_contains: "doesn't contain",
    starts_with: "starts with", ends_with: "ends with",
    gt: ">", gte: "≥", lt: "<", lte: "≤", between: "between",
    is_null: "is empty", not_null: "is not empty",
  }[op] ?? op;
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;" }[c]));
}

// Strip leaves whose column was dropped; collapse empty groups.
function pruneTree(node, allowed) {
  if (!node) return null;
  if (Array.isArray(node.children)) {
    const kids = node.children.map((c) => pruneTree(c, allowed)).filter(Boolean);
    if (kids.length === 0) return null;
    return { op: node.op, children: kids };
  }
  return allowed.has(node.col) ? node : null;
}

// Migrate leaf column names through a rename map, then prune. `lookup`
// may be null (no rename pairs known); leaves are still pruned.
function renameTree(node, lookup, allowed) {
  if (!node) return null;
  if (Array.isArray(node.children)) {
    const kids = node.children.map((c) => renameTree(c, lookup, allowed)).filter(Boolean);
    if (kids.length === 0) return null;
    return { op: node.op, children: kids };
  }
  const next = lookup?.get(node.col) ?? node.col;
  return allowed.has(next) ? { ...node, col: next } : null;
}
