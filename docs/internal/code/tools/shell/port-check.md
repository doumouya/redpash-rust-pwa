---
title: tools/port-check.sh
source: ../../../../../tools/port-check.sh
owner: Gus
section: Internal · Code · Tools · shell
last modified date: 2026-05-30
---

# port-check.sh

## Purpose

Sanity-probe key dev ports across WSL + Windows. Inspired by the
Jenkins rabbit-hole on 2026-05-25 — a Docker container we'd forgotten
about was holding the dev port, costing hours of misdirected
debugging. This script fingerprints whatever's holding each port so
the next *"port already in use"* error names the culprit instead of
sending you down the same path.

## Public surface

- `sh tools/port-check.sh` — prints port + holder for each known dev port.
- Returns non-zero if a key port is held by an unexpected process.
- Probes both WSL-side and Windows-side (works inside WSL2 distros).

## Drift-prone areas

- **Port set** is hard-coded (api 8080, mcp-server, vite if used);
  new dev services need adding.
- **Process-identification** uses `lsof` / `ss` on the WSL side and
  `netstat` PowerShell-from-WSL on the Windows side; either tool
  breaking changes shape.

## Related

- [Sibling: health-check.sh](health-check.md)
