---
title: Page — Docs
section: Internal
last modified date: 2026-06-07
---

# Page — Docs

## Purpose

`/docs` is the in-app markdown reader. It answers one question: **"how does
this thing work?"** without leaving the app or opening the repo. The whole
`docs/` markdown tree is served straight to the browser, rendered to HTML, and
browsed through the standard rail-shell — so documentation ships with the app
and is one click away from any page (via the rail footer's Docs link).

It is a thin viewer: there is no editing, no auth-gated content, no DB. The
page is pure presentation over two read-only endpoints.

## What it serves today (reality)

The reader currently serves the **public `docs/` tier**. The backend route
hard-codes `DOCS_DIR = "../docs"` (relative to `backend/`, the server CWD) and
walks that tree recursively for `*.md` files. So whatever lives under `docs/`
— including `docs/internal/` — is technically reachable, but the index is the
public-facing docs, not the internal survival layer.

> **Phase E repoints this at `docs/internal/`.** The plan is to change the
> backend's `DOCS_DIR` (and the index/sort contract) so the reader becomes the
> in-app window onto the internal docs spine. Until that lands, treat `/docs`
> as the public-docs reader. The page script itself needs no change — it is
> source-agnostic; it renders whatever the API returns.

## Rail

The rail is **section groups containing doc tabs**, built entirely from the
`/api/docs` index — there is no hand-authored tab list to drift.

- The index returns items pre-sorted: **`section == "Start here"` first**, then
  alphabetical by section name, then by each doc's `order`, then title. The
  frontend preserves that server order exactly: `groupBySection` walks the flat
  list and starts a new group only when the section name changes (a Map would
  silently re-order, breaking the "Start here first" contract).
- Each group is a collapsible header (chevron + a 2-letter color-coded mark +
  doc count). Groups are **expanded by default** — section count is small and
  the user wants to scan the whole table of contents at once. Group accent
  colors cycle blue → mauve → teal → peach by index.
- Each tab is a doc (file-text icon + title). The active tab carries `.active`.

Rail collapse uses the shared `rail-controls` helper; the rail footer (Docs /
Settings / Profile) and the topbar are the standard shared chrome.

## Surface

The body renders the active doc at full width — the shell is `.rp-shell--wide`
because long-form prose reads better wide than in the normal railed column.

**Routing is hash-driven, one URL per doc.** Clicking a tab sets
`#/docs?slug=<slug>`; the router re-mounts `/docs` on `hashchange`, and on mount
the page reads the slug back out of the URL. That makes every doc shareable and
back-button-friendly. A bare `#/docs` (no slug) defaults to the **first doc of
the first section** so the body is never empty on landing; if the requested
slug isn't in the index it also falls back to that first doc.

The `slug` is the doc's path under `docs/` with the `.md` stripped (e.g.
`api/auth`, `frontend/design`). Loading a doc hits `GET /api/docs/<slug>`,
which returns **rendered HTML** (not JSON) — `api.js`'s `safeJson` fallback
hands back the raw text when a response isn't JSON-parseable, so the same `api`
client serves both the index and the rendered body. The page wraps the HTML in
a header (title + `last modified` stamp pulled from the index item) and an
`<article class="rp-doc">`.

### Backend rendering (why it's lean)

The route parses frontmatter by hand — it's flat `key: value` lines fenced by
`---`, so no YAML library is pulled in. Note the frontmatter key is
`last modified date` (with spaces), matching the convention every doc in this
repo uses. Markdown → HTML is `pulldown-cmark` with all options on; code blocks
render as plain `<pre><code>` with **no syntax highlighter** — a deliberate
lean choice. The render route guards against path traversal by rejecting any
slug containing `..`, keeping reads inside the docs tree. The route is
**public**: no auth, no DB touch.

### Failure + empty states

Every fetch has an explicit state: the index sets a rail error (with status
code if present) and an empty body message if `/api/docs` fails; a per-doc
load shows "Loading…" then an error line if `/api/docs/<slug>` fails; and if
the index is genuinely empty the body invites dropping a markdown file into
`docs/` to make it appear.

## Source files

- [../code/frontend/scripts/pages/docs.md](../code/frontend/scripts/pages/docs.md) — the page script (rail grouping, hash routing, doc render).
- [../code/backend/api/routes/docs.md](../code/backend/api/routes/docs.md) — the `/api/docs` index + render endpoints (frontmatter parse, pulldown-cmark, `DOCS_DIR`).
- [../code/frontend/scripts/api.md](../code/frontend/scripts/api.md) — the fetch client; `safeJson` fallback that returns raw HTML for the render route.
- [../code/frontend/scripts/topbar.md](../code/frontend/scripts/topbar.md) — shared topbar chrome.
- [../code/frontend/scripts/rail-footer.md](../code/frontend/scripts/rail-footer.md) — shared rail footer (the Docs / Settings / Profile nav that links here).
- [../code/frontend/scripts/rail-controls.md](../code/frontend/scripts/rail-controls.md) — shared rail collapse behavior.
- [../code/frontend/scripts/dom.md](../code/frontend/scripts/dom.md) — `esc` / `cssEsc` HTML/selector escaping helpers.
