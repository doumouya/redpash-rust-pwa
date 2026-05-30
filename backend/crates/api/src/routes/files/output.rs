//! Doc: docs/internal/code/backend/api/routes/files/output.md
//! File-materialisation endpoints: snapshot (post-replay → new project
//! file on disk) and export (post-replay → download stream).
//!
//! Both surface the current view (after step replay) as bytes. Snapshot
//! persists a new project_files row; export is one-shot and stateless.
//! Co-located here because they share the data::dtype / data::stats /
//! data::export call surface and the spawn_blocking + CSV-writer
//! pattern.

use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    Json,
};
use std::sync::Arc;

use crate::{db, error::AppError, id, state::AppState};

use super::{hydrate, FileEnvelope};
use shared::file::FileSummary;

#[derive(serde::Deserialize)]
pub(super) struct SnapshotBody { name: Option<String> }

/// Materialise the current view (post step-replay) as a new project
/// file. The fresh file has no step history — it's a clean snapshot
/// the user can hand to Reports / Dashboards without worrying about
/// step changes invalidating downstream work.
#[tracing::instrument(skip_all, fields(rid = %rid))]
pub(super) async fn snapshot(
    State(state): State<AppState>,
    headers:      axum::http::HeaderMap,
    Path(rid):    Path<String>,
    Json(body):   Json<SnapshotBody>,
) -> Result<(StatusCode, Json<FileEnvelope>), AppError> {
    let user = crate::routes::resolve_user_rid(&state, &headers).await?;
    crate::routes::ensure_owner(db::file_owner(&state.db, &rid).await, &user, "file", &rid)?;
    let entry = hydrate(&state, &rid).await?;
    let frame = Arc::clone(&entry.frame);

    let new_rid     = id::new("FIL");
    let storage_rel = format!("files/{new_rid}.bin");
    let abs_path    = state.file_path(&new_rid);
    let path_for_blocking = abs_path.clone();
    // The CSV is written to disk inside the blocking task below, before
    // the DB row exists. Guard it so a failure in the writer, metadata,
    // or insert removes the orphan blob; disarmed after the row commits.
    let mut blob_guard = super::BlobGuard::arm(abs_path.clone());

    let globals = db::list_global_sentinels(&state.db).await?;
    let (columns, h, w, cleanness, fully_null_rows) = tokio::task::spawn_blocking(move || -> Result<_, data::DataError> {
        let mut df = (*frame).clone();
        let h = df.height();
        let w = df.width();
        let columns = data::dtype::summarize(&df)?;
        // Snapshot scored against the shared vocabulary (globals).
        let cleanness = data::stats::cleanness(&df, &columns, &globals);
        let fully_null = data::stats::count_fully_null_rows(&df);
        let file = std::fs::File::create(&path_for_blocking)
            .map_err(data::DataError::Io)?;
        use polars::prelude::SerWriter;
        polars::io::csv::write::CsvWriter::new(file)
            .include_header(true)
            .finish(&mut df)
            .map_err(data::DataError::from)?;
        Ok((columns, h, w, cleanness, fully_null))
    })
    .await
    .map_err(|e| AppError::internal("join", e.to_string()))??;

    let csv_size = tokio::fs::metadata(&abs_path).await
        .map_err(|e| AppError::internal("io", format!("metadata: {e}")))?
        .len();

    let project   = entry.summary.project_redpash_id.clone();
    // Stem only (mig 011). Base names are already stripped at read
    // time; defensive strip covers legacy data + any body-provided
    // name the caller happened to include an extension on.
    let base_name = data::parse::strip_upload_ext(
        entry.summary.display_name.as_deref().unwrap_or(&entry.summary.filename),
    );
    let filename  = body.name
        .filter(|s| !s.is_empty())
        .map(|s| data::parse::strip_upload_ext(&s).to_string())
        .unwrap_or_else(|| format!("{base_name}_cleaned"));

    db::insert_file(
        &state.db, &new_rid, &project, &filename, "utf-8",
        h as u64, w as u32, csv_size, &storage_rel, &columns, cleanness,
    )
    .await?;
    blob_guard.disarm();

    let now = chrono::Utc::now();
    let summary = FileSummary {
        redpash_id:         new_rid.clone(),
        project_redpash_id: project,
        filename:           filename.clone(),
        display_name:       Some(filename),
        file_type:          "csv".into(),
        stage:              "new".into(), // fresh file — no steps/charts/dashboards yet
        row_count:          Some(h as u64),
        col_count:          Some(w as u32),
        file_size_bytes:    Some(csv_size),
        cleanness_pct:      cleanness,
        encoding:           Some("utf-8".into()),
        delimiter:          Some(",".into()),
        created_at:         now,
        updated_at:         now,
        fully_null_rows:    Some(fully_null_rows),
    };

    crate::event::info(&state.db, "file_snapshot", format!("snapshot of {rid} → {new_rid}"))
        .user(user.clone())
        .context(serde_json::json!({
            "file":   new_rid.clone(),
            "source": rid.clone(),
            "rows":   h,
            "cols":   w,
        }))
        .send();

    Ok((StatusCode::CREATED, Json(FileEnvelope { summary, columns, steps: vec![] })))
}

