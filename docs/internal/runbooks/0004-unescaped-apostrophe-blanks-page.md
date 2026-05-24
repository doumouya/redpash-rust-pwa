---
title: 0004 — Unescaped apostrophe blanks the page
section: Internal
order: 4
last modified date: 2026-05-24
---

# 0004 — Unescaped apostrophe blanks the page

**Date:** 2026-05-24 · **Area:** frontend / Docs page · **Status:** resolved (commit `c9acfbf`)

## Problem Statement

Navigating to `/docs` rendered the generic mount-failure shell
(*"Something went wrong — reload to try again."*). The rail and
body were both empty. Browser console showed:

```
[router] mount failed: SyntaxError: unexpected token: identifier
  navigate    http://localhost:8080/scripts/main.js:84
```

Backend served `/scripts/pages/docs.js` with HTTP 200 and the full
~5 KB body — the file delivered fine, it just didn't parse. Other
pages (`/workspace`, `/monitoring`, `/objects`) loaded normally;
only `/docs` was broken.

## Troubleshooting steps

1. **Confirmed delivery, not 404.** `curl -I /scripts/pages/docs.js`
   → `200`, `content-length: 5163`. The asset was being served,
   the browser just rejected it at parse time.

2. **Read the error literally.** *"Unexpected token: identifier"*
   means the parser tripped over a bare identifier where a
   delimiter or operator was expected. That's a classic shape for
   a string-literal that closed early — the parser carries on,
   hits a letter, and treats it as the start of an identifier.

3. **Scanned `docs.js` for single-quoted strings with apostrophes.**
   Pattern: a `'...x'y...'` where the middle `'` was meant to be
   a typographic apostrophe but is a real one. Hit on line 160:

   ```js
   view.innerHTML = '<p class="rp-shell-state">No docs yet — '
     + 'drop a markdown file into <code>docs/</code> and it'll appear.</p>';
   ```

4. **Confirmed by inspection.** The string opens at the second
   `'`, runs through `drop a markdown file into <code>docs/</code> and it`
   and closes at the apostrophe in `it'll`. After the close, `ll`
   parses as an identifier — exactly the reported error.

The whole diagnosis took two minutes; the error message named the
file and the symptom uniquely identified the bug class.

## RCA

Two compounding causes:

1. **Mixed apostrophe conventions in the same file.** The rest of
   `docs.js` uses the curly `'` (U+2019) inside single-quoted
   strings to dodge exactly this problem — e.g. line 153
   `Couldn't load this doc`. The empty-state string was added
   later and used the straight ASCII `'`, which silently breaks
   the enclosing literal.

2. **No parser-level CI gate on the JS files.** The file ships as
   a static asset and only fails at browser parse time, so
   nothing between "save" and "load in browser" caught it. There
   is no build step that would have rejected the change.

The static-asset / no-build pipeline is a deliberate choice (see
[[no-frameworks]] memory), and on balance still the right one for
RedPash's stage — but it does mean a one-character typo can take
a whole page off the air with no warning until someone navigates
to it.

## Solution

Replaced the straight apostrophe with the curly U+2019, matching
the rest of the file:

```js
view.innerHTML = '<p class="rp-shell-state">No docs yet — '
  + 'drop a markdown file into <code>docs/</code> and it’ll appear.</p>';
```

Commit: `c9acfbf`.

## Post Checking

1. Hard refresh `/docs` — rail + body render. ✓
2. Browser console — no SyntaxError. ✓
3. Click a doc tab in the rail — body loads. ✓
4. `grep -rn "'[^']*[a-z]'[a-z]" frontend/scripts/` — no other
   suspect strings outside JSDoc comments. ✓

## The discipline this updates

When writing **user-facing strings with contractions** in a
single-quoted JS literal, three safe options — in preference
order:

1. **Use the curly apostrophe `'` (U+2019)** when the string is
   prose for the UI. It's typographically nicer anyway and the
   existing files already use it. *"Couldn't"*, *"it'll"*,
   *"won't"*, *"you're"* — all should be U+2019.
2. **Escape with `\'`** when you specifically want the ASCII
   apostrophe (e.g. code samples shown to the user).
3. **Switch to double quotes or template literals** for the
   offending string. Avoid mixing conventions inside a single
   `+`-concatenated HTML chunk.

What does NOT work as a defense:

- Hoping the linter catches it — there is no linter on the
  static-asset path today.
- Trusting that "it parses on my machine" — the bug is
  deterministic; if you typed `'` instead of `'`, the file is
  broken for everyone.

### Follow-up worth a pass

A one-shot grep across `frontend/scripts/` for the pattern
`'[^']*[a-z]'[a-z]` (with a manual filter for JSDoc / comment
hits) found zero other instances at the time of this entry. The
defense for the long run is one of:

- A pre-commit hook that runs a JS parser (acorn, esbuild, or
  even `node --check` adapted for ESM) over the changed files.
  Cheap, blocks the bug class entirely.
- Or just continue with the typographic-apostrophe convention,
  enforced by code review.

For now the convention is the defense. If this happens a second
time, ship the pre-commit hook.

## Linked

- The fix — commit `c9acfbf`.
- The convention this rule enforces — already in use across
  `frontend/scripts/pages/*.js` for contractions.
- Related discipline — [[no-mystery-css]] (the analogue: an
  unaccounted-for CSS file breaks the live app silently). Same
  shape of bug, different file type.
