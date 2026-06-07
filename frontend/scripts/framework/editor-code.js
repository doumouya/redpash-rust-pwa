/* Purpose: Code editor framework component — a transparent textarea over a syntax-highlighted <pre>, language-parameterized.
   Doc: docs/internal/code/frontend/scripts/framework/editor-code.md */
// ── Code editor (framework component) ────────────────────────────────────────
// mountEditorCode(host, config) — the transparent-<textarea>-over-highlighted-
// <pre> editing surface, generalized out of the SheetWise SQL console so any
// code / SQL / expression input reuses ONE component instead of a page rolling
// its own. The highlighter is COSMETIC (it never parses or executes — the
// backend allowlist is the real guard) and is parameterized by `language` via an
// OPEN registry: a new language is a registration, not a fork (mirrors the
// codec / type registries).
//
// SECURITY: highlight() builds its output from esc()'d slices only — every token
// span wraps escaped source — so the <pre> innerHTML is XSS-safe by construction.
//
// CSS: styles/framework/editor-code.css (rp-editor* + rp-tok-*). Behaviour only —
// this module never touches that sheet.
"use strict";

import { register } from "/scripts/framework/component-registry.js";
import { esc } from "/scripts/dom.js";

// ── language registry ────────────────────────────────────────────────────────
//   def: { keywords:Set|string[], functions:Set|string[], lineComment?:string,
//          strings?:string[] }  — keyword/function matching is case-insensitive.
const LANGUAGES = Object.create(null);

/** Register (or override) a highlight language. Open-ended: a vertical that needs
 *  a new language registers it here; the tokenizer reads the def, no `switch`. */
export function registerEditorLanguage(name, def = {}) {
  LANGUAGES[name] = {
    keywords: def.keywords instanceof Set ? def.keywords : new Set(def.keywords || []),
    functions: def.functions instanceof Set ? def.functions : new Set(def.functions || []),
    lineComment: def.lineComment || null,
    strings: Array.isArray(def.strings) ? def.strings : ["'"],
  };
}

// SQL — the first language (the SheetWise console). Verbatim keyword/function
// sets from the page this component was extracted from.
registerEditorLanguage("sql", {
  keywords: ("select from where group by order having limit offset distinct as join inner left right full outer on "
    + "union all and or not in is null like between case when then else end asc desc with count sum avg min max").split(" "),
  functions: "count sum avg min max coalesce upper lower round cast".split(" "),
  lineComment: "--",
  strings: ["'"],
});

// plain — no highlighting; a reusable fallback for any text/code surface.
registerEditorLanguage("plain", { keywords: [], functions: [], lineComment: null, strings: [] });

/** Cosmetic tokenizer → an HTML string of esc()'d token spans (+ a trailing "\n"
 *  so the <pre>'s final-line height matches the textarea's). */
function highlight(src, lang) {
  const def = LANGUAGES[lang] || LANGUAGES.plain;
  const s = src, lc = def.lineComment, strs = def.strings;
  let out = "", k = 0;
  while (k < s.length) {
    const c = s[k];
    if (lc && s.startsWith(lc, k)) {                               // line comment
      let j = s.indexOf("\n", k); if (j < 0) j = s.length;
      out += '<span class="rp-tok-com">' + esc(s.slice(k, j)) + "</span>"; k = j; continue;
    }
    if (strs.includes(c)) {                                        // string literal
      let j = k + 1; while (j < s.length && s[j] !== c) j++; j = Math.min(j + 1, s.length);
      out += '<span class="rp-tok-str">' + esc(s.slice(k, j)) + "</span>"; k = j; continue;
    }
    if (c >= "0" && c <= "9") {                                    // number
      let j = k; while (j < s.length && /[0-9.]/.test(s[j])) j++;
      out += '<span class="rp-tok-num">' + esc(s.slice(k, j)) + "</span>"; k = j; continue;
    }
    if (/[A-Za-z_]/.test(c)) {                                     // word → keyword/function/ident
      let j = k; while (j < s.length && /[A-Za-z0-9_]/.test(s[j])) j++;
      const w = s.slice(k, j), lw = w.toLowerCase();
      const cls = def.keywords.has(lw) ? "rp-tok-kw" : (def.functions.has(lw) ? "rp-tok-fn" : "");
      out += cls ? '<span class="' + cls + '">' + esc(w) + "</span>" : esc(w); k = j; continue;
    }
    out += esc(c); k++;
  }
  return out + "\n";
}

