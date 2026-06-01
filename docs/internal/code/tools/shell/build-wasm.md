---
title: tools/build-wasm.sh
source: ../../../../../tools/build-wasm.sh
owner: Gus
section: Internal · Code · Tools · shell
last modified date: 2026-05-30
---

# build-wasm.sh

## Purpose

Builds the `data` crate as a browser-loadable WASM module — the bundle
the login-page CSV demo loads to run `parse_csv` + `auto_clean`
client-side. Four stages gated by `wasm-bindgen` and `wasm-opt`:
release-mode cargo build → wasm-bindgen JS wrapper generation → wasm-opt
size pass → **content-hash** (rename `data_bg.wasm` → `data_bg.<sha256[:12]>.wasm`
and rewrite the single loader ref in `data.js`). Output lands in the frontend
bundle dir so the login page can `import('/wasm/data.js')`.

## Public surface

- `sh tools/build-wasm.sh` — one-shot build with all three stages.
- Reads `wasm-bindgen` and `wasm-opt` from `PATH`; logs versions inline.
- Writes the bundle under `frontend/wasm/` (or whatever
  `wasm-bindgen --out-dir` resolves to in the script).

## Drift-prone areas

- **wasm-bindgen / wasm-opt versions** must match the project pin in
  `Cargo.toml`. Drift here breaks the build silently — `stack-version.sh`
  flags it.
- **The script assumes a release build** (the dev path uses `cargo
  watch` instead). Don't add debug-mode without splitting the entry.
- **Content-hash (stage 4, 2026-06-01):** the `.wasm` is named by its sha256
  prefix so the hash IS the cache version — every rebuild auto-versions the URL
  (never stale, never a manual cache-version bump, the treadmill that got the
  caching SW gutted). `data.js`'s `new URL('data_bg.wasm', …)` is rewritten to
  the hashed name; `.gitignore` covers `data_bg*.wasm`; the dir holds exactly
  one (`rm -f data_bg.*.wasm` before the rename). Do NOT reintroduce a manual
  SW cache-version. Offline caching, when wanted, = SW Cache API keyed on this
  hashed URL — see [wasm-engine](../../../subsystems/wasm-engine.md).

## Related

- [Sibling: stack-version.sh](stack-version.md) — version probe
- [Architecture: roadmap-webassembly](../../../architecture/roadmap-webassembly.md)
- [Subsystem: wasm-engine](../../../subsystems/wasm-engine.md)
