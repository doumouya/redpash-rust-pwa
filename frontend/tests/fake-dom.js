/* fake-dom — a tiny, functional DOM shim for node:test (the repo ships no deps;
   node:test only). It implements exactly the surface the framework's el()/atoms
   + delegated-click components touch: element creation, class/attr/dataset,
   children (append/prepend/replaceChildren), text/value/checked, event listeners
   with real bubbling so closest()/contains() delegation works, and
   querySelector/querySelectorAll over a class+tag+attribute mini-matcher.
   Install with installDom() at the top of a test module (before importing the
   framework modules, which read globals at import time). */

class ClassList {
  constructor(node) { this._n = node; this._s = new Set(); }
  add(...c) { for (const x of c) if (x) this._s.add(x); this._sync(); }
  remove(...c) { for (const x of c) this._s.delete(x); this._sync(); }
  toggle(c, force) {
    const on = force === undefined ? !this._s.has(c) : !!force;
    if (on) this._s.add(c); else this._s.delete(c);
    this._sync();
    return on;
  }
  contains(c) { return this._s.has(c); }
  _sync() { this._n._class = [...this._s].join(" "); }
  _set(str) { this._s = new Set(String(str || "").split(/\s+/).filter(Boolean)); this._sync(); }
}

class FakeNode {
  constructor(tag) {
    this.tagName = String(tag || "").toUpperCase();
    this.nodeType = 1;
    this.children = [];        // element children
    this.childNodes = [];      // incl. text nodes
    this.parentNode = null;
    this.attributes = {};
    // dataset reflects to/from data-* attributes (like the real DOM): writing
    // node.dataset.fooBar = x sets the data-foo-bar attribute, and vice-versa.
    this.dataset = new Proxy({}, {
      set: (t, k, v) => {
        t[k] = String(v);
        const attr = "data-" + String(k).replace(/[A-Z]/g, (c) => "-" + c.toLowerCase());
        this.attributes[attr] = String(v);
        return true;
      },
      deleteProperty: (t, k) => {
        delete t[k];
        delete this.attributes["data-" + String(k).replace(/[A-Z]/g, (c) => "-" + c.toLowerCase())];
        return true;
      },
    });
    this._class = "";
    this._listeners = {};
    this._text = "";
    this.value = "";
    this.checked = false;
    this.indeterminate = false;
    this.disabled = false;
    this.selected = false;
    this.classList = new ClassList(this);
  }
  get className() { return this._class; }
  set className(v) { this.classList._set(v); }

  setAttribute(k, v) {
    this.attributes[k] = String(v);
    if (k === "class") this.className = v;
    if (k.startsWith("data-")) {
      const key = k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      this.dataset[key] = String(v);
    }
  }
  getAttribute(k) { return k in this.attributes ? this.attributes[k] : null; }
  removeAttribute(k) { delete this.attributes[k]; }

  _adopt(c) {
    const node = c && c.nodeType ? c : new TextNode(String(c));
    node.parentNode = this;
    this.childNodes.push(node);
    if (node.nodeType === 1) this.children.push(node);
    // DocumentFragment: splice its kids in.
    if (node.nodeType === 11) {
      for (const k of [...node.childNodes]) this._adopt(k);
      return;
    }
  }
  append(...cs) { for (const c of cs) if (c != null) this._adopt(c); }
  prepend(...cs) {
    const existing = [...this.childNodes];
    this.childNodes = []; this.children = [];
    for (const c of cs) if (c != null) this._adopt(c);
    for (const e of existing) this._adopt(e);
  }
  replaceChildren(...cs) {
    for (const k of this.childNodes) k.parentNode = null;
    this.childNodes = []; this.children = [];
    for (const c of cs) if (c != null) this._adopt(c);
  }
  remove() {
    const p = this.parentNode;
    if (!p) return;
    p.childNodes = p.childNodes.filter((n) => n !== this);
    p.children = p.children.filter((n) => n !== this);
    this.parentNode = null;
  }
  get firstChild() { return this.childNodes[0] ?? null; }
  get previousElementSibling() {
    const p = this.parentNode; if (!p) return null;
    const i = p.children.indexOf(this);
    return i > 0 ? p.children[i - 1] : null;
  }
  get nextElementSibling() {
    const p = this.parentNode; if (!p) return null;
    const i = p.children.indexOf(this);
    return i >= 0 && i + 1 < p.children.length ? p.children[i + 1] : null;
  }

