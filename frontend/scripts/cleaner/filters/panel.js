// Filter panel — inline tree editor.
//
// One tool, every scenario. The panel renders a `FilterNode` tree
// directly in the left sidebar (no modal). Leaves use type-aware
// inputs:
//   • String columns → op selector + value input + datalist (eq only)
//   • Numeric columns → number inputs (between renders min/max)
//   • Date columns → <input type="date">
//   • is_null / not_null → no value input
//
// Groups can nest, with an AND/OR pill. The cell-click "quick filter"
// in the redtable appends to the root AND group when one is active.
//
// The panel owns its own mutable tree; commits are debounced and push
// the tree to the table via setFilters(). After every cleaner
// state-change (step applied, file opened) `update()` re-pulls the
// table's current filter so external mutations (chip-×, cell click)
// stay in sync.

import { api } from "/scripts/api.js";

const DEBOUNCE_MS = 300;

const STRING_OPS = [
  ["contains",     "contains"],
  ["not_contains", "doesn't contain"],
  ["eq",           "equals"],
  ["neq",          "≠"],
  ["starts_with",  "starts with"],
  ["ends_with",    "ends with"],
];
const NUMERIC_OPS = [
  ["eq",      "="],
  ["neq",     "≠"],
  ["gt",      ">"],
  ["gte",     "≥"],
  ["lt",      "<"],
  ["lte",     "≤"],
  ["between", "between"],
];
const NULL_OPS = [
  ["is_null",  "is empty"],
  ["not_null", "is not empty"],
];

