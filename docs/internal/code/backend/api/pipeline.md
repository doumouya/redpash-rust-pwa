---
title: backend/crates/api/src/pipeline.rs
source: ../../../../../backend/crates/api/src/pipeline.rs
owner: Torv
section: Internal · Code · backend · api
last modified date: 2026-06-01
---

# pipeline.rs

## Purpose

The **framework upload pipeline** — the single path that turns raw CSV bytes
into a `project_files` row, applying the framework's policy invariants so every
producer inherits them instead of re-implementing (or silently bypassing) them.

Before this existed, connectors called `db::insert_file` directly, which skips
RBAC (write to any project), the `file_upload` audit event, and the org-rule
cascade. `CAS_A4448B94…` (memory `[[connector-through-framework]]`) lifted that
core out of `routes/files::upload` so the UI route **and** the Kafka loader (and
every future ETL connector) go through one enforced entry point.

## Public surface

- `pub async fn upload_csv(pool, data_dir, caller, caller_is_admin, project,
  original_filename, bytes, tld) -> Result<UploadOutcome, AppError>` — the one
  path. In order: **RBAC** (`resolve_grant`, `effective() ≥ Member`; leak-free
  not-found on deny; skipped when `caller_is_admin`) → Excel→CSV conversion →
  blob write to `<data_dir>/files/<rid>.bin` (orphan-guarded) → parse +
  `dtype::summarize` + `stats::cleanness` (shared global-sentinel vocabulary, on
  a blocking thread) → `db::insert_file` → `file_upload` audit event attributed
  to `caller`.
- `pub struct UploadOutcome { rid, filename, encoding, columns, cleanness,
  size_bytes, fully_null_rows, frame }` — enough for the web route to build its
  `FileEnvelope` + cache the hot `frame` in `state.files`; a batch connector
  uses `rid` and drops the frame.

## Who calls it

- `routes/files/mod.rs::upload` — passes the resolved web user + `data_dir` +
  `is_platform_admin`. The caller always uploads to their OWN project, so the
  write-check is a pass-through here; the route keeps the web-only `state.files`
  cache + the `FileEnvelope` response.
- `kafka_loader::ingest_csv` — passes the configured `KAFKA_AS_USER` +
  `caller_is_admin=false`, so a connector load fails loudly unless the as-user
  holds ≥Member reach on the target project.

## Drift-prone areas

- **RBAC rule lives here, not in the callers.** The write gate is
  `effective() ≥ Member`. If a new producer appears, route it through here —
  don't re-check RBAC in the producer (that's the bypass this case removed). A
  future `tools/connectors-audit/` lint should flag any connector touching
  `db::insert_*` directly.
- **`caller_is_admin` is the only bypass.** The web route passes
  `is_platform_admin`; connectors MUST pass `false` (a connector with admin
  bypass could silently land data anywhere — the exact bug this fixed).
- **Blob orphan guard** mirrors `routes::files::BlobGuard` but is a private copy
  here so the pipeline has no dependency back into the route module. If a third
  copy appears, lift it to a shared `pub(crate)` helper.
- The `state.files` hot-frame cache is **web-only** and stays in the route — the
  pipeline returns the `frame` rather than caching it, so a batch load doesn't
  pin every loaded frame in memory.

## Related

- [routes/files/mod.rs](routes/files/mod.md) — the web upload route (delegates here).
- [kafka_loader.rs](kafka_loader.md) — the first connector through this path.
- [rbac.rs](rbac.md) — `resolve_grant` / `Grant` / `Role` the write-check uses.
