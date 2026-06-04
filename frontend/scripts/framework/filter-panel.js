/* Purpose: Filter-panel framework component — the FilterNode-AST builder that mounts into the rp-panel shell.
   Doc: docs/internal/code/frontend/scripts/framework/filter-panel.md */
// ── Filter-panel (framework component, CAS_37B2E1BF) ────────────────────────
// The FILTER-AST builder: a stack of group cards (each an AND/OR combo + a list
// of predicate rows + an Add-condition button), joined by inter-group separator
// pills, that reads out a FilterNode tree on Apply. It COMPOSES the rp-panel
// shell (mountPanel, variant "filter") for the head (Filter|Report pill tabs) +
// body + foot + close, then mounts its OWN group-builder content INTO that body
// and its Clear/Apply buttons INTO the foot. Generic + data-driven —
// mountFilterPanel(host, config) emits the whole rp-filter structure from a
// config of columns + handlers; the page supplies the columns and what Apply
// does ("lego brick").
//
// Composes, not duplicates:
//   - mountPanel (framework/panel.js) — the panel SHELL (head/tabs/body/foot/
//     close). The filter content mounts into the returned body + foot.
//   - rp-seg / rp-seg--combo (framework/seg.css) — the per-group AND/OR combo.
//   - rp-btn-icon (+ --glass/--block/--accent) (atoms.css) — Add-group,
//     Add-condition, Clear, Apply buttons (legacy .rt-btn = rp-btn-icon verbatim;
//     the foot's Apply stretch is panel.css's .rp-panel-foot .rp-btn-icon--accent).
//   - rp-input shape — the value <input> uses the .rp-pred input base (filter-
//     panel.css), which mirrors the rp-input atom for the predicate row.
//
// State is OWNED PER MOUNT (not module singletons like the legacy workspace.js
// IIFE): groupCombo (top-level inter-group AND/OR), the columns array, and the
// committed ast snapshot all live on the closure so two filter panels can
// coexist. The uncommitted builder state lives ENTIRELY in the body DOM until
// Apply snapshots it via getAst() — the Apply/Clear lifecycle is preserved
// exactly, and a re-render never wipes #groupList out from under an in-progress
// condition.
//
// VALUE-EDITOR cutover note: the in/not_in chip-picker (rp-chip-picker*) and the
// single-value autocomplete dropdown (rp-ac*) are emitted here as BUILD-READY
// markup + slots. Their live BEHAVIOR is autocomplete.js's mountChipPicker /
// attachAutocomplete, which today emit the rt-* markup. At cutover, point those
// two primitives at the rp- names (or pass them in via config.valueEditors) and
// the slots light up; until then the chip-picker reads its selected values
// straight from the DOM chips (readChips), so getAst() is correct without the
// live primitive. The slot markup + the data-value chip contract match what
// mountChipPicker expects, so the rewire is a name swap.
"use strict";

import { register } from "/scripts/framework/component-registry.js";
import { mountPanel } from "/scripts/framework/panel.js";
import { esc } from "/scripts/dom.js";

// ── op catalog — single source of truth (ported from workspace.js OP_SPECS) ──
// [wire-op, label, group, applicable-dtypes, value-kind]. opsForColumn projects
// this through a column's dtype; a column config MAY override with its own `ops`
// (a list of wire-op strings) to constrain the menu.
const STR_DTYPES  = ["string", "empty"];
const NUM_DTYPES  = ["int", "float"];
const DATE_DTYPES = ["date"];
const ALL_DTYPES  = ["string", "int", "float", "date", "bool", "empty"];
const ORDERED     = ["int", "float", "date"];   // ops that need an ordering
const OP_SPECS = [
  ["eq",           "is",                "Equality",   ALL_DTYPES,  "text"],
  ["neq",          "is not",            "Equality",   ALL_DTYPES,  "text"],
  ["contains",     "contains",          "Text",       STR_DTYPES,  "text"],
  ["not_contains", "does not contain",  "Text",       STR_DTYPES,  "text"],
  ["starts_with",  "starts with",       "Text",       STR_DTYPES,  "text"],
  ["ends_with",    "ends with",         "Text",       STR_DTYPES,  "text"],
  ["gt",           "> greater than",    "Comparison", NUM_DTYPES,  "number"],
  ["gte",          "≥ at least",   "Comparison", NUM_DTYPES,  "number"],
  ["lt",           "< less than",       "Comparison", NUM_DTYPES,  "number"],
  ["lte",          "≤ at most",    "Comparison", NUM_DTYPES,  "number"],
  ["between",      "between",           "Range",      ORDERED,     "range"],
  ["before",       "before",            "Range",      DATE_DTYPES, "date"],
  ["after",        "after",             "Range",      DATE_DTYPES, "date"],
  ["in",           "in (any of)",       "Set",        ALL_DTYPES,  "list"],
  ["not_in",       "not in",            "Set",        ALL_DTYPES,  "list"],
  ["is_null",      "is empty",          "Presence",   ALL_DTYPES,  "none"],
  ["not_null",     "is not empty",      "Presence",   ALL_DTYPES,  "none"],
];
const OP_BY_WIRE = Object.fromEntries(
  OP_SPECS.map((s) => [s[0], { label: s[1], group: s[2], dtypes: s[3], value: s[4] }]));
