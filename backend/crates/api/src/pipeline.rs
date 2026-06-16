//! Purpose: THE framework upload path — the single function that turns raw CSV
//! bytes into a project_files row, applying RBAC + scoring so every producer
//! (UI upload, future connectors) inherits the policy instead of bypassing it.
//!
//! Day-one seal: `insert_file` is PRIVATE to this module. There is no public
//! db::insert_file. Creating a file row is therefore impossible outside
//! upload_csv — the connector-bypass class the predecessor hit (a loader
//! calling db::insert_file directly, skipping RBAC + audit) cannot exist here
//! by visibility, not convention.
//!
//! Files are registered ENTITIES (day-one #2) so file-level sharing and the
//! uniform RBAC cascade work without a special-case arm.
//!
//! TODO(phase-4 follow-on): stream the multipart body to a temp file instead
//! of buffering the whole upload in a Vec (polars still parses from memory,
//! but we shouldn't hold bytes + frame + response simultaneously at 256 MiB).

use std::path::Path;

use polars::prelude::DataFrame;
use shared::file::ColumnMeta;
use sqlx::PgPool;

use crate::{
    db,
    error::AppError,
    id,
    rbac::{self, Role},
    type_cache::TypeDefCache,
};

pub struct UploadOutcome {
    pub rid: String,
    pub filename: String,
    pub encoding: String,
    pub columns: Vec<ColumnMeta>,
    pub cleanness: Option<f32>,
    pub size_bytes: u64,
    pub fully_null_rows: u64,
    /// The parsed frame — the web route caches it; a batch connector drops it.
    pub frame: DataFrame,
}

/// Orphan-blob cleanup: bytes hit disk before the DB row that references them,
/// so a later failure must remove the file or it leaks. Disarm once committed.
struct BlobGuard {
    path: std::path::PathBuf,
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

/// Turn raw CSV bytes into a project_files row in `project`, uploaded as
/// `caller`. RBAC: caller needs >= Member write-reach on the project unless
/// `caller_is_admin` (the UI passes is_platform_admin; connectors pass false).
/// Denial is leak-free 404.
#[allow(clippy::too_many_arguments)]
pub async fn upload_csv(
    pool: &PgPool,
    cache: &TypeDefCache,
    data_dir: &Path,
    caller: &str,
    caller_is_admin: bool,
    project: &str,
    original_filename: &str,
    bytes: Vec<u8>,
    tld: Option<String>,
) -> Result<UploadOutcome, AppError> {
    if !caller_is_admin {
        let grant = rbac::resolve_grant(pool, cache, caller, project).await?;
        let can_write = grant.effective().is_some_and(|r| r >= Role::Member);
        if !can_write {
            return Err(AppError::not_found("not_found", format!("project {project}")));
        }
    }

    let size_bytes = bytes.len() as u64;
    let rid = id::new("FIL");
    let storage_rel = format!("files/{rid}.bin");
    let abs_path = data_dir.join("files").join(format!("{rid}.bin"));
    if let Some(parent) = abs_path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| AppError::internal("io", format!("mkdir: {e}")))?;
    }
    tokio::fs::write(&abs_path, &bytes)
        .await
        .map_err(|e| AppError::internal("io", format!("write: {e}")))?;
    let mut blob_guard = BlobGuard::arm(abs_path.clone());

    // parse + summarize + score off the async runtime.
    let parsed = tokio::task::spawn_blocking(move || -> Result<_, data::DataError> {
        let (df, _diag, enc) = data::parse::from_csv_bytes(&bytes, tld.as_deref())?;
        let cols = data::dtype::summarize(&df)?;
        // TODO(phase-4): learned/global sentinels — empty extras for now.
        let cleanness = data::stats::cleanness(&df, &cols, &[]);
        let fully = data::stats::count_fully_null_rows(&df);
        Ok((df, enc, cols, cleanness, fully))
    })
    .await
    .map_err(|e| AppError::internal("join", e.to_string()))??;
    let (frame, encoding, columns, cleanness, fully_null_rows) = parsed;

    let filename = strip_upload_ext(original_filename).to_string();
    insert_file(
        pool,
        &rid,
        project,
        &filename,
        &encoding,
        frame.height() as i64,
        frame.width() as i32,
        &storage_rel,
        &columns,
        cleanness,
    )
    .await?;
    blob_guard.disarm();

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

/// SEALED: the only function that inserts a project_files row. Registers the
/// file entity first (day-one #2) in the same tx.
#[allow(clippy::too_many_arguments)]
async fn insert_file(
    pool: &PgPool,
    rid: &str,
    project: &str,
    filename: &str,
    encoding: &str,
    rows: i64,
    cols: i32,
    storage_rel: &str,
    columns: &[ColumnMeta],
    cleanness: Option<f32>,
) -> Result<(), AppError> {
    let columns_json = serde_json::to_value(columns)
        .map_err(|e| AppError::internal("serialize", e.to_string()))?;
    let mut tx = pool.begin().await?;
    db::register_entity(&mut tx, rid, "file").await?;
    sqlx::query(
        "INSERT INTO project_files
           (redpash_id, project_id, filename, file_type, storage_path,
            row_count, col_count, cleanness_pct, encoding, columns_meta)
         VALUES ($1, $2, $3, 'csv', $4, $5, $6, $7, $8, $9)",
    )
    .bind(rid)
    .bind(project)
    .bind(filename)
    .bind(storage_rel)
    .bind(rows)
    .bind(cols)
    .bind(cleanness)
    .bind(encoding)
    .bind(&columns_json)
    .execute(&mut *tx)
    .await?;
    // Genesis step (ordinal 0): the file's "original" state. It carries the
    // baseline cleanness on its own step record, in the SAME tx as the file, so
    // the score trajectory always starts from a persisted baseline. Replaying it
    // is the identity (see data::steps::apply "original").
    sqlx::query(
        "INSERT INTO project_steps (id, file_id, ordinal, kind, params, applied, cleanness)
         VALUES ($1, $2, 0, 'original', '{}', true, $3)",
    )
    .bind(id::new("STP"))
    .bind(rid)
    .bind(cleanness)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(())
}

/// Strip a known upload extension from a filename for the display name.
fn strip_upload_ext(name: &str) -> &str {
    for ext in [".csv", ".tsv", ".txt", ".xlsx", ".xls"] {
        if let Some(stem) = name.strip_suffix(ext) {
            return stem;
        }
        // case-insensitive tail check
        if name.len() >= ext.len()
            && name[name.len() - ext.len()..].eq_ignore_ascii_case(ext)
        {
            return &name[..name.len() - ext.len()];
        }
    }
    name
}
