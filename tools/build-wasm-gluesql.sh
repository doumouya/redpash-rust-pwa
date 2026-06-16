#!/usr/bin/env bash
# Purpose: build the on-device GlueSQL store (frontend/wasm-src/gluesql) — the
# customer-data engine: GlueSQL + IndexedDB, shipped beside the Polars engine.
# Same 4-stage pipeline + content-hash-as-cache-version as tools/build-wasm.sh,
# but a SEPARATE, self-isolated crate (its idb/getrandom-js deps never touch the
# pure `data` crate or the native build). Output: frontend/wasm/gluesql.js + the
# hashed gluesql_bg.<hash>.wasm.
set -euo pipefail
cd "$(dirname "$0")/.."

# shellcheck disable=SC1090
. "$HOME/.cargo/env" 2>/dev/null || true

OUT=frontend/wasm
SRC=frontend/wasm-src/gluesql
TARGET="$SRC/target/wasm32-unknown-unknown/release/gluesql_store.wasm"

echo "== 1/4 cargo build (wasm32 release) — gluesql-store"
# getrandom 0.2 + the "js" feature handles wasm RNG; no RUSTFLAGS cfg needed.
(cd "$SRC" && cargo build --quiet --release --target wasm32-unknown-unknown)

echo "== 2/4 wasm-bindgen"
wasm-bindgen --target web --out-dir "$OUT" --out-name gluesql "$TARGET"

echo "== 3/4 wasm-opt -Oz"
wasm-opt -Oz --strip-debug --enable-bulk-memory --enable-nontrapping-float-to-int \
  -o "$OUT/gluesql_bg.opt.wasm" "$OUT/gluesql_bg.wasm"
mv "$OUT/gluesql_bg.opt.wasm" "$OUT/gluesql_bg.wasm"

echo "== 4/4 content-hash"
HASH=$(sha256sum "$OUT/gluesql_bg.wasm" | cut -c1-12)
mv "$OUT/gluesql_bg.wasm" "$OUT/gluesql_bg.${HASH}.wasm"
sed -i "s/gluesql_bg\.wasm/gluesql_bg.${HASH}.wasm/g" "$OUT/gluesql.js"

RAW=$(stat -c%s "$OUT/gluesql_bg.${HASH}.wasm")
GZ=$(gzip -c "$OUT/gluesql_bg.${HASH}.wasm" | wc -c)
echo "store: gluesql_bg.${HASH}.wasm  raw $((RAW / 1024)) KiB · gz $((GZ / 1024)) KiB"