#[derive(serde::Deserialize)]
pub(super) struct ExportQuery {
    #[serde(default)]
    format: Option<String>,
}

/// `GET /api/files/:rid/export?format=` — stream the current view
/// (post step-replay) as a download. `format` is `csv` (default),
/// `xlsx`, or `json`; an unknown value is a 400. Unlike `snapshot`
/// this writes nothing to disk and creates no new file row: it's a
/// pure materialise-and-hand-back. The body is built in-memory; for
/// the 256 MiB upload cap that's a few hundred MiB worst case,
/// acceptable for a single-shot download (we can switch to a
/// streaming body if big-file exports become common).
#[tracing::instrument(skip_all, fields(rid = %rid))]
pub(super) async fn export(
    State(state): State<AppState>,
    headers:      axum::http::HeaderMap,
    Path(rid):    Path<String>,
    Query(q):     Query<ExportQuery>,
) -> Result<impl axum::response::IntoResponse, AppError> {
    let user = crate::routes::resolve_user_rid(&state, &headers).await?;
    crate::routes::ensure_owner(db::file_owner(&state.db, &rid).await, &user, "file", &rid)?;

    // Resolve the renderer up front so an unknown format fails fast
    // with a 400 — before hydrating the frame.
    let format = q.format.as_deref().unwrap_or("csv").to_ascii_lowercase();
    let (render, ext, content_type): (
        fn(&polars::prelude::DataFrame) -> data::Result<Vec<u8>>,
        &str,
        &str,
    ) = match format.as_str() {
        "csv"  => (data::export::to_csv, "csv", "text/csv; charset=utf-8"),
        "xlsx" => (
            data::export::to_xlsx,
            "xlsx",
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        ),
        "json" => (data::export::to_json, "json", "application/json; charset=utf-8"),
        other  => return Err(AppError::bad_request(
            "unsupported_format",
            format!("export format '{other}' is not supported (use csv, xlsx, or json)"),
        )),
    };

    let entry = hydrate(&state, &rid).await?;
    let frame = Arc::clone(&entry.frame);
    let bytes = tokio::task::spawn_blocking(move || render(frame.as_ref()))
        .await
        .map_err(|e| AppError::internal("join", e.to_string()))??;

    // Download filename — prefer the display name, force the chosen
    // format's extension, and strip anything that could break the
    // Content-Disposition header (quotes, control chars, path seps).
    let raw_name = entry.summary.display_name.as_deref()
        .unwrap_or(&entry.summary.filename);
    let stem = raw_name
        .trim_end_matches(".csv")
        .trim_end_matches(".xlsx")
        .trim_end_matches(".json")
        .trim_end_matches('.');
    let safe: String = stem.chars()
        .map(|c| if c.is_control() || matches!(c, '"' | '\\' | '/' | '\n' | '\r') { '_' } else { c })
        .collect();
    let download_name = format!("{safe}.{ext}");

    use axum::http::header;
    Ok((
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, content_type.to_string()),
            (header::CONTENT_DISPOSITION, format!("attachment; filename=\"{download_name}\"")),
        ],
        bytes,
    ))
}
