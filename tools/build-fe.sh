#!/bin/sh
# build-fe — hashed release build of the frontend (S8). See build-fe.mjs.
set -e
cd "$(dirname "$0")/.."
node tools/build-fe.mjs