const NULL_OPS            = new Set(["is_null", "not_null"]);     // carry no value
const SINGLE_VALUE_AC_OPS = new Set(["eq", "neq", "contains", "not_contains", "starts_with", "ends_with"]);
const LIST_OPS            = new Set(["in", "not_in"]);

// Storage dtype with the empty-as-string promotion stats does for un-typed cols.
function colDtype(col) {
  if (!col) return "string";
  return col.dtype || "string";
}
// value-kind for an (op, column) combo — picks the right input shape: `between`
// is numeric vs date; date-typed text ops use a calendar picker.
function valueKindFor(op, col) {
  const spec = OP_BY_WIRE[op];
  if (!spec) return "text";
  if (spec.value === "range") return DATE_DTYPES.includes(colDtype(col)) ? "range-date" : "range-number";
  if (spec.value === "text" && DATE_DTYPES.includes(colDtype(col))) return "date";
  return spec.value;
}
// The ops applicable to a column — dtype-filtered, then narrowed by a column's
// explicit `ops` allow-list when present (preserves OP_SPECS order/grouping).
function opsForColumn(col) {
  const dtype = colDtype(col);
  let ops = OP_SPECS.filter((s) => s[3].includes(dtype));
  if (Array.isArray(col?.ops) && col.ops.length) {
    const allow = new Set(col.ops);
    ops = ops.filter((s) => allow.has(s[0]));
  }
  return ops;
}

// ── config shape ─────────────────────────────────────────────────────────────
//   columns : [{ key, label, dtype, ops }]
//             key   → the FilterNode leaf `col` (the backend column name)
//             label → the <option> text in the column <select>
//             dtype → "string"|"int"|"float"|"date"|"bool"|"empty" (drives ops)
//             ops   → optional wire-op allow-list narrowing the op <select>
//   onApply : (ast) => void   → fired on Apply with the FilterNode tree (or null)
//   onClear : () => void      → fired on Clear (after the builder resets)
//   initial : FilterNode|null → reserved for a future hydrate; the builder seeds
//                               one empty group when columns exist (legacy parity)
//   tabs / pills / onTab      → forwarded to mountPanel (the head pill strip);
//                               default = Filter|Report pills (Report owned by
//                               the caller's body section, like the live app)
// Returns { el, panel, body, foot, getAst(), clear(), setColumns(cols), setOpen,
//           setTab }. getAst() snapshots the live DOM builder into a FilterNode.

