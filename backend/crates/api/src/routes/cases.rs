//! Doc: docs/internal/code/backend/api/routes/cases.md
//! `/api/cases/*` — LEAN trim (CAS_C8A9): the only surviving surface is the
//! category taxonomy the Monitoring page's CATALOG tab reads. The case +
//! comment CRUD and the `/:rid/members` team nest were dropped in the
//! single-user slim (CHECKPOINT-1 approved); their full multi-tenant form lives
//! in the `full-app-pre-slim` snapshot.
//!
//! Endpoint:
//!   GET /api/cases/categories   flat category list (Monitoring CATALOG tab)

use axum::{extract::State, http::HeaderMap, routing::get, Json, Router};
use serde::Serialize;
use shared::case::Category;

use crate::{db, error::AppError, state::AppState};

pub fn routes() -> Router<AppState> {
    Router::new().route("/categories", get(list_categories))
}

// ── categories ─────────────────────────────────────────────────────

#[derive(Serialize)]
struct CategoryList {
    items: Vec<Category>,
}

/// Flat list of categories the caller can pick from. Returns the global /
/// built-in seed taxonomy. The Monitoring CATALOG tab groups by `parent_id`
/// to build the picker tree (monitoring.js:1270, tabs.js:62).
#[tracing::instrument(skip_all)]
async fn list_categories(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<CategoryList>, AppError> {
    let user = super::resolve_user_rid(&state, &headers).await?;
    let items = db::list_categories(&state.db, Some(&user)).await?;
    Ok(Json(CategoryList { items }))
}
