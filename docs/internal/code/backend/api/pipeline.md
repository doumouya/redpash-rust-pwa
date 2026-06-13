---
title: backend/crates/api/src/pipeline.rs
source: ../../../../../backend/crates/api/src/pipeline.rs
owner: Torv
section: Internal · Code · backend · api
last modified date: 2026-06-13
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

- `pub async fn upload_csv(pool, data_dir, caller, _caller_is_admin, project,
  original_filename, bytes, tld) -> Result<UploadOutcome, AppError>` — the one
  path. In order (lean, CAS_C8A9): ~~RBAC write-reach check~~ **dropped** (the sole
  user owns every project; `_caller_is_admin` retained in the signature for the
  snapshot's gate) → Excel→CSV conversion → blob write to
  `<data_dir>/files/<rid>.bin` (orphan-guarded) → parse + `dtype::summarize` +
  `stats::cleanness` (shared global-sentinel vocabulary, on a blocking thread) →
  `db::insert_file` → `file_upload` audit event attributed to `caller`.
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
  `caller_is_admin=false` (now ignored — the reach check is gone in the lean build).

## Drift-prone areas

- **RBAC neutered (lean, CAS_C8A9).** The per-request write-reach check was removed
  — single-user tool, the sole user owns every project. The framework-owns-policy
  principle still holds: route every producer through `upload_csv` (audit + parse +
  cleanness invariants stay). The multi-tenant `effective() ≥ Member` gate is in the
  `full-app-pre-slim` snapshot. A future `tools/connectors-audit/` lint should still
  flag any connector touching `db::insert_*` directly.
- **Blob orphan guard** mirrors `routes::files::BlobGuard` but is a private copy
  here so the pipeline has no dependency back into the route module. If a third
  copy appears, lift it to a shared `pub(crate)` helper.
- The `state.files` hot-frame cache is **web-only** and stays in the route — the
  pipeline returns the `frame` rather than caching it, so a batch load doesn't
  pin every loaded frame in memory.

## Related

- [routes/files/mod.rs](routes/files/mod.md) — the web upload route (delegates here).
- [kafka_loader.rs](kafka_loader.md) — the first connector through this path.
- [rbac.rs](rbac.md) — the (neutered) gate surface; the write-reach resolver it used was deleted in the lean slim.
