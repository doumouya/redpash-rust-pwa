#!/usr/bin/env bash
# Purpose: sanity-probe key dev ports across WSL + Windows.
# Doc: docs/internal/code/tools/shell/port-check.md
# Re-exec under bash for [[ ]] + arrays.
if [ -z "${BASH_VERSION-}" ]; then exec bash "$0" "$@"; fi
# ── port-check.sh ────────────────────────────────────────────────────────────
# Sanity-probe key dev ports across WSL + Windows. Inspired by the Jenkins
# rabbit-hole on 2026-05-25 — a Docker container we'd forgotten about
# held :8080 for 15 months, silently intercepting Windows-browser hits
# to `localhost:8080` while the api inside WSL bound the same port in
# its own network namespace. Both servers running, neither one wrong,
# the browser landed on Jenkins. This tool turns that 90-minute debug
# into a 10-second probe.
#
# Ports probed by default:
#   8080  — RedPash api (primary)
#   8081  — RedPash api alt (when 8080 is taken)
#   5432  — postgres
#   50000 — Jenkins agent (historical signal — if anything's on it,
#           Jenkins or a leftover from it is around)
#
# Override with `--ports 8080,9000,5432` or env PORTS=…
#
# Each port reports:
#   - WSL-side: process name + PID via ss -ltnp
#   - Windows-side: process name + PID via Get-NetTCPConnection + Get-Process
#   - Verdict: same-process / split-binding / collision-risk
#
# Exit codes:
#   0 — no surprise bindings on any probed port
#   1 — at least one port is held by something unexpected on either side

set -u

PORTS_DEFAULT="8080,8081,5432,50000"
PORTS_ARG="${PORTS:-$PORTS_DEFAULT}"
for arg in "$@"; do
  case "$arg" in
    --ports)    shift; PORTS_ARG="$1"; shift ;;
    --ports=*)  PORTS_ARG="${arg#--ports=}" ;;
    -h|--help)
      sed -n '/^# ── port-check.sh/,/^$/p' "$0" | sed 's/^# //;s/^#//'
      exit 0 ;;
  esac
done

if [ -t 1 ] && command -v tput >/dev/null 2>&1; then
  C_OK=$(tput setaf 2); C_WARN=$(tput setaf 3); C_BAD=$(tput setaf 1)
  C_DIM=$(tput setaf 8 2>/dev/null || tput setaf 7); C_RST=$(tput sgr0); C_BOLD=$(tput bold)
else
  C_OK=""; C_WARN=""; C_BAD=""; C_DIM=""; C_RST=""; C_BOLD=""
fi

