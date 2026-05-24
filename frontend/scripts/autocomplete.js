// autocomplete.js — typeahead + chip-picker atom backed by column-index.
//
// Two consumer surfaces, one shared internals:
//
//   attachAutocomplete(input, ctx)
//     Wraps a single <input> with a focus-driven suggestion list. Used
//     by the filter predicate UI for single-value ops (eq / neq /
//     contains / starts_with / ends_with). User types → debounced
//     fetch via column-index → suggestion list renders → click or
//     Enter picks the highlighted value.
//
//   mountChipPicker(slot, ctx)
//     Replaces a slot's content with a chip-list + add-input. Used by
//     the filter predicate UI for `in` / `not_in` ops (set-membership).
//     Each picked value becomes a chip; backspace at empty input
//     removes the last chip. Returns a control with read/write API.
//
// The dropdown element uses .rt-ac (separate from .rt-dd) so the
// bindDropdown click-toggle handler in /scripts/dropdown.js doesn't
// fight our focus-driven open/close. Outside-click handling lives
// here, scoped to the wrap element.
//
// Both surfaces share keyboard nav (ArrowUp / ArrowDown / Enter /
// Escape / Tab), debounced fetch (200ms via column-index), and the
// "no results" / "truncated" state rendering.

import { getDistinct } from "/scripts/column-index.js";
import { esc } from "/scripts/dom.js";

const DEBOUNCE_MS = 200;
const SUGGESTION_LIMIT = 50;

// ── single-value typeahead ─────────────────────────────────────────

/**
 * @param {HTMLInputElement} input
 * @param {{fileRid: () => string|null, colName: () => string|null}} ctx
 * @returns {{detach: () => void}}
 */
export function attachAutocomplete(input, ctx) {
  if (input.dataset.acAttached) return { detach: () => {} };
  input.dataset.acAttached = "1";

  const wrap = ensureWrap(input);
  const list = makeList(wrap);
  const state = { suggestions: [], activeIdx: -1, debounceTimer: null, open: false };

  function debounceFetch(q) {
    clearTimeout(state.debounceTimer);
    state.debounceTimer = setTimeout(() => fetchAndRender(q), DEBOUNCE_MS);
  }

  async function fetchAndRender(q) {
    const rid = ctx.fileRid?.();
    const col = ctx.colName?.();
    if (!rid || !col) { closeList(); return; }
    const r = await getDistinct(rid, col, { q, limit: SUGGESTION_LIMIT });
    state.suggestions = r.values || [];
    state.activeIdx = state.suggestions.length ? 0 : -1;
    renderList(list, state.suggestions, state.activeIdx, r);
    openList();
  }

  function openList() {
    if (state.open) return;
    state.open = true;
    list.classList.add("open");
  }
  function closeList() {
    if (!state.open) return;
    state.open = false;
    list.classList.remove("open");
    state.activeIdx = -1;
  }

  function pick(value) {
    input.value = value;
    closeList();
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }

  input.addEventListener("focus", () => debounceFetch(input.value));
  input.addEventListener("input", () => debounceFetch(input.value));
  input.addEventListener("blur",  () => {
    // Delay close to let click on a suggestion fire first.
    setTimeout(closeList, 120);
  });
  input.addEventListener("keydown", (e) => {
    if (!state.open) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      state.activeIdx = Math.min(state.activeIdx + 1, state.suggestions.length - 1);
      paintActive(list, state.activeIdx);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      state.activeIdx = Math.max(state.activeIdx - 1, 0);
      paintActive(list, state.activeIdx);
    } else if (e.key === "Enter") {
      if (state.activeIdx >= 0 && state.suggestions[state.activeIdx] != null) {
        e.preventDefault();
        pick(state.suggestions[state.activeIdx]);
      }
    } else if (e.key === "Escape") {
      closeList();
    }
  });

  list.addEventListener("mousedown", (e) => {
    // mousedown (not click) so the input's blur doesn't fire first
    // and close the list before the pick lands.
    const item = e.target.closest(".rt-ac-item");
    if (!item) return;
    e.preventDefault();
    pick(item.dataset.value || "");
  });

  return {
    detach: () => {
      clearTimeout(state.debounceTimer);
      list.remove();
      delete input.dataset.acAttached;
    },
  };
}

// ── chip-picker (for in / not_in) ──────────────────────────────────

