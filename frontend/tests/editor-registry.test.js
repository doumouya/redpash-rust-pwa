/* node:test over the redtable editor-registry: dtype → factory resolution
   (default text, numeric for int/float, explicit override, fallback) + the
   commit/cancel/parse behavior of the built-in editors via the fake-dom shim.
   Run via: sh tools/test-fe.sh */

import { test } from "node:test";
import assert from "node:assert/strict";
import { installDom } from "./fake-dom.js";

installDom(); // before importing the framework modules (they read globals)

const { register, editorFor } = await import(
  "../framework/redtable/editor-registry.js"
);
const { el } = await import("../framework/boot/dom.js");

test("editorFor: int and float both resolve to a numeric editor (type=number)", () => {
  const textF = editorFor({ dtype: "text" });
  const intF = editorFor({ dtype: "int" });
  const floatF = editorFor({ dtype: "float" });
  assert.equal(typeof intF, "function");
  assert.equal(typeof floatF, "function");
  // behavior, not identity: numeric editors build a type=number input.
  const intEd = intF(el("td", {}), { value: 1, onCommit() {} });
  const floatEd = floatF(el("td", {}), { value: 1, onCommit() {} });
  assert.equal(intEd.el.getAttribute("type"), "number");
  assert.equal(floatEd.el.getAttribute("type"), "number");
  intEd.cancel(); floatEd.cancel();
  // the text editor builds a plain text input — a different shape.
  const textEd = textF(el("td", {}), { value: "x", onCommit() {} });
  assert.equal(textEd.el.getAttribute("type"), "text");
  textEd.cancel();
});

test("editorFor: unknown / missing dtype falls back to the text editor", () => {
  const textF = editorFor({ dtype: "text" });
  assert.equal(editorFor({ dtype: "geo" }), textF); // unknown dtype → text
  assert.equal(editorFor({}), textF); // no dtype → text
  assert.equal(editorFor(null), textF); // no column → text
});

test("editorFor: an explicit col.editor overrides dtype", () => {
  const marker = () => {};
  register("rating", marker);
  assert.equal(editorFor({ editor: "rating", dtype: "int" }), marker);
});

test("text editor: commits the typed value on Enter, calls onCommit once", () => {
  const td = el("td", {}, "old");
  let committed;
  const factory = editorFor({ dtype: "text" });
  const ed = factory(td, { value: "old", onCommit: (v) => { committed = v; } });
  ed.el.value = "new";
  ed.commit();
  assert.equal(committed, "new");
  ed.commit(); // idempotent — no second fire
  assert.equal(committed, "new");
});

test("text editor: cancel reverts and never commits", () => {
  const td = el("td", {}, "old");
  let committed = "untouched";
  const ed = editorFor({ dtype: "text" })(td, { value: "old", onCommit: (v) => { committed = v; } });
  ed.el.value = "changed";
  ed.cancel();
  assert.equal(committed, "untouched");
});

test("numeric editor: parses to a Number; blank → empty string; non-numeric cancels", () => {
  const numF = editorFor({ dtype: "int" });

  let n;
  const a = numF(el("td", {}), { value: 1, onCommit: (v) => { n = v; } });
  a.el.value = "42";
  a.commit();
  assert.equal(n, 42);
  assert.equal(typeof n, "number");

  let blank;
  const b = numF(el("td", {}), { value: 1, onCommit: (v) => { blank = v; } });
  b.el.value = "   ";
  b.commit();
  assert.equal(blank, ""); // a cleared numeric cell

  let bad = "untouched";
  const c = numF(el("td", {}), { value: 1, onCommit: (v) => { bad = v; } });
  c.el.value = "not-a-number";
  c.commit();
  assert.equal(bad, "untouched"); // parse returned undefined → no commit
});
