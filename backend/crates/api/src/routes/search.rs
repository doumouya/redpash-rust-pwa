//! `/api/search` — omnisearch backing the topbar input.
//!
//!   GET /api/search?q=<text>&limit=<int>
//!
//! One flat result list, `kind`-discriminated; the topbar groups by
//! kind for display. User-scoped today (results only span projects the
//! caller owns or has a project_membership in) — Phase 4 of the
//! roadmap adds `?scope=admin` for org-wide search behind the
//! company-admin role when RBAC lands.
//!
//! Search strategy: per-kind ILIKE `%q%` on the label-relevant
//! columns, with a prefix-match boost so `q = "ali"` puts
//! `"Alice's data"` above `"Initial alignment"`. Per-kind cap +
//! overall cap keep the response small and the kinds balanced (a
//! noisy filename can't drown out projects).
//!
//! Wire DTO: `shared::search::{SearchResponse, SearchResult}`.

use std::time::Instant;

use axum::{
    extract::{Query, State},
    http::HeaderMap,
    routing::get,
    Json, Router,
};
use serde::Deserialize;
use shared::search::{SearchResponse, SearchResult};
use sqlx::Row;

use crate::{error::AppError, state::AppState};

pub fn routes() -> Router<AppState> {
    Router::new().route("/", get(search))
}

#[derive(Deserialize)]
struct SearchQuery {
    #[serde(default)] q:     Option<String>,
    #[serde(default)] limit: Option<u32>,
}

const PER_KIND_LIMIT: i64 = 5;
const DEFAULT_TOTAL_LIMIT: u32 = 20;
const MAX_TOTAL_LIMIT: u32 = 100;
const MIN_Q_LEN: usize = 1;

async fn search(
    State(state): State<AppState>,
    headers:      HeaderMap,
    Query(q):     Query<SearchQuery>,
) -> Result<Json<SearchResponse>, AppError> {
    let started = Instant::now();
    let user = super::resolve_user_rid(&state, &headers).await?;

    // Trim + bail on empty. Single-char queries are noisy but allowed —
    // gives the user feedback that typing is doing something; the
    // per-kind ILIKE on a 1-char prefix is still bounded by LIMIT.
    let q_raw = q.q.unwrap_or_default();
    let q_trim = q_raw.trim();
    let total_cap = q.limit.unwrap_or(DEFAULT_TOTAL_LIMIT).clamp(1, MAX_TOTAL_LIMIT);

    if q_trim.len() < MIN_Q_LEN {
        return Ok(Json(SearchResponse {
            q: q_trim.into(),
            results: Vec::new(),
            ms: started.elapsed().as_millis() as u32,
        }));
    }

    let q_owned = q_trim.to_string();
    let mut results: Vec<SearchResult> = Vec::with_capacity(total_cap as usize);

    // ── projects ───────────────────────────────────────────────
    // User-scoped: owner_id OR ∃ project_membership with caller.
    // Prefix-match boost via the CASE in ORDER BY.
    let rows = sqlx::query(
        "SELECT p.redpash_id, p.name,
                COALESCE(p.description, '') AS description
           FROM projects p
          WHERE (p.owner_id = $1
                 OR EXISTS (SELECT 1 FROM project_memberships m
                             WHERE m.project_redpash_id = p.redpash_id
                               AND m.user_redpash_id    = $1))
            AND (p.name                 ILIKE '%' || $2 || '%'
                 OR COALESCE(p.description, '') ILIKE '%' || $2 || '%')
          ORDER BY (CASE WHEN p.name ILIKE $2 || '%' THEN 0 ELSE 1 END),
                   p.updated_at DESC
          LIMIT $3",
    )
    .bind(&user)
    .bind(&q_owned)
    .bind(PER_KIND_LIMIT)
    .fetch_all(&state.db)
    .await?;

    for r in rows {
        let rid: String = r.try_get("redpash_id").unwrap_or_default();
        let name: String = r.try_get("name").unwrap_or_default();
        let description: String = r.try_get("description").unwrap_or_default();
        results.push(SearchResult {
            kind:  "project".into(),
            hash:  format!("#/workspace?project={rid}"),
            label: name,
            sub:   description,
            rid,
        });
    }

    // ── files / charts / dashboards ─────────────────────────────
    // Single query — all three are project_files rows. The match-
    // ing kind comes back as a column so we don't run three nearly-
    // identical queries. Per-kind cap is enforced post-hoc; the
    // ROW_NUMBER() bounds it inside SQL so a busy file_type can't
    // monopolise the result set.
    let rows = sqlx::query(
        "WITH ranked AS (
            SELECT f.redpash_id, f.filename, f.display_name, f.file_type,
                   f.project_redpash_id, p.name AS project_name,
                   ROW_NUMBER() OVER (
                     PARTITION BY f.file_type
                     ORDER BY (CASE WHEN COALESCE(f.display_name, f.filename) ILIKE $2 || '%' THEN 0 ELSE 1 END),
                              f.updated_at DESC
                   ) AS rn
              FROM project_files f
              JOIN projects p ON p.redpash_id = f.project_redpash_id
             WHERE (p.owner_id = $1
                    OR EXISTS (SELECT 1 FROM project_memberships m
                                WHERE m.project_redpash_id = p.redpash_id
                                  AND m.user_redpash_id    = $1))
               AND (f.filename                 ILIKE '%' || $2 || '%'
                    OR COALESCE(f.display_name, '') ILIKE '%' || $2 || '%')
         )
         SELECT redpash_id, filename, display_name, file_type,
                project_redpash_id, project_name
           FROM ranked
          WHERE rn <= $3
          ORDER BY file_type, rn",
    )
    .bind(&user)
    .bind(&q_owned)
    .bind(PER_KIND_LIMIT)
    .fetch_all(&state.db)
    .await?;

    for r in rows {
        let rid: String = r.try_get("redpash_id").unwrap_or_default();
        let filename: String = r.try_get("filename").unwrap_or_default();
        let display_name: Option<String> = r.try_get("display_name").ok();
        let file_type: String = r.try_get("file_type").unwrap_or_default();
        let project_name: String = r.try_get("project_name").unwrap_or_default();
        let label = display_name.unwrap_or(filename);
        // Workspace deep-link convention matches the existing
        // home→workspace deep-link Torv built (`ef4ec9f`); all three
        // file types land in the same surface.
        let hash = format!("#/workspace?file={rid}");
        let kind = match file_type.as_str() {
            "chart"     => "chart",
            "dashboard" => "dashboard",
            _           => "file", // csv (and anything new with no
                                    // explicit slot defaults to file)
        }.to_string();
        results.push(SearchResult {
            kind,
            rid,
            label,
            sub: format!("in {project_name}"),
            hash,
        });
    }

    // Stable cap at the user's limit. Projects ordered first by the
    // appending order above; the kind-balance per ROW_NUMBER means a
    // chatty file_type can't crowd the rest out.
    results.truncate(total_cap as usize);

    Ok(Json(SearchResponse {
        q: q_owned,
        results,
        ms: started.elapsed().as_millis() as u32,
    }))
}
