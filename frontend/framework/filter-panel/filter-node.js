/* filter-node — the PURE FilterNode <-> rows logic for the filter-panel.
   No DOM, no imports: extracted so the assembly is unit-testable (node:test)
   and so the panel's only job is wiring inputs to these functions.

   THE shape (shared::filter::FilterNode, day-one decision #4):
     Group { node:"group", op:"and"|"or", children:[...] }
     Pred  { node:"pred", col, op, value?, case_sensitive? }
   Empty Group = match-all. PredOps: the 14 below. */

/** The 14 PredOps with human labels, in the order the op <select> shows them. */
export const PRED_OPS = [
  { value: "eq", label: "equals" },
  { value: "neq", label: "does not equal" },
  { value: "contains", label: "contains" },
  { value: "not_contains", label: "does not contain" },
  { value: "starts_with", label: "starts with" },
  { value: "ends_with", label: "ends with" },
  { value: "gt", label: "greater than" },
  { value: "gte", label: "greater than or equal" },
  { value: "lt", label: "less than" },
  { value: "lte", label: "less than or equal" },
  { value: "between", label: "is between" },
  { value: "in", label: "is one of" },
  { value: "is_null", label: "is empty" },
  { value: "not_null", label: "is not empty" },
];

/** ops that take NO value (the value input is hidden). */
export const VALUELESS_OPS = new Set(["is_null", "not_null"]);
/** ops that take TWO numeric bounds. */
export const RANGE_OPS = new Set(["between"]);
/** ops that take a comma list -> array value. */
export const LIST_OPS = new Set(["in", "not_in"]);

/** A blank row model. */
export function blankRow() {
  return { col: "", op: "eq", value: "", from: "", to: "", caseSensitive: false };
}

/** Is a row complete enough to become a Pred? (skip-incomplete rule) */
export function rowComplete(row) {
  if (!row || !row.col || !row.op) return false;
  if (VALUELESS_OPS.has(row.op)) return true;
  if (RANGE_OPS.has(row.op)) {
    return String(row.from ?? "").trim() !== "" && String(row.to ?? "").trim() !== "";
  }
  return String(row.value ?? "").trim() !== "";
}

/** Parse a value cell into the right JSON shape for a Pred's `value`. */
function predValue(row) {
  if (VALUELESS_OPS.has(row.op)) return undefined; // omitted
  if (RANGE_OPS.has(row.op)) {
    return [coerceNumber(row.from), coerceNumber(row.to)];
  }
  if (LIST_OPS.has(row.op)) {
    return String(row.value ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s !== "");
  }
  return String(row.value ?? "");
}

/** Numbers stay numbers when they parse cleanly; otherwise keep the raw text
    (the engine coerces per-column — we don't guess types here). */
function coerceNumber(v) {
  const s = String(v ?? "").trim();
  if (s === "") return s;
  const n = Number(s);
  return Number.isFinite(n) && String(n) === s ? n : s;
}

/** One row -> one Pred node. Assumes rowComplete(row). */
export function rowToPred(row) {
  const pred = { node: "pred", col: row.col, op: row.op };
  const value = predValue(row);
  if (value !== undefined) pred.value = value;
  if (row.caseSensitive) pred.case_sensitive = true;
  return pred;
}

/** A blank nested-group row model (DC3c): an AND group seeded with one blank
    predicate row. The panel's "Add group" appends this. */
export function blankGroup() {
  return { group: true, op: "and", children: [blankRow()] };
}

/** One row -> one FilterNode child, or null when it contributes nothing. A
    predicate row yields a Pred (or null if incomplete); a nested-group row
    (`{ group:true, op, children:[...] }`) recurses, yielding a Group node — or
    null when it has no complete children, so an empty group never lands in the
    tree. Recursion handles arbitrary nesting. */
function rowToNode(row) {
  if (row && row.group) {
    const children = (row.children ?? []).map(rowToNode).filter((c) => c !== null);
    return children.length ? { node: "group", op: row.op === "or" ? "or" : "and", children } : null;
  }
  return rowComplete(row) ? rowToPred(row) : null;
}

/** Assemble rows + combinator into a top-level Group FilterNode. Incomplete
    predicate rows and empty nested groups are skipped. Returns a match-all
    Group when nothing is complete (the empty filter). `combinator` is
    "and" | "or". Rows may nest groups to any depth (DC3c). */
