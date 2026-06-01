//! Purpose: the framework upload pipeline — the single path that turns raw CSV
//! bytes into a `project_files` row, applying RBAC + audit so every producer
//! (the UI upload route, the Kafka loader, any future connector) inherits the
//! same policy instead of re-implementing — or silently bypassing — it.
//! Doc: docs/internal/code/backend/api/pipeline.md
//!
//! Why this exists: connectors used to call `db::insert_file` directly, which
//! skips RBAC (write to any project), audit (`file_upload` event), and the
//! org-rule cascade. Routing every producer through `upload_csv` fixes those
//! gaps once, for all producers, instead of per-connector. See
//! `CAS_A4448B94…` / memory `connector-through-framework`.

use std::path::Path;

use polars::prelude::DataFrame;
use shared::file::ColumnMeta;
use sqlx::PgPool;

use crate::{
    db,
    error::AppError,
    id,
    rbac::{self, Role},
};

/// What `upload_csv` produces — enough for the web route to build its response
/// + in-memory cache, and for a connector to log what landed.
pub struct UploadOutcome {
    pub rid:             String,
    pub filename:        String,
    pub encoding:        String,
    pub columns:         Vec<ColumnMeta>,
    pub cleanness:       Option<f32>,
    pub size_bytes:      u64,
    pub fully_null_rows: u64,
    /// The parsed frame — the web route caches it in `state.files`; a batch
    /// connector drops it.
    pub frame:           DataFrame,
}

/// Best-effort orphan-blob cleanup: the bytes hit disk before the DB row that
/// references them exists, so a later failure (parse / DB) must remove the
/// file or it leaks (no row → no sweep ever finds it). Disarm once the row is
/// committed. Mirrors `routes::files::BlobGuard`, kept local so the pipeline
/// has no dependency back into the route module.
struct BlobGuard {
    path:  std::path::PathBuf,
    armed: bool,
}
impl BlobGuard {
    fn arm(path: std::path::PathBuf) -> Self {
        Self { path, armed: true }
    }
    fn disarm(&mut self) {
        self.armed = false;
    }
}
impl Drop for BlobGuard {
    fn drop(&mut self) {
        if self.armed {
            let _ = std::fs::remove_file(&self.path);
        }
    }
}

/// Turn raw CSV (or Excel) bytes into a `project_files` row in `project`,
/// uploaded *as* `caller`. The one path all file producers go through.
///
/// Applies the framework's policy invariants so no producer can skip them:
///   • **RBAC** — `caller` must reach `project` with ≥ `Member` (write); else a
///     leak-free not-found. Skipped when `caller_is_admin` (the web route
///     passes `is_platform_admin`; connectors pass `false`, so an operator
///     can't silently land data in a project they hold no membership in).
///   • **Audit** — emits a `file_upload` event attributed to `caller`.
///   • Parse + summarize + cleanness (shared global-sentinel vocabulary).
///
/// Excel-family filenames are converted to CSV bytes first (same as the UI).
/// `tld` is the optional top-level-domain parse hint the UI form forwards.
/// The blob is written under `<data_dir>/files/<rid>.bin`.
#[allow(clippy::too_many_arguments)]
pub async fn upload_csv(
    pool:              &PgPool,
    data_dir:          &Path,
    caller:            &str,
    caller_is_admin:   bool,
    project:           &str,
    original_filename: &str,
    bytes:             Vec<u8>,
    tld:               Option<String>,
) -> Result<UploadOutcome, AppError> {
    // ── RBAC: caller needs write-reach (≥ Member) on the target project ──
    // The UI always uploads to the caller's own project (owner → passes); this
    // check only bites a connector aimed at a project the caller can't reach.
    if !caller_is_admin {
        let grant = rbac::resolve_grant(pool, caller, project).await?;
        let can_write = grant.effective().is_some_and(|r| r >= Role::Member);
        if !can_write {
            // Leak-free: a denied caller can't tell "no reach" from "doesn't
            // exist" (matches rbac::require_grant's contract).
            return Err(AppError::not_found("not_found", format!("project {project}")));
        }
    }

    // ── Excel → CSV (same pre-disk conversion as the UI path) ──
    let bytes = if data::parse::is_excel_filename(original_filename) {
        tokio::task::spawn_blocking(move || data::parse::xlsx_to_csv(&bytes))
            .await
            .map_err(|e| AppError::internal("join", e.to_string()))??
    } else {
        bytes
    };

    let size_bytes  = bytes.len() as u64;
    let rid         = id::new("FIL");
    let storage_rel = format!("files/{rid}.bin");
    let abs_path    = data_dir.join("files").join(format!("{rid}.bin"));
    if let Some(parent) = abs_path.parent() {
        tokio::fs::create_dir_all(parent).await
            .map_err(|e| AppError::internal("io", format!("mkdir {}: {e}", parent.display())))?;
    }
    tokio::fs::write(&abs_path, &bytes).await
        .map_err(|e| AppError::internal("io", format!("write {}: {e}", abs_path.display())))?;
    // Armed until the DB row is committed; if anything below fails, drop
    // removes the orphan blob.
    let mut blob_guard = BlobGuard::arm(abs_path.clone());

    // ── parse + summarize + score (off the async runtime) ──
    let globals = db::list_global_sentinels(pool).await?;
    let parsed = tokio::task::spawn_blocking(move || -> Result<_, data::DataError> {
        let (df, enc) = data::parse::from_csv_bytes(&bytes, tld.as_deref())?;
        let cols      = data::dtype::summarize(&df)?;
        let cleanness = data::stats::cleanness(&df, &cols, &globals);
        let fully     = data::stats::count_fully_null_rows(&df);
        Ok((df, enc, cols, cleanness, fully))
    })
    .await
    .map_err(|e| AppError::internal("join", e.to_string()))??;
    let (frame, encoding, columns, cleanness, fully_null_rows) = parsed;

    let filename = data::parse::strip_upload_ext(original_filename).to_string();
    db::insert_file(
        pool, &rid, project, &filename, &encoding,
        frame.height() as u64, frame.width() as u32, size_bytes, &storage_rel, &columns, cleanness,
    )
    .await?;
    blob_guard.disarm();

    // ── audit: every producer's upload is now an attributable event ──
    crate::event::info(pool, "file_upload", format!("uploaded {filename}"))
        .user(caller.to_string())
        .context(serde_json::json!({
            "file": rid.clone(), "project": project.to_string(), "rows": frame.height(),
        }))
        .send();

    Ok(UploadOutcome {
        rid,
        filename,
        encoding,
        columns,
        cleanness,
        size_bytes,
        fully_null_rows,
        frame,
    })
}
