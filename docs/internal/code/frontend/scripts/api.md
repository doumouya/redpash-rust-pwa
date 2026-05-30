---
title: frontend/scripts/api.js
source: ../../../../frontend/scripts/api.js
owner: Torv
section: Internal · Code · Frontend · scripts
last modified date: 2026-05-30
---

# api.js

## Purpose

Thin /api client. Wraps fetch with: /api prefix, JSON Content-Type / Accept, error parsing into Error objects with status and body, and capture of x-request-id from every response so frontend events can correlate to backend logs.

## Public surface

- api.get/post/patch/put/del(path, body?) — JSON-in, JSON-out.
- Throws Error with .status + .body on 4xx/5xx; 401 triggers redirect to #/login.
- Reads x-request-id header; surfaces it for events.js correlation.

## Drift-prone areas

- Backend response shape (error envelope) is shared with crates/api/src/error.rs:AppError::into_response; drift here breaks every page.

## Related

- [Frontend pillar landing](../../index.md)
