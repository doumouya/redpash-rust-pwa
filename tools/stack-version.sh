#!/usr/bin/env bash
# Re-exec under bash when invoked with `sh script.sh` (which ignores the
# shebang). The script uses `declare -A` + array literals; dash chokes on
# both. This guard is pure POSIX sh so dash parses it fine.
if [ -z "${BASH_VERSION-}" ]; then exec bash "$0" "$@"; fi
# ── stack-version.sh ─────────────────────────────────────────────────────────
# Probe + report the version of every tool the RedPash stack uses. Run before
# a release / when something feels off / when onboarding a new machine.
#
# The Node-12 surprise (a `node --check` on rs-audit failed during a routine
# audit because the host's Node was EOL) is the cautionary tale behind this
# script — if it had existed, the discrepancy would have surfaced in seconds.
#
# Each tool entry declares:
#   - probe command (or "missing" if `command -v` returns nothing)
#   - MIN_VERSION (a floor; anything below trips ⚠ or ✗)
#   - criticality: "core" (✗ when missing/below) | "optional" (⚠ when missing)
#
# Exit codes:
#   0 — every core tool is at MIN_VERSION or above
#   1 — at least one core tool is below MIN_VERSION or missing
#
# Output is plain text — pipe to a file, diff against an earlier run to spot
# drift. Lives in tools/ alongside the audit suite; not part of the build.

set -u

# tput is nice when available — fall back to plain text in dumb terminals.
if [ -t 1 ] && command -v tput >/dev/null 2>&1; then
  C_OK=$(tput setaf 2); C_WARN=$(tput setaf 3); C_BAD=$(tput setaf 1)
  C_DIM=$(tput setaf 8 2>/dev/null || tput setaf 7); C_RST=$(tput sgr0); C_BOLD=$(tput bold)
else
  C_OK=""; C_WARN=""; C_BAD=""; C_DIM=""; C_RST=""; C_BOLD=""
fi

OK_TAG="${C_OK}✓${C_RST}"
WARN_TAG="${C_WARN}⚠${C_RST}"
BAD_TAG="${C_BAD}✗${C_RST}"

fail_count=0
warn_count=0
# Map of tool → install hint, populated below. Failing rows append their
# tool name to NEEDS_FIX; the footer iterates and prints the hint.
declare -A INSTALL_HINTS
NEEDS_FIX=()

# vercmp A B → returns 0 if A >= B, 1 otherwise. Uses sort -V for natural
# version ordering (handles 1.10 > 1.9 correctly). Strips leading "v".
vercmp() {
  local a="${1#v}" b="${2#v}"
  [ "$(printf '%s\n%s' "$a" "$b" | sort -V | head -1)" = "$b" ]
}

