/* node:test over the safe Markdown renderer. The security-critical claim: user
   text NEVER becomes HTML elements — it's built as DOM text nodes, so injected
   tags render literal. Plus the formatting subset. Uses the fake-dom shim.
   Run via: sh tools/test-fe.sh */

import { test } from "node:test";
import assert from "node:assert/strict";
import { installDom } from "./fake-dom.js";

installDom();

const { renderMarkdown } = await import("../framework/markdown/markdown.js");

test("XSS: raw HTML in the body never becomes an element", () => {
  const r = renderMarkdown('<img src=x onerror="alert(1)"> then <script>alert(2)</script>');
  assert.equal(r.querySelectorAll("img").length, 0, "no <img> element");
  assert.equal(r.querySelectorAll("script").length, 0, "no <script> element");
  assert.ok(r.textContent.includes("<img"), "the tag is literal text");
  assert.ok(r.textContent.includes("<script>"), "the script tag is literal text");
});

test("bold / italic / code render as their elements", () => {
  const r = renderMarkdown("**b** and _i_ and `c`");
  assert.equal(r.querySelectorAll("strong").length, 1);
  assert.equal(r.querySelectorAll("em").length, 1);
  assert.equal(r.querySelectorAll("code").length, 1);
  assert.equal(r.querySelector("strong").textContent, "b");
  assert.equal(r.querySelector("code").textContent, "c");
});

test("safe links open in a new tab; unsafe schemes stay literal", () => {
  const ok = renderMarkdown("[site](https://example.com)");
  const a = ok.querySelector("a");
  assert.equal(a.getAttribute("href"), "https://example.com");
  assert.equal(a.getAttribute("target"), "_blank");
  assert.ok((a.getAttribute("rel") || "").includes("noopener"));
  assert.equal(a.textContent, "site");

  const bad = renderMarkdown("[x](javascript:alert)");
  assert.equal(bad.querySelectorAll("a").length, 0, "unsafe scheme is not a link");
  assert.ok(bad.textContent.includes("javascript:"), "rendered as literal text");
});

test("blocks: lists, blockquote, fenced code", () => {
  assert.equal(renderMarkdown("- a\n- b").querySelectorAll("li").length, 2);
  assert.equal(renderMarkdown("1. a\n2. b").querySelectorAll("ol").length, 1);
  assert.equal(renderMarkdown("> quoted").querySelectorAll("blockquote").length, 1);
  const code = renderMarkdown("```\n<b>not bold</b>\n```");
  assert.equal(code.querySelectorAll("pre").length, 1);
  assert.equal(code.querySelectorAll("b").length, 0, "fenced content is literal");
  assert.ok(code.textContent.includes("<b>not bold</b>"));
});