  get textContent() {
    if (this._text) return this._text;
    return this.childNodes.map((n) => n.textContent).join("");
  }
  set textContent(v) { this._text = String(v); this.childNodes = []; this.children = []; }

  set innerHTML(_v) { /* the tests don't assert over innerHTML cells */ this.childNodes = []; this.children = []; }
  get innerHTML() { return ""; }

  addEventListener(type, fn) { (this._listeners[type] ??= []).push(fn); }
  removeEventListener(type, fn) {
    this._listeners[type] = (this._listeners[type] ?? []).filter((f) => f !== fn);
  }
  // dispatch with real capture-less bubbling up the parent chain.
  dispatchEvent(evt) {
    let node = evt.target;
    while (node) {
      for (const fn of node._listeners?.[evt.type] ?? []) fn.call(node, evt);
      node = node.parentNode;
    }
  }
  // convenience for tests: click this node (bubbles).
  click() {
    this.dispatchEvent({ type: "click", target: this, inputType: undefined,
      preventDefault() {}, stopPropagation() {} });
  }

  contains(other) {
    let n = other;
    while (n) { if (n === this) return true; n = n.parentNode; }
    return false;
  }
  closest(sel) {
    let n = this;
    while (n && n.nodeType === 1) { if (matches(n, sel)) return n; n = n.parentNode; }
    return null;
  }
  matches(sel) { return matches(this, sel); }
  querySelector(sel) { return queryAll(this, sel)[0] ?? null; }
  querySelectorAll(sel) { return queryAll(this, sel); }
  setSelectionRange() {}
  select() {}
  focus() {}
  blur() {}
}

class TextNode {
  constructor(text) { this.nodeType = 3; this._text = String(text); this.parentNode = null; }
  get textContent() { return this._text; }
}

class FragmentNode extends FakeNode {
  constructor() { super("#fragment"); this.nodeType = 11; }
}

// <template>.content is a fragment; we route innerHTML→content for the redtable
// fast path (not exercised by these tests, but keeps mounts from throwing).
class TemplateNode extends FakeNode {
  constructor() { super("template"); this.content = new FragmentNode(); }
}

/* ── a minimal selector matcher: comma list of compound selectors made of
   tag, .class and [attr] / [attr="v"] parts (no combinators needed here). ── */
function matchOne(node, sel) {
  if (node.nodeType !== 1) return false;
  const parts = sel.match(/(\.[\w-]+|#[\w-]+|\[[^\]]+\]|[\w*-]+)/g) || [];
  for (const p of parts) {
    if (p.startsWith(".")) { if (!node.classList.contains(p.slice(1))) return false; }
    else if (p.startsWith("[")) {
      const m = p.slice(1, -1).match(/^([\w-]+)(?:=["']?([^"'\]]*)["']?)?$/);
      if (!m) return false;
      const have = node.getAttribute(m[1]);
      if (m[2] === undefined) { if (have == null) return false; }
      else if (have !== m[2]) return false;
    } else if (p !== "*") {
      if (node.tagName !== p.toUpperCase()) return false;
    }
  }
  return true;
}
function matches(node, sel) {
  // last compound selector only (no descendant combinator support needed).
  return sel.split(",").map((s) => s.trim()).some((s) => {
    const last = s.split(/\s+/).pop();
    return matchOne(node, last);
  });
}
function queryAll(root, sel) {
  const out = [];
  const walk = (n) => {
    for (const c of n.children) { if (matches(c, sel)) out.push(c); walk(c); }
  };
  walk(root);
  return out;
}

/** Install the shim onto globalThis. Returns a fresh document root. */
export function installDom() {
  const document = {
    documentElement: { dataset: {}, style: {} },
    createElement: (tag) =>
      tag === "template" ? new TemplateNode()
      : tag === "#fragment" ? new FragmentNode()
      : new FakeNode(tag),
    createDocumentFragment: () => new FragmentNode(),
    createTextNode: (t) => new TextNode(t),
    addEventListener() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
  };
  globalThis.document = document;
  globalThis.window = {
    addEventListener() {},
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  };
  globalThis.getComputedStyle = () => ({ fontSize: "16px" });
  globalThis.CSS = { escape: (s) => String(s) };
  return new FakeNode("div");
}
