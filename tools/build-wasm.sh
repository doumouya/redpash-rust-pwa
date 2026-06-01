#!/usr/bin/env sh
# Purpose: builds the data crate as a browser-loadable wasm module.
# Doc: docs/internal/code/tools/shell/build-wasm.md
# ─────────────────────────────────────────────────────────────────────────────
# Build the `data` crate as a browser-loadable wasm module.
#
# Four stages, gated by `wasm-bindgen` and `wasm-opt`:
#   1. `cargo build --target wasm32-unknown-unknown -p data` (release)
#   2. `wasm-bindgen --target web` → JS glue + import-bound .wasm
#   3. `wasm-opt -Oz --strip-debug` → final cdylib
#   4. content-hash the .wasm (data_bg.<hash>.wasm) + rewrite the data.js
#      loader → the hash is the cache version (no manual bumping, never stale)
#
# Output lands in `frontend/wasm/` (gitignored — regenerated on demand).
# Source of truth: backend/crates/data/src/wasm.rs (the four wrappers).
# See docs/internal/roadmap-webassembly.md for the architecture context.
#
# Usage:  sh tools/build-wasm.sh
# Run from anywhere; resolves the repo root from this script's location.
#
# Prerequisites (one-shot, per machine):
#   rustup target add wasm32-unknown-unknown
#   cargo install wasm-bindgen-cli --version 0.2.121
#   cargo install wasm-opt
# ─────────────────────────────────────────────────────────────────────────────
set -e

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT/backend"

echo "════════════════════════  1/3  cargo build (release, wasm32)  ════════════════════════"
RUSTFLAGS='--cfg getrandom_backend="wasm_js"' \
  cargo build --release --target wasm32-unknown-unknown -p data
cd "$REPO_ROOT"

echo
echo "════════════════════════  2/3  wasm-bindgen → frontend/wasm/  ═══════════════════════"
mkdir -p frontend/wasm
wasm-bindgen --target web --out-dir frontend/wasm --out-name data \
  backend/target/wasm32-unknown-unknown/release/data.wasm

echo
echo "════════════════════════  3/3  wasm-opt -Oz --strip-debug  ══════════════════════════"
wasm-opt -Oz --strip-debug \
  --enable-reference-types --enable-bulk-memory --enable-mutable-globals \
  --enable-nontrapping-float-to-int --enable-sign-ext --enable-simd \
  --enable-multivalue --enable-tail-call --enable-extended-const --enable-gc \
  -o frontend/wasm/data_bg.opt.wasm frontend/wasm/data_bg.wasm
mv frontend/wasm/data_bg.opt.wasm frontend/wasm/data_bg.wasm

echo
echo "════════════════════════  4/4  content-hash (kills manual cache-bumping)  ════════════"
# The wasm is big (~12 MB) + rebuilt often. Naming it by CONTENT HASH makes
# the hash the cache version: every rebuild → new bytes → new hash → new
# URL, so the browser cache-misses fresh (never stale) with ZERO manual
# version bumps — the treadmill that got the caching SW gutted. Drop any
# prior hashed build so the dir holds exactly one, then rewrite the single
# loader reference in data.js (wasm-bindgen's `new URL('data_bg.wasm', …)`).
rm -f frontend/wasm/data_bg.*.wasm
HASH=$(sha256sum frontend/wasm/data_bg.wasm | cut -c1-12)
mv frontend/wasm/data_bg.wasm "frontend/wasm/data_bg.${HASH}.wasm"
sed -i "s|new URL('data_bg.wasm', import.meta.url)|new URL('data_bg.${HASH}.wasm', import.meta.url)|" frontend/wasm/data.js
echo "  data_bg.${HASH}.wasm  (data.js loader rewritten — content-versioned, no manual bump)"
WASM_FILE="frontend/wasm/data_bg.${HASH}.wasm"

echo
echo "════════════════════════  artifact sizes  ═══════════════════════════════════════════"
for f in "$WASM_FILE" frontend/wasm/data.js; do
  raw=$(wc -c < "$f")
  gz=$(gzip -c -9 "$f" | wc -c)
  awk -v f="$f" -v raw="$raw" -v gz="$gz" \
    'BEGIN { printf "  %-32s  %7.2f MB raw  %7.2f MB gz\n", f, raw/1024/1024, gz/1024/1024 }'
done

total_gz=$( { gzip -c -9 "$WASM_FILE"; gzip -c -9 frontend/wasm/data.js; } | wc -c )
awk -v t="$total_gz" 'BEGIN { printf "  TOTAL OVER-THE-WIRE              %7.2f MB gz\n", t/1024/1024 }'
echo
echo "done."
