/* node:test over the framework's pure logic: the component registry, the
   pref-registry cascade, esc(), and the apps registry's policy-aware filter.
   Run via: sh tools/test-fe.sh (node --test frontend/tests/). */

import { test } from "node:test";
import assert from "node:assert/strict";

/* browser shims the modules expect at import time */
globalThis.localStorage = (() => {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
  };
})();
globalThis.document = {
  documentElement: { dataset: {} },
  addEventListener() {},
  createElement: () => ({ append() {}, setAttribute() {}, classList: { add() {} } }),
};
globalThis.window = { addEventListener() {} };

const { register, getComponent, listComponents } = await import(
  "../framework/registry/component-registry.js"
);
const { esc } = await import("../framework/boot/dom.js");
const pref = await import("../framework/registry/pref-registry.js");
const { appsFor, allPages, pageById } = await import("../framework/boot/apps.js");

test("component registry: register + list + lookup", () => {
  register("x-test", () => "mounted");
  assert.equal(getComponent("x-test").mount(), "mounted");
  assert.ok(listComponents().some((c) => c.name === "x-test"));
});

test("esc neutralizes html", () => {
  assert.equal(esc('<img src=x onerror="a">&'), "&lt;img src=x onerror=&quot;a&quot;&gt;&amp;");
});

test("pref cascade: default → mirror → resolved", () => {
  pref.registerPref({ key: "t.cascade", label: "x", group: "T", control: "text", default: "from-default" });
  assert.equal(pref.getPref("t.cascade"), "from-default");
  localStorage.setItem("rp-pref-t.cascade", JSON.stringify("from-mirror"));
  assert.equal(pref.getPref("t.cascade"), "from-mirror");
  pref.seedResolved({ "t.cascade": "from-server" }, { userRid: "USR_X" });
  assert.equal(pref.getPref("t.cascade"), "from-server");
});

test("pref cascade: unknown keys pass through untouched", () => {
  pref.seedResolved({ "ghost.key": 42 }, {});
  assert.equal(pref.getPref("ghost.key"), 42); // no registration needed
});

test("apps registry: hidden + unbuilt + admin + policy filters", () => {
  const user = { is_platform_admin: false };
  const admin = { is_platform_admin: true };
  // only built pages produce visible apps; auth is hidden
  for (const app of appsFor(admin)) {
    assert.notEqual(app.id, "auth");
    assert.ok(app.pages.some((p) => p.built));
  }
  // admin app never visible to non-admin
  assert.ok(!appsFor(user).some((a) => a.id === "admin"));
  // policy kill-switch: app.<id>.enabled=false hides an app even for admin
  pref.seedResolved({ "app.studio.enabled": false }, {});
  assert.ok(!appsFor(admin).some((a) => a.id === "studio"));
  pref.seedResolved({ "app.studio.enabled": true }, {});
  // pages flatten with owning app
  assert.equal(pageById("login").app.id, "auth");
  assert.ok(allPages().length >= 5);
});
