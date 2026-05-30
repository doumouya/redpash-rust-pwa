#!/usr/bin/env bash
# Purpose: installs the runtime stack (Rust + Postgres + Node + wasm tools).
# Doc: docs/internal/code/tools/shell/install-stack.md
# Re-exec under bash when invoked via `sh script.sh` (which ignores the
# shebang). Sibling of stack-version.sh — see that file's comment block
# for the version-probe catalog this script installs against.
if [ -z "${BASH_VERSION-}" ]; then exec bash "$0" "$@"; fi
# ── install-stack.sh ─────────────────────────────────────────────────────────
# Idempotent installer for the RedPash dev stack on a fresh Ubuntu host.
# Skips anything already present + at MIN_VERSION; otherwise installs from
# the canonical source for that tool (apt for OS packages, rustup for the
# Rust toolchain, nvm for Node, cargo for wasm-pack).
#
# Targets the version floor declared in `tools/stack-version.sh`:
#
#   rustc / cargo  ≥ 1.75      via rustup (+ wasm32-unknown-unknown target)
#   node / npm     ≥ 18 / 9    via nvm + node 24 LTS
#   psql           ≥ 14        via apt (postgresql + postgresql-client)
#   git            ≥ 2.30      via apt
#   bash           ≥ 5.0       via apt (already on Ubuntu by default)
#   jq             ≥ 1.6       via apt
#   curl           ≥ 7.70      via apt
#   wasm-pack      ≥ 0.12      via cargo install
#   wasm-opt       ≥ 100       via apt (binaryen)
#
# Deliberately skipped: python3. Tagged `optional` in stack-version.sh —
# RedPash is Rust + vanilla JS; nothing in the runtime needs Python. Two
# corpus-prep scripts in tools/ (csv-to-xlsx.py, wasm-bench/generate.py)
# are the only consumers, and they're one-shot dev utilities you can
# install ad-hoc with `apt install python3` if you ever run them.
#
# Exit codes:
#   0 — every required tool is at or above MIN_VERSION after the run
#   1 — at least one required tool failed to install
#
# Usage:
#   sh tools/install-stack.sh                # install everything missing
#   sh tools/install-stack.sh --dry-run      # report what would happen, no changes
#
# After the script, re-run `sh tools/stack-version.sh` to verify the
# floor. The two scripts are a matched pair — same catalog, opposite
# operations.

set -u

# ── argv ────────────────────────────────────────────────────────────────────
DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    -h|--help)
      sed -n '/^# ── install-stack.sh/,/^$/p' "$0" | sed 's/^# //;s/^#//'
      exit 0 ;;
    *) echo "unknown argument: $arg (try --help)"; exit 2 ;;
  esac
done

# ── color tags (mirrors stack-version.sh) ───────────────────────────────────
if [ -t 1 ] && command -v tput >/dev/null 2>&1; then
  C_OK=$(tput setaf 2); C_WARN=$(tput setaf 3); C_BAD=$(tput setaf 1)
  C_DIM=$(tput setaf 8 2>/dev/null || tput setaf 7); C_RST=$(tput sgr0); C_BOLD=$(tput bold)
else
  C_OK=""; C_WARN=""; C_BAD=""; C_DIM=""; C_RST=""; C_BOLD=""
fi
TAG_OK="${C_OK}✓${C_RST}"
TAG_INSTALL="${C_WARN}→${C_RST}"
TAG_FAIL="${C_BAD}✗${C_RST}"

run() {
  if [ "$DRY_RUN" -eq 1 ]; then
    echo "  ${C_DIM}[dry] $*${C_RST}"
    return 0
  fi
  echo "  ${C_DIM}\$ $*${C_RST}"
  "$@"
}

# vercmp A B → 0 if A >= B (sort -V handles 1.10 > 1.9 correctly).
vercmp() {
  local a="${1#v}" b="${2#v}"
  [ "$(printf '%s\n%s' "$a" "$b" | sort -V | head -1)" = "$b" ]
}

# Extract first version-like token from a command's `--version` output.
probe_ver() {
  "$@" 2>/dev/null | head -1 | grep -oE '[0-9]+(\.[0-9]+){0,3}' | head -1
}

# need NAME CMD VERSION_FLAG MIN_VER INSTALL_FN
#   Runs INSTALL_FN unless `command -v CMD` exists AND its version is ≥ MIN_VER.
need() {
  local name="$1" cmd="$2" flag="$3" min="$4" install_fn="$5"
  echo "${C_BOLD}── $name${C_RST}"
  if command -v "$cmd" >/dev/null 2>&1; then
    local cur; cur=$(probe_ver "$cmd" "$flag")
    if [ -n "$cur" ] && vercmp "$cur" "$min"; then
      echo "  $TAG_OK present at $cur (≥ $min)"
      return 0
    fi
    echo "  $TAG_INSTALL present at ${cur:-unknown} — below floor $min, upgrading"
  else
    echo "  $TAG_INSTALL not installed — installing"
  fi
  "$install_fn"
  if command -v "$cmd" >/dev/null 2>&1; then
    local now; now=$(probe_ver "$cmd" "$flag")
    if [ -n "$now" ] && vercmp "$now" "$min"; then
      echo "  $TAG_OK installed at $now"
    else
      echo "  $TAG_FAIL post-install version ${now:-(missing)} still below $min"
      FAILED=$((FAILED + 1))
    fi
  else
    echo "  $TAG_FAIL post-install: command still missing"
    FAILED=$((FAILED + 1))
  fi
}

FAILED=0
APT_UPDATED=0
apt_install() {
  if [ "$APT_UPDATED" -eq 0 ]; then
    run sudo apt-get update -qq
    APT_UPDATED=1
  fi
  run sudo apt-get install -y --no-install-recommends "$@"
}

