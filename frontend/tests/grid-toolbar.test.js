/* node:test over grid-toolbar: action dispatch through the ONE delegated
   handler (button/toggle/menu/chip/search) + the `when`/`active`/`visible`
   predicates re-evaluating on update(state). Uses the fake-dom shim.
   Run via: sh tools/test-fe.sh */

import { test } from "node:test";
import assert from "node:assert/strict";
import { installDom } from "./fake-dom.js";

installDom();

const { mountGridToolbar } = await import(
  "../framework/grid-toolbar/grid-toolbar.js"
);

function makeHost() {
  return installDom();
}

test("button dispatch: clicking a button fires onAction(id, {})", () => {
  const host = makeHost();
  const calls = [];
  const tb = mountGridToolbar(host, {
    state: {},
    controls: [{ kind: "button", id: "add", icon: "bi-plus", title: "Add" }],
    onAction: (id, ctx) => calls.push([id, ctx]),
  });
  tb.el.querySelector('[data-gtb="add"]').click();
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0][0], "add");
  assert.deepEqual(calls[0][1], {});
});

test("`when` gating: when=false hides + disables the button, and a disabled click does NOT dispatch", () => {
  const host = makeHost();
  const calls = [];
  const tb = mountGridToolbar(host, {
    state: { canDelete: false },
    controls: [{ kind: "button", id: "del", icon: "bi-trash", title: "Delete", when: (s) => s.canDelete }],
    onAction: (id) => calls.push(id),
  });
  const btn = tb.el.querySelector('[data-gtb="del"]');
  assert.equal(btn.classList.contains("is-hidden"), true);
  assert.equal(btn.disabled, true);
  btn.click(); // delegated handler bails on a disabled target
  assert.equal(calls.length, 0);

  // re-evaluate on update(state): now allowed → shown + enabled + dispatches.
  tb.update({ state: { canDelete: true } });
  assert.equal(btn.classList.contains("is-hidden"), false);
  assert.equal(btn.disabled, false);
  btn.click();
  assert.deepEqual(calls, ["del"]);
});

test("toggle: active(state) drives the is-active skin + aria-pressed, refreshed on update", () => {
  const host = makeHost();
  const tb = mountGridToolbar(host, {
    state: { view: "table" },
    controls: [
      { kind: "toggle", id: "t-table", icon: "bi-table", title: "Table", group: "view", active: (s) => s.view === "table" },
      { kind: "toggle", id: "t-cards", icon: "bi-grid", title: "Cards", group: "view", active: (s) => s.view === "cards" },
    ],
    onAction: () => {},
  });
  const tTable = tb.el.querySelector('[data-gtb="t-table"]');
  const tCards = tb.el.querySelector('[data-gtb="t-cards"]');
  assert.equal(tTable.classList.contains("is-active"), true);
  assert.equal(tTable.getAttribute("aria-pressed"), "true");
  assert.equal(tCards.classList.contains("is-active"), false);

  tb.update({ state: { view: "cards" } });
  assert.equal(tTable.classList.contains("is-active"), false);
  assert.equal(tCards.classList.contains("is-active"), true);
});

test("setActive: the consumer can reflect a toggle's state directly", () => {
  const host = makeHost();
  const tb = mountGridToolbar(host, {
    state: {},
    controls: [{ kind: "toggle", id: "pin", icon: "bi-pin", title: "Pin" }],
    onAction: () => {},
  });
  const pin = tb.el.querySelector('[data-gtb="pin"]');
  assert.equal(pin.classList.contains("is-active"), false);
  tb.setActive("pin", true);
  assert.equal(pin.classList.contains("is-active"), true);
  assert.equal(pin.getAttribute("aria-pressed"), "true");
});

test("chip: visible(state) toggles + label(state) recomputes on update", () => {
  const host = makeHost();
  const tb = mountGridToolbar(host, {
    state: { n: 0 },
    controls: [{ kind: "chip", id: "sel", label: (s) => `${s.n} selected`, visible: (s) => s.n > 0 }],
    onAction: () => {},
  });
  const chip = tb.el.querySelector('[data-gtb="sel"]');
  assert.equal(chip.classList.contains("is-hidden"), true);
  tb.update({ state: { n: 3 } });
  assert.equal(chip.classList.contains("is-hidden"), false);
  assert.equal(chip.textContent, "3 selected");
});

test("chip click dispatches onAction(id)", () => {
  const host = makeHost();
  let fired = null;
  const tb = mountGridToolbar(host, {
    state: { n: 1 },
    controls: [{ kind: "chip", id: "sel", label: () => "1 selected", visible: () => true }],
    onAction: (id) => { fired = id; },
  });
  tb.el.querySelector('[data-gtb="sel"]').click();
  assert.equal(fired, "sel");
});

test("search: onInput fires the spec callback AND onAction(id,{value})", () => {
  const host = makeHost();
  const captured = [];
  let specQ = null;
  const tb = mountGridToolbar(host, {
    state: {},
    controls: [{ kind: "search", id: "q", placeholder: "Find", onInput: (q) => { specQ = q; } }],
    onAction: (id, ctx) => captured.push([id, ctx.value]),
  });
  const field = tb.el.querySelector(".rp-gtb-search").querySelector("input");
  field.value = "abc";
  field.dispatchEvent({ type: "input", target: field, preventDefault() {} });
  assert.equal(specQ, "abc");
  assert.deepEqual(captured, [["q", "abc"]]);
});