# ── wsl side ────────────────────────────────────────────────────────────────
# ss -ltnp prints `users:(("name",pid=N,fd=M))` for processes the caller
# owns or when run with sudo. Without that annotation we can only
# confirm "something is bound here" — surface that as "(unknown)".
wsl_holder() {
  local port="$1"
  # Match local-address column ending in ":<port>". Limit to the
  # listening rows, then extract just the PID + process name if
  # the users:((…)) block is present.
  local line
  line=$(ss -ltnp 2>/dev/null | awk -v port=":$port" '
    $1=="LISTEN" {
      # Column 4 = local addr:port. Strip address, compare port.
      n=length($4); colon=0
      for (i=n; i>0; i--) if (substr($4, i, 1) == ":") { colon=i; break }
      if (colon == 0) next
      lport = substr($4, colon)
      if (lport == port) { print; exit }
    }
  ')
  if [ -z "$line" ]; then
    return  # nothing listening
  fi
  # Try to extract `name|pid` from users:(("name",pid=N,...)).
  local extracted
  extracted=$(echo "$line" | sed -nE 's/.*users:\(\(\"([^\"]+)\",pid=([0-9]+).*/\1|\2/p')
  if [ -n "$extracted" ]; then
    echo "$extracted"
  else
    echo "(unknown)|?"
  fi
}

# ── windows side via /init ──────────────────────────────────────────────────
WIN_PROBE_AVAILABLE=0
if [ -x /init ] && [ -x /mnt/c/WINDOWS/System32/WindowsPowerShell/v1.0/powershell.exe ]; then
  WIN_PROBE_AVAILABLE=1
fi

win_holder() {
  local port="$1"
  if [ "$WIN_PROBE_AVAILABLE" -eq 0 ]; then
    echo "n/a"
    return
  fi
  /init /mnt/c/WINDOWS/System32/WindowsPowerShell/v1.0/powershell.exe -Command "
    \$c = Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue | Select-Object -First 1
    if (\$c) {
      \$p = Get-Process -Id \$c.OwningProcess -ErrorAction SilentlyContinue
      Write-Output (\$p.ProcessName + '|' + \$c.OwningProcess)
    } else {
      Write-Output 'free'
    }
  " 2>/dev/null | tr -d '\r' | head -1
}

# ── verdict for a single port ──────────────────────────────────────────────
verdict() {
  local w_proc="$1" w_pid="$2" win_proc="$3" win_pid="$4"
  if [ "$w_proc" = "free" ] && [ "$win_proc" = "free" ]; then
    echo "$C_DIM·$C_RST free"
  elif [ "$w_proc" = "free" ]; then
    if [ "$win_proc" = "wslrelay" ]; then
      echo "$C_WARN→$C_RST Windows holds via wslrelay but no WSL bind — stale relay (kill PID $win_pid as Admin)"
    else
      echo "$C_WARN→$C_RST Windows-only: $win_proc (PID $win_pid)"
    fi
  elif [ "$win_proc" = "free" ]; then
    echo "$C_OK✓$C_RST WSL-only: $w_proc (PID $w_pid)"
  elif [ "$win_proc" = "wslrelay" ]; then
    echo "$C_OK✓$C_RST WSL: $w_proc (PID $w_pid) — Windows forwards via wslrelay"
  else
    echo "$C_BAD✗$C_RST DUAL binding — WSL has $w_proc (PID $w_pid), Windows has $win_proc (PID $win_pid)"
    return 1
  fi
}

# ── run ────────────────────────────────────────────────────────────────────
echo ""
echo "${C_BOLD}port-check${C_RST}   $(date '+%FT%T%z')"
echo "  ports: $PORTS_ARG"
if [ "$WIN_PROBE_AVAILABLE" -eq 0 ]; then
  echo "  ${C_WARN}Windows-side probe unavailable (no /init or powershell.exe)${C_RST}"
fi
echo ""
printf "  %-6s  %-30s  %-30s  %s\n" "PORT" "WSL" "WINDOWS" "VERDICT"
printf "  %-6s  %-30s  %-30s  %s\n" "────" "───" "───────" "───────"

FAILED=0
IFS=',' read -ra PORT_ARRAY <<< "$PORTS_ARG"
for port in "${PORT_ARRAY[@]}"; do
  port=$(echo "$port" | tr -d ' ')
  [ -z "$port" ] && continue

  w_raw=$(wsl_holder "$port")
  if [ -z "$w_raw" ]; then
    w_proc="free"; w_pid=""
    w_disp="free"
  else
    w_proc="${w_raw%|*}"; w_pid="${w_raw#*|}"
    w_disp="$w_proc (PID $w_pid)"
  fi

  win_raw=$(win_holder "$port")
  if [ "$win_raw" = "free" ] || [ -z "$win_raw" ]; then
    win_proc="free"; win_pid=""
    win_disp="free"
  elif [ "$win_raw" = "n/a" ]; then
    win_proc="n/a"; win_pid=""
    win_disp="n/a"
  else
    win_proc="${win_raw%|*}"; win_pid="${win_raw#*|}"
    win_disp="$win_proc (PID $win_pid)"
  fi

  v=$(verdict "$w_proc" "$w_pid" "$win_proc" "$win_pid") || FAILED=$((FAILED + 1))
  printf "  %-6s  %-30s  %-30s  %s\n" "$port" "$w_disp" "$win_disp" "$v"
done

echo ""
if [ $FAILED -eq 0 ]; then
  echo "${C_OK}no surprise bindings.${C_RST}"
  exit 0
else
  echo "${C_BAD}$FAILED port(s) with dual binding — see above${C_RST}"
  exit 1
fi
