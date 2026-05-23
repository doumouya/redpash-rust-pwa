---
title: Omnisearch keystroke → navigate
section: Internal
order: 43
last modified date: 2026-05-24
status: stub
---

# Flow: Omnisearch keystroke → navigate

> **TODO.** Fill with the actual request waterfall in DevTools.

To cover:

- Keystroke handler in `topbar.js` → debounce 200ms → AbortController setup
- `api.get("/search?q=...&limit=20", { signal })` — `q` URL-encoded
- Server (`routes/search.rs`): ILIKE on indexed columns across projects/files/charts; group by kind; rank with prefix-match boost
- Response: `{ q, ms, results: [{ kind, rid, label, sub, hash }] }`
- Frontend render: section header on kind transition; per-row icon from `kindIcon(kind)` (additive — unknown kinds fall back to `bi-dot`)
- Match highlight: first case-insensitive substring of `q` wrapped in `.rp-omni-hl`
- Keyboard: ↓/↑ cycle (wrap), Enter → `location.hash = r.hash`, Esc → close + blur
- Out-of-order replies suppressed by `inflight.abort()` on next keystroke