export function assembleFilter(rows, combinator) {
  const children = (rows ?? []).map(rowToNode).filter((c) => c !== null);
  return { node: "group", op: combinator === "or" ? "or" : "and", children };
}

/** One FilterNode child -> one row model. Inverse of rowToNode: a Group child
    becomes a nested-group row (`{ group:true, op, children:[...] }`) and recurses;
    anything else becomes a predicate row. */
function nodeToRow(child) {
  if (child && child.node === "group") {
    return {
      group: true,
      op: child.op === "or" ? "or" : "and",
      children: (child.children ?? []).map(nodeToRow),
    };
  }
  return predToRow(child);
}

/** Decompose a top-level Group FilterNode back into editable rows, recursing
    into nested groups (DC3c — the builder now represents the full tree).
    Returns { combinator, rows }. A non-Group / empty value yields one blank row. */
export function decomposeFilter(node) {
  if (!node || node.node !== "group" || !Array.isArray(node.children) || node.children.length === 0) {
    return { combinator: "and", rows: [blankRow()] };
  }
  const combinator = node.op === "or" ? "or" : "and";
  const rows = node.children.map(nodeToRow);
  return { combinator, rows: rows.length ? rows : [blankRow()] };
}

/** One Pred node -> one row model (inverse of rowToPred). */
export function predToRow(pred) {
  const row = blankRow();
  if (!pred || pred.node !== "pred") return row;
  row.col = pred.col ?? "";
  row.op = pred.op ?? "eq";
  row.caseSensitive = pred.case_sensitive === true;
  if (RANGE_OPS.has(row.op) && Array.isArray(pred.value)) {
    row.from = pred.value[0] != null ? String(pred.value[0]) : "";
    row.to = pred.value[1] != null ? String(pred.value[1]) : "";
  } else if (LIST_OPS.has(row.op) && Array.isArray(pred.value)) {
    row.value = pred.value.join(", ");
  } else if (!VALUELESS_OPS.has(row.op) && pred.value != null) {
    row.value = String(pred.value);
  }
  return row;
}

/* ── client-side evaluation ───────────────────────────────────────────────────
   Apply a FilterNode to a plain row object IN THE BROWSER — for client-loaded
   lists (e.g. object-list) that filter their in-memory rows without a server
   round-trip. Mirrors the PredOp semantics the server/wasm compile to: string
   ops are case-insensitive unless `case_sensitive`, numeric ops coerce, an empty
   Group is match-all. The server stays the source of truth for paged frames;
   this is only for already-loaded rows. */
export function evalFilter(node, row) {
  if (!node) return true;
  if (node.node === "group") {
    const kids = node.children ?? [];
    if (!kids.length) return true; // empty group = match-all
    return node.op === "or"
      ? kids.some((c) => evalFilter(c, row))
      : kids.every((c) => evalFilter(c, row));
  }
  return evalPred(node, row);
}

function evalPred(p, row) {
  const raw = row?.[p.col];
  const present = raw != null && String(raw) !== "";
  if (p.op === "is_null") return !present;
  if (p.op === "not_null") return present;
  const ci = p.case_sensitive !== true;
  const norm = (s) => (ci ? String(s ?? "").toLowerCase() : String(s ?? ""));
  const cell = norm(raw);
  const val = norm(p.value);
  switch (p.op) {
    case "eq": return cell === val;
    case "neq": return cell !== val;
    case "contains": return cell.includes(val);
    case "not_contains": return !cell.includes(val);
    case "starts_with": return cell.startsWith(val);
    case "ends_with": return cell.endsWith(val);
    case "gt": case "gte": case "lt": case "lte": {
      const a = Number(raw), b = Number(p.value);
      const numeric = Number.isFinite(a) && Number.isFinite(b);
      const [x, y] = numeric ? [a, b] : [cell, val];
      return p.op === "gt" ? x > y : p.op === "gte" ? x >= y : p.op === "lt" ? x < y : x <= y;
    }
    case "between": {
      const [lo, hi] = Array.isArray(p.value) ? p.value : ["", ""];
      const a = Number(raw);
      if (Number.isFinite(a) && Number.isFinite(Number(lo)) && Number.isFinite(Number(hi))) {
        return a >= Number(lo) && a <= Number(hi);
      }
      return cell >= norm(lo) && cell <= norm(hi);
    }
    case "in": return (Array.isArray(p.value) ? p.value : []).some((v) => norm(v) === cell);
    default: return true;
  }
}
