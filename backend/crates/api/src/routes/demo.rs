//! Doc: docs/internal/code/backend/api/routes/demo.md
//! `/api/demo` — the public landing-page "parse any CSV" demo.
//!
//! `POST /api/demo/parse` takes a raw CSV body, parses + cleanness-
//! scores it entirely in memory, and returns the score. **No auth,
//! nothing stored, no file row** — it exists to show a visitor what
//! RedPash sees in their messiest file, then funnel them to sign-up.
//!
//! The body is capped small here — the workspace-wide 256 MiB limit is
//! for real authenticated uploads, not an anonymous demo endpoint.

use std::time::Instant;

use axum::{body::Bytes, extract::DefaultBodyLimit, routing::post, Json, Router};
use serde::Serialize;

use crate::{error::AppError, state::AppState};

/// 4 MiB — a demo file, not a real dataset.
const DEMO_MAX_BYTES: usize = 4 * 1024 * 1024;

#[derive(Serialize)]
struct DemoResult {
    rows:            usize,
    columns:         usize,
    /// Blended cleanness score, 0–100.
    score:           f64,
    /// String columns whose values are really numbers / dates / bools.
    type_mismatches: usize,
    /// Empty cells as a percentage of the whole grid.
    empty_pct:       f64,
    parse_ms:        u64,
}

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/parse", post(parse))
        .layer(DefaultBodyLimit::max(DEMO_MAX_BYTES))
}

/// `POST /api/demo/parse` — parse + score a CSV, in memory, no auth.
async fn parse(body: Bytes) -> Result<Json<DemoResult>, AppError> {
    if body.is_empty() {
        return Err(AppError::bad_request("empty", "no CSV content"));
    }

    let result = tokio::task::spawn_blocking(move || -> Result<DemoResult, data::DataError> {
        let started = Instant::now();
        let (df, _enc) = data::parse::from_csv_bytes(body.as_ref(), None)?;
        let cols = data::dtype::summarize(&df)?;
        let parse_ms = started.elapsed().as_millis() as u64;

        // Eval against the canonical sentinel set only (`&[]`), same as
        // the score_dir harness — keeps the demo score reproducible.
        let score = data::stats::cleanness_report(&df, &cols, &[])
            .map(|r| r.score as f64)
            .unwrap_or(0.0);

        // Type drift — a string column that's really numeric / date /
        // bool: the dirt the cleaner fixes.
        let type_mismatches = cols
            .iter()
            .filter(|c| {
                c.dtype == "string"
                    && matches!(c.semantic_dtype.as_str(), "int" | "float" | "date" | "bool")
            })
            .count();

        // Empty-cell fraction across the whole grid.
        let total_cells = df.width() * df.height();
        let empty_cells: usize = df.get_columns().iter().map(|s| s.null_count()).sum();
        let empty_pct = if total_cells > 0 {
            empty_cells as f64 / total_cells as f64 * 100.0
        } else {
            0.0
        };

        Ok(DemoResult {
            rows: df.height(),
            columns: df.width(),
            score,
            type_mismatches,
            empty_pct,
            parse_ms,
        })
    })
    .await
    .map_err(|e| AppError::internal("join", e.to_string()))??;

    Ok(Json(result))
}