# ── per-tool installers ─────────────────────────────────────────────────────
install_git()      { apt_install git; }
install_curl()     { apt_install curl ca-certificates; }
install_jq()       { apt_install jq; }
install_bash()     { apt_install bash; }
install_psql()     { apt_install postgresql postgresql-client; }
install_wasm_opt() { apt_install binaryen; }  # provides wasm-opt
install_build_tools() {
  apt_install build-essential pkg-config libssl-dev libpq-dev
}

# rustup — single-file installer from rustup.rs. Adds the
# wasm32-unknown-unknown target post-install (Phase A+B WASM groundwork).
install_rust() {
  if [ "$DRY_RUN" -eq 0 ]; then
    install_build_tools
    run curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs -o /tmp/rustup-init.sh
    run sh /tmp/rustup-init.sh -y --default-toolchain stable --profile minimal
    # shellcheck disable=SC1091
    [ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"
    run rustup target add wasm32-unknown-unknown
  else
    echo "  ${C_DIM}[dry] curl https://sh.rustup.rs | sh -s -- -y --default-toolchain stable${C_RST}"
    echo "  ${C_DIM}[dry] rustup target add wasm32-unknown-unknown${C_RST}"
  fi
}

# nvm — installs to ~/.nvm, sources via shell rc. Picks node 24 (LTS at
# time of writing, matches the version stack-version.sh probes against).
install_node() {
  if [ "$DRY_RUN" -eq 0 ]; then
    install_curl
    run curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
    export NVM_DIR="$HOME/.nvm"
    # shellcheck disable=SC1091
    [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
    run nvm install 24
    run nvm alias default 24
  else
    echo "  ${C_DIM}[dry] curl nvm.sh install + nvm install 24${C_RST}"
  fi
}

# wasm-pack via cargo (sources tied to rustup's toolchain so we get a
# compatible build). Idempotent — cargo install is a no-op when the
# binary's already at the requested version.
install_wasm_pack() {
  if [ "$DRY_RUN" -eq 0 ]; then
    # shellcheck disable=SC1091
    [ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"
    run cargo install --locked wasm-pack
  else
    echo "  ${C_DIM}[dry] cargo install --locked wasm-pack${C_RST}"
  fi
}

# ── header ──────────────────────────────────────────────────────────────────
echo ""
echo "${C_BOLD}RedPash stack — install${C_RST}    $(date '+%FT%T%z')"
if [ "$DRY_RUN" -eq 1 ]; then
  echo "  ${C_WARN}DRY RUN — no changes will be made${C_RST}"
fi
echo ""

# ── run, in dependency order ────────────────────────────────────────────────
# OS deps + apt-installed binaries first (curl needed for rustup + nvm).
need "git"       git       "--version" "2.30.0" install_git
need "curl"      curl      "--version" "7.70.0" install_curl
need "bash"      bash      "--version" "5.0.0"  install_bash
need "jq"        jq        "--version" "1.6"    install_jq
need "psql"      psql      "--version" "14.0"   install_psql
need "wasm-opt"  wasm-opt  "--version" "100"    install_wasm_opt

# Rust toolchain (rustup brings cargo with it; both probed against same floor).
need "rustc"     rustc     "--version" "1.75.0" install_rust
need "cargo"     cargo     "--version" "1.75.0" install_rust

# Node + npm via nvm.
need "node"      node      "--version" "18.0.0" install_node
need "npm"       npm       "--version" "9.0.0"  install_node

# wasm-pack — cargo-installed, runs after Rust is live.
need "wasm-pack" wasm-pack "--version" "0.12.0" install_wasm_pack

# ── tools/ npm deps ─────────────────────────────────────────────────────────
# tools/package.json pins the npm deps the audit harnesses load
# (acorn for js-audit + css-tab-compare-audit). Provisioning is a
# one-shot `npm install` from the tools/ dir — idempotent + cheap on
# warm cache; skipped under --dry-run. Node was just verified at the
# floor above, so npm is live by the time we get here.
echo "${C_BOLD}── tools/ npm deps${C_RST}"
if [ "$DRY_RUN" -eq 1 ]; then
  echo "  ${C_DIM}[dry] (cd tools && npm install --no-audit --no-fund)${C_RST}"
elif [ ! -f tools/package.json ]; then
  echo "  $TAG_FAIL tools/package.json missing — audit harnesses cannot load deps"
  FAILED=$((FAILED + 1))
elif ! command -v npm >/dev/null 2>&1; then
  echo "  $TAG_FAIL npm not on PATH — earlier node install must have failed"
  FAILED=$((FAILED + 1))
else
  if (cd tools && run npm install --no-audit --no-fund); then
    echo "  $TAG_OK tools/ npm deps installed"
  else
    echo "  $TAG_FAIL tools/ npm install failed"
    FAILED=$((FAILED + 1))
  fi
fi

# ── footer ──────────────────────────────────────────────────────────────────
echo ""
if [ "$DRY_RUN" -eq 1 ]; then
  echo "${C_WARN}dry-run complete — nothing was installed${C_RST}"
  exit 0
fi
if [ "$FAILED" -eq 0 ]; then
  echo "${C_OK}all installed.${C_RST}"
  echo ""
  echo "  Next steps:"
  echo "    1. Open a new shell (so nvm + cargo PATH bits load from your rc files)."
  echo "    2. Verify the floor:    sh tools/stack-version.sh"
  echo "    3. Boot the app:        cd backend && cargo run -p api"
  exit 0
else
  echo "${C_BAD}$FAILED tool(s) failed to reach the version floor — see above.${C_RST}"
  exit 1
fi