/**
 * Replace `slot`'s content with a chip-picker. Picked values become
 * chips; the add-input runs autocomplete via column-index.
 *
 * @param {HTMLElement} slot           — typically a .rt-pred-val-slot
 * @param {{fileRid, colName, initialValues?: string[]}} ctx
 * @returns {{values: () => string[], add(v): void, clear(): void, detach(): void}}
 */
export function mountChipPicker(slot, ctx) {
  slot.innerHTML = ''
    + '<div class="rt-chip-picker">'
    +   '<div class="rt-chip-list"></div>'
    +   '<input class="rt-chip-input rt-pred-val" type="text" placeholder="Add value…" />'
    + '</div>';

  const picker = slot.querySelector(".rt-chip-picker");
  const chips  = slot.querySelector(".rt-chip-list");
  const input  = slot.querySelector(".rt-chip-input");

  const selected = new Set(ctx.initialValues || []);
  renderChips();

  function renderChips() {
    chips.innerHTML = Array.from(selected).map((v) =>
      '<span class="rt-chip" data-value="' + esc(v) + '">'
      +   esc(v)
      +   '<button type="button" class="rt-chip-x" aria-label="Remove ' + esc(v) + '">×</button>'
      + '</span>'
    ).join("");
  }

  function addChip(v) {
    const value = (v || "").trim();
    if (!value || selected.has(value)) return;
    selected.add(value);
    renderChips();
    // Surface a synthetic change on the picker for the predicate-reader
    // (readPred) to pick up.
    picker.dispatchEvent(new Event("change", { bubbles: true }));
  }
  function removeChip(v) {
    selected.delete(v);
    renderChips();
    picker.dispatchEvent(new Event("change", { bubbles: true }));
  }

  // Click on chip × → remove. Click anywhere else on picker → focus
  // input. Picker stays focused-feeling so the user can keep typing.
  picker.addEventListener("click", (e) => {
    const x = e.target.closest(".rt-chip-x");
    if (x) {
      const chip = x.closest(".rt-chip");
      if (chip) removeChip(chip.dataset.value);
      return;
    }
    input.focus();
  });

  // Autocomplete on the add-input. Picking a suggestion adds a chip.
  const ac = attachAutocomplete(input, ctx);
  input.addEventListener("change", () => {
    // The autocomplete's pick() fires a change event with input.value
    // set. Convert it to a chip + clear so the user can keep adding.
    if (input.value) {
      addChip(input.value);
      input.value = "";
    }
  });
  // Backspace at empty input → drop the last chip.
  input.addEventListener("keydown", (e) => {
    if (e.key === "Backspace" && input.value === "" && selected.size > 0) {
      const last = Array.from(selected).pop();
      removeChip(last);
    } else if (e.key === "Enter" && input.value && !input.dataset.acOpenPick) {
      // Plain Enter on free text (no suggestion picked) → add as chip.
      e.preventDefault();
      addChip(input.value);
      input.value = "";
    }
  });

  return {
    values: () => Array.from(selected),
    add: addChip,
    clear: () => { selected.clear(); renderChips(); },
    detach: () => { ac.detach(); slot.innerHTML = ""; },
  };
}

// ── internals ──────────────────────────────────────────────────────

function ensureWrap(input) {
  if (input.parentElement?.classList.contains("rt-ac-wrap")) {
    return input.parentElement;
  }
  const w = document.createElement("span");
  w.className = "rt-ac-wrap";
  input.parentNode.insertBefore(w, input);
  w.appendChild(input);
  return w;
}

function makeList(wrap) {
  const el = document.createElement("div");
  el.className = "rt-ac";
  wrap.appendChild(el);
  return el;
}

function renderList(list, suggestions, activeIdx, result) {
  if (!suggestions.length) {
    list.innerHTML = '<div class="rt-ac-empty">No matching values.</div>';
    return;
  }
  const head = (result?.truncated || result?.total > suggestions.length)
    ? '<div class="rt-ac-head">' + suggestions.length + ' of ' + result.total
        + (result.truncated ? '+ (capped)' : '') + '</div>'
    : '';
  list.innerHTML = head + suggestions.map((v, i) =>
    '<div class="rt-ac-item' + (i === activeIdx ? ' is-active' : '')
    +     '" data-value="' + esc(v) + '">' + esc(v) + '</div>'
  ).join("");
}

function paintActive(list, idx) {
  list.querySelectorAll(".rt-ac-item").forEach((el, i) => {
    el.classList.toggle("is-active", i === idx);
  });
  // Keep the active row in view.
  const active = list.querySelector(".rt-ac-item.is-active");
  active?.scrollIntoView({ block: "nearest" });
}
