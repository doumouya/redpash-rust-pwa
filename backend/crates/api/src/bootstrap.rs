//! Doc: docs/internal/code/backend/api/bootstrap.md
//! Startup-time idempotent setup.
//!
//! Runs after migrations. Ensures the dev user + their default project
//! exist so the upload pipeline always has somewhere to put files. Once
//! Phase 4 (Google OAuth) ships, this falls back to a no-op when at
//! least one human user already exists.

use crate::{db, id};
use anyhow::Context;
use shared::user::UserProfile;
use sqlx::PgPool;

const DEV_USERNAME: &str = "dev";
// The canonical "internal" company — the org that builds RedPash. A case
// is "internal" iff its reporter shares membership here; everything else
// is "external" (customer-reported). Must match the name AppState::init
// resolves into `internal_company_id` (REDPASH_INTERNAL_COMPANY_NAME).
const INTERNAL_COMPANY_DEFAULT: &str = "RedPash";

pub struct Bootstrap {
    pub user:    UserProfile,
    pub project: String,
}

pub async fn run(pool: &PgPool) -> anyhow::Result<Bootstrap> {
    let user = match db::find_user_by_username(pool, DEV_USERNAME)
        .await
        .context("looking up dev user")?
    {
        Some(u) => u,
        None => {
            let rid = id::new("USR");
            tracing::info!(%rid, "creating dev user");
            db::insert_user(pool, &rid, DEV_USERNAME, "Dev user", None, None, None)
                .await
                .context("creating dev user")?
        }
    };

    let project = match db::find_default_project(pool, &user.redpash_id)
        .await
        .context("looking up default project")?
    {
        Some(p) => p,
        None => {
            let rid = id::new("PRJ");
            tracing::info!(%rid, "creating default project");
            db::insert_project(pool, &rid, &user.redpash_id, "Workspace", true)
                .await
                .context("creating default project")?;
            rid
        }
    };

    // Ensure the canonical internal company exists + the dev user belongs
    // to it. This is what `/api/cases?source=` keys off: without a company
    // of this name, AppState resolves `internal_company_id = None` and the
    // source filter silently no-ops (internal + external return the same
    // rows). create_company seats `user` as an owner-member, so the dev
    // user's cases read as internal; cases by non-members read as external.
    let internal_name = std::env::var("REDPASH_INTERNAL_COMPANY_NAME")
        .unwrap_or_else(|_| INTERNAL_COMPANY_DEFAULT.to_string());
    let existing: Option<String> = sqlx::query_scalar(
        "SELECT redpash_id FROM companies WHERE name = $1 LIMIT 1",
    )
    .bind(&internal_name)
    .fetch_optional(pool)
    .await
    .context("looking up internal company")?;
    if existing.is_none() {
        let rid  = id::new("CMP");
        let slug = format!("{}-{}",
            internal_name.to_ascii_lowercase().replace(' ', "-"),
            &rid[4..10].to_ascii_lowercase());
        tracing::info!(%rid, name = %internal_name, "creating canonical internal company");
        db::create_company(pool, &rid, &internal_name, &slug, &user.redpash_id)
            .await
            .context("creating internal company")?;
    }

    Ok(Bootstrap { user, project })
}
