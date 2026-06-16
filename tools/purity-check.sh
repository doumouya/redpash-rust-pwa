#!/usr/bin/env sh
# Purpose: the mechanical "one engine, two surfaces" gate.
# The data crate must compile to wasm32-unknown-unknown at every commit —
# zero io / http / threads / time. In the predecessor this rule was held by
# convention and a grep; here it fails the build instead.
#
# getrandom 0.3 needs the wasm_js backend cfg flag to build for wasm32 (the
# data crate enables the `wasm_js` feature; this RUSTFLAG flips it on for
# every transitive consumer — polars/ahash). Same flag tools/build-wasm.sh
# will pass.
set -eu
cd "$(dirname "$0")/../backend"
echo "purity-check: cargo check --target wasm32-unknown-unknown -p data"
RUSTFLAGS='--cfg getrandom_backend="wasm_js"' \
    cargo check --quiet --target wasm32-unknown-unknown -p data
echo "purity-check: OK — data crate is wasm32-clean"