export function mount(host, opts) {
  let table   = opts.table;
  let columns = opts.columns ?? [];
  let rid     = opts.rid;
  let tree    = pullTree();
  const uniqueCache = new Map();
  let debounceTimer = null;

  host.innerHTML = `
    <aside class="rp-filters" aria-label="Filter rows">
      <header class="rp-filters__head">
        <h2>Filter rows</h2>
        <button class="rp-btn rp-btn--sm" data-clear-all>Clear</button>
      </header>
      <div class="rp-filters__body"></div>
    </aside>
  `;
  const body = host.querySelector(".rp-filters__body");

  host.querySelector("[data-clear-all]").addEventListener("click", () => {
    tree = emptyRoot();
    commit(true);
    render();
  });

  function emptyRoot() { return { op: "and", children: [] }; }

  function pullTree() {
    const cur = table?.getFilter?.();
    if (!cur) return emptyRoot();
    // Always present as a group at the top — wrap a lone leaf if needed.
    if (!Array.isArray(cur.children)) return { op: "and", children: [cur] };
    return JSON.parse(JSON.stringify(cur));   // deep clone so edits don't mutate table state
  }

  function commit(immediate) {
    if (debounceTimer) clearTimeout(debounceTimer);
    const send = () => {
      const cleaned = compact(tree);
      table?.setFilters(cleaned ?? []);
    };
    if (immediate) send();
    else debounceTimer = setTimeout(send, DEBOUNCE_MS);
  }

  function defaultLeaf() {
    const c = columns[0]?.name ?? "";
    return { col: c, op: defaultOpForDtype(getDtype(c)), value: "" };
  }
  function getDtype(name) {
    return columns.find((c) => c.name === name)?.dtype ?? "string";
  }
  function defaultOpForDtype(dt) {
    if (dt === "int" || dt === "float" || dt === "date") return "eq";
    return "contains";
  }
  function opsForDtype(dt) {
    if (dt === "int" || dt === "float" || dt === "date") return [...NUMERIC_OPS, ...NULL_OPS];
    return [...STRING_OPS, ...NULL_OPS];
  }
  function valueKindFor(dt, op) {
    if (op === "is_null" || op === "not_null") return "none";
    if (op === "between") return dt === "date" ? "date-range" : "number-range";
    if (dt === "int" || dt === "float") return "number";
    if (dt === "date") return "date";
    return "text";
  }

  // ─── Rendering ─────────────────────────────────────
  function render() {
    body.innerHTML = "";
    body.appendChild(renderGroup(tree, []));
  }

  function renderGroup(group, path) {
    const wrap = document.createElement("div");
    wrap.className = "rp-filters__group";
    if (path.length === 0) wrap.classList.add("rp-filters__group--root");
    wrap.innerHTML = `
      <header>
        <div class="rp-filters__op-toggle">
          <button class="${group.op === "and" ? "is-active" : ""}" data-op="and">AND</button>
          <button class="${group.op === "or"  ? "is-active" : ""}" data-op="or">OR</button>
        </div>
        ${path.length ? `<button class="rp-filters__rm" data-rm aria-label="Remove group">×</button>` : ""}
      </header>
      <div class="rp-filters__children"></div>
      <footer class="rp-filters__group-actions">
        <button class="rp-btn rp-btn--sm" data-add-leaf>+ Filter</button>
        <button class="rp-btn rp-btn--sm" data-add-group>+ Group</button>
      </footer>
    `;
    const kids = wrap.querySelector(".rp-filters__children");
    group.children.forEach((child, i) => {
      const childEl = Array.isArray(child.children)
        ? renderGroup(child, [...path, i])
        : renderLeaf(child, [...path, i]);
      kids.appendChild(childEl);
    });

    wrap.querySelectorAll(":scope > header [data-op]").forEach((btn) => {
      btn.addEventListener("click", () => {
        group.op = btn.dataset.op;
        render();
        commit();
      });
    });
    wrap.querySelector(":scope > header [data-rm]")?.addEventListener("click", () => {
      removeAt(path); render(); commit();
    });
    wrap.querySelector(":scope > footer [data-add-leaf]").addEventListener("click", () => {
      group.children.push(defaultLeaf());
      render();   // no commit yet — the leaf has no value
    });
    wrap.querySelector(":scope > footer [data-add-group]").addEventListener("click", () => {
      group.children.push({ op: "and", children: [defaultLeaf()] });
      render();
    });
    return wrap;
  }

  function renderLeaf(leaf, path) {
    const dt = getDtype(leaf.col);
    const ops = opsForDtype(dt);
    const valueKind = valueKindFor(dt, leaf.op);
    const safeId = (leaf.col || "_").replace(/[^a-z0-9_-]/gi, "_") + "_" + path.join("_");

    const row = document.createElement("div");
    row.className = "rp-filters__leaf";
    row.innerHTML = `
      <header>
        <select data-field="col" class="rp-filters__col-select">
          ${columns.map((c) =>
            `<option value="${esc(c.name)}"${c.name === leaf.col ? " selected" : ""}>${esc(c.name)}</option>`).join("")}
        </select>
        <button class="rp-filters__rm" data-rm aria-label="Remove">×</button>
      </header>
      <div class="rp-filters__leaf-controls">
        <select data-field="op">
          ${ops.map(([v, l]) =>
            `<option value="${v}"${v === leaf.op ? " selected" : ""}>${l}</option>`).join("")}
        </select>
        ${renderValueInput(leaf, valueKind, safeId)}
      </div>
      ${valueKind === "text" ? `<datalist id="dl-${esc(safeId)}"></datalist>` : ""}
    `;

    // Column change → reset op if no longer applicable + re-render.
    row.querySelector('[data-field="col"]').addEventListener("change", (e) => {
      leaf.col = e.target.value;
      const newOps = opsForDtype(getDtype(leaf.col));
      if (!newOps.some(([v]) => v === leaf.op)) leaf.op = defaultOpForDtype(getDtype(leaf.col));
      render();
      commit();
    });

    // Op change → adjust value shape + re-render.
    row.querySelector('[data-field="op"]').addEventListener("change", (e) => {
      leaf.op = e.target.value;
      if (leaf.op === "between") leaf.value = ["", ""];
      else if (leaf.op === "is_null" || leaf.op === "not_null") delete leaf.value;
      else if (Array.isArray(leaf.value)) leaf.value = "";
      else if (leaf.value == null) leaf.value = "";
      render();
      commit();
    });

    // Value editing (text / number / date).
    row.querySelector('[data-field="v"]')?.addEventListener("input", (e) => {
      leaf.value = e.target.value;
      commit();
    });
    row.querySelector('[data-field="v0"]')?.addEventListener("input", (e) => {
      if (!Array.isArray(leaf.value)) leaf.value = ["", ""];
      leaf.value[0] = e.target.value;
      commit();
    });
    row.querySelector('[data-field="v1"]')?.addEventListener("input", (e) => {
      if (!Array.isArray(leaf.value)) leaf.value = ["", ""];
      leaf.value[1] = e.target.value;
      commit();
    });

    // Autocomplete: fetch uniques on first focus when op = eq on a string col.
    const valInput = row.querySelector('[data-field="v"]');
    if (valueKind === "text" && leaf.op === "eq" && valInput) {
      valInput.addEventListener("focus", () => populateDatalist(leaf.col, safeId), { once: true });
    }

    // Remove.
    row.querySelector("[data-rm]").addEventListener("click", () => {
      removeAt(path); render(); commit();
    });

    return row;
  }

  function renderValueInput(leaf, kind, safeId) {
    if (kind === "none") return `<span class="rp-muted rp-filters__no-value">—</span>`;
    if (kind === "text") {
      return `<input class="rp-tools__input" type="search" data-field="v"
                     list="dl-${esc(safeId)}" value="${esc(leaf.value ?? "")}" placeholder="value" />`;
    }
    if (kind === "number") {
      return `<input class="rp-tools__input" type="number" data-field="v"
                     value="${esc(leaf.value ?? "")}" placeholder="value" />`;
    }
    if (kind === "date") {
      return `<input class="rp-tools__input" type="date"   data-field="v"
                     value="${esc(leaf.value ?? "")}" />`;
    }
    if (kind === "number-range") {
      return `
        <div class="rp-filters__range">
          <input class="rp-tools__input" type="number" data-field="v0" value="${esc(arrAt(leaf.value, 0))}" placeholder="min" />
          <input class="rp-tools__input" type="number" data-field="v1" value="${esc(arrAt(leaf.value, 1))}" placeholder="max" />
        </div>`;
    }
    if (kind === "date-range") {
      return `
        <div class="rp-filters__range">
          <input class="rp-tools__input" type="date" data-field="v0" value="${esc(arrAt(leaf.value, 0))}" />
          <input class="rp-tools__input" type="date" data-field="v1" value="${esc(arrAt(leaf.value, 1))}" />
        </div>`;
    }
    return "";
  }

  async function populateDatalist(col, safeId) {
    const dl = body.querySelector(`#dl-${cssId(safeId)}`);
    if (!dl || dl.dataset.loaded) return;
    let key = `${rid}::${col}`;
    let values = uniqueCache.get(key);
    if (!values) {
      try {
        const res = await api.get(`/files/${encodeURIComponent(rid)}/uniques?col=${encodeURIComponent(col)}&limit=200`);
        values = res.values ?? [];
        uniqueCache.set(key, values);
      } catch { values = []; }
    }
    dl.innerHTML = values.map((v) => `<option value="${esc(v)}"></option>`).join("");
    dl.dataset.loaded = "1";
  }

  function removeAt(path) {
    if (!path.length) return;
    let parent = tree;
    for (let i = 0; i < path.length - 1; i++) parent = parent.children[path[i]];
    parent.children.splice(path[path.length - 1], 1);
  }

  return {
    update(ctx) {
      const newRid = ctx.rid ?? rid;
      // File switch → discard everything.
      if (newRid !== rid) {
        rid     = newRid;
        uniqueCache.clear();
        columns = ctx.columns ?? columns;
        table   = ctx.table   ?? table;
        tree    = pullTree();
        render();
        return;
      }
      columns = ctx.columns ?? columns;
      table   = ctx.table   ?? table;
      // Re-pull only when the table state has drifted from ours (cell-
      // click, chip-×, rename-step). Same shape → keep the local tree
      // so a half-typed leaf doesn't lose focus when an unrelated
      // refresh fires.
      const ours   = compact(JSON.parse(JSON.stringify(tree)));
      const theirs = table?.getFilter?.() ?? null;
      if (JSON.stringify(ours) !== JSON.stringify(theirs)) {
        tree = pullTree();
        render();
      }
    },
  };
}

// Strip leaves with missing values + collapse empty groups so the wire
// payload is minimal and the server isn't asked to evaluate degenerate
// branches.
function compact(node) {
  if (Array.isArray(node.children)) {
    const kids = node.children.map(compact).filter(Boolean);
    return kids.length ? { op: node.op, children: kids } : null;
  }
  if (!node.col || !node.op) return null;
  const needsValue = !(node.op === "is_null" || node.op === "not_null");
  if (needsValue) {
    if (node.op === "between") {
      if (!Array.isArray(node.value) || node.value[0] === "" || node.value[0] == null
          || node.value[1] === "" || node.value[1] == null) return null;
      return { col: node.col, op: node.op, value: node.value };
    }
    if (node.value === "" || node.value == null) return null;
    return { col: node.col, op: node.op, value: node.value };
  }
  return { col: node.col, op: node.op };
}

function cssId(s) { return s.replace(/[^a-z0-9_-]/gi, "_"); }
function arrAt(v, i) { return Array.isArray(v) ? (v[i] ?? "") : ""; }
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;" }[c]));
}