# Trim a version string to the first MAX_VER chars so noisy banners
# (psql, curl, bash) don't bloat the table. Adds an ellipsis when truncated.
MAX_VER=28
short_ver() {
  local s="$1"
  if [ ${#s} -gt $MAX_VER ]; then
    printf '%s…' "${s:0:$((MAX_VER - 1))}"
  else
    printf '%s' "$s"
  fi
}

# probe NAME CMD VERSION_FLAG MIN CRITICALITY NOTE
#   CMD is the executable name; if `command -v CMD` is empty the row
#   renders as ✗/⚠ depending on criticality. Otherwise the script runs
#   `CMD VERSION_FLAG`, takes the first line, extracts the first
#   number-with-optional-dots and compares against MIN.
probe() {
  local name="$1" cmd="$2" flag="$3" min="$4" criticality="$5" note="${6:-}"
  local version="" status="" tag=""
  local needs_fix=0

  if ! command -v "$cmd" >/dev/null 2>&1; then
    version="(not installed)"
    if [ "$criticality" = "core" ]; then
      tag="$BAD_TAG"; status="MISSING"; fail_count=$((fail_count + 1)); needs_fix=1
    else
      tag="$WARN_TAG"; status="optional"; warn_count=$((warn_count + 1)); needs_fix=1
    fi
  else
    # Some tools (perl -v) print an empty banner line first; pick the
    # first line that actually contains a digit so head -1 doesn't eat
    # the wrapper.
    version="$("$cmd" $flag 2>/dev/null | grep -E '[0-9]' | head -1)"
    if [ -z "$version" ]; then
      tag="$BAD_TAG"; status="PROBE FAILED"; fail_count=$((fail_count + 1)); needs_fix=1
    else
      # First number sequence (with optional .minor.patch). Accepts bare
      # integers — wasm-opt prints "version 116" with no dots.
      local v=$(printf '%s' "$version" | grep -oE '[0-9]+(\.[0-9]+){0,2}' | head -1)
      if [ -z "$v" ]; then
        tag="$WARN_TAG"; status="version unparsed"; warn_count=$((warn_count + 1))
      elif vercmp "$v" "$min"; then
        tag="$OK_TAG"; status="ok"
      else
        if [ "$criticality" = "core" ]; then
          tag="$BAD_TAG"; status="< min $min"; fail_count=$((fail_count + 1)); needs_fix=1
        else
          tag="$WARN_TAG"; status="< min $min"; warn_count=$((warn_count + 1)); needs_fix=1
        fi
      fi
    fi
  fi

  # Queue this row's install hint for the footer if it failed AND a hint
  # was registered (see INSTALL_HINTS at the bottom of the script).
  if [ "$needs_fix" -eq 1 ] && [ -n "${INSTALL_HINTS[$name]:-}" ]; then
    NEEDS_FIX+=("$name")
  fi

  printf "  %s  %-12s  %-30s  %-16s  %s\n" \
    "$tag" "$name" "$(short_ver "$version")" "$status" "${C_DIM}${note}${C_RST}"
}

echo
echo "${C_BOLD}RedPash stack — version probe${C_RST}    $(date -Iseconds)"
echo
printf "  %-2s  %-14s  %-30s  %-16s  %s\n" "" "tool" "version" "status" "note"
printf "  ─────────────────────────────────────────────────────────────────────────\n"

# ── install hints ───────────────────────────────────────────────────────────
# Per-tool one-shot fix command. Printed at the bottom of the report ONLY for
# tools that failed the probe — so the script doubles as a setup runbook
# without cluttering the OK rows. Source of truth: Em's onboarding commands
# (2026-05-24 chat); update here when a canonical path changes.
INSTALL_HINTS[node]='curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh"
nvm install --lts && nvm use --lts && nvm alias default '"'"'lts/*'"'"''
INSTALL_HINTS[npm]='(bundled with Node — install via the `node` hint above)'
INSTALL_HINTS[jq]='sudo apt-get install -y jq'
INSTALL_HINTS[curl]='sudo apt-get install -y curl'
INSTALL_HINTS[wasm-pack]='curl https://rustwasm.github.io/wasm-pack/installer/init.sh -sSf | sh'
INSTALL_HINTS[wasm-opt]='cargo install wasm-opt   # or download a binaryen release'
INSTALL_HINTS[rustc]='curl --proto '"'"'=https'"'"' --tlsv1.2 -sSf https://sh.rustup.rs | sh'
INSTALL_HINTS[cargo]='(bundled with rustc — install via the `rustc` hint above)'
INSTALL_HINTS[psql]='sudo apt-get install -y postgresql-14 postgresql-client-14'
INSTALL_HINTS[python3]='sudo apt-get install -y python3'
INSTALL_HINTS[git]='sudo apt-get install -y git'
INSTALL_HINTS[bash]='(already part of any sane Linux distro; reinstall via your package manager if needed)'

# ── runtimes (core) ─────────────────────────────────────────────────────────
probe "rustc"     rustc     "--version" "1.75.0" core     "backend compile"
probe "cargo"     cargo     "--version" "1.75.0" core     "build/test harness"
probe "node"      node      "--version" "18.0.0" core     "tools/ + frontend audits"
probe "npm"       npm       "--version" "9.0.0"  optional "only if installing tools"
probe "psql"      psql      "--version" "14.0"   core     "date_bin needs Postgres 14+"
probe "python3"   python3   "--version" "3.8.0"  optional "smoke-test glue + ad-hoc"
# perl deliberately not probed — its `-v` banner format doesn't parse with
# the generic regex (prints "This is perl 5, version 34, subversion 0"),
# and no script in tools/ has a meaningful version floor. Any perl 5.x
# works. Re-add with a per-tool probe if a floor ever matters.

# ── essential tools ─────────────────────────────────────────────────────────
probe "git"       git       "--version" "2.30.0" core     "branch/push policy lives in [[push-policy]]"
probe "bash"      bash      "--version" "5.0.0"  core     "shell scripts (this one + audit.sh)"
probe "jq"        jq        "--version" "1.6"    optional "audit.sh + ad-hoc JSON"
probe "curl"      curl      "--version" "7.70.0" core     "smoke tests"

# ── WASM build chain ────────────────────────────────────────────────────────
probe "wasm-pack" wasm-pack "--version" "0.12.0" optional "needed for WASM engine builds"
probe "wasm-opt"  wasm-opt  "--version" "100"    optional "binaryen, post-build optimizer"

# ── OS context (informational, no min) ──────────────────────────────────────
echo
echo "  ${C_DIM}OS:${C_RST} $(uname -srm)   $(lsb_release -ds 2>/dev/null || (grep -h PRETTY_NAME /etc/os-release 2>/dev/null | cut -d'"' -f2) || echo '?')"

# ── install hints for failing rows ──────────────────────────────────────────
# Only printed when at least one row failed AND has a hint registered. The
# OK case stays terse — the script reads as a clean health check.
if [ "${#NEEDS_FIX[@]}" -gt 0 ]; then
  echo
  echo "  ${C_BOLD}fix:${C_RST}"
  for tool in "${NEEDS_FIX[@]}"; do
    echo
    echo "    ${C_BOLD}${tool}${C_RST}"
    # Indent the (possibly multi-line) hint by 6 spaces so it nests under
    # the tool name cleanly.
    printf '      %s\n' "${INSTALL_HINTS[$tool]}" | sed '2,$s/^/      /'
  done
fi

echo
if [ "$fail_count" -gt 0 ]; then
  echo "  ${C_BAD}${fail_count} core issue(s)${C_RST}   ${warn_count} warning(s)"
  exit 1
elif [ "$warn_count" -gt 0 ]; then
  echo "  ${C_OK}core OK${C_RST}   ${warn_count} warning(s)"
  exit 0
else
  echo "  ${C_OK}all good${C_RST}"
  exit 0
fi
