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

/// THE chart write path (file-producing → lives here per the one-write-path rule;
/// there is no public db inserter). A chart is a `project_files{file_type:'chart'}`
/// row whose `spec` is the OPAQUE chart cfg; it has NO bytes (storage_path='') and
/// NO genesis step. Project is DERIVED from the source CSV (the IDOR anchor); RBAC =
/// Member+ on that project (admin bypasses). Registers the entity in the same tx so
/// require_action cascades chart→project. Returns the new rid.
pub(crate) async fn create_chart(
    pool: &PgPool,
    cache: &TypeDefCache,
    caller: &str,
    caller_is_admin: bool,
    source_file_id: &str,
    title: &str,
    spec: &serde_json::Value,
) -> Result<String, AppError> {
    let project: Option<String> = sqlx::query_scalar(
        "SELECT project_id FROM project_files WHERE redpash_id = $1 AND file_type = 'csv'",
    )
    .bind(source_file_id)
    .fetch_optional(pool)
    .await?;
    let project =
        project.ok_or_else(|| AppError::not_found("not_found", format!("source file {source_file_id}")))?;
    if !caller_is_admin {
        let grant = rbac::resolve_grant(pool, cache, caller, &project).await?;
        if !grant.effective().is_some_and(|r| r >= Role::Member) {
            return Err(AppError::not_found("not_found", format!("project {project}")));
        }
    }
    let rid = id::new("CHT");
    let mut tx = pool.begin().await?;
    db::register_entity(&mut tx, &rid, "chart").await?;
    sqlx::query(
        "INSERT INTO project_files (redpash_id, project_id, filename, file_type, source_file_id, spec)
         VALUES ($1, $2, $3, 'chart', $4, $5)",
    )
    .bind(&rid)
    .bind(&project)
    .bind(title)
    .bind(source_file_id)
    .bind(spec)
    .execute(&mut *tx)
    .await?;
    db::grant_owner(&mut tx, &rid, caller).await?;
    tx.commit().await?;
    Ok(rid)
}

/// THE dashboard write path (sibling of create_chart). A dashboard is a
/// `project_files{file_type:'dashboard'}` row whose `spec` is the OPAQUE 15×10
/// layout; no source_file_id, no bytes, no genesis step. RBAC = Member+ on the
/// supplied project (admin bypasses). Registers the entity in the same tx.
pub(crate) async fn create_dashboard(
    pool: &PgPool,
    cache: &TypeDefCache,
    caller: &str,
    caller_is_admin: bool,
    project: &str,
    title: &str,
    folder: Option<&str>,
    spec: &serde_json::Value,
) -> Result<String, AppError> {
    let exists: Option<i32> = sqlx::query_scalar("SELECT 1 FROM projects WHERE redpash_id = $1")
        .bind(project)
        .fetch_optional(pool)
        .await?;
    if exists.is_none() {
        return Err(AppError::not_found("not_found", format!("project {project}")));
    }
    if !caller_is_admin {
        let grant = rbac::resolve_grant(pool, cache, caller, project).await?;
        if !grant.effective().is_some_and(|r| r >= Role::Member) {
            return Err(AppError::not_found("not_found", format!("project {project}")));
        }
    }
    let rid = id::new("DSH");
    let mut tx = pool.begin().await?;
    db::register_entity(&mut tx, &rid, "dashboard").await?;
    sqlx::query(
        "INSERT INTO project_files (redpash_id, project_id, filename, file_type, folder, spec)
         VALUES ($1, $2, $3, 'dashboard', $4, $5)",
    )
    .bind(&rid)
    .bind(project)
    .bind(title)
    .bind(folder)
    .bind(spec)
    .execute(&mut *tx)
    .await?;
    db::grant_owner(&mut tx, &rid, caller).await?;
    tx.commit().await?;
    Ok(rid)
}

/// SEALED: the only function that inserts a *CSV* project_files row (the chart +
/// dashboard creators above are its non-parsing siblings). Registers the file
/// entity first (day-one #2) in the same tx.
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

pub struct AttachmentOutcome {
    pub rid: String,
    pub filename: String,
    pub mime: String,
    pub size_bytes: u64,
}

/// RAW attachment store — the case analogue of `upload_csv`, but with NO parse /
/// summarize / score: the bytes land IMMUTABLE on disk and a `case_attachments`
/// METADATA row references them. "No customer data in Postgres" holds by
/// construction (there is no bytes column — only `storage_path`); the on-disk
/// `.bin` is the durable share + recovery source (exactly as CSVs), and the client
/// caches a GlueSQL working copy. The CALLER gates RBAC (`require_action` Edit on
/// the case) before calling — this just seals the write. `insert_attachment` is
/// PRIVATE (the seal, mirroring `insert_file`): no public `db::insert_attachment`.
#[allow(clippy::too_many_arguments)]
pub async fn upload_attachment(
    pool: &PgPool,
    data_dir: &Path,
    case_id: &str,
    comment_id: Option<&str>,
    uploaded_by: &str,
    filename: &str,
    mime: &str,
    bytes: Vec<u8>,
) -> Result<AttachmentOutcome, AppError> {
    let size_bytes = bytes.len() as u64;
    let rid = id::new("ATT");
    let storage_rel = format!("attachments/{rid}.bin");
    let abs_path = data_dir.join("attachments").join(format!("{rid}.bin"));
    if let Some(parent) = abs_path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| AppError::internal("io", format!("mkdir: {e}")))?;
    }
    tokio::fs::write(&abs_path, &bytes)
        .await
        .map_err(|e| AppError::internal("io", format!("write: {e}")))?;
    let mut blob_guard = BlobGuard::arm(abs_path.clone());
    insert_attachment(pool, &rid, case_id, comment_id, uploaded_by, filename, mime, size_bytes as i64, &storage_rel)
        .await?;
    blob_guard.disarm();
    Ok(AttachmentOutcome { rid, filename: filename.to_string(), mime: mime.to_string(), size_bytes })
}

/// SEALED: the only inserter of a `case_attachments` row (no public db helper).
/// Attachments are NOT registered entities — their RBAC derives from the parent
/// case — so there is no `register_entity` here (unlike `insert_file`).
#[allow(clippy::too_many_arguments)]
async fn insert_attachment(
    pool: &PgPool,
    rid: &str,
    case_id: &str,
    comment_id: Option<&str>,
    uploaded_by: &str,
    filename: &str,
    mime: &str,
    size_bytes: i64,
    storage_rel: &str,
) -> Result<(), AppError> {
    sqlx::query(
        "INSERT INTO case_attachments
           (redpash_id, case_id, comment_id, uploaded_by, filename, mime, size_bytes, storage_path)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
    )
    .bind(rid)
    .bind(case_id)
    .bind(comment_id)
    .bind(uploaded_by)
    .bind(filename)
    .bind(mime)
    .bind(size_bytes)
    .bind(storage_rel)
    .execute(pool)
    .await?;
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
