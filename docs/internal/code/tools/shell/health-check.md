---
title: tools/health-check.sh
source: ../../../../../tools/health-check.sh
owner: Gus
section: Internal · Code · Tools · shell
last modified date: 2026-05-30
---

# health-check.sh

## Purpose

Single-command *"is the dev env healthy?"* probe. Runs each sub-check
independently (Postgres connectivity, port availability, `/api/health`,
disk space, etc.) and reports per-section, returning the count of
failures. Pairs with `port-check.sh` for the network half.

## Public surface

- `sh tools/health-check.sh` — exits with the number of failed checks.
- Per-section output for human-readable diagnosis.
- Non-zero exit means *something* is wrong; the section output names which.

## Drift-prone areas

- **Check set** is hard-coded; new dev-env dependencies (Redis, queue
  backends, …) need adding here.
- **`/api/health` endpoint shape** must stay `{"status":"ok"}`; if the
  backend changes the response, this probe regresses.

## Related

- [Sibling: port-check.sh](port-check.md)
- [Sibling: stack-version.sh](stack-version.md)
