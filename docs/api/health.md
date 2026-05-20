---
title: Health
section: API
order: 1
last modified date: 2026-05-16
---

# `/api/health`

Liveness probe. Returns instantly without touching the DB.

**Route file:** [`crates/api/src/routes/health.rs`](../../backend/crates/api/src/routes/health.rs)
**Auth:** none (mounted before any session check)

---

## `GET /api/health`

```jsonc
200 OK
{
  "status":  "ok",
  "version": "0.1.0"            // CARGO_PKG_VERSION at build time
}
```

`version` is baked in at compile-time via `env!("CARGO_PKG_VERSION")` —
useful for confirming a deploy actually swapped the binary.

A `?deep=1` flag that also pings Postgres is on the roadmap; today the
endpoint never returns anything other than 200.

---

## When to call it

- Container liveness/readiness probes.
- Uptime monitors.
- Manual sanity check after `cargo run -p api`:

  ```bash
  curl -s http://localhost:8080/api/health
  ```

The frontend doesn't call this — the router doesn't gate page loads on
it. It exists purely for ops.
