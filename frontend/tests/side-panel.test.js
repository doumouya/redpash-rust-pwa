/* node:test over side-panel: tab switching (active class + body visibility),
   LAZY body mount (a tab's mount() runs only on first show, then is cached),
   collapse open/close, and the onTab/onToggle callbacks. Uses the fake-dom shim.
   Run via: sh tools/test-fe.sh */

import { test } from "node:test";
import assert from "node:assert/strict";
import { installDom } from "./fake-dom.js";

installDom();

const { mountSidePanel } = await import(
  "../framework/side-panel/side-panel.js"
);

function tabsFixture(log) {
  return [
    { id: "a", label: "Alpha", icon: "bi-a", mount: (bh) => { log.push("mount:a"); return { destroy: () => log.push("destroy:a") }; } },
    { id: "b", label: "Beta", icon: "bi-b", mount: (bh) => { log.push("mount:b"); return { destroy: () => log.push("destroy:b") }; } },
  ];
}

test("lazy mount: only the initial active tab mounts on first render", () => {
  const host = installDom();
  const log = [];
  mountSidePanel(host, { side: "left", tabs: tabsFixture(log), active: "a" });
  assert.deepEqual(log, ["mount:a"]); // b not mounted yet
});

test("setActive: switching to a tab mounts it once, then caches (no re-mount)", () => {
  const host = installDom();
  const log = [];
  const sp = mountSidePanel(host, { side: "left", tabs: tabsFixture(log), active: "a" });
  sp.setActive("b");
  assert.deepEqual(log, ["mount:a", "mount:b"]);
  sp.setActive("a");
  sp.setActive("b");
  assert.deepEqual(log, ["mount:a", "mount:b"]); // cached — no further mounts
});

test("setActive: flips the active tab chip + pane visibility", () => {
  const host = installDom();
  const sp = mountSidePanel(host, { side: "left", tabs: tabsFixture([]), active: "a" });
  const chipA = sp.el.querySelector('[data-tab="a"]');
  const chipB = sp.el.querySelector('[data-tab="b"]');
  assert.equal(chipA.classList.contains("is-active"), true);
  assert.equal(chipB.classList.contains("is-active"), false);
  sp.setActive("b");
  assert.equal(chipA.classList.contains("is-active"), false);
  assert.equal(chipB.classList.contains("is-active"), true);
  // the active pane shows, the other hides.
  assert.equal(sp.body("b").classList.contains("is-active"), true);
  assert.equal(sp.body("a").classList.contains("is-active"), false);
});

test("clicking a tab chip switches active and fires onTab", () => {
  const host = installDom();
  const tabs = [];
  const sp = mountSidePanel(host, { side: "left", tabs: tabsFixture([]), active: "a", onTab: (id) => tabs.push(id) });
  sp.el.querySelector('[data-tab="b"]').click();
  assert.deepEqual(tabs, ["b"]);
  assert.equal(sp.el.querySelector('[data-tab="b"]').classList.contains("is-active"), true);
});

test("collapse: setOpen(false) hides the body + fires onToggle, setOpen(true) restores", () => {
  const host = installDom();
  const toggles = [];
  const sp = mountSidePanel(host, { side: "right", tabs: tabsFixture([]), active: "a", onToggle: (o) => toggles.push(o) });
  sp.setOpen(false);
  assert.equal(sp.el.classList.contains("is-collapsed"), true);
  sp.setOpen(true);
  assert.equal(sp.el.classList.contains("is-collapsed"), false);
  assert.deepEqual(toggles, [false, true]);
});

test("tab(id): exposes the cached mount handle after first show", () => {
  const host = installDom();
  const sp = mountSidePanel(host, { side: "left", tabs: tabsFixture([]), active: "a" });
  assert.notEqual(sp.tab("a"), null); // active tab is mounted
  assert.equal(sp.tab("b"), null);    // never shown → no handle
  sp.setActive("b");
  assert.notEqual(sp.tab("b"), null);
});

test("destroy: tears down every cached tab handle", () => {
  const host = installDom();
  const log = [];
  const sp = mountSidePanel(host, { side: "left", tabs: tabsFixture(log), active: "a" });
  sp.setActive("b"); // mount both
  sp.destroy();
  assert.ok(log.includes("destroy:a"));
  assert.ok(log.includes("destroy:b"));
});