/** Build + wire the filter panel into `host`. `host` becomes the `.rp-panel`. */
export function mountFilterPanel(host, config = {}) {
  if (!host) return null;

  let columns    = Array.isArray(config.columns) ? config.columns.slice() : [];
  let groupCombo = "AND";   // top-level inter-group AND/OR (per-mount state)

  // ── 1. compose the panel shell (head pill-tabs + body + foot + close) ──────
  const tabs = config.tabs || [
    { id: "filter", label: "Filter", icon: "bi-funnel", active: true },
    { id: "report", label: "Report", icon: "bi-bar-chart-line" },
  ];
  const panel = mountPanel(host, {
    variant: "filter",
    tabs,
    pills:   config.pills !== false,
    foot:    true,
    onClose: config.onClose,
    onTab:   config.onTab,
  });
  const body = panel.body;
  const foot = panel.foot;

  // ── 2. mount the filter builder content INTO the panel body ────────────────
  body.innerHTML =
      '<span class="rp-label">Condition groups</span>'
    + '<div class="rp-group-list"></div>'
    + '<button class="rp-btn-icon rp-btn-icon--glass rp-btn-icon--block rp-add-group" type="button">'
    +   '<i class="bi bi-plus-lg"></i> Add group</button>';
  const groupList = body.querySelector(".rp-group-list");
  const addGroupBtn = body.querySelector(".rp-add-group");

  // ── 3. mount Clear / Apply INTO the panel foot ─────────────────────────────
  // The foot buttons compose the rp-btn-icon atom (legacy .rt-btn = rp-btn-icon
  // verbatim) + its modifiers — Clear is the bare icon-button, Apply adds
  // --accent, which the panel.css `.rp-panel-foot .rp-btn-icon--accent { flex:1 }`
  // rule stretches to fill the foot.
  foot.innerHTML =
      '<button class="rp-btn-icon rp-filter-clear" type="button">Clear</button>'
    + '<button class="rp-btn-icon rp-btn-icon--accent rp-filter-apply" type="button">'
    +   '<i class="bi bi-funnel"></i> Apply filter</button>';
  const clearBtn = foot.querySelector(".rp-filter-clear");
  const applyBtn = foot.querySelector(".rp-filter-apply");

  // ── markup builders (all dynamic content via esc()) ────────────────────────

  // Op <select> innerHTML for a column — <optgroup>s straight from OP_SPECS[2].
  function opSelectHTML(col, selected) {
    const ops = opsForColumn(col);
    const groups = {};
    ops.forEach((o) => { (groups[o[2]] = groups[o[2]] || []).push(o); });
    return Object.keys(groups).map((g) =>
      '<optgroup label="' + esc(g) + '">'
      + groups[g].map((o) =>
          '<option value="' + esc(o[0]) + '"' + (o[0] === selected ? ' selected' : '') + '>'
          + esc(o[1]) + '</option>'
        ).join("")
      + '</optgroup>'
    ).join("");
  }

  // Value-input HTML for an (op, column) pair — six shapes (none/text/number/
  // date/list/range-*). Presence ops emit a hidden input so the :has() rule in
  // filter-panel.css collapses the value row.
  function valueInputHTML(op, col) {
    const kind = valueKindFor(op, col);
    if (kind === "none") {
      return '<input class="rp-pred-val" type="hidden" />';
    }
    if (kind === "number") {
      return '<input class="rp-pred-val" type="number" step="any" placeholder="value" />';
    }
    if (kind === "date") {
      return '<input class="rp-pred-val" type="date" placeholder="YYYY-MM-DD" />';
    }
    if (kind === "list") {
      // Build-ready chip-picker scaffold (rp-chip-picker* markup + add-input
      // slot). The live mountChipPicker rewires at cutover; until then chips
      // are read straight from the DOM (readChips).
      return chipPickerHTML();
    }
    if (kind === "range-number") {
      return '<span class="rp-pred-range">'
        + '<input class="rp-pred-val rp-pred-val-a" type="number" step="any" placeholder="min" />'
        + '<span class="rp-pred-range-sep">to</span>'
        + '<input class="rp-pred-val rp-pred-val-b" type="number" step="any" placeholder="max" />'
        + '</span>';
    }
    if (kind === "range-date") {
      return '<span class="rp-pred-range">'
        + '<input class="rp-pred-val rp-pred-val-a" type="date" />'
        + '<span class="rp-pred-range-sep">to</span>'
        + '<input class="rp-pred-val rp-pred-val-b" type="date" />'
        + '</span>';
    }
    return '<input class="rp-pred-val" type="text" placeholder="value" />';
  }

  // The in/not_in chip-picker scaffold — chip-list + autocompleting add-input.
  function chipPickerHTML() {
    return '<div class="rp-chip-picker">'
      +   '<div class="rp-chip-list"></div>'
      +   '<input class="rp-chip-input rp-pred-val" type="text" placeholder="Add value…" />'
      + '</div>';
  }

  // One predicate (condition) row. firstCol/firstOp seed the row from the first
  // column + its first applicable op.
  function predRow() {
    const firstCol = columns[0];
    const ops      = opsForColumn(firstCol);
    const firstOp  = ops[0]?.[0] || "eq";
    const d = document.createElement("div");
    d.className = "rp-pred";
    d.innerHTML =
        '<select class="rp-pred-col">'
      +   columns.map((c) => '<option value="' + esc(c.key) + '">' + esc(c.label ?? c.key) + '</option>').join("")
      + '</select>'
      + '<select class="rp-pred-op">' + opSelectHTML(firstCol, firstOp) + '</select>'
      + '<span class="rp-pred-val-slot">' + valueInputHTML(firstOp, firstCol) + '</span>'
      + '<button class="rp-pred-del" type="button" title="Remove condition"><i class="bi bi-x"></i></button>';
    wireValueSlot(d);
    return d;
  }

  // Wire the value slot — emit the autocomplete-ready / chip-ready markup, and
  // (at cutover) attach the live primitive. The ctx the live primitive needs is
  // returned by the page via config.valueEditors; when absent, the slot stays
  // build-ready and getAst() reads the DOM directly.
  function wireValueSlot(pred) {
    const opSel = pred.querySelector(".rp-pred-op");
    const op = opSel?.value || "eq";
    const slot = pred.querySelector(".rp-pred-val-slot");
    if (!slot) return;
    slot._chipCtrl = null;
    const editors = config.valueEditors;   // { attachAutocomplete, mountChipPicker, ctxFor }
    if (LIST_OPS.has(op)) {
      if (editors?.mountChipPicker) {
        slot._chipCtrl = editors.mountChipPicker(slot, editors.ctxFor?.(pred) || {});
      }
      // else: the chipPickerHTML scaffold is already in the slot; readChips
      // (in readPred) reads the DOM chips, so getAst() is correct.
      return;
    }
    if (SINGLE_VALUE_AC_OPS.has(op) && editors?.attachAutocomplete) {
      const input = slot.querySelector(".rp-pred-val");
      if (input && input.type !== "hidden") editors.attachAutocomplete(input, editors.ctxFor?.(pred) || {});
    }
    // numeric / date / between / null ops — no wiring; the input shape is right.
  }

  // One group card — AND/OR combo (rp-seg--combo) + per-group delete + the
  // predicate list + the Add-condition button. Seeded with one predicate row.
  function groupCard() {
    const card = document.createElement("div");
    card.className = "rp-group-card";
    card.innerHTML =
        '<div class="rp-group-card-head">'
      +   '<div class="rp-seg rp-seg--combo rp-group-card-combo">'
      +     '<button type="button" class="is-active" data-combo="AND">AND</button>'
      +     '<button type="button" data-combo="OR">OR</button>'
      +   '</div>'
      +   '<button class="rp-group-card-del" type="button" title="Remove group"><i class="bi bi-trash3"></i></button>'
      + '</div>'
      + '<div class="rp-pred-list"></div>'
      + '<button class="rp-btn-icon rp-btn-icon--glass rp-btn-icon--block rp-add-pred" type="button">'
      +   '<i class="bi bi-plus-lg"></i> Add condition</button>';
    card.querySelector(".rp-pred-list").appendChild(predRow());
    return card;
  }

  // Inter-group separator pills — re-rendered after every add/remove. The pill
  // label is the top-level groupCombo; clicking it flips the combo + re-labels.
  function renderSeps() {
    groupList.querySelectorAll(".rp-group-sep").forEach((s) => s.remove());
    const cards = Array.from(groupList.querySelectorAll(".rp-group-card"));
    cards.slice(0, -1).forEach((card) => {
      const sep = document.createElement("div");
      sep.className = "rp-group-sep";
      sep.innerHTML = '<button type="button">' + esc(groupCombo) + '</button>';
      card.after(sep);
    });
  }
  function addGroup() { groupList.appendChild(groupCard()); renderSeps(); }

  // ── delegated handlers — one click + one change on the group list ──────────
  addGroupBtn.addEventListener("click", () => { if (columns.length) addGroup(); });

  groupList.addEventListener("click", (e) => {
    if (e.target.closest(".rp-pred-del")) { e.target.closest(".rp-pred").remove(); return; }
    if (e.target.closest(".rp-add-pred")) {
      e.target.closest(".rp-group-card").querySelector(".rp-pred-list").appendChild(predRow());
      return;
    }
    if (e.target.closest(".rp-group-card-del")) {
      if (groupList.querySelectorAll(".rp-group-card").length > 1)
        e.target.closest(".rp-group-card").remove();
      renderSeps();
      return;
    }
    const gcBtn = e.target.closest(".rp-group-card-combo button");
    if (gcBtn) {
      gcBtn.parentElement.querySelectorAll("button").forEach((b) => b.classList.remove("is-active"));
      gcBtn.classList.add("is-active");
      return;
    }
    if (e.target.closest(".rp-group-sep button")) {
      groupCombo = groupCombo === "AND" ? "OR" : "AND";
      groupList.querySelectorAll(".rp-group-sep button").forEach((b) => { b.textContent = groupCombo; });
    }
  });

  groupList.addEventListener("change", (e) => {
    const pred = e.target.closest(".rp-pred");
    if (!pred) return;
    // Column changed → dtype may have changed → rebuild the op dropdown (drop
    // ops that don't apply, keep the current op if still valid) + the value
    // slot, then re-wire.
    if (e.target.classList.contains("rp-pred-col")) {
      const col = columnFor(e.target.value);
      const opSel = pred.querySelector(".rp-pred-op");
      const ops = opsForColumn(col);
      const wantOp = ops.find((o) => o[0] === opSel.value)?.[0] || ops[0]?.[0] || "eq";
      opSel.innerHTML = opSelectHTML(col, wantOp);
      const slot = pred.querySelector(".rp-pred-val-slot");
      slot._chipCtrl = null;
      slot.innerHTML = valueInputHTML(wantOp, col);
      wireValueSlot(pred);
      return;
    }
    // Op changed → swap the value slot if the value-kind shifted.
    if (e.target.classList.contains("rp-pred-op")) {
      const col = columnFor(pred.querySelector(".rp-pred-col").value);
      const slot = pred.querySelector(".rp-pred-val-slot");
      slot._chipCtrl = null;
      slot.innerHTML = valueInputHTML(e.target.value, col);
      wireValueSlot(pred);
    }
  });

  // ── readout — the live DOM builder → a FilterNode AST ──────────────────────
  // column key (the <select> value) → column config.
  function columnFor(key) {
    return columns.find((c) => String(c.key) === String(key));
  }

  // Read the chips out of a chip-picker slot — prefers the live controller's
  // .values(), else reads the DOM chips' data-value (the build-ready path).
  function readChips(slot) {
    if (slot?._chipCtrl?.values) return slot._chipCtrl.values();
    return Array.from(slot?.querySelectorAll(".rp-chip[data-value]") || [])
      .map((c) => c.dataset.value);
  }

  function readGroup(card) {
    return {
      combo: card.querySelector(".rp-group-card-combo .is-active").dataset.combo,
      preds: Array.from(card.querySelectorAll(".rp-pred")).map(readPred),
    };
  }

  // One predicate row → a normalized intermediate shape. Range → val:[a,b];
  // list → val:string[] from the chips; everything else → a single string.
  // predToLeaf is the validator that drops incomplete predicates.
  function readPred(p) {
    const op  = p.querySelector(".rp-pred-op").value;
    const key = p.querySelector(".rp-pred-col").value;
    if (op === "between") {
      const a = p.querySelector(".rp-pred-val-a")?.value.trim() || "";
      const b = p.querySelector(".rp-pred-val-b")?.value.trim() || "";
      return { key, op, val: [a, b] };
    }
    if (op === "in" || op === "not_in") {
      const slot = p.querySelector(".rp-pred-val-slot");
      const chips = readChips(slot);
      if (chips.length > 0) return { key, op, val: chips };
      // Defensive comma-split fallback when no chips were picked.
      const raw = p.querySelector(".rp-chip-input, .rp-pred-val")?.value.trim() || "";
      return { key, op, val: raw };
    }
    return { key, op, val: p.querySelector(".rp-pred-val")?.value.trim() || "" };
  }

  // Per-op value coercion → a FilterNode leaf (the backend contract). Returns
  // null for incomplete predicates so buildFilterNode drops them — a half-filled
  // row never poisons the request. NaN rejection + date-vs-number typing are
  // load-bearing (a raw-string emit would 400 the server).
  function predToLeaf(p) {
    const col  = columnFor(p.key);
    if (!col) return null;
    const spec = OP_BY_WIRE[p.op];
    if (!spec) return null;
    const op = p.op;
    if (NULL_OPS.has(op)) return { col: col.key, op };

    if (op === "between") {
      const [a, b] = Array.isArray(p.val) ? p.val : ["", ""];
      if (a === "" || b === "") return null;
      const isDateCol = DATE_DTYPES.includes(colDtype(col));
      const value = isDateCol ? [a, b] : [Number(a), Number(b)];
      if (!isDateCol && (Number.isNaN(value[0]) || Number.isNaN(value[1]))) return null;
      return { col: col.key, op, value };
    }

    if (op === "in" || op === "not_in") {
      const items = Array.isArray(p.val)
        ? p.val.map((s) => String(s).trim()).filter(Boolean)
        : String(p.val || "").split(",").map((s) => s.trim()).filter(Boolean);
      if (!items.length) return null;
      const isNumCol = NUM_DTYPES.includes(colDtype(col));
      const value = isNumCol ? items.map(Number) : items;
      if (isNumCol && value.some(Number.isNaN)) return null;
      return { col: col.key, op, value };
    }

    if (["gt", "gte", "lt", "lte"].includes(op)) {
      if (p.val === "") return null;
      const n = Number(p.val);
      if (Number.isNaN(n)) return null;
      return { col: col.key, op, value: n };
    }

    if (p.val === "") return null;
    return { col: col.key, op, value: p.val };
  }

  // Walk the builder → a FilterNode tree (or null). One group = one FilterGroup;
  // a single group is handed out directly (no outer wrapper — keeps the wire
  // payload byte-stable); multiple groups wrap under the top-level combo.
  function buildFilterNode() {
    const groups = Array.from(groupList.querySelectorAll(".rp-group-card")).map(readGroup);
    const groupNodes = groups
      .map((g) => ({ op: g.combo.toLowerCase(), children: g.preds.map(predToLeaf).filter(Boolean) }))
      .filter((g) => g.children.length > 0);
    if (groupNodes.length === 0) return null;
    if (groupNodes.length === 1) return groupNodes[0];
    return { op: groupCombo.toLowerCase(), children: groupNodes };
  }

  // ── lifecycle ──────────────────────────────────────────────────────────────
  // Rebuild the builder for a fresh column set — wipe, reset combo, seed one
  // empty group when columns exist (legacy rebuildFilterCols parity).
  function setColumns(cols) {
    columns = Array.isArray(cols) ? cols.slice() : [];
    groupList.innerHTML = "";
    groupCombo = "AND";
    if (columns.length) addGroup();
  }

  // Reset the builder to one empty group (legacy Clear lifecycle).
  function reset() {
    groupList.innerHTML = "";
    groupCombo = "AND";
    if (columns.length) addGroup();
  }

  applyBtn.addEventListener("click", () => {
    const ast = buildFilterNode();
    config.onApply?.(ast);
  });
  clearBtn.addEventListener("click", () => {
    reset();
    config.onClear?.();
  });

  // Seed the initial builder state (one empty group per legacy parity). A future
  // `initial` FilterNode hydrate plugs in here.
  if (columns.length) addGroup();

  return {
    el: host,
    panel,
    body,
    foot,
    /** Snapshot the live DOM builder into a FilterNode tree (or null). */
    getAst: buildFilterNode,
    /** Reset the builder to one empty group (no onClear fired). */
    clear: reset,
    /** Rebuild for a fresh column set (e.g. on file load). */
    setColumns,
    /** Open / close the panel (delegates to the shell). */
    setOpen: panel.setOpen,
    /** Switch the head tab (delegates to the shell). */
    setTab: panel.setTab,
  };
}

register("filter-panel", mountFilterPanel);
