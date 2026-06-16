#!/usr/bin/env bash
# Purpose: build the data crate's browser engine — the 4-stage pipeline:
#   1. cargo build (wasm32, release, getrandom wasm_js backend)
#   2. wasm-bindgen --target web  → frontend/wasm/data.js glue + data_bg.wasm
#   3. wasm-opt -Oz               → size-optimized binary
#   4. content-hash rename        → data_bg.<hash12>.wasm + loader URL rewrite
# THE HASH IS THE CACHE VERSION: a rebuild yields new bytes → new hash → new
# URL, so the service worker's cache-first can never serve a stale engine and
# nobody ever hand-bumps a cache version.
set -euo pipefail
cd "$(dirname "$0")/.."

# shellcheck disable=SC1090
. "$HOME/.cargo/env" 2>/dev/null || true

OUT=frontend/wasm
TARGET=backend/target/wasm32-unknown-unknown/release/data.wasm

echo "== 1/4 cargo build (wasm32 release)"
(cd backend && RUSTFLAGS='--cfg getrandom_backend="wasm_js"' \
  cargo build --quiet --release --target wasm32-unknown-unknown -p data)

echo "== 2/4 wasm-bindgen"
rm -rf "$OUT"
mkdir -p "$OUT"
wasm-bindgen --target web --out-dir "$OUT" --out-name data "$TARGET"

echo "== 3/4 wasm-opt -Oz"
wasm-opt -Oz --strip-debug --enable-bulk-memory --enable-nontrapping-float-to-int \
  -o "$OUT/data_bg.opt.wasm" "$OUT/data_bg.wasm"
mv "$OUT/data_bg.opt.wasm" "$OUT/data_bg.wasm"

echo "== 4/4 content-hash"
HASH=$(sha256sum "$OUT/data_bg.wasm" | cut -c1-12)
mv "$OUT/data_bg.wasm" "$OUT/data_bg.${HASH}.wasm"
# the bindgen glue references data_bg.wasm relative to itself — point it at
# the hashed name
sed -i "s/data_bg\.wasm/data_bg.${HASH}.wasm/g" "$OUT/data.js"

RAW=$(stat -c%s "$OUT/data_bg.${HASH}.wasm")
GZ=$(gzip -c "$OUT/data_bg.${HASH}.wasm" | wc -c)
echo "engine: data_bg.${HASH}.wasm  raw $((RAW / 1024)) KiB · gz $((GZ / 1024)) KiB"
