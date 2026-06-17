/* markdown — a SAFE, minimal Markdown → DOM renderer. Message/comment bodies are
   stored as TEXT; this builds DOM NODES (every text run via a text node →
   auto-escaped), NEVER innerHTML of user content and NEVER raw-HTML passthrough.
   So a body of `<img src=x onerror=alert(1)>` or `<script>…</script>` renders as
   literal text — no injection, no execution. Links are scheme-checked (http/https/
   mailto only) and open in a new tab (rel=noopener). Everything not recognised is
   literal text.

   Supported: paragraphs (blank-line separated, single newline → <br>), **bold** /
   __bold__, *italic* / _italic_, `code`, ```fenced``` code, > blockquote, - / *
   and 1. lists, [label](url) links. Sole owner of .rp-md (markdown.css).

   renderMarkdown(text) -> HTMLElement (a .rp-md container). */

import { el } from "../boot/dom.js";
import { register } from "../registry/component-registry.js";

const SAFE_SCHEME = /^(https?:|mailto:)/i;
const BLOCK_LEAD = /^(```|>\s?|\s*[-*]\s+|\s*\d+\.\s+)/;

// ── inline spans: emit text nodes + safe inline elements, leftmost-match first.
//    Precedence at a tie: code · link · bold · italic. Nested by re-parsing the
//    captured content (terminates — each level consumes its delimiters).
const INLINE = /`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)|\*\*([^*]+)\*\*|__([^_]+)__|\*([^*]+)\*|_([^_]+)_/;
function inline(text) {
  const out = [];
  let rest = String(text);
  while (rest) {
    const m = INLINE.exec(rest);
    if (!m) { out.push(document.createTextNode(rest)); break; }
    if (m.index > 0) out.push(document.createTextNode(rest.slice(0, m.index)));
    if (m[1] != null) out.push(el("code", {}, m[1]));
    else if (m[2] != null) {
      out.push(SAFE_SCHEME.test(m[3])
        ? el("a", { href: m[3], target: "_blank", rel: "noopener noreferrer" }, ...inline(m[2]))
        : document.createTextNode(m[0])); // unsafe scheme → literal text
    } else if (m[4] != null || m[5] != null) out.push(el("strong", {}, ...inline(m[4] ?? m[5])));
    else if (m[6] != null || m[7] != null) out.push(el("em", {}, ...inline(m[6] ?? m[7])));
    rest = rest.slice(m.index + m[0].length);
  }
  return out;
}

// a run of lines sharing a prefix → one <li>'s inline content.
const listItems = (lines, strip) => lines.map((ln) => el("li", {}, ...inline(ln.replace(strip, ""))));

export function renderMarkdown(text) {
  const root = el("div", { class: "rp-md" });
  const lines = String(text ?? "").replace(/\r\n/g, "\n").split("\n");
  let i = 0;
  const take = (pred) => { const buf = []; while (i < lines.length && pred(lines[i])) { buf.push(lines[i]); i++; } return buf; };

  while (i < lines.length) {
    const line = lines[i];
    if (/^```/.test(line)) {
      i++; // opening fence
      const buf = take((l) => !/^```/.test(l));
      i++; // closing fence
      root.append(el("pre", {}, el("code", {}, buf.join("\n"))));
    } else if (/^>\s?/.test(line)) {
      const buf = take((l) => /^>\s?/.test(l)).map((l) => l.replace(/^>\s?/, ""));
      root.append(el("blockquote", {}, ...inline(buf.join("\n"))));
    } else if (/^\s*[-*]\s+/.test(line)) {
      root.append(el("ul", {}, ...listItems(take((l) => /^\s*[-*]\s+/.test(l)), /^\s*[-*]\s+/)));
    } else if (/^\s*\d+\.\s+/.test(line)) {
      root.append(el("ol", {}, ...listItems(take((l) => /^\s*\d+\.\s+/.test(l)), /^\s*\d+\.\s+/)));
    } else if (line.trim() === "") {
      i++;
    } else {
      const buf = take((l) => l.trim() !== "" && !BLOCK_LEAD.test(l));
      const p = el("p", {});
      buf.forEach((ln, k) => { if (k) p.append(el("br")); p.append(...inline(ln)); });
      root.append(p);
    }
  }
  return root;
}

register("markdown", null, { builders: ["renderMarkdown"] });
