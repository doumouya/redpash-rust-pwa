---
title: Events and logs
section: Internal
order: 24
last modified date: 2026-05-24
owner: Gus
status: stub
---

# Events and logs

> **TODO (Gus).** Fill from `events.rs`, `request_log.rs`, `routes/events.rs`, `routes/monitoring.rs`, and `frontend/scripts/events.js`.

To cover:

- Two distinct streams: **events** (semantic — what happened) vs **request_log** (mechanical — every HTTP request)
- Capture pipeline: frontend `installErrorCapture` + `reportEvent` → POST → `events` table
- The `capture_mw` middleware that auto-populates `request_log`
- Read surfaces: `/api/events`, `/api/metrics`, `/api/monitoring/events`, `/api/monitoring/requests`
- The 401-spam baseline (anon page loads hitting `/api/me`) and why it's expected
- Future: the unified Logs tab (per [redtable-unification](../architecture/redtable-unification.md))