/**
 * Mount a code editor into `host` (host becomes the `.rp-editor` card). A
 * transparent textarea sits over a highlighted <pre> with identical metrics, so
 * the caret/selection track the rendered tokens.
 * @param {Element} host
 * @param {{ value?:string, language?:string, placeholder?:string, ariaLabel?:string,
 *           bar?:boolean, hint?:string,
 *           onInput?:(value:string)=>void, onRun?:(value:string)=>void }} [opts]
 *   onRun fires on ⌘/Ctrl+Enter. Tab inserts two spaces (never leaves the field).
 *   bar:true renders a footer bar (hint text + an actions slot the caller fills
 *   with its own rp-btn-icon buttons — exposed as the returned `actions`).
 * @returns {{ el:Element, actions:Element|null, getValue:()=>string,
 *             setValue:(v:string)=>void, focus:()=>void,
 *             insertAtCaret:(text:string)=>void, destroy:()=>void }}
 */
export function mountEditorCode(host, opts = {}) {
  if (!host) return null;
  const lang = opts.language || "sql";
  host.className = "rp-editor";
  host.innerHTML =
      '<div class="rp-editor-scroll">'
    +   '<pre class="rp-editor-hi" aria-hidden="true"></pre>'
    +   '<textarea class="rp-editor-input" spellcheck="false" autocapitalize="off"'
    +     ' autocomplete="off" autocorrect="off"'
    +     (opts.ariaLabel ? ' aria-label="' + esc(opts.ariaLabel) + '"' : '')
    +     (opts.placeholder ? ' placeholder="' + esc(opts.placeholder) + '"' : '')
    +   '></textarea>'
    + '</div>'
    + (opts.bar
        ? '<div class="rp-editor-bar">'
          + '<span class="rp-editor-hint">' + esc(opts.hint || "") + '</span>'
          + '<span class="rp-editor-actions"></span>'
          + '</div>'
        : '');

  const ta = host.querySelector(".rp-editor-input");
  const hi = host.querySelector(".rp-editor-hi");
  ta.value = opts.value != null ? String(opts.value) : "";

  function sync() {
    hi.innerHTML = highlight(ta.value, lang);
    hi.scrollTop = ta.scrollTop; hi.scrollLeft = ta.scrollLeft;
  }
  const onScroll = () => { hi.scrollTop = ta.scrollTop; hi.scrollLeft = ta.scrollLeft; };
  const onInput = () => { sync(); opts.onInput?.(ta.value); };
  const onFocus = () => host.classList.add("is-focus");
  const onBlur = () => host.classList.remove("is-focus");
  const onKeydown = (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); opts.onRun?.(ta.value); }
    else if (e.key === "Tab") {
      e.preventDefault();
      ta.setRangeText("  ", ta.selectionStart, ta.selectionEnd, "end"); sync();
    }
  };
  ta.addEventListener("input", onInput);
  ta.addEventListener("scroll", onScroll);
  ta.addEventListener("focus", onFocus);
  ta.addEventListener("blur", onBlur);
  ta.addEventListener("keydown", onKeydown);

  sync();

  return {
    el: host,
    actions: host.querySelector(".rp-editor-actions"),
    getValue: () => ta.value,
    setValue: (v) => { ta.value = v == null ? "" : String(v); sync(); },
    focus: () => ta.focus(),
    insertAtCaret: (text) => {
      ta.setRangeText(String(text), ta.selectionStart, ta.selectionEnd, "end");
      sync(); opts.onInput?.(ta.value); ta.focus();
    },
    destroy: () => {
      ta.removeEventListener("input", onInput); ta.removeEventListener("scroll", onScroll);
      ta.removeEventListener("focus", onFocus); ta.removeEventListener("blur", onBlur);
      ta.removeEventListener("keydown", onKeydown);
      host.innerHTML = ""; host.className = "";
    },
  };
}

register("editor-code", mountEditorCode);
