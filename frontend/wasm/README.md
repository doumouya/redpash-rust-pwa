# `frontend/wasm/` — the data crate as a browser module

wasm-bindgen output for `backend/crates/data` — the same engine that
runs server-side, served to the browser. Architecture context in
[`docs/internal/roadmap-webassembly.md`](../../docs/internal/roadmap-webassembly.md).

## Generated artifacts (gitignored)

| File | Purpose | Approx size |
|---|---|---:|
| `data_bg.wasm` | the engine (wasm-opt -Oz) | ~11.5 MB raw / ~3.3 MB gz |
| `data.js` | wasm-bindgen JS glue | ~18 KB raw / ~4 KB gz |
| `data.d.ts`, `data_bg.wasm.d.ts` | TypeScript types | — |

These are regenerated from the Rust source — they are **not** committed.
After any change to `backend/crates/data/src/wasm.rs` (or any
upstream `data` crate code), regenerate with:

```sh
sh tools/build-wasm.sh
```

## How to call from the frontend

Use [`frontend/scripts/wasm-engine.js`](../scripts/wasm-engine.js) — it
handles the lazy load and the demo size cap. Don't import
`/wasm/data.js` directly from page code; the loader exists so the page
shell never blocks on a 3 MB download cold-visitor never asked for.

```js
import { getEngine, gateBySize, DEMO_CAP_BYTES } from '/scripts/wasm-engine.js';

// Demo flow (login page):
const file = inputEl.files[0];
try { gateBySize(file); } catch (e) { showSignUpCTA(e.message); return; }

const text = await file.text();
const rows = /* parse CSV → array of row objects */;

const engine = await getEngine();             // ~3 MB download on first await; cached after
const cleaned = JSON.parse(engine.auto_clean(JSON.stringify(rows)));
//   { rows: [...cleaned row objects...], summary: { cells_trimmed, junk_blanked, duplicate_rows_dropped } }
```

The four entry points (`apply_filter`, `apply_sort`, `auto_clean`,
`step_preview`) are defined in `backend/crates/data/src/wasm.rs`. All
take JSON strings and return JSON strings; no Polars types cross the
JS boundary.

## When to load the engine

| Surface | Load timing |
|---|---|
| Landing page (visitor) | **Lazy** — `getEngine()` awaited only after `gateBySize` passes, i.e. user committed to a real file under the cap. Cold visitors pay nothing. |
| Logged-in workspace | **Preload** — `getEngine()` fired on workspace mount, await later. The user is going to do data work; warm the cache. |
| Any background tab | Don't. The lazy pattern handles this for you. |

## Why not ship two engines (one tiny for landing, one full for workspace)?

[Two engines = two surfaces = a downgrade-then-upgrade gap.](../../docs/internal/roadmap-webassembly.md) The
visitor signs up because of what they tried; if that was a watered-down
demo, the post-sign-up experience is a *less-magical* version of the
moment that converted them. One engine, one experience — gated by
**capacity** (file size), not by **capability**.
